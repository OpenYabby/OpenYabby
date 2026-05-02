import { log } from "../logger.js";
import { getChannel, listChannels } from "./index.js";
import { emitConversationUpdate } from "../logger.js";
import { addTurn } from "../../db/queries/conversations.js";
import { getAgentWhatsAppGroup } from "../../db/queries/agent-whatsapp-groups.js";
import { getThreadManager } from "./thread-binding-manager.js";
import { listConversations } from "../../db/queries/channels.js";

const YABBY_AGENT_ID = "yabby-000000";

// Channels eligible for the "Yabby super-agent symmetric fan-out" — when an
// agent has no explicit binding for a channel, we still mirror Yabby's task
// status to that channel so every connected surface sees what's happening.
// The web channel is excluded — its delivery is handled by the SSE event
// emitted in step 1 (the chat window auto-refreshes via conversation_update).
const SYMMETRIC_FANOUT_CHANNELS = ["telegram", "discord", "slack", "signal"];

/**
 * Unified task-status delivery helper.
 *
 * Writes one notification turn into the agent conversation (driving the
 * web chat SSE refresh) and fans out the same text to every channel the
 * agent is reachable on:
 *   - WhatsApp (when bound, via agent_whatsapp_groups or _yabbyGroupId for super-agent)
 *   - Every channel_thread_bindings row for this agent (Telegram/Discord/Slack/Signal)
 *   - The originating channel from queueTask.source_id, when not already covered
 *
 * Per-surface delivery is independent and non-fatal — one channel down does
 * not silence the others.
 */
