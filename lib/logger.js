import { pubsub } from "../db/redis.js";

// SSE clients set — shared across modules
const sseClients = new Set();

// WS broadcast function — set by ws-gateway after init
let _broadcastWs = null;
export function setWsBroadcast(fn) { _broadcastWs = fn; }

// Track recent notifications to prevent duplicates
const recentNotifications = new Map();

export { sseClients };

export function log(...args) {
  const timestamp = new Date().toISOString();
  const message = args.map(a => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(`[${timestamp}]`, ...args);

  const event = JSON.stringify({ timestamp, message });
  for (const client of sseClients) {
    client.write(`data: ${event}\n\n`);
  }

  // Broadcast to WebSocket clients
  if (_broadcastWs) {
    _broadcastWs({ type: "log", timestamp, message });
  }
}

export function emitTaskEvent(taskId, type, detail) {
  const event = JSON.stringify({ timestamp: new Date().toISOString(), taskId, type, detail });
  for (const client of sseClients) {
    client.write(`event: task\ndata: ${event}\n\n`);
  }
  if (_broadcastWs) {
    _broadcastWs({ type: "task", taskId, eventType: type, detail });
  }
}

export function emitHeartbeatEvent(agentId, projectId, status, progress, summary) {
  const event = JSON.stringify({
    timestamp: new Date().toISOString(),
    agentId, projectId, status, progress, summary,
  });
  for (const client of sseClients) {
    client.write(`event: heartbeat\ndata: ${event}\n\n`);
  }
  if (_broadcastWs) {
    _broadcastWs({ type: "heartbeat", agentId, projectId, status, progress, summary });
  }
}

export function emitSpeakerNotification(agent, projectId, type, message, context = {}) {
  // ✅ NOUVEAU: Extraire contexte enrichi
  // skipChannelBroadcast: when true, only emits the SSE/WS speaker_notify event
  // (so the voice toast still fires) but does NOT call broadcastToChannels.
  // Used when a parallel delivery path (deliverTaskMessage) already covers
  // WhatsApp/Telegram/Slack/Discord — prevents duplicate channel messages.
  //
  // skipVoiceAnnouncement: when true, suppresses the SSE `speaker_notify`
  // emit that drives handleSSESpeakerNotify → DataChannel inject → Realtime
  // response.create. WS broadcast and channels still fire. Used when a
  // dedicated SSE event (e.g. plan_review, project_question) is already
  // the canonical voice announcement for this milestone — without this,
  // the user hears two overlapping summaries for the same event.
  const { conversationId, taskId, speakerMetadata, skipChannelBroadcast, skipVoiceAnnouncement } = context;

  // Create unique key for this notification to prevent duplicates
  const notificationKey = `${agent?.id || 'no-agent'}_${type}_${message.substring(0, 50)}`;
  const now = Date.now();

  // Check if we sent this exact notification in the last 5 seconds
  if (recentNotifications.has(notificationKey)) {
    const lastSent = recentNotifications.get(notificationKey);
    if (now - lastSent < 5000) {
      log(`[NOTIFICATION] Skipping duplicate notification: ${notificationKey}`);
      return;
    }
  }

  // Record this notification
  recentNotifications.set(notificationKey, now);

  // Clean up old entries (older than 10 seconds)
  for (const [key, timestamp] of recentNotifications.entries()) {
    if (now - timestamp > 10000) {
      recentNotifications.delete(key);
    }
  }

  const event = JSON.stringify({
    timestamp: new Date().toISOString(),
    agentId: agent?.id,
    agentName: agent?.name,
    agentRole: agent?.role,
    projectId,
    type,
    message,
    // ✅ NOUVEAU: Contexte enrichi
    conversationId,
    taskId,
    speakerMetadata,
  });
  if (!skipVoiceAnnouncement) {
    for (const client of sseClients) {
      client.write(`event: speaker_notify\ndata: ${event}\n\n`);
    }
  }
  if (_broadcastWs) {
    _broadcastWs({
      type: "speaker_notify",
      agentId: agent?.id,
      agentName: agent?.name,
      projectId,
      notifType: type,
      message,
      // ✅ NOUVEAU: Contexte enrichi
      conversationId,
      taskId,
      speakerMetadata,
    });
  }

  // Broadcast to channels (WhatsApp, Slack, Discord, etc.) unless the caller
  // has already delivered to those surfaces by a different path.
  if (!skipChannelBroadcast) {
    broadcastToChannels({
      type,
      agent: agent?.name,
      agentId: agent?.id, // Add agent ID for thread routing
      projectId,
      message
    });
  }
}

export function emitPlanReviewEvent(data) {
  const event = JSON.stringify({ timestamp: new Date().toISOString(), ...data });
  for (const client of sseClients) {
    client.write(`event: plan_review\ndata: ${event}\n\n`);
  }
  if (_broadcastWs) {
    _broadcastWs({ type: "plan_review", ...data });
  }
}

/**
 * Emit a presentation lifecycle event. The SSE event name is the `type`
 * argument, so the frontend can listen on specific channels:
 *   presentation_ready / presentation_updated /
 *   presentation_run_requested / presentation_run_completed / presentation_run_failed
 */
export function emitPresentationEvent(type, detail) {
  const event = JSON.stringify({ timestamp: new Date().toISOString(), type, ...detail });
  for (const client of sseClients) {
    client.write(`event: ${type}\ndata: ${event}\n\n`);
  }
  if (_broadcastWs) {
    _broadcastWs({ type, ...detail });
  }
}

export function emitProjectQuestionEvent(data) {
  const event = JSON.stringify({ timestamp: new Date().toISOString(), ...data });
  for (const client of sseClients) {
    client.write(`event: project_question\ndata: ${event}\n\n`);
  }
  if (_broadcastWs) {
    _broadcastWs({ type: "project_question", ...data });
  }
}

/**
 * Light notification for discovery questions (SSE only, no channel broadcast)
 * Used when lead agents post discovery questions to avoid notification spam
 * @param {object} agent - Agent object with id, name
 * @param {string} projectId - Project ID
 * @param {object} data - Additional data (question, elapsed, etc.)
 */
export function emitDiscoveryQuestionNotification(agent, projectId, data) {
  const event = JSON.stringify({
    type: 'discovery_progress',
    timestamp: new Date().toISOString(),
    agentId: agent?.id,
    agentName: agent?.name,
    projectId,
    ...data
  });

  // SSE only (no channels, no WebSocket)
  for (const client of sseClients) {
    client.write(`event: discovery_progress\ndata: ${event}\n\n`);
  }

  log(`[DISCOVERY] ${agent?.name} - question posted (${data.elapsed || 0}s)`);
}

/**
 * Emit system update instruction to all active voice clients
 * @param {string} updateType - Type of update: 'voice_instruction', 'tool_update', 'workflow_change'
 * @param {string} message - Human-readable update message
 * @param {object} data - Additional data (optional)
 */
export function emitSystemUpdate(updateType, message, data = {}) {
  const event = {
    type: 'system_update',
    updateType,
    message,
    timestamp: new Date().toISOString(),
    ...data
  };

  log(`[SYSTEM-UPDATE] ${updateType}: ${message}`);

  // Broadcast to all SSE clients
  for (const client of sseClients) {
    try {
      client.write(`event: system_update\ndata: ${JSON.stringify(event)}\n\n`);
    } catch (err) {
      log(`[SYSTEM-UPDATE] Failed to send to SSE client:`, err.message);
    }
  }

  // Broadcast to all WebSocket clients
  if (_broadcastWs) {
    try {
      _broadcastWs(event);
    } catch (err) {
      log(`[SYSTEM-UPDATE] Failed to send to WS clients:`, err.message);
    }
  }
}

export function emitConversationUpdate(convId, turnCount) {
  const event = JSON.stringify({
    timestamp: new Date().toISOString(),
    conversationId: convId,
    turnCount
  });
  for (const client of sseClients) {
    client.write(`event: conversation_update\ndata: ${event}\n\n`);
  }
  if (_broadcastWs) {
    _broadcastWs({ type: "conversation_update", conversationId: convId, turnCount });
  }

  // Publish to Redis for cross-process listeners (e.g., channel notification forwarder)
  pubsub.publish("yabby:conversation-update", event).catch(err => {
    log("[CONV-UPDATE] Failed to publish to Redis:", err.message);
  });
}

/**
 * Broadcast notification to all active channels (WhatsApp, Slack, Discord, etc.)
 * Instead of sending raw notifications, route them through the notification listener
 * so the speaker can reformulate naturally
 * @param {Object} notification - {type, agent, projectId, message}
 */
async function broadcastToChannels(notification) {
  try {
    log(`[BROADCAST] 🔔 Notification received`);
    log(`[BROADCAST]    - type: ${notification.type}`);
    log(`[BROADCAST]    - agentId: ${notification.agentId || 'undefined'}`);
    log(`[BROADCAST]    - message: "${notification.message.substring(0, 100)}..."`);

    // Skip startup recovery errors (tasks that failed in 0-1s are likely orphan resumption failures)
    if (notification.type === "error" && /\(0s\)|\(1s\)/.test(notification.message) && /thread\/resume|Failed to resume/.test(notification.message)) {
      log(`[BROADCAST] Skipping startup recovery error — not user-triggered`);
      return;
    }

    const { getChannel, listChannels } = await import("./channels/index.js");
    const { handleTaskNotification } = await import("./channels/notification-listener.js");

    const channels = listChannels();
    let sentCount = 0;

    for (const [name, info] of Object.entries(channels)) {
      if (!info.running || name === 'web') continue;

      const adapter = getChannel(name);
      if (!adapter) continue;

      try {
        if (name === 'whatsapp') {
          // WhatsApp: use the existing group-based routing
          let targetGroupId = adapter._yabbyGroupId;

          if (notification.agentId) {
            const { getAgentWhatsAppGroup } = await import("../db/queries/agent-whatsapp-groups.js");
            const agentGroup = await getAgentWhatsAppGroup(notification.agentId);
            if (agentGroup) targetGroupId = agentGroup.group_id;
          }

          if (targetGroupId) {
            await handleTaskNotification(targetGroupId, notification, adapter);
            sentCount++;
            log(`[BROADCAST] ✓ Sent to whatsapp (${targetGroupId})`);
          }
        } else {
          // Telegram, Discord, Slack, Signal: find the most recent conversation
          // and send the notification as a direct message
          const { listConversations } = await import("../db/queries/channels.js");
          const convs = await listConversations(name, 1);

          if (convs.length > 0) {
            // Send to the most recently active channel/chat
            const targetChannelId = convs[0].channel_id;
            const notifText = `📋 ${notification.message}`;
            await adapter.send(targetChannelId, notifText);
            sentCount++;
            log(`[BROADCAST] ✓ Sent to ${name} (${targetChannelId})`);
          } else {
            log(`[BROADCAST] ⚠️ ${name}: no conversations to send notification to`);
          }
        }
      } catch (err) {
        log(`[BROADCAST] ✗ Failed to send to ${name}: ${err.message}`);
      }
    }

    log(`[BROADCAST] Done — sent to ${sentCount} channel(s)`);

  } catch (err) {
    log("[BROADCAST] ✗ Failed to route notification:", err.message, err.stack);
  }
}
