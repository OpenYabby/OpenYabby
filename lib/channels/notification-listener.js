/**
 * Conversation Notification Listener
 *
 * Listens for conversation updates via Redis pubsub and forwards assistant messages
 * to active channels (WhatsApp, Discord, etc.) to keep all interfaces synchronized.
 *
 * Prevents infinite loops by:
 * 1. Self-sent messages have `fromMe=true` and are ignored by channel handlers
 * 2. No platformMsgId means handler won't save to channel_messages
 */

import { pubsub } from "../../db/redis.js";
import { query } from "../../db/pg.js";
import { log } from "../logger.js";
import { getChannelContainer } from "../../db/queries/channel-containers.js";

// Map of registered channel adapters
const channelAdapters = new Map();

/**
 * Register a channel adapter for notification forwarding
 * @param {string} channelName - Name of the channel (e.g., "whatsapp", "discord")
 * @param {object} adapter - Channel adapter instance with send() method
 */
export function registerChannelAdapter(channelName, adapter) {
  channelAdapters.set(channelName, adapter);
  log(`[NOTIF-LISTENER] Registered adapter: ${channelName}`);
}

/**
 * Start listening for conversation updates and forward to channels
 */
export async function startConversationListener() {
  // Subscribe to conversation updates via Redis pubsub
  const subscriber = pubsub.duplicate();
  await subscriber.connect();

  await subscriber.subscribe("yabby:conversation-update", async (message) => {
    try {
      const { conversationId, turnCount } = JSON.parse(message);
      log(`[NOTIF-LISTENER] 📥 Received update: convId=${conversationId}, turnCount=${turnCount}`);

      // Get latest turn from conversation with source field
      const result = await query(
        `SELECT role, text, source, created_at
         FROM conversation_turns
         WHERE conversation_id = $1 AND active = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
        [conversationId]
      );

      if (!result.rows.length) {
        log(`[NOTIF-LISTENER] ⚠️ No turns found`);
        return;
      }

      const latestTurn = result.rows[0];
      log(`[NOTIF-LISTENER] Latest turn: role=${latestTurn.role}, source=${latestTurn.source || 'unknown'}, text="${latestTurn.text.slice(0, 50)}..."`);

      // Skip if neither user nor assistant message
      if (latestTurn.role !== "user" && latestTurn.role !== "assistant") {
        log(`[NOTIF-LISTENER] ⏭️ Skipping non-user/assistant message`);
        return;
      }

      // System-internal sources are handled directly by deliverTaskMessage
      // (web SSE refresh + WhatsApp + bindings + symmetric Yabby fan-out).
      // Re-forwarding them here would create duplicates on every channel.
      // 'agent_task' is the setup-task source — never user-facing on channels.
      const internalSources = ['notification', 'task_result_raw', 'agent_task'];
      if (internalSources.includes(latestTurn.source)) {
        log(`[NOTIF-LISTENER] 🚫 Skipping - internal source '${latestTurn.source}' (deliverTaskMessage handles it)`);
        return;
      }

      // Channel-originated sources (whatsapp, telegram, discord, slack, signal)
      // are now cross-posted to OTHER channels for full conversation mirroring
      // — the user sees their question + the LLM ack on every connected
      // surface, regardless of where they typed it. Ping-pong is prevented by
      // the `channelName === source` skip in the loop below.
      const source = latestTurn.source || 'web';
      log(`[NOTIF-LISTENER] ✅ Message source is ${source} - forwarding to other channels (skipping source)`);

      // Forward to all active channels EXCEPT the source channel (to avoid echo)
      for (const [channelName, adapter] of channelAdapters) {
        if (!adapter.running) continue;
        if (channelName === source) continue; // Don't echo back to source
        if (channelName === 'web') continue; // Web gets updates via SSE

        try {
          // STEP 1 — generic per-conversation binding lookup (works for ANY
          // channel that uses channel_thread_bindings: telegram forum topics,
          // discord private channels, slack private channels, legacy whatsapp
          // bindings). Tried FIRST so per-agent threads always win over the
          // channel-wide fallbacks below. Skipped for the shared main conv
          // (which uses channel-specific defaults further down).
          if (conversationId !== "00000000-0000-0000-0000-000000000001") {
            const tb = await query(
              `SELECT thread_id FROM channel_thread_bindings
               WHERE channel_name = $1 AND conversation_id = $2 LIMIT 1`,
              [channelName, conversationId]
            );
            if (tb.rows.length > 0) {
              await adapter.send(tb.rows[0].thread_id, latestTurn.text);
              log(`[NOTIF-LISTENER] ✅ Forwarded to ${channelName} via binding (${tb.rows[0].thread_id})`);
              continue;
            }
          }

          if (channelName === 'whatsapp') {
            // WhatsApp: priority order
            //   1. Shared main conv → whatsapp_settings.yabby_group_id
            //   2. Per-agent conv   → agent_whatsapp_groups.group_id
            //      (canonical home for standalone-agent WhatsApp groups —
            //      schema separate from channel_thread_bindings)
            let targetChannelId;

            if (conversationId === "00000000-0000-0000-0000-000000000001") {
              const groupResult = await query(
                `SELECT yabby_group_id FROM whatsapp_settings LIMIT 1`
              );
              if (groupResult.rows.length > 0) {
                targetChannelId = groupResult.rows[0].yabby_group_id;
              }
            } else {
              // Per-agent: join conversations → agent_whatsapp_groups
              const agentGroupResult = await query(
                `SELECT awg.group_id
                 FROM conversations c
                 JOIN agent_whatsapp_groups awg ON awg.agent_id = c.agent_id
                 WHERE c.id = $1
                 LIMIT 1`,
                [conversationId]
              );
              if (agentGroupResult.rows.length > 0) {
                targetChannelId = agentGroupResult.rows[0].group_id;
              }
            }

            if (targetChannelId) {
              await adapter.send(targetChannelId, latestTurn.text);
              log(`[NOTIF-LISTENER] ✅ Forwarded to whatsapp (${targetChannelId})`);
            } else {
              log(`[NOTIF-LISTENER] ⚠ whatsapp: no group resolved for conversation ${conversationId}`);
            }
          } else if (channelName === "telegram") {
            // Reached only when the per-conversation binding lookup at step 1
            // didn't resolve. Two cases handle the remainder:
            //   1. Forum container paired → post to its General topic so the
            //      user sees web/voice and WhatsApp turns mirrored on Telegram
            //      too. We never fall back to "most recent chat" with a forum
            //      container because that can resurrect a disabled DM after
            //      pairing.
            //   2. No container paired (legacy Yabby-only DM flow) → post to
            //      the most recent Telegram conversation.
            const container = await getChannelContainer("telegram");
            if (container) {
              await adapter.send(String(container.container_id), latestTurn.text);
              log(`[NOTIF-LISTENER] ✅ Forwarded to telegram forum General (${container.container_id})`);
            } else {
              const convResult = await query(
                `SELECT channel_id FROM channel_conversations
                 WHERE channel_name = $1 ORDER BY last_message_at DESC LIMIT 1`,
                [channelName]
              );
              if (convResult.rows.length > 0) {
                await adapter.send(convResult.rows[0].channel_id, latestTurn.text);
                log(`[NOTIF-LISTENER] ✅ Forwarded to ${channelName} (${convResult.rows[0].channel_id})`);
              }
            }
          } else {
            // Discord, Slack, Signal: find most recent conversation for this channel
            const convResult = await query(
              `SELECT channel_id FROM channel_conversations
               WHERE channel_name = $1 ORDER BY last_message_at DESC LIMIT 1`,
              [channelName]
            );

            if (convResult.rows.length > 0) {
              await adapter.send(convResult.rows[0].channel_id, latestTurn.text);
              log(`[NOTIF-LISTENER] ✅ Forwarded to ${channelName} (${convResult.rows[0].channel_id})`);
            }
          }
        } catch (err) {
          log(`[NOTIF-LISTENER] ❌ Failed to forward to ${channelName}: ${err.message}`);
        }
      }
    } catch (err) {
      log(`[NOTIF-LISTENER] ❌ Error forwarding to WhatsApp:`, err.message);
    }
  });

  log("[NOTIF-LISTENER] Started listening for conversation updates");
}

/**
 * Send a task status message to a conversation + WhatsApp thread.
 * Used for "task started" and "task completed" notifications.
 *
 * `systemMarker: true` skips the conversation write + SSE refresh so the
 * Realtime model doesn't TTS the literal `[bracketed]` UI marker from
 * history. WhatsApp delivery still fires — bracketed markers are useful
 * timeline acks on chat surfaces, just not in voice context.
 */
export async function notifyTaskStatus(message, conversationId, whatsappAdapter, groupId, { systemMarker = false } = {}) {
  try {
    if (!systemMarker) {
      const { addTurn } = await import("../../db/queries/conversations.js");
      const { emitConversationUpdate } = await import("../logger.js");
      const turn = await addTurn('assistant', message, conversationId, 'notification');
      emitConversationUpdate(conversationId, turn.turnCount);
    }
    if (whatsappAdapter?.running && groupId) {
      await whatsappAdapter.send(groupId, message);
    }
    log(`[NOTIF] ✅ Status: "${message.substring(0, 60)}"`);
  } catch (err) {
    log(`[NOTIF] Status notification failed: ${err.message}`);
  }
}

/**
 * Build a one-line voice-friendly mirror summary directly from the raw task
 * result, in the user's configured language.
 *
 * One LLM pass (gpt-4.1-nano) does both jobs at once:
 *   - extract: skip section headings ("Status update:", "Review Summary:"),
 *     tables, code fences, IDs, and pick a real content sentence
 *   - localize: write that sentence in the configured server language
 *
 * This replaces a fragile two-stage pipeline (regex extractor +
 * separate localizer) where the regex would let through any new heading
 * variation an agent invents. The LLM is the only thing that reliably
 * tells "title" from "content".
 *
 * Reuses the global LANGUAGE_NAMES + getServerLanguage from lib/i18n.js so
 * any future supported language works automatically.
 *
 * Returns null on failure — the caller falls back to its heuristic.
 */
export async function summarizeMirrorFromResult(rawResult, agentName = null) {
  if (!rawResult || typeof rawResult !== 'string') return null;
  const trimmed = rawResult.trim();
  if (!trimmed) return null;
  // Cap input to keep the call cheap. The opening of the result is what
  // the LLM needs — anything past 1500 chars is detail that doesn't
  // belong in a one-sentence mirror.
  const head = trimmed.slice(0, 1500);

  const { getServerLanguage, LANGUAGE_NAMES } = await import("../i18n.js");
  const lang = getServerLanguage();
  const target = LANGUAGE_NAMES[lang] || LANGUAGE_NAMES.en;

  // The mirror lives in Yabby's conversation — the user is talking to
  // Yabby, not to the agent. The sentence must read as a third-person
  // report ("Emma livered the backend") so Realtime doesn't mistake the
  // agent for the user. Naming the agent as the subject also tells the
  // user who did the work without us prefixing "<Name>:" (which Realtime
  // parses as a dialogue tag).
  const subjectRule = agentName
    ? `- Use "${agentName}" as the subject of the sentence (e.g. "${agentName} has shipped the backend on port 4747"). Write in third person.\n`
    : `- Write in third person, describing what was done.\n`;

  try {
    const { getProvider } = await import("../providers/index.js");
    const provider = getProvider("openai");
    const llmResult = await provider.complete([
      {
        role: "system",
        content:
          `You write one short sentence in ${target} (max 20 words) that tells the user what was just accomplished, based on a raw task result.\n\n` +
          `Rules:\n` +
          `- Output ONE sentence in ${target}. No preamble, no quotes, no markdown.\n` +
          `- Skip section headings, table rows, code blocks, IDs, "Status update:", "Review Summary:" and similar labels — describe the actual accomplishment, not the title of a section.\n` +
          subjectRule +
          `- Keep names, numbers, and ports verbatim.\n` +
          `- If the result is empty or unintelligible, return exactly: TASK_COMPLETED`,
      },
      { role: "user", content: head },
    ], { model: "gpt-4.1-nano", maxTokens: 80, context: "mirror_summary" });

    const out = (llmResult.text || '').trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!out || out === 'TASK_COMPLETED') return null;
    // Cap length defensively in case the model overshoots.
    return out.length > 200 ? out.slice(0, 197).trimEnd() + '…' : out;
  } catch (err) {
    log(`[MIRROR-SUMMARY] Failed: ${err.message}`);
    return null;
  }
}

/**
 * Build a short, voice-friendly summary of a plan_content document for the
 * speaker to read aloud when a plan_review event fires.
 *
 * The plan_content can be very long Markdown (5–20k chars), too long for a
 * single spoken sentence. This helper runs gpt-4.1-nano to extract the
 * essentials (team, milestones, key features) in the user's language, in
 * 2–3 short sentences (~50 words max). Returns null on failure — the
 * caller falls back to a generic "plan ready" line.
 */
export async function summarizePlanForVoice(planContent, agentName, projectName) {
  if (!planContent || typeof planContent !== 'string') return null;
  const head = planContent.slice(0, 2500);
  const { getServerLanguage, LANGUAGE_NAMES } = await import("../i18n.js");
  const lang = getServerLanguage();
  const target = LANGUAGE_NAMES[lang] || LANGUAGE_NAMES.en;

  try {
    const { getProvider } = await import("../providers/index.js");
    const provider = getProvider("openai");
    const llmResult = await provider.complete([
      {
        role: "system",
        content:
          `You produce a short, spoken summary in ${target} of a project plan a project lead just submitted. The user will hear this read aloud — keep it natural, conversational, under 50 words, 2–3 short sentences.\n\n` +
          `Rules:\n` +
          `- Output is ${target}, plain text, no markdown, no bullet points, no headings, no IDs.\n` +
          `- Mention the agent name (${agentName || 'the lead'}) once if natural, and the project name (${projectName || ''}) once.\n` +
          `- Cover the gist: team size, key sections/milestones, what the deliverable is. Skip technical details (port numbers, framework names, file paths).\n` +
          `- End with a sentence inviting the user to approve, revise, or cancel.\n` +
          `- Sound like the lead is briefing the user verbally, not reading a doc.`,
      },
      { role: "user", content: head },
    ], { model: "gpt-4.1-nano", maxTokens: 200, context: "plan_voice_summary" });

    const out = (llmResult.text || '').trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!out) return null;
    // Cap defensively
    return out.length > 600 ? out.slice(0, 597).trimEnd() + '…' : out;
  } catch (err) {
    log(`[PLAN-VOICE-SUMMARY] Failed: ${err.message}`);
    return null;
  }
}

/**
 * Reformulate a task result into a natural response via fast LLM.
 * Returns the reformulated text, or null on failure.
 */
export async function reformulateResult(rawText) {
  try {
    const cleanText = rawText.replace(/^✅\s*(?:Tâche terminée|Task completed).*?\n\n/s, '');
    const { getProvider } = await import("../providers/index.js");
    const provider = getProvider("openai");
    const llmResult = await provider.complete([
      {
        role: "system",
        content: "You are an assistant. Reformulate this task result into a natural and complete response for the user. Keep ALL important information (numbers, data, lists, file paths). Respond directly as if it were your own answer — no 'here is the result', no 'the task is completed'. Be natural and concise but do not lose any useful data."
      },
      { role: "user", content: cleanText }
    ], { model: "gpt-5-mini", maxTokens: 4000, context: "task_reformulation" });
    return llmResult.text?.trim() || null;
  } catch (err) {
    log(`[REFORMULATE] Failed: ${err.message}`);
    return null;
  }
}

/**
 * Send a Yabby task result to webchat + WhatsApp with a natural follow-up.
 * 1. Saves raw result as assistant turn in main conversation (webchat)
 * 2. Sends raw result to WhatsApp
 * 3. Generates a short follow-up via fast LLM → saves + sends it too
 */
async function sendYabbyTaskResult(rawMessage, whatsappAdapter, targetGroupId, { skipDefaultConvPersist = false } = {}) {
  const DEFAULT_CONV_ID = "00000000-0000-0000-0000-000000000001";
  const { addTurn } = await import("../../db/queries/conversations.js");
  const { emitConversationUpdate } = await import("../logger.js");

  // 1. Completion status → webchat + WhatsApp
  const { serverMsg } = await import("../i18n.js");
  await notifyTaskStatus(serverMsg().taskSuccess, DEFAULT_CONV_ID, whatsappAdapter, targetGroupId, { systemMarker: true });

  // 2. Reformulated follow-up via fast LLM (non-fatal)
  // skipDefaultConvPersist: when the caller knows a parallel SSE event
  // (plan_review, project_question) already drove a clean voice
  // announcement, we suppress the addTurn into DEFAULT_CONV_ID so Realtime
  // doesn't re-summarize this large reformulated EN block. WhatsApp still
  // gets the detailed reformulation — useful as an external timeline.
  try {
    const followUp = await reformulateResult(rawMessage);
    if (followUp) {
      if (!skipDefaultConvPersist) {
        const followTurn = await addTurn('assistant', followUp, DEFAULT_CONV_ID, 'notification');
        emitConversationUpdate(DEFAULT_CONV_ID, followTurn.turnCount);
      } else {
        log(`[NOTIF] 🔕 follow-up persistence to DEFAULT_CONV_ID skipped (specialized SSE event already covers voice)`);
      }
      await whatsappAdapter.send(targetGroupId, followUp);
      log(`[NOTIF] ✅ Sent follow-up: "${followUp.substring(0, 80)}"`);
    }
  } catch (err) {
    log(`[NOTIF] Follow-up failed (non-fatal): ${err.message}`);
  }
}

/**
 * Handle task notification and send to WhatsApp via speaker reformulation
 * Called by logger.js when a task completes/fails
 * @param {string} targetGroupId - WhatsApp group ID
 * @param {object} notification - Notification object with type and message
 * @param {object} whatsappAdapter - WhatsApp adapter instance
 */
export async function handleTaskNotification(targetGroupId, notification, whatsappAdapter) {
  log(`[NOTIF] 🔍 DIAG 7 - handleTaskNotification called`);
  log(`[NOTIF]    - targetGroupId: ${targetGroupId}`);
  log(`[NOTIF]    - notification.type: ${notification.type}`);
  log(`[NOTIF]    - notification.agentId: ${notification.agentId || 'undefined'}`);
  log(`[NOTIF]    - notification.message: "${notification.message.substring(0, 150)}..."`);

  if (!whatsappAdapter || !whatsappAdapter.running) {
    log('[NOTIF] WhatsApp adapter not running, skipping notification');
    return;
  }

  try {
    // Get thread binding to find target agent ID
    const { query } = await import("../../db/pg.js");
    const bindingResult = await query(
      `SELECT agent_id, conversation_id FROM channel_thread_bindings WHERE thread_id = $1 AND channel_name = 'whatsapp'`,
      [targetGroupId]
    );

    const targetAgentId = bindingResult.rows[0]?.agent_id || null;
    const conversationId = bindingResult.rows[0]?.conversation_id || null;
    log(`[NOTIF] Thread binding: conversationId=${conversationId}, targetAgentId=${targetAgentId || 'null'}`);

    // For Yabby (no agent binding): raw result + follow-up to webchat + WhatsApp
    if (!targetAgentId) {
      // ─── DEDUP CHECK ──
      // If the originating agent (notification.agentId) just submitted a
      // plan_review or posted project_questions, the dedicated SSE events
      // already drove a clean voice announcement. Persisting the long
      // reformulated EN follow-up into DEFAULT_CONV_ID would force Realtime
      // to re-summarize the same milestone. Suppress the persist (channel
      // delivery still happens — useful for WhatsApp/Telegram timeline).
      let skipDefaultConvPersist = false;
      if (notification.agentId) {
        try {
          const planRow = await query(
            `SELECT 1 FROM plan_reviews
             WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '2 minutes'
             LIMIT 1`,
            [notification.agentId]
          );
          const questionRow = await query(
            `SELECT 1 FROM project_questions
             WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '2 minutes'
             LIMIT 1`,
            [notification.agentId]
          );
          if (planRow.rows.length > 0) {
            skipDefaultConvPersist = true;
            log(`[NOTIF] 🔕 plan_review SSE already covers — DEFAULT_CONV_ID persist will be skipped`);
          } else if (questionRow.rows.length > 0) {
            skipDefaultConvPersist = true;
            log(`[NOTIF] 🔕 project_question SSE already covers — DEFAULT_CONV_ID persist will be skipped`);
          }
        } catch (dedupErr) {
          log(`[NOTIF] dedup check failed (proceeding without skip): ${dedupErr.message}`);
        }
      }
      await sendYabbyTaskResult(notification.message, whatsappAdapter, targetGroupId, { skipDefaultConvPersist });
      return;
    }

    // For agent threads: use handler for LLM reformulation
    const { handleChannelMessage } = await import("./handler.js");

    const systemNotification = {
      isSystemNotification: true,
      text: notification.message,
      contextMessage: notification.message,
      channelName: 'whatsapp',
      channelId: targetGroupId,
      isGroup: true,
      userId: 'system',
      userName: 'System',
      targetAgentId: targetAgentId,
      conversationId: conversationId,
      timestamp: new Date()
    };

    log(`[NOTIF] Agent ${targetAgentId} — triggering speaker reformulation`);
    await handleChannelMessage(systemNotification, whatsappAdapter);
    log(`[NOTIF] ✅ Speaker reformulated and sent to ${targetGroupId}`);
  } catch (err) {
    log(`[NOTIF] ❌ Failed to send notification:`, err.message);
  }
}