export async function deliverTaskMessage({ agentId, conversationId, text, queueTask = null, isYabby = false, webOnly = false, systemMarker = false }) {
  // 1. Web chat — always (unless this is a system marker). The
  //    conversation_update SSE event is what makes the open chat window
  //    refresh; the turn itself becomes part of the visible history.
  //
  //    `systemMarker: true` skips the conversation write + SSE refresh for
  //    bracketed UI-only strings (taskLaunched, taskSuccess, agentSetup,
  //    agentSetupDone). They were never meant to be conversation content —
  //    they're transient timeline markers — but persisting them caused the
  //    Realtime model to read them back from history and TTS the literal
  //    `[brackets]` to the user, plus produce a redundant summary turn for
  //    each marker. The activity feed already covers the "task launched /
  //    completed" signal via SSE `task` events. Channel fan-out still fires
  //    below so external clients (WhatsApp/Telegram/...) keep their
  //    timeline acks intact.
  if (!systemMarker) {
    try {
      const turn = await addTurn("assistant", text, conversationId, "notification");
      emitConversationUpdate(conversationId, turn.turnCount);
    } catch (err) {
      log(`[DELIVER] conversation write failed: ${err.message}`);
    }
  }

  // Web-only short-circuit: used for the spawn notification ("[task launched]")
  // because every channel handler ALREADY emits its own ack reply ("Launched.
  // I'll update you when it's done.") right after calling yabby_execute.
  // Sending a parallel system bubble would duplicate the ack on WhatsApp /
  // Telegram / Discord / Slack. The web chat still gets the bubble because
  // it has no LLM-ack of its own (the chat-tool path drops the ack into the
  // same conversation, but only after the queue confirmation).
  if (webOnly) return;

  // 2. WhatsApp — Yabby super-agent uses the shared main group; standalone
  //    agents use their own bound group from agent_whatsapp_groups.
  const whatsapp = getChannel("whatsapp");
  let waGroupId = null;
  if (whatsapp?.running) {
    try {
      if (isYabby || agentId === YABBY_AGENT_ID) {
        waGroupId = whatsapp._yabbyGroupId || null;
      } else {
        const group = await getAgentWhatsAppGroup(agentId);
        waGroupId = group?.group_id || null;
      }
      if (waGroupId) {
        try {
          await whatsapp.send(waGroupId, text);
        } catch (err) {
          log(`[DELIVER] whatsapp send failed: ${err.message}`);
        }
      }
    } catch (err) {
      log(`[DELIVER] whatsapp lookup failed: ${err.message}`);
    }
  }

  // 3. Other bound channels (Telegram/Discord/Slack/Signal). Loaded once
  //    here so we can reuse the list when checking origin coverage below.
  let bindings = [];
  try {
    const manager = getThreadManager("_global", "main");
    bindings = await manager.getAllByAgentId(agentId);
  } catch (err) {
    log(`[DELIVER] bindings lookup failed: ${err.message}`);
  }

  for (const b of bindings) {
    if (b.channel_name === "whatsapp") continue; // already handled above
    const adapter = getChannel(b.channel_name);
    if (!adapter?.running) continue;
    try {
      // Phase 3 will compose Telegram forum-topic IDs as "chat:topic"; here
      // we just hand the raw thread_id to the adapter — current WhatsApp/Telegram
      // bindings are bare chat IDs and continue to work.
      await adapter.send(b.thread_id, text);
    } catch (err) {
      log(`[DELIVER] ${b.channel_name} send failed: ${err.message}`);
    }
  }

  // 4. Originating channel — when a task was triggered from a channel that
  //    has no agent binding (e.g. user pings Yabby super-agent from Telegram),
  //    deliver back to that exact chat. Skip if already covered above.
  let originChannelName = null;
  let originChatId = null;
  if (queueTask?.source_id && typeof queueTask.source_id === "string") {
    const sep = queueTask.source_id.indexOf(":");
    if (sep > 0) {
      originChannelName = queueTask.source_id.slice(0, sep);
      originChatId = queueTask.source_id.slice(sep + 1);
      const alreadyCovered =
        (originChannelName === "whatsapp" && waGroupId) ||
        bindings.some(b => b.channel_name === originChannelName);
      if (!alreadyCovered && originChatId) {
        const adapter = getChannel(originChannelName);
        if (adapter?.running) {
          try {
            await adapter.send(originChatId, text);
          } catch (err) {
            log(`[DELIVER] origin ${originChannelName} send failed: ${err.message}`);
          }
        }
      }
    }
  }

  // 5. Symmetric fan-out for the Yabby super-agent — mirror the bubble to
  //    every connected channel that is NOT already covered above so the user
  //    sees the same timeline on Telegram / Discord / Slack / Signal as on
  //    WhatsApp + web, regardless of where the task was triggered from.
  //
  //    Only applies to the Yabby super-agent because regular standalone
  //    agents have explicit bindings (channel_thread_bindings) that already
  //    target the right thread for their owner. Cross-posting Marie's task
  //    completion to a Telegram chat that has nothing to do with Marie would
  //    be noise.
  //
  //    For each candidate channel we send to the most-recently-active
  //    conversation (channel_conversations.last_message_at DESC). With the
  //    single-owner-per-channel pairing already in place, that's always the
  //    right user.
  if ((isYabby || agentId === YABBY_AGENT_ID)) {
    const activeChannels = listChannels();
    for (const channelName of SYMMETRIC_FANOUT_CHANNELS) {
      const info = activeChannels[channelName];
      if (!info?.running) continue;
      // Already covered by step 3 binding fan-out
      if (bindings.some(b => b.channel_name === channelName)) continue;
      // Already covered by step 4 origin send
      if (originChannelName === channelName) continue;
      const adapter = getChannel(channelName);
      if (!adapter?.running) continue;
      try {
        const convs = await listConversations(channelName, 1);
        if (!convs.length) continue;
        const targetChatId = convs[0].channel_id;
        if (!targetChatId) continue;
        try {
          await adapter.send(targetChatId, text);
        } catch (err) {
          log(`[DELIVER] symmetric ${channelName} send failed: ${err.message}`);
        }
      } catch (err) {
        log(`[DELIVER] symmetric ${channelName} lookup failed: ${err.message}`);
      }
    }
  }
}
