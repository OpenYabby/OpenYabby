/* ═══════════════════════════════════════════════════════
   Channel Message Handler
   ═══════════════════════════════════════════════════════
   Central handler: incoming msg → find/create conversation
   → build context → call LLM provider → send response back.
   Commands: /status, /new, /reset, /tasks.
   Retry with dead letter queue on failure.
   NOW WITH TOOL SUPPORT via function calling loop.
*/

import { log, emitConversationUpdate } from "../logger.js";
import { getDefaultProvider } from "../providers/index.js";
import {
  findOrCreateConversation,
  addMessage as addChannelMessage,
  getMessages,
  insertDeadLetter,
  clearConversationMessages,
} from "../../db/queries/channels.js";
import { addTurn, getConversation, DEFAULT_CONV_ID } from "../../db/queries/conversations.js";
import { query } from "../../db/pg.js";
import { buildChannelInstructions, buildAgentContextBlock } from "../prompts.js";
import { getMemoryProfile, extractMemories } from "../memory.js";
import { getConnectorSummary } from "../connectors/manager.js";
import { getPromptFragments, getServerLanguage, serverMsg } from "../i18n.js";
import { getToolsForChannel } from "../plugins/tool-registry.js";
import { getThreadManager } from "./thread-binding-manager.js";
import { buildVisionParts } from "../media/vision.js";
import { detectMediaIntent, intentToToolHint } from "./media-intent.js";
import { getOwner as getPairingOwner, consumePairingCode, claimOwner as claimPairingOwner } from "../../db/queries/channel-pairings.js";
import { getChannelContainer } from "../../db/queries/channel-containers.js";
import { downloadAll } from "./download-attachment.js";

const COMMANDS = {
  "/status": handleStatusCommand,
  "/new": handleNewCommand,
  "/reset": handleNewCommand,
  "/help": handleHelpCommand,
  "/screenshot": handleScreenshotCommand,
  "/search": handleSearchCommand,
  "/image": handleImageCommand,
};

const PAIRING_REQUIRED = new Set(["telegram", "discord", "slack", "signal"]);

/**
 * Pairing gate: ensure the sender is the paired owner for this channel.
 * Returns: "allow" | "claimed" | "reject"
 */
async function checkPairingGate(msg, adapter) {
  if (!PAIRING_REQUIRED.has(msg.channelName)) return "allow";

  const owner = await getPairingOwner(msg.channelName);
  if (owner) {
    // Channel is paired — only owner can interact
    if (String(msg.userId) !== owner.owner_user_id) return "reject";
    return "allow";
  }

  // Channel unpaired — only accept a valid pairing code
  const trimmed = (msg.text || "").trim();
  const match = trimmed.match(/YABBY-[A-F0-9]{4}-[A-F0-9]{4}/i);
  if (!match) return "reject"; // No code in message, silently reject

  const userLang = (msg.userLang || "").split("-")[0].toLowerCase() || null;
  const m = serverMsg(userLang);
  const ok = await consumePairingCode(msg.channelName, match[0]);
  if (!ok) {
    try { await adapter.send(msg.channelId, m.pairingInvalid); } catch {}
    return "reject";
  }

  // Claim ownership
  await claimPairingOwner(msg.channelName, {
    userId: String(msg.userId),
    userName: msg.userName,
    chatId: String(msg.channelId),
  });
  try { await adapter.send(msg.channelId, m.pairingSuccess); } catch {}

  // First-pairing onboarding: explain the next setup step (creating an
  // agent container) in the user's own platform language. Localized via
  // serverMsg(userLang) so a Telegram user with language_code='fr' gets
  // the French message even if the server-wide language is English.
  try {
    const onboardingKey = {
      telegram: "pairOnboardingTelegram",
      discord:  "pairOnboardingDiscord",
      slack:    "pairOnboardingSlack",
    }[msg.channelName];
    if (onboardingKey) {
      const { serverMsg } = await import("../i18n.js");
      const lang = (msg.userLang || "").split("-")[0].toLowerCase() || null;
      const onboarding = serverMsg(lang)?.[onboardingKey];
      if (onboarding) await adapter.send(msg.channelId, onboarding);
    }
  } catch (err) {
    log(`[CHANNEL:${msg.channelName}] Pairing onboarding send failed (non-fatal): ${err.message}`);
  }

  return "claimed";
}

/**
 * Container gate: once a forum/server/workspace container is paired for a
 * channel, DMs to the bot are disabled. The user is told to use the forum.
 * Group/forum messages always pass through. Returns "allow" | "reject".
 */
async function checkContainerGate(msg, adapter) {
  if (msg.channelName !== "telegram") return "allow";
  if (msg.isGroup) return "allow";
  const container = await getChannelContainer("telegram");
  if (!container) return "allow";
  const lang = (msg.userLang || "").split("-")[0].toLowerCase() || null;
  try { await adapter.send(msg.channelId, serverMsg(lang).useForumNotDm); } catch {}
  log(`[CHANNEL:${msg.channelName}] Container exists, DM rejected (user=${msg.userId})`);
  return "reject";
}

const MAX_CONTEXT_MESSAGES = 20;
const MAX_RETRIES = 3;
const RETRY_DELAY_BASE = 3000;
const MAX_FUNCTION_CALL_ITERATIONS = 5;

// Action/hallucination classifier — moved to lib/hallucination-detector.js so
// voice handlers can reuse the same logic.
import { detectActionClaim as detectActionHallucination } from "../hallucination-detector.js";

/**
 * Central message handler for all channel adapters.
 * @param {import('./normalize.js').NormalizedMessage} msg
 * @param {import('./base.js').ChannelAdapter} adapter
 */
export async function handleChannelMessage(msg, adapter) {
  log(`[CHANNEL:${msg.channelName}] handleChannelMessage called: "${msg.text.substring(0, 50)}..."`);

  // Skip empty messages (but allow photo-only messages with attachments)
  if (!msg.text && (!Array.isArray(msg.attachments) || msg.attachments.length === 0)) {
    log(`[CHANNEL:${msg.channelName}] Empty message, skipping`);
    return null;
  }

  // Pairing gate: reject non-owners on pairable channels
  const gate = await checkPairingGate(msg, adapter);
  if (gate === "reject") return null;
  if (gate === "claimed") return null; // Pairing successful, no further processing

  // Container gate: once a forum is paired for Telegram, DMs are disabled
  const containerGate = await checkContainerGate(msg, adapter);
  if (containerGate === "reject") return null;

  // ⚠️ DÉDUPLICATION: Vérifier si message déjà traité via platform_msg_id
  if (msg.platformMsgId) {
    const existing = await query(
      `SELECT id FROM channel_messages WHERE platform_msg_id = $1 LIMIT 1`,
      [msg.platformMsgId]
    );

    if (existing.rows.length > 0) {
      log(`[CHANNEL:${msg.channelName}] Message ${msg.platformMsgId} already exists in DB, skipping`);
      return null;
    }
  }

  // Thread Binding Check: si message dans un thread lié à un agent
  if (msg.threadId) {
    const manager = getThreadManager(msg.channelName, msg.accountId || "main");
    const binding = await manager.getByThreadId(msg.threadId);

    if (binding) {
      log(`[CHANNEL:${msg.channelName}] Thread ${msg.threadId} bound to agent ${binding.agent_id}`);

      // Single-owner per thread (defence in depth on top of channel_pairings).
      // When owner_user_id is set on the binding, only that user can interact
      // with the agent through this thread. Anyone else (someone added to a
      // forum topic / Discord channel / Slack channel) is silently rejected
      // and audit-logged with a sha256 of the message — we record the attempt
      // without persisting potentially sensitive content.
      if (binding.owner_user_id && msg.userId && String(msg.userId) !== String(binding.owner_user_id)) {
        log(`[CHANNEL:${msg.channelName}] 🚫 Thread ${msg.threadId} non-owner access — rejecting silently (binding owner=${binding.owner_user_id}, attempted by=${msg.userId})`);
        try {
          const { createHash } = await import("crypto");
          const { logEvent } = await import("../../db/queries/events.js");
          const messageSha256 = createHash("sha256").update(msg.text || "").digest("hex");
          await logEvent("thread_access_denied", {
            agentId: binding.agent_id,
            detail: {
              channel: msg.channelName,
              thread_id: msg.threadId,
              binding_owner_user_id: String(binding.owner_user_id),
              attempted_by_user_id: String(msg.userId),
              attempted_by_user_name: msg.userName || null,
              message_sha256: messageSha256,
            },
          });
        } catch (err) {
          log(`[CHANNEL:${msg.channelName}] Audit log write failed (non-fatal): ${err.message}`);
        }
        return null;
      }

      // Override routing vers cet agent
      msg.targetAgentId = binding.agent_id;
      msg.conversationId = binding.conversation_id;

      // Touch activity (reset idle timer)
      await manager.touchActivity(msg.threadId);

      log(`[CHANNEL:${msg.channelName}] Message will be routed to agent ${binding.agent_id} (conversation: ${binding.conversation_id})`);
    }
  }

  // Fallback: if adapter set targetAgentId directly (e.g. WhatsApp agent groups)
  // but no thread binding exists, resolve the agent's conversation
  if (msg.targetAgentId && !msg.conversationId) {
    try {
      const { getOrCreateAgentConversation } = await import("../../db/queries/conversations.js");
      msg.conversationId = await getOrCreateAgentConversation(msg.targetAgentId);
      log(`[CHANNEL:${msg.channelName}] Resolved agent conversation for ${msg.targetAgentId}: ${msg.conversationId}`);
    } catch (err) {
      log(`[CHANNEL:${msg.channelName}] Failed to resolve agent conversation: ${err.message}, falling back to main`);
    }
  }

  // Check DM policy
  if (!msg.isGroup && !adapter.isUserAllowed(msg.userId)) {
    log(`[CHANNEL:${msg.channelName}] DM not allowed for user ${msg.userId}`);
    await adapter.send(msg.channelId, serverMsg().accessDenied);
    return null;
  }

  // Group mention gating: in groups, only respond when text contains bot name
  log(`[CHANNEL:${msg.channelName}] isGroup=${msg.isGroup}, groupMentionGating=${adapter.config.groupMentionGating}, targetAgentId=${msg.targetAgentId || 'none'}`);
  // Bypass the mention gate when:
  //   (a) the message lands in a thread that is explicitly bound to an agent
  //       (Telegram forum topic / Discord private channel / Slack private
  //       channel auto-created by createAgentXXX), or
  //   (b) the channel has a paired container (e.g. Telegram forum). In that
  //       case the forum IS the canonical surface — DMs are disabled — so
  //       every message in the forum is for Yabby, no @-mention required.
  let bypassMention = !!msg.targetAgentId;
  if (!bypassMention && msg.isGroup && adapter.config.groupMentionGating) {
    try {
      const container = await getChannelContainer(msg.channelName);
      if (container && String(container.container_id) === String(msg.channelId)) {
        bypassMention = true;
        log(`[CHANNEL:${msg.channelName}] Mention gate bypassed: paired forum container`);
      }
    } catch {}
  }
  if (msg.isGroup && adapter.config.groupMentionGating && !bypassMention) {
    const botName = adapter.config.botName || "yabby";
    const mentionPatterns = [
      `@${botName}`,
      botName.toLowerCase(),
    ];
    const textLower = msg.text.toLowerCase();
    log(`[CHANNEL:${msg.channelName}] Checking for bot mention: patterns=${JSON.stringify(mentionPatterns)}, text="${textLower}"`);
    if (!mentionPatterns.some(p => textLower.includes(p))) {
      log(`[CHANNEL:${msg.channelName}] No bot mention found, ignoring group message`);
      return null; // Ignore non-mentioned group messages
    }
  }

  // Check for commands
  const commandKey = msg.text.split(" ")[0].toLowerCase();
  if (COMMANDS[commandKey]) {
    try {
      await COMMANDS[commandKey](msg, adapter);
    } catch (err) {
      log(`[CHANNEL:${msg.channelName}] Command error:`, err.message);
      log(`[CHANNEL:${msg.channelName}] Stack:`, err.stack);
      await adapter.send(msg.channelId, `${serverMsg().errorPrefix}: ${err.message}`);
    }
    return null;
  }

  // Regular message → LLM response with retry
  return await handleWithRetry(msg, adapter);
}

async function handleWithRetry(msg, adapter) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await generateAndSendResponse(msg, adapter);
    } catch (err) {
      log(`[CHANNEL:${msg.channelName}] Attempt ${attempt + 1}/${MAX_RETRIES} failed:`, err.message);
      log(`[CHANNEL:${msg.channelName}] Error stack:`, err.stack);
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, RETRY_DELAY_BASE * (attempt + 1)));
        continue;
      }
      // Dead letter after all retries fail
      await insertDeadLetter(msg.channelName, msg.userId, msg.text, err.message, MAX_RETRIES);
      log(`[CHANNEL:${msg.channelName}] Dead letter: ${msg.userId}: ${err.message}`);
      await adapter.send(msg.channelId, serverMsg().sorry);
    }
  }
}

async function generateAndSendResponse(msg, adapter) {
  // Log differently for system notifications
  if (msg.isSystemNotification) {
    log(`[CHANNEL:${msg.channelName}] Processing system notification for ${msg.channelId}`);
  } else {
    log(`[CHANNEL:${msg.channelName}] Generating response for: "${msg.text.substring(0, 50)}..."`);
  }

  const provider = getDefaultProvider();
  if (!provider) {
    log(`[CHANNEL:${msg.channelName}] ERROR: No provider available`);
    throw new Error("No LLM provider configured");
  }

  log(`[CHANNEL:${msg.channelName}] Using provider: ${provider.name}`);

  // Use the main conversation (same as web voice) OR agent-specific conversation if bound
  const convId = msg.conversationId || DEFAULT_CONV_ID;
  log(`[CHANNEL:${msg.channelName}] Using conversation: ${convId}${msg.conversationId ? ' (agent-bound)' : ' (main)'}`);

  // Add message to main conversation
  // For system notifications, save the contextMessage (simplified version)
  let userTurnResult;
  if (!msg.isSystemNotification) {
    log(`[CHANNEL:${msg.channelName}] Saving user message to main conversation...`);
    userTurnResult = await addTurn("user", msg.text, convId, msg.channelName);
  } else {
    log(`[CHANNEL:${msg.channelName}] Saving context message for system notification...`);
    userTurnResult = await addTurn("user", msg.contextMessage || msg.text, convId, msg.channelName);
  }

  // Also save to channel-specific conversations (for Channels > Conversations UI)
  if (!msg.isSystemNotification && msg.channelName !== 'web') {
    try {
      const channelConv = await findOrCreateConversation(
        msg.channelName, msg.channelId, msg.userId, msg.userName, msg.isGroup
      );
      await addChannelMessage(channelConv.id, "user", msg.text, msg.platformMsgId);
      msg._channelConvId = channelConv.id; // Store for assistant reply
    } catch (err) {
      log(`[CHANNEL:${msg.channelName}] Channel conversation save error: ${err.message}`);
    }
  }

  // ✅ MICRO-FIX: Emit pub/sub for user messages (enables web→WhatsApp sync)
  const { emitConversationUpdate } = await import("../logger.js");
  await emitConversationUpdate(convId, userTurnResult.turnCount);

  // ✅ Voice-active bypass: when the user has Yabby's Realtime voice ACTIVE
  // on the webapp AND the message is for the MAIN conversation (not an
  // agent-bound thread), let Realtime handle the reply instead of running a
  // parallel gpt-5-mini channel response. The SSE conversation_update we
  // just emitted lands in voice.js → handleSSEConversationUpdate, which
  // injects the user turn into Realtime + triggers a response. The Realtime
  // reply is then forwarded to this channel by notification-listener.js.
  if (!msg.isSystemNotification && convId === DEFAULT_CONV_ID && !msg.targetAgentId) {
    try {
      const { redis, KEY } = await import("../../db/redis.js");
      const voiceActive = await redis.get(KEY("voice:active"));
      if (voiceActive === "1") {
        log(`[CHANNEL:${msg.channelName}] 🎤 Voice active — skipping channel LLM, Realtime will reply via SSE`);
        return null;
      }
    } catch (err) {
      log(`[CHANNEL:${msg.channelName}] voice:active check failed (continuing normally): ${err.message}`);
    }
  }

  // Fetch history, memory profile, and connectors in parallel (P1)
  const [conv, profile, connSummary] = await Promise.all([
    getConversation(convId, 35),  // Fetch last 30 turns + 5 buffer
    getMemoryProfile().catch(err => { log(`[CHANNEL:${msg.channelName}] Memory profile unavailable: ${err.message}`); return null; }),
    getConnectorSummary().catch(err => { log(`[CHANNEL:${msg.channelName}] Connector summary unavailable: ${err.message}`); return null; }),
  ]);
  const recentTurns = conv.turns.slice(-30);  // Increased from -12 to -30 for better context
  log(`[CHANNEL:${msg.channelName}] Loaded ${recentTurns.length} turns (from ${conv.turns.length} total)`);

  // INJECT MAIN CONVERSATION CONTEXT (if agent thread)
  if (msg.targetAgentId) {
    log(`[CHANNEL:${msg.channelName}] Agent thread detected, injecting main conversation context`);

    const DEFAULT_CONV_ID = "00000000-0000-0000-0000-000000000001";
    const mainConv = await getConversation(DEFAULT_CONV_ID, 15);  // Only need last 10 turns + buffer
    const mainContextTurns = mainConv.turns.slice(-10);

    if (mainContextTurns.length > 0) {
      const contextSummary = mainContextTurns
        .map(t => `${t.role === 'user' ? 'User' : 'Yabby'}: ${t.text}`)
        .join('\n');

      msg._mainConversationContext = contextSummary;
      log(`[CHANNEL:${msg.channelName}] Injected ${mainContextTurns.length} turns from main conversation`);
    }
  }

  // Find last assistant message + detect context reference
  const lastAssistantTurn = recentTurns.slice().reverse().find(t => t.role === 'assistant');
  const contextRefKeywords = /\b(plus court|résume|reformule|clarifie|condense|raccourci|simplifie|ce que tu (viens de|as) dit)\b/i;
  const userIsReferencingContext = contextRefKeywords.test(msg.text);

  if (userIsReferencingContext && lastAssistantTurn) {
    log(`[CHANNEL:${msg.channelName}] Context reference detected: "${msg.text}"`);
    log(`[CHANNEL:${msg.channelName}] Last assistant message: "${lastAssistantTurn.text.substring(0, 100)}..."`);
    msg._lastAssistantMessage = lastAssistantTurn.text;
    msg._isContextReference = true;
  }

  // Build system prompt: use agent's system_prompt if targetAgentId, else generic channel prompt
  const now = new Date().toLocaleString('fr-FR', { dateStyle: 'full', timeStyle: 'short' });
  const pf = getPromptFragments();
  let systemPrompt;

  if (msg.targetAgentId) {
    // Load agent and use its system prompt, prefixed with a runtime context
    // block (identity + current workspace + date) so LLM1 and its downstream
    // yabby_execute instructions reflect the agent's ACTUAL current workspace,
    // not what was stored when the agent was created.
    const { getAgent } = await import("../../db/queries/agents.js");
    const agent = await getAgent(msg.targetAgentId);
    if (agent && agent.systemPrompt) {
      // Resolve default workspace for this agent (the same logic spawner.js uses)
      let defaultWorkspace = null;
      try {
        const { getAgentWorkspacePath, getYabbyWorkspacePath, getSandboxPath } = await import("../sandbox.js");
        if (agent.isSuperAgent || agent.id === "yabby-000000") {
          defaultWorkspace = await getYabbyWorkspacePath();
        } else if (agent.projectId) {
          defaultWorkspace = await getSandboxPath(agent.projectId, agent.projectName);
        } else {
          defaultWorkspace = await getAgentWorkspacePath(agent.id, agent.name);
        }
      } catch (err) {
        log(`[CHANNEL:${msg.channelName}] Workspace resolution note: ${err.message}`);
      }

      const contextBlock = buildAgentContextBlock({
        name: agent.name,
        role: agent.role,
        agentId: agent.id,
        workspacePath: agent.workspacePath,
        defaultWorkspace,
      });
      systemPrompt = contextBlock + '\n' + agent.systemPrompt;
      log(`[CHANNEL:${msg.channelName}] Using agent ${agent.name} prompt (${systemPrompt.length} chars, workspace: ${agent.workspacePath || defaultWorkspace || 'unknown'})`);
    } else {
      log(`[CHANNEL:${msg.channelName}] WARNING: No system prompt for agent ${msg.targetAgentId}, using default`);
      systemPrompt = buildChannelInstructions(msg.channelName, now);
    }
  } else {
    systemPrompt = buildChannelInstructions(msg.channelName, now);
  }

  // Add memory profile (capped at 1500 chars)
  if (profile) {
    const cappedProfile = profile.length > 1500 ? profile.slice(0, 1500) + "\n..." : profile;
    systemPrompt += `\n\n${pf.userProfile}:\n${cappedProfile}`;
    log(`[CHANNEL:${msg.channelName}] Added memory profile (${cappedProfile.length} chars)`);
  }

  // Add connector summary
  if (connSummary) {
    systemPrompt += `\n\n${pf.connectors}:\n${connSummary}`;
    log(`[CHANNEL:${msg.channelName}] Added connector summary`);
  }

  // Inject recent tasks (like voice does)
  try {
    const tasksResp = await fetch(`http://localhost:${process.env.PORT || 3000}/api/tasks/recent?hours=1&limit=10`);
    if (tasksResp.ok) {
      const tasksData = await tasksResp.json();
      const runningTasks = (tasksData.tasks || []).filter(t =>
        t.status === 'running' || t.status === 'done' || t.status === 'paused'
      );

      if (runningTasks.length > 0) {
        const taskList = runningTasks
          .map(t => {
            const elapsed = Math.round((Date.now() - new Date(t.startTime).getTime()) / 1000);
            const timeStr = elapsed < 60 ? `${elapsed}s` : `${Math.round(elapsed / 60)}min`;
            const desc = t.title || 'Task';
            return `- ${t.id}: "${desc}" (${t.status}, il y a ${timeStr})`;
          })
          .join('\n');

        const m = serverMsg();
        const taskContext = `\n\n## ${m.recentTasks}\n\n${m.recentTasksIntro}\n${taskList}\n\n${m.recentTasksHint}`;
        systemPrompt += taskContext;
        log(`[CHANNEL:${msg.channelName}] Injected ${runningTasks.length} recent tasks`);
      }
    }
  } catch (err) {
    log(`[CHANNEL:${msg.channelName}] Failed to fetch recent tasks:`, err.message);
  }

  systemPrompt += `\n\nTu communiques actuellement via ${msg.channelName}. L'utilisateur s'appelle ${msg.userName}.`;
  log(`[CHANNEL:${msg.channelName}] System prompt length: ${systemPrompt.length} chars`);

  // Download inbound media attachments (if any)
  let inboundAssetIds = [];
  let inboundMediaRefs = [];
  if (msg.attachments && msg.attachments.length > 0) {
    try {
      const makeFetcher = (ref) => adapter.makeMediaFetcher(ref);
      inboundMediaRefs = await downloadAll(msg.attachments, makeFetcher, {
        source: msg.channelName,
        channelName: msg.channelName,
      });
      inboundAssetIds = inboundMediaRefs.map(r => r.assetId).filter(Boolean);
      log(`[CHANNEL:${msg.channelName}] Downloaded ${inboundAssetIds.length} inbound media attachments`);

      // Link inbound media to the user turn that was already saved
      if (inboundAssetIds.length > 0 && userTurnResult) {
        try {
          const { query: dbQuery } = await import("../../db/pg.js");
          // Get the most recent turn for this conversation
          const turnRes = await dbQuery(
            `SELECT id FROM conversation_turns WHERE conversation_id = $1 ORDER BY ts DESC LIMIT 1`,
            [convId]
          );
          if (turnRes.rows[0]) {
            for (let i = 0; i < inboundAssetIds.length; i++) {
              await dbQuery(
                `INSERT INTO turn_media (turn_id, asset_id, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
                [turnRes.rows[0].id, inboundAssetIds[i], i]
              );
            }
            log(`[CHANNEL:${msg.channelName}] Linked ${inboundAssetIds.length} media assets to turn ${turnRes.rows[0].id}`);
          }
        } catch (err) {
          log(`[CHANNEL:${msg.channelName}] Failed to link media to turn: ${err.message}`);
        }
      }
    } catch (err) {
      log(`[CHANNEL:${msg.channelName}] Inbound media download error: ${err.message}`);
    }
  }

  // Media intent detection — inject system hint if user likely wants media action
  let mediaIntentHint = "";
  if (msg.text && !msg.isSystemNotification) {
    try {
      const intent = await detectMediaIntent(msg.text);
      if (intent && intent.intent !== "none" && intent.confidence > 0.7) {
        mediaIntentHint = intentToToolHint(intent);
        log(`[CHANNEL:${msg.channelName}] Media intent detected: ${intent.intent} (${intent.confidence})`);
      }
    } catch (err) {
      log(`[CHANNEL:${msg.channelName}] Media intent detection error: ${err.message}`);
    }
  }

  // Get channel-relevant tools (excludes voice-only tools to save tokens)
  const rawTools = getToolsForChannel();
  // OpenAI expects: {type: "function", function: {name, description, parameters}}
  // Registry provides: {type: "function", name, description, parameters}
  const tools = rawTools
    .filter(t => t && t.name && t.description && t.parameters) // Validate tools
    .map(t => ({
      type: "function",
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters
      }
    }));
  log(`[CHANNEL:${msg.channelName}] Loaded ${tools.length} tools from registry (${rawTools.length} raw)`);

  // Build initial messages array
  const messages = [];

  // INJECT MAIN CONVERSATION CONTEXT (if available for agent threads)
  if (msg._mainConversationContext) {
    messages.push({
      role: 'system',
      content: `CONTEXTE DU CHAT PRINCIPAL YABBY (arrière-plan):

${msg._mainConversationContext}

───────────────────────────────────────────────
Les messages ci-dessous sont dans TON thread WhatsApp dédié.
Si l'utilisateur fait référence au contexte ci-dessus, utilise-le.
Si l'utilisateur dit "plus court" ou "résume", il parle de TON dernier message dans CE thread.
───────────────────────────────────────────────`
    });
    log(`[CHANNEL:${msg.channelName}] Injected main conversation context into messages (${msg._mainConversationContext.length} chars)`);
  }

  // Add system prompt
  messages.push({ role: "system", content: systemPrompt });

  // Add conversation turns (with multimodal content if media attached)
  messages.push(...recentTurns.map(t => ({ role: t.role, content: t.text })));

  // Inject media intent hint into system prompt
  if (mediaIntentHint) {
    messages.push({ role: "system", content: mediaIntentHint });
  }

  // Build multimodal user message if inbound attachments exist
  if (inboundMediaRefs.length > 0) {
    try {
      const providerInst = getDefaultProvider();
      const visionContent = await buildVisionParts(inboundMediaRefs, msg.text || "", providerInst.name);
      if (Array.isArray(visionContent) && visionContent.length > 0) {
        // Replace the last user turn with the multimodal content array
        const lastUserIdx = messages.length - 1;
        if (messages[lastUserIdx]?.role === "user") {
          messages[lastUserIdx].content = visionContent;
          log(`[CHANNEL:${msg.channelName}] Replaced user message with multimodal (${visionContent.length} parts)`);
        }
      }
    } catch (err) {
      log(`[CHANNEL:${msg.channelName}] Vision parts build error: ${err.message}`);
    }
  }

  // If it's a system notification, add it as a user message
  // The speaker will receive it and reformulate naturally
  if (msg.isSystemNotification) {
    messages.push({
      role: "user",
      content: msg.text
    });
    log(`[CHANNEL:${msg.channelName}] Added system notification to messages`);
  }

  // No pre-hoc forcing of yabby_execute. LLM 1 responds freely.
  // The post-hoc classifier (COUCHE 2 below) detects if the response claims an
  // action was launched and, if so, re-calls LLM 1 to reformulate the request
  // into a clean instruction that is then passed to yabby_execute server-side.
  const hasYabbyExecute = tools.some(t => t.function.name === 'yabby_execute');

  // Function calling loop
  let finalResponseText = null;
  let iterations = 0;
  const allToolCallsExecuted = [];
  const outboundMediaAssetIds = [];
  // Track spawn-tool outcomes so we can catch ghost "Launched" acks when the
  // underlying yabby_execute/yabby_intervention call actually failed.
  const spawnAttempts = []; // { name, ok, error, taskId }

  while (!finalResponseText && iterations < MAX_FUNCTION_CALL_ITERATIONS) {
    iterations++;
    log(`[CHANNEL:${msg.channelName}] Function calling iteration ${iterations}/${MAX_FUNCTION_CALL_ITERATIONS}`);

    // Prepare completion options
    const completeOpts = {
      tools,
      context: `channel:${msg.channelName}`,
      maxTokens: 2500,
      model: "gpt-5-mini"  // Explicit model for better logging
    };

    // Call LLM with tools
    const result = await provider.complete(messages, completeOpts);

    // Case 1: Got text response (no tool calls)
    if (result.text && !result.tool_calls) {
      finalResponseText = result.text;
      log(`[CHANNEL:${msg.channelName}] Got final text response (${result.text.length} chars)`);

      // Lightweight hallucination log: if the response claims an action
      // but no tool was called, we just log it (useful for debugging).
      // No retry — the prompt (buildStandaloneAgentPrompt / buildChannelInstructions)
      // instructs the LLM to write self-contained yabby_execute instructions
      // when it needs to launch an action, so this should be rare.
      const hadYabbyExecute = allToolCallsExecuted.some(tc => tc === 'yabby_execute');
      if (!hadYabbyExecute && hasYabbyExecute && !msg.isSystemNotification) {
        try {
          const claimsAction = await detectActionHallucination(finalResponseText);
          if (claimsAction) {
            log(`[CHANNEL:${msg.channelName}] ⚠️  HALLUCINATION — response claims action but no yabby_execute was called`);
            log(`[CHANNEL:${msg.channelName}]    Response: "${finalResponseText.substring(0, 120)}..."`);
          }
        } catch {}
      }

      break;
    }

    // Case 2: Got tool calls
    if (result.tool_calls && result.tool_calls.length > 0) {
      log(`[CHANNEL:${msg.channelName}] ════════════════════ TOOL CALLS ════════════════════`);
      log(`[CHANNEL:${msg.channelName}] 🔧 LLM wants to call ${result.tool_calls.length} tool(s):`);

      // Log all tool calls with their arguments — FULL content for debugging
      result.tool_calls.forEach((tc, idx) => {
        log(`[CHANNEL:${msg.channelName}]   ${idx + 1}. ${tc.function.name}`);
        try {
          const args = JSON.parse(tc.function.arguments);
          // Special highlight for yabby_execute so we can trace instruction enrichment
          if (tc.function.name === 'yabby_execute' && args.instruction) {
            log(`[CHANNEL:${msg.channelName}]      ▶ INSTRUCTION FROM LLM (${args.instruction.length} chars):`);
            log(`[CHANNEL:${msg.channelName}]      ┌─────────────────────────────────────────────`);
            args.instruction.split('\n').forEach(line => {
              log(`[CHANNEL:${msg.channelName}]      │ ${line}`);
            });
            log(`[CHANNEL:${msg.channelName}]      └─────────────────────────────────────────────`);
            // Also log other args if present (agent_id, etc.)
            const otherArgs = { ...args };
            delete otherArgs.instruction;
            if (Object.keys(otherArgs).length > 0) {
              log(`[CHANNEL:${msg.channelName}]      Other args: ${JSON.stringify(otherArgs)}`);
            }
          } else {
            log(`[CHANNEL:${msg.channelName}]      Arguments: ${JSON.stringify(args, null, 2).split('\n').join('\n      ')}`);
          }
        } catch (err) {
          log(`[CHANNEL:${msg.channelName}]      Arguments: ${tc.function.arguments} (invalid JSON)`);
        }
      });
      log(`[CHANNEL:${msg.channelName}] ═══════════════════════════════════════════════════════`);

      // ⚠️ DÉDUPLICATION: Détecter appels dupliqués dans la même réponse
      const seenToolCalls = new Map();  // key = toolName + JSON.stringify(args)
      const uniqueToolCalls = [];
      const skippedResults = [];  // Résultats pour les appels dupliqués

      for (const tc of result.tool_calls) {
        const key = `${tc.function.name}:${tc.function.arguments}`;

        if (seenToolCalls.has(key)) {
          log(`[CHANNEL:${msg.channelName}] ⚠️  Duplicate tool call detected: ${tc.function.name}, skipping`);
          // Créer un résultat "déjà exécuté" pour ce call_id
          skippedResults.push({
            id: tc.id,
            name: tc.function.name,
            output: JSON.stringify({
              skipped: true,
              reason: "Duplicate tool call detected in same response"
            })
          });
          continue;
        }

        seenToolCalls.set(key, tc.id);
        uniqueToolCalls.push(tc);
      }

      log(`[CHANNEL:${msg.channelName}] Executing ${uniqueToolCalls.length} unique tool calls (${result.tool_calls.length - uniqueToolCalls.length} duplicates skipped)`);

      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: result.text || null,
        tool_calls: result.tool_calls
      });

      // Execute all UNIQUE tool calls in parallel (P2)
      const toolResults = await Promise.all(uniqueToolCalls.map(async (toolCall) => {
        const { id, function: fn } = toolCall;
        const toolName = fn.name;
        let args;
        try {
          args = JSON.parse(fn.arguments);
        } catch (parseErr) {
          log(`[CHANNEL:${msg.channelName}] ❌ Tool ${toolName} - failed to parse arguments:`, parseErr.message);
          log(`[CHANNEL:${msg.channelName}]    Raw arguments: ${fn.arguments}`);
          args = {};
        }

        log(`[CHANNEL:${msg.channelName}] ⚙️  Executing tool: ${toolName} with args: ${JSON.stringify(args)}`);
        let toolOutput = "";
        try {
          toolOutput = await executeToolForChannel(toolName, args, msg);
          const outputPreview = toolOutput.length > 200 ? toolOutput.substring(0, 200) + "..." : toolOutput;
          let toolFailed = false;
          try {
            const probe = JSON.parse(toolOutput);
            if (probe && probe.error) toolFailed = true;
          } catch {}
          if (toolFailed) {
            log(`[CHANNEL:${msg.channelName}] ❌ Tool ${toolName} returned error. Output: ${outputPreview}`);
          } else {
            log(`[CHANNEL:${msg.channelName}] ✅ Tool ${toolName} succeeded. Output: ${outputPreview}`);
          }

          allToolCallsExecuted.push(toolName);

          // Extract media asset IDs from tool results for outbound dispatch
          try {
            const parsed = JSON.parse(toolOutput);
            if (parsed.assetId) outboundMediaAssetIds.push(parsed.assetId);
            if (Array.isArray(parsed.assets)) {
              parsed.assets.forEach(a => { if (a.assetId) outboundMediaAssetIds.push(a.assetId); });
            }
            // Track spawn-tool outcomes for ghost-ack detection
            if (toolName === 'yabby_execute' || toolName === 'yabby_intervention') {
              const taskId = parsed.task_id || parsed.queue_id || null;
              const ok = !parsed.error && (!!taskId || parsed.queued === true || parsed.status === 'running' || parsed.status === 'queued');
              spawnAttempts.push({ name: toolName, ok, error: parsed.error || null, taskId });
            }
          } catch {}
        } catch (err) {
          log(`[CHANNEL:${msg.channelName}] ❌ Tool ${toolName} FAILED:`, err.message);
          log(`[CHANNEL:${msg.channelName}]    Error stack:`, err.stack);
          toolOutput = JSON.stringify({ error: err.message });
          if (toolName === 'yabby_execute' || toolName === 'yabby_intervention') {
            spawnAttempts.push({ name: toolName, ok: false, error: err.message, taskId: null });
          }
        }
        return { id, name: toolName, output: toolOutput };
      }));

      // Merge executed results with skipped results
      const allResults = [...toolResults, ...skippedResults];

      // Add results to messages (preserving order)
      for (const { id, name, output } of allResults) {
        messages.push({ role: "tool", tool_call_id: id, name, content: output });
      }

      // Continue loop to get final response
      continue;
    }

    // Case 3: No text and no tool calls
    log(`[CHANNEL:${msg.channelName}] WARNING: No text or tool_calls in response`);
    break;
  }

  if (!finalResponseText) {
    throw new Error(`No final response after ${iterations} iterations`);
  }

  // Don't send empty responses, just dots, or explicit silence markers
  const trimmed = finalResponseText.trim();
  if (!trimmed || trimmed.length === 0 || /^\.+$/.test(trimmed) || /^\[silence\]$/i.test(trimmed)) {
    log(`[CHANNEL:${msg.channelName}] Empty or invalid response (${trimmed}), skipping send`);
    return null;
  }

  // Ghost-ack guard: if the LLM attempted a spawn tool but none succeeded, and
  // its reply reads like "launched/running/started", rewrite it as a failure
  // so the user doesn't think work is happening when the task never landed.
  if (spawnAttempts.length > 0 && spawnAttempts.every(s => !s.ok)) {
    const looksLikeAck = /\b(launched|lanc[ée]|running|en cours|started|on it|d[ée]marr[ée])\b/i.test(finalResponseText);
    if (looksLikeAck) {
      const lastErr = spawnAttempts.map(s => s.error).filter(Boolean).pop() || 'unknown error';
      log(`[CHANNEL:${msg.channelName}] 🚫 Ghost-ack blocked — spawn failed (${lastErr}); rewriting reply.`);
      finalResponseText = `Couldn't start the task — ${lastErr}. Please try again.`;
    }
  }

  log(`[CHANNEL:${msg.channelName}] Final response: ${finalResponseText.substring(0, 50)}...`);

  // Save assistant response to main conversation
  const result2 = await addTurn("assistant", finalResponseText, convId, msg.channelName);

  // Also save to channel-specific conversation
  if (msg._channelConvId) {
    try {
      await addChannelMessage(msg._channelConvId, "assistant", finalResponseText);
    } catch (err) {
      log(`[CHANNEL:${msg.channelName}] Channel conversation assistant save error: ${err.message}`);
    }
  }

  log(`[CHANNEL:${msg.channelName}] 🔍 DIAG 3 - Saved assistant response`);
  log(`[CHANNEL:${msg.channelName}]    - conversationId: ${convId}`);
  log(`[CHANNEL:${msg.channelName}]    - turnCount: ${result2.turnCount}`);
  log(`[CHANNEL:${msg.channelName}]    - targetAgentId: ${msg.targetAgentId || 'none'}`);

  // Trigger memory extraction every 6 turns
  if (result2.turnCount % 6 === 0) {
    log(`[CHANNEL:${msg.channelName}] Triggering memory extraction (turn ${result2.turnCount})`);
    getConversation(convId, 15).then(conv => {  // Only need last 10 turns + buffer
      const recentTurns = conv.turns.slice(-10);
      extractMemories(recentTurns).catch(err =>
        log(`[CHANNEL:${msg.channelName}] Memory extraction failed:`, err.message)
      );
    }).catch(err => {
      log(`[CHANNEL:${msg.channelName}] Failed to load conversation for memory extraction:`, err.message);
    });
  }

  // Notify frontend
  log(`[CHANNEL:${msg.channelName}] 🔍 DIAG 4 - Emitting conversation_update SSE`);
  emitConversationUpdate(convId, result2.turnCount);

  // Send to channel
  log(`[CHANNEL:${msg.channelName}] 🔍 DIAG 5 - Sending response to channel...`);
  log(`[CHANNEL:${msg.channelName}]    - channelId: ${msg.channelId || 'web (no channelId)'}`);
  log(`[CHANNEL:${msg.channelName}]    - isAudio: ${msg.isAudio || false}`);
  log(`[CHANNEL:${msg.channelName}]    - response length: ${finalResponseText.length} chars`);

  // Reply target: when the message came from a thread (Telegram forum topic,
  // Discord thread, Slack thread), we MUST reply inside the same thread.
  // For Telegram, msg.threadId is the composite "<chat>:<topic>" produced by
  // the adapter — its send() parses the colon and sets message_thread_id.
  // For other channels with no thread, msg.channelId is the chat itself.
  const replyTo = msg.threadId || msg.channelId;

  // Always send the text response first so the user has a readable trace in
  // the channel history (searchable, copy-pasteable, accessible).
  await adapter.send(replyTo, finalResponseText);
  log(`[CHANNEL:${msg.channelName}] ✓ Text response sent successfully`);

  // Send outbound media (images/screenshots/PDFs/videos from tool results).
  // Route per asset kind — previously every asset went through sendImage(),
  // which on Telegram maps to sendPhoto and silently rejects PDFs/videos.
  if (outboundMediaAssetIds.length > 0) {
    log(`[CHANNEL:${msg.channelName}] Dispatching ${outboundMediaAssetIds.length} outbound media assets`);
    const { head: mediaHead } = await import("../media/store.js");
    for (const assetId of outboundMediaAssetIds) {
      try {
        const meta = await mediaHead(assetId);
        const kind = meta?.row?.kind || "file";
        const mime = meta?.row?.mime || "";

        if (kind === "image") {
          await adapter.sendImage(replyTo, { assetId });
        } else if (kind === "video" && typeof adapter.sendVideo === "function") {
          await adapter.sendVideo(replyTo, { assetId });
        } else if (typeof adapter.sendDocument === "function") {
          // PDFs, docs, videos on channels without native sendVideo
          await adapter.sendDocument(replyTo, { assetId });
        } else {
          // Last resort: pretend it's an image. Will fail loud if the channel
          // can't handle it — better than silent drop.
          await adapter.sendImage(replyTo, { assetId });
        }
        log(`[CHANNEL:${msg.channelName}] ✓ Sent media ${assetId} (kind=${kind}, mime=${mime})`);
      } catch (err) {
        log(`[CHANNEL:${msg.channelName}] ⚠ Failed to send media ${assetId}: ${err.message}`);
      }
    }
  }

  // If original message was audio and adapter supports sendAudio, ALSO send
  // an audio version so the user gets both. The text arrives first (instant),
  // the audio follows once TTS finishes.
  if (msg.isAudio && adapter.sendAudio) {
    log(`[CHANNEL:${msg.channelName}] Original was audio, also generating audio response...`);
    try {
      const { speak } = await import("../tts/index.js");
      const ttsResult = await speak(finalResponseText, { provider: 'openai' });
      const audioBuffer = ttsResult?.audio || ttsResult;

      if (audioBuffer) {
        await adapter.sendAudio(msg.channelId, audioBuffer);
        log(`[CHANNEL:${msg.channelName}] ✓ Audio response also sent successfully`);
      } else {
        log(`[CHANNEL:${msg.channelName}] ⚠ Audio generation returned empty buffer (text already sent)`);
      }
    } catch (err) {
      log(`[CHANNEL:${msg.channelName}] Error generating audio (text already sent):`, err.message);
    }
  }

  // Return the response text (for web API endpoint)
  log(`[CHANNEL:${msg.channelName}] ✅ Returning response: "${finalResponseText.substring(0, 100)}..."`);
  return finalResponseText;
}

/**
 * Execute a tool call from a channel message.
 * Maps tool names to backend API endpoints or handlers.
 */
/**
 * Execute a tool call from a channel message.
 * Now uses the unified /api/tools/execute endpoint.
 */
async function executeToolForChannel(toolName, args, msg) {
  log(`[CHANNEL-TOOL] 🔧 Executing ${toolName} via unified endpoint`);
  log(`[CHANNEL-TOOL]    Args: ${JSON.stringify(args)}`);

  try {
    const res = await fetch(`http://localhost:${process.env.PORT || 3000}/api/tools/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        toolName,
        args,
        context: {
          source: 'channel',
          channel: msg?.channelName || 'whatsapp',
          channelId: msg?.channelId || null,
          // Thread binding wins; fall back to Yabby super agent for unbound DMs / group chats.
          agentId: msg?.targetAgentId || 'yabby-000000',
          conversationId: msg?.conversationId || null,
          // Capture the real user utterance so start_task can persist it in speaker_metadata.
          lastUserMessage: msg?.text || msg?.content || '',
          // Per-user platform locale hint so the CLI agent replies in the same language
          // the user messaged in, instead of defaulting to the server-wide config.
          userLang: msg?.userLang || null,
        }
      })
    });

    const data = await res.json();

    if (data.error) {
      throw new Error(data.error);
    }

    log(`[CHANNEL-TOOL] ✅ Tool ${toolName} succeeded`);
    return JSON.stringify(data);

  } catch (err) {
    log(`[CHANNEL-TOOL] ❌ Tool ${toolName} failed:`, err.message);
    return JSON.stringify({
      error: err.message
    });
  }
}

// ── Commands ──

async function handleStatusCommand(msg, adapter) {
  try {
    const port = process.env.PORT || 3000;
    const base = `http://localhost:${port}`;

    // Fetch tasks
    const res = await fetch(`${base}/api/tasks`);
    const data = await res.json();
    const tasks = data.tasks || [];

    const running = tasks.filter(t => t.status === "running");
    const paused = tasks.filter(t => t.status === "paused" || t.status === "paused_llm_limit");
    const doneCount = tasks.filter(t => t.status === "done").length;
    const errorCount = tasks.filter(t => t.status === "error").length;

    const lines = [];
    const m = serverMsg();
    lines.push(`📊 *Yabby Status*`);
    lines.push(m.statusSummary(running.length, paused.length, doneCount, errorCount));
    lines.push('');

    // Current running tasks
    if (running.length > 0) {
      lines.push(m.runningTasksHeader);
      for (const t of running.slice(0, 5)) {
        const id = t.id?.slice(0, 8) || '?';
        const title = (t.title || '').slice(0, 60) || id;
        const elapsed = t.elapsed ? formatElapsed(t.elapsed) : '-';
        const agent = t.agent_id ? t.agent_id.slice(0, 8) : '-';
        lines.push(`  • [${id}] ${title}`);
        lines.push(`    Agent: ${agent} · ${m.durationLabel}: ${elapsed}`);

        // Fetch last log lines
        try {
          const logRes = await fetch(`${base}/api/tasks/${t.id}/log?limit=5`);
          const logData = await logRes.json();
          const logLines = logData.lines || logData.log || [];
          if (logLines.length > 0) {
            const last = logLines.slice(-3).map(l =>
              (typeof l === 'string' ? l : l.text || '').slice(0, 80)
            ).filter(Boolean);
            if (last.length > 0) {
              lines.push(`    ${m.lastLogs}`);
              last.forEach(l => lines.push(`    > ${l}`));
            }
          }
        } catch {}
      }
      lines.push('');
    }

    // Paused tasks
    if (paused.length > 0) {
      lines.push(m.pausedHeader);
      for (const t of paused.slice(0, 3)) {
        const id = t.id?.slice(0, 8) || '?';
        const title = (t.title || '').slice(0, 60) || id;
        const reason = t.status === 'paused_llm_limit' ? m.llmLimitLabel : '';
        lines.push(`  • [${id}] ${title} ${reason}`);
      }
      lines.push('');
    }

    // Queue for agents with running tasks
    for (const t of running.slice(0, 3)) {
      if (!t.agent_id) continue;
      try {
        const qRes = await fetch(`${base}/api/agents/${t.agent_id}/queue`);
        const qData = await qRes.json();
        const qLen = qData.queue_length || 0;
        if (qLen > 0) {
          const agentName = qData.agent_name || t.agent_id.slice(0, 8);
          lines.push(m.queueStatus(agentName, qLen));
          (qData.queued_tasks || []).slice(0, 5).forEach((q, i) => {
            const qTitle = (q.title || q.instruction || '').slice(0, 60);
            lines.push(`  ${i + 1}. ${qTitle}`);
          });
          lines.push('');
        }
      } catch {}
    }

    if (running.length === 0 && paused.length === 0) {
      lines.push(m.noRunningTasks);
    }

    await adapter.send(msg.channelId, lines.join('\n'));
  } catch (err) {
    await adapter.send(msg.channelId, `${serverMsg().errorPrefix}: ${err.message}`);
  }
}

function formatElapsed(seconds) {
  if (!seconds || seconds < 0) return '-';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m${s.toString().padStart(2, '0')}s`;
  return `${s}s`;
}

async function handleNewCommand(msg, adapter) {
  const conversation = await findOrCreateConversation(
    msg.channelName, msg.channelId, msg.userId, msg.userName, msg.isGroup
  );
  // Actually clear message history so next interaction starts fresh
  await clearConversationMessages(conversation.id);
  await adapter.send(msg.channelId, serverMsg().newConversation);
}

async function handleHelpCommand(msg, adapter) {
  await adapter.send(msg.channelId, serverMsg().helpText);
}

async function handleScreenshotCommand(msg, adapter) {
  const m = serverMsg();
  const url = msg.text.replace(/^\/screenshot\s*/i, "").trim();
  if (!url || !url.startsWith("http")) {
    await adapter.send(msg.channelId, m.screenshotCommand);
    return;
  }
  try {
    const { default: webScreenshot } = await import("../tools/web-screenshot.js");
    const result = await webScreenshot({ url });
    if (result.assetId) {
      await adapter.sendImage(msg.channelId, { assetId: result.assetId, caption: url });
    } else {
      await adapter.send(msg.channelId, result.error || m.screenshotFailed);
    }
  } catch (err) {
    await adapter.send(msg.channelId, `${m.errorPrefix}: ${err.message}`);
  }
}

async function handleSearchCommand(msg, adapter) {
  const m = serverMsg();
  const query = msg.text.replace(/^\/search\s*/i, "").trim();
  if (!query) {
    await adapter.send(msg.channelId, m.searchCommand);
    return;
  }
  try {
    const { default: searchImages } = await import("../tools/search-images.js");
    const result = await searchImages({ query, count: 4 });
    if (result.assets && result.assets.length > 0) {
      for (const asset of result.assets) {
        await adapter.sendImage(msg.channelId, { assetId: asset.assetId, caption: asset.sourceUrl || "" });
      }
    } else {
      await adapter.send(msg.channelId, result.error || m.noImagesFound);
    }
  } catch (err) {
    await adapter.send(msg.channelId, `${m.errorPrefix}: ${err.message}`);
  }
}

async function handleImageCommand(msg, adapter) {
  const m = serverMsg();
  const prompt = msg.text.replace(/^\/image\s*/i, "").trim();
  if (!prompt) {
    await adapter.send(msg.channelId, m.imageCommand);
    return;
  }
  try {
    const { default: generateImage } = await import("../tools/generate-image.js");
    const result = await generateImage({ prompt });
    if (result.assetId) {
      await adapter.sendImage(msg.channelId, { assetId: result.assetId, caption: prompt });
    } else {
      await adapter.send(msg.channelId, result.error || m.imageGenerationFailed);
    }
  } catch (err) {
    await adapter.send(msg.channelId, `${m.errorPrefix}: ${err.message}`);
  }
}
