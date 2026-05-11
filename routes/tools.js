/* ═══════════════════════════════════════════════════════
   Generic Tool Executor
   ═══════════════════════════════════════════════════════
   Unified endpoint for tool execution across voice + channels.
   Dispatches tool calls to appropriate backend APIs.
*/

import { Router } from "express";
import { log } from "../lib/logger.js";
import { serverMsg, getServerLanguage } from "../lib/i18n.js";
import { getAgent, findAgentByName, getActiveTaskId } from "../db/queries/agents.js";
import { findProjectByName } from "../db/queries/projects.js";
import { getLatestTaskForAgent } from "../db/queries/tasks.js";
import { getSuggestionsForTool, formatSuggestions } from "../lib/tool-suggestions.js";
import { getAllTools, getBaseTools, getPluginTools, getMcpTools } from "../lib/plugins/tool-registry.js";

const router = Router();

// Voice-only tools (blocked for channels)
const VOICE_ONLY_TOOLS = new Set(['switch_to_agent', 'back_to_yabby', 'sleep_mode']);

/**
 * Dispatch a media asset to an agent's WhatsApp group (if connected).
 * Called by media tools (send_media, web_screenshot, etc.) so CLI agents
 * get immediate delivery without waiting for task completion.
 * Non-fatal — silently skips if WhatsApp is down or agent has no group.
 */
/**
 * Resolve all channels an agent is reachable on.
 * Returns [{ channelName, chatId }] from both WhatsApp groups and thread bindings.
 */
async function resolveAgentChannels(agentId) {
  const channels = [];
  try {
    // WhatsApp: dedicated agent groups
    const { getAgentWhatsAppGroup } = await import("../db/queries/agent-whatsapp-groups.js");
    const { getChannel } = await import("../lib/channels/index.js");
    const waGroup = await getAgentWhatsAppGroup(agentId);
    if (waGroup?.group_id) {
      channels.push({ channelName: "whatsapp", chatId: waGroup.group_id });
    } else if (agentId === "yabby-000000") {
      const wa = getChannel("whatsapp");
      if (wa?._yabbyGroupId) channels.push({ channelName: "whatsapp", chatId: wa._yabbyGroupId });
    }

    // All channels: thread bindings (Telegram, Discord, Slack, Signal, etc.)
    const { getThreadManager } = await import("../lib/channels/thread-binding-manager.js");
    // Use any manager instance — getAllByAgentId queries globally (no channel filter)
    const manager = getThreadManager("_global", "main");
    const bindings = await manager.getAllByAgentId(agentId);
    for (const b of bindings) {
      // Don't duplicate WhatsApp if already added above
      if (b.channel_name === "whatsapp" && channels.some(c => c.channelName === "whatsapp")) continue;
      channels.push({ channelName: b.channel_name, chatId: b.thread_id });
    }
  } catch (err) {
    log(`[TOOL-MEDIA] resolveAgentChannels error: ${err.message}`);
  }
  return channels;
}

function dispatchMediaToAgent(assetId, mime, context) {
  // Fire-and-forget: the asset is stored synchronously by the caller; channel
  // delivery (which can block on a hung Baileys/Telegram/Slack send) runs
  // detached so the HTTP response returns immediately with the assetId.
  // Errors are still logged via the inner try/catch; they just don't propagate.
  if (!assetId) return;
  (async () => {
    try {
      const agentId = context?.agentId || context?.targetAgentId || "yabby-000000";
      log(`[TOOL-MEDIA] Dispatching ${assetId} (${mime || 'unknown'}) for agent ${agentId}`);

      const agentChannels = await resolveAgentChannels(agentId);
      if (agentChannels.length === 0) {
        log(`[TOOL-MEDIA] No channels found for agent ${agentId}, skipping`);
        return;
      }

      const { getChannel } = await import("../lib/channels/index.js");
      const isGif = mime === "image/gif";
      const isImage = mime && mime.startsWith("image/") && !isGif;
      const isVideo = mime && mime.startsWith("video/");

      for (const { channelName, chatId } of agentChannels) {
        try {
          const adapter = getChannel(channelName);
          if (!adapter?.running) {
            log(`[TOOL-MEDIA] ${channelName} not running, skipping`);
            continue;
          }
          if (isGif && typeof adapter.sendAnimation === "function") {
            await adapter.sendAnimation(chatId, { assetId });
          } else if (isVideo && typeof adapter.sendVideo === "function") {
            await adapter.sendVideo(chatId, { assetId });
          } else if (isImage) {
            await adapter.sendImage(chatId, { assetId });
          } else {
            await adapter.sendDocument(chatId, { assetId });
          }
          log(`[TOOL-MEDIA] ✅ Sent ${assetId} to ${channelName}:${chatId}`);
        } catch (err) {
          log(`[TOOL-MEDIA] ⚠ Failed on ${channelName}: ${err.message}`);
        }
      }
    } catch (err) {
      log(`[TOOL-MEDIA] ⚠ dispatchMediaToAgent error: ${err.message}`);
    }
  })();
}

// Yabby super-agent — default scope when no agent is explicitly in context
const YABBY_ID = 'yabby-000000';

/**
 * Auto-reminder prepended to EVERY yabby_execute / yabby_intervention
 * instruction before it reaches the CLI super-agent.
 *
 * The reminder:
 *   1. Reaffirms the CLI's full capability surface so it doesn't under-deliver
 *      (it might otherwise assume it can only do bash + files, and miss that it
 *      can orchestrate projects, agents, connectors, scheduled tasks, etc.)
 *   2. Points to GET /api/tools/list as the authoritative discovery endpoint.
 *   3. Reminds it that voice/channels have only 3 tools — the CLI is the one
 *      expected to carry out the real work.
 *
 * Placed inside the instruction (not the system prompt) so it's visible on
 * EVERY invocation, not just on first spawn.
 */
// Identity-agnostic capability block — same for every CLI agent.
// Lists what the agent runtime CAN do (Mac access, tool catalog, files) so
// the LLM doesn't underestimate its surface. Identity-specific framing
// (super-agent vs project lead vs sub-agent) is added by buildReminder().
const CAPABILITY_BLOCK = `WHAT YOU CAN DO
• Mac actions: files, scripts (bash/python/node/AppleScript), app control, web (Playwright/APIs), media (ffmpeg/OCR/transcription), productivity (Mail/Calendar/Notes/Spotify), data (CSV/JSON/Excel), dev (git/tests/deploy).
• Introspection: GET /api/tasks/recent, /api/tasks/{id}, /api/tasks/llm-limit, /api/agents, /api/projects.
• Connectors: GET /api/connectors (MCP servers already mounted in .mcp.json).

TOOL DISCOVERY — MANDATORY FIRST STEP
Before attempting ANY tool you haven't used before: curl -s "http://localhost:${process.env.PORT || 3000}/api/tools/list?format=summary" | jq .
This is the ONLY authoritative catalog. NEVER guess tool names or parameters. If a tool doesn't appear in this list, it doesn't exist.
All tools are callable via POST /api/tools/execute. Always include "context": {"agentId": "YOUR_AGENT_ID"} for media tools so files are delivered to your channel.

USER FILES: Files sent by users (images, PDFs, docs) are stored automatically. Use get_channel_files to find them — it returns local paths you can read/process directly.`;

// Identity preamble for the Yabby super-agent: it owns project / standalone-
// agent creation. Project leads and sub-agents do NOT — those belong to their
// own bounded scope.
const YABBY_IDENTITY = `You are the persistent Yabby CLI super-agent. Voice/chat/WhatsApp only expose yabby_execute + yabby_intervention (+ sleep_mode for voice) — EVERY real action lands on you.

YABBY-SPECIFIC ACTIONS
• Projects: POST /api/tools/execute with toolName=create_project. This is a ONE-CALL flow: the server creates the project, spins up the lead agent (auto-generated first name if needed), and enqueues a Phase 1 task for the lead. The lead then runs discovery / planning on its own. DO NOT call talk_to_agent / assign_agent afterwards — everything is automatic. Just report to the user in one sentence and stop.
• Standalone agents (recurring/specialized work): assign_agent + talk_to_agent.
• Workflow replies: /api/project-questions, /api/plan-reviews, /api/presentations.`;

function buildAgentIdentity(agent) {
  // agent: { id, name, role, isLead, projectId, projectName? }
  const name = agent?.name || "this agent";
  const role = agent?.role ? ` — ${agent.role}` : "";
  if (agent?.isLead) {
    const projHint = agent?.projectName ? ` of project "${agent.projectName}"` : agent?.projectId ? ` (project ${agent.projectId})` : "";
    return `You are ${name}${role}, the LEAD${projHint}. Stay strictly within your project's scope: create / coordinate / instruct sub-agents that you've spawned, deliver the milestones from your approved plan. Do NOT create new top-level projects, do NOT touch other projects' agents.`;
  }
  if (agent?.projectId) {
    return `You are ${name}${role}, a sub-agent assigned to a project. Stay strictly within the scope of the task you were given by your superior. Report progress / completion to your superior; do NOT create new agents or touch other projects.`;
  }
  return `You are ${name}${role}, a standalone agent. Stay strictly within your declared role; deliver what the user asks within that scope.`;
}

const LANG_NAMES = { en: 'English', fr: 'French', es: 'Spanish', de: 'German', it: 'Italian', pt: 'Portuguese' };

function buildReminder(identity, mode, userLang) {
  const header = mode === 'intervention'
    ? `[CLI REMINDER — MID-TASK INTERVENTION — re-read before acting]`
    : `[CLI REMINDER — re-read before acting]`;

  // Server-configured language wins over the per-user platform hint so all
  // system-generated reports (task complete, status, etc.) match the locale
  // the operator picked in settings. Only fall back to the Telegram/WhatsApp
  // client's advertised language_code when the server language is unset.
  let serverLang = null;
  try { serverLang = getServerLanguage(); } catch { serverLang = null; }
  const effectiveLang = serverLang || userLang || null;
  let langBlock = '';
  if (effectiveLang) {
    const base = String(effectiveLang).toLowerCase().split('-')[0];
    const name = LANG_NAMES[base] || base.toUpperCase();
    langBlock = `\n[USER LOCALE] Reply to the user in ${name} only. Do not mix languages. Progress updates, final reports, and any user-facing text must be in ${name}.\n`;
  }

  return `${header}\n${identity}\n\n${CAPABILITY_BLOCK}\n${langBlock}\n=== USER INSTRUCTION ===\n`;
}

/**
 * Wrap the user instruction with a CLI reminder tailored to the target agent.
 *
 * - When targetAgentId is the Yabby super-agent (or null/undefined), the
 *   reminder uses the YABBY identity preamble (mentions project creation,
 *   standalone-agent assignment, etc.).
 * - Otherwise, looks up the agent and emits an identity-aware preamble:
 *   project lead, sub-agent, or standalone — each with their own scope rules.
 * - Capability + tool-discovery + locale blocks are identical in both cases.
 *
 * Async because the agent identity is resolved from DB.
 */
async function wrapWithCliReminder(instruction, mode, userLang = null, targetAgentId = null) {
  let identity;
  if (!targetAgentId || targetAgentId === 'yabby-000000') {
    identity = YABBY_IDENTITY;
  } else {
    let agent = null;
    try { agent = await getAgent(targetAgentId); } catch { agent = null; }
    identity = buildAgentIdentity(agent || { id: targetAgentId });
  }
  return `${buildReminder(identity, mode, userLang)}${instruction || ''}`;
}

/**
 * Resolve the agent this task-tool call should target.
 * Priority: explicit args.agent_id → switched voice/channel agent → Yabby.
 */
function resolveAgentScope(args, context) {
  return args.agent_id || context.agentId || YABBY_ID;
}

/**
 * Resolve the task this tool call should act on.
 * Priority: explicit args.task_id → agent's active task → agent's latest non-archived task.
 * Used for continue/get_task_detail/get_task_logs. NOT for pause/kill (which use active only).
 */
async function resolveTaskId(args, agentId) {
  if (args.task_id) return args.task_id;
  const active = await getActiveTaskId(agentId);
  if (active) return active;
  const latest = await getLatestTaskForAgent(agentId);
  return latest?.id || null;
}

/**
 * Generic tool executor
 * POST /api/tools/execute
 * Body: { toolName, args, context: { source: 'voice'|'channel', channel?: 'whatsapp' } }
 */
router.post("/api/tools/execute", async (req, res) => {
  const { toolName, tool, args, params, context } = req.body;
  const resolvedTool = toolName || tool;
  const resolvedArgs = args ?? params ?? {};

  if (!resolvedTool) {
    return res.status(400).json({ error: "toolName is required" });
  }

  const source = context?.source || 'unknown';
  log(`[TOOL-EXECUTOR] ${resolvedTool} called from ${source}${context?.channel ? ':' + context.channel : ''}`);

  try {
    const result = await dispatchTool(resolvedTool, resolvedArgs, context || {});
    res.json(result);
  } catch (err) {
    log(`[TOOL-EXECUTOR] Error executing ${resolvedTool}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/tools/list
 * Returns the full catalog of tools available to the Yabby CLI super-agent
 * (base + plugin + MCP). The CLI agent can curl this endpoint to discover
 * its own capabilities without needing them all in the system prompt.
 *
 * Query params:
 *   - category: 'base' | 'plugin' | 'mcp' | 'all' (default: all)
 *   - format:   'full' (default, OpenAI schema) | 'summary' (name + description only)
 */
router.get("/api/tools/list", (req, res) => {
  const category = req.query.category || 'all';
  const format = req.query.format || 'summary';

  let tools;
  switch (category) {
    case 'base':   tools = getBaseTools(); break;
    case 'plugin': tools = getPluginTools(); break;
    case 'mcp':    tools = getMcpTools(); break;
    default:       tools = getAllTools();
  }

  if (format === 'summary') {
    tools = tools.map(t => ({
      name: t.name,
      description: t.description,
      required: t.parameters?.required || [],
    }));
  }

  res.json({
    count: tools.length,
    category,
    format,
    tools,
  });
});

/**
 * Helper: Enrich the result with contextual suggestions
 */
function enrichWithSuggestions(result, toolName) {
  const suggestions = getSuggestionsForTool(toolName);
  if (suggestions) {
    const formatted = formatSuggestions(suggestions);
    if (formatted) {
      // Add suggestions to the result
      if (typeof result === 'object' && result !== null) {
        result._suggestions = formatted;
      }
    }
  }
  return result;
}

/**
 * Resolve a `project_name_or_id` argument to a real project id.
 * Returns null if no match (caller decides whether to throw or surface a friendly error).
 */
async function resolveProjectId(nameOrId) {
  if (!nameOrId) return null;
  // 12-char id with no spaces is treated as already resolved.
  if (typeof nameOrId === 'string' && nameOrId.length === 12 && !nameOrId.includes(' ')) {
    return nameOrId;
  }
  const project = await findProjectByName(nameOrId);
  return project ? project.id : null;
}

/**
 * Dispatch tool to appropriate backend API
 */
async function dispatchTool(toolName, args, context) {
  // Block voice-only tools for channels
  if (VOICE_ONLY_TOOLS.has(toolName) && context.source !== 'voice') {
    throw new Error(`Tool ${toolName} is only available in voice mode`);
  }

  // ── Task Tools ──
  // All task tools auto-scope to Yabby (yabby-000000) unless an explicit
  // agent_id/context.agentId tells them otherwise. See floofy-wobbling-harp plan.
  if (toolName === 'start_task') {
    const agentId = resolveAgentScope(args, context);
    // Accept task | instruction | input — LLM is inconsistent about arg name
    const taskText = args.task || args.instruction || args.input || '';
    if (!taskText) {
      throw new Error('start_task: missing task/instruction');
    }

    const utterance = String(context.lastUserMessage || taskText).slice(0, 500);

    const result = await fetchJSON('http://localhost:3000/api/tasks/start', 'POST', {
      task: taskText,
      agent_id: agentId,
      project_id: args.project_id,
      conversation_id: context.conversationId || null,
      created_by_speaker: true,
      speaker_metadata: {
        utterance,
        timestamp: new Date().toISOString(),
        channel: context.source || 'voice',
      },
    });
    return enrichWithSuggestions(result, toolName);
  }

  if (toolName === 'check_tasks') {
    return await fetchJSON('http://localhost:3000/api/tasks/check', 'POST', {
      task_ids: args.task_ids || []
    });
  }

  if (toolName === 'continue_task') {
    const agentId = resolveAgentScope(args, context);
    const taskId = await resolveTaskId(args, agentId);
    if (!taskId) {
      return {
        error: `No task to continue for ${agentId === YABBY_ID ? 'Yabby' : agentId}.`
      };
    }
    const taskText = args.task || args.instruction || args.input || '';
    if (!taskText) {
      throw new Error('continue_task: missing task/instruction');
    }
    return await fetchJSON('http://localhost:3000/api/tasks/continue', 'POST', {
      task_id: taskId,
      task: taskText,
    });
  }

  if (toolName === 'pause_task') {
    const agentId = resolveAgentScope(args, context);
    const taskId = args.task_id || await getActiveTaskId(agentId);
    if (!taskId) {
      return { error: 'No active task to pause.' };
    }
    return await fetchJSON('http://localhost:3000/api/tasks/pause', 'POST', {
      task_id: taskId
    });
  }

  if (toolName === 'kill_task') {
    const agentId = resolveAgentScope(args, context);
    const taskId = args.task_id || await getActiveTaskId(agentId);
    if (!taskId) {
      return { error: 'No active task to stop.' };
    }
    return await fetchJSON('http://localhost:3000/api/tasks/kill', 'POST', {
      task_id: taskId
    });
  }

  if (toolName === 'yabby_status') {
    log(`[TOOL-EXECUTOR] 📊 yabby_status called`);
    const port = process.env.PORT || 3000;
    const base = `http://localhost:${port}`;
    const targetAgentId = context.agentId || 'yabby-000000';

    try {
      // Find the running task for THIS agent
      const tasksRes = await fetchJSON(`${base}/api/tasks`, 'GET');
      const tasks = tasksRes.tasks || [];
      const agentTask = tasks.find(t => t.agent_id === targetAgentId && t.status === 'running');

      if (!agentTask) {
        return { status: 'idle', message: 'No running task for this agent.', queue: [] };
      }

      // Build task info
      const result = {
        task: {
          id: agentTask.id?.slice(0, 8),
          title: (agentTask.title || '').slice(0, 100),
          agent_id: agentTask.agent_id,
          elapsed: agentTask.elapsed || 0,
          status: agentTask.status,
        },
        queue: [],
      };

      // Last 10 log lines
      try {
        const logRes = await fetchJSON(`${base}/api/tasks/${agentTask.id}/log?limit=10`, 'GET');
        const lines = logRes.lines || logRes.log || [];
        result.task.last_logs = lines.slice(-10).map(l =>
          (typeof l === 'string' ? l : l.text || '').slice(0, 120)
        ).filter(Boolean);
      } catch { result.task.last_logs = []; }

      // Queue for this agent
      try {
        const qRes = await fetchJSON(`${base}/api/agents/${targetAgentId}/queue`, 'GET');
        result.queue = (qRes.queued_tasks || []).map((q, i) => ({
          id: q.id,
          title: (q.title || q.instruction || '').slice(0, 80),
          position: i + 1,
        }));
      } catch {}

      return result;
    } catch (err) {
      return { error: err.message };
    }
  }

  if (toolName === 'yabby_execute') {
    // Route to agent's persistent queue (context.agentId for agent threads, or Yabby by default)
    const targetAgentId = context.agentId || 'yabby-000000';
    const agentName = context.agentId ? `agent ${context.agentId}` : 'Yabby super agent';
    log(`[TOOL-EXECUTOR] 🔍 yabby_execute called`);
    log(`[TOOL-EXECUTOR]    - context.agentId: ${context.agentId || 'undefined'}`);
    log(`[TOOL-EXECUTOR]    - targetAgentId: ${targetAgentId}`);
    log(`[TOOL-EXECUTOR]    - instruction: "${args.instruction.substring(0, 100)}..."`);
    log(`[TOOL-EXECUTOR]    - Routing to: ${agentName} queue`);
    return await fetchJSON('http://localhost:3000/claude/start', 'POST', {
      task: await wrapWithCliReminder(args.instruction, 'execute', context.userLang, targetAgentId),
      agent_id: targetAgentId,
      origin_channel: context.source === 'channel' ? context.channel : null,
      origin_channel_id: context.source === 'channel' ? context.channelId : null,
    });
  }

  if (toolName === 'yabby_intervention') {
    // Pause the agent's running task and resume it with a new instruction (atomic).
    // Graceful fallback: if no task is active, silently degrade to yabby_execute
    // (start a fresh task) and return a hint so the model learns the distinction
    // for next time instead of failing with a 500.
    //
    // Resolve the target agent: voice LLM sometimes passes a task ID or garbage
    // string instead of a real agent ID. We try to resolve, then fall back to Yabby.
    let targetAgentId = 'yabby-000000';
    const rawTarget = args.agent_id || context.agentId || 'yabby-000000';
    if (rawTarget !== 'yabby-000000') {
      let resolved = await getAgent(rawTarget);
      if (!resolved) resolved = await findAgentByName(rawTarget);
      targetAgentId = resolved ? resolved.id : 'yabby-000000';
    }
    log(`[TOOL-EXECUTOR] 🎯 yabby_intervention called`);
    log(`[TOOL-EXECUTOR]    - targetAgentId: ${targetAgentId} (raw: ${rawTarget})`);
    log(`[TOOL-EXECUTOR]    - instruction: "${(args.instruction || '').substring(0, 100)}..."`);

    const activeTaskId = await getActiveTaskId(targetAgentId);
    if (!activeTaskId) {
      log(`[TOOL-EXECUTOR]    ⚠ No active task for ${targetAgentId} — falling back to yabby_execute`);
      const result = await fetchJSON('http://localhost:3000/claude/start', 'POST', {
        task: await wrapWithCliReminder(args.instruction, 'execute', context.userLang, targetAgentId),
        agent_id: targetAgentId,
      });
      // Preserve whatever task start endpoint returned (task_id, status, etc.) and add
      // an explicit hint so the model self-corrects on the next turn.
      return {
        ...(result || {}),
        fallback_applied: true,
        notice: `No task was running, so this was started as a fresh task via yabby_execute. Next time, use yabby_intervention ONLY when a task is actively running; otherwise use yabby_execute directly.`,
      };
    }

    return await fetchJSON('http://localhost:3000/api/tasks/intervene', 'POST', {
      agent_id: targetAgentId,
      instruction: await wrapWithCliReminder(args.instruction, 'intervention', context.userLang, targetAgentId),
    });
  }

  if (toolName === 'get_task_detail') {
    const agentId = resolveAgentScope(args, context);
    const taskId = await resolveTaskId(args, agentId);
    if (!taskId) {
      return { error: 'No task to inspect.' };
    }
    return await fetchJSON(`http://localhost:3000/api/tasks/${taskId}`, 'GET');
  }

  if (toolName === 'search_tasks') {
    const params = new URLSearchParams();
    if (args.query) params.append('q', args.query);
    if (args.status) params.append('status', args.status);
    if (args.project_id) params.append('project', args.project_id);
    if (args.agent_id) params.append('agent', args.agent_id);
    if (args.limit) params.append('limit', args.limit);

    return await fetchJSON(`http://localhost:3000/api/tasks/search?${params}`, 'GET');
  }

  if (toolName === 'list_recent_tasks') {
    const params = new URLSearchParams();
    params.append('hours', args.hours || 24);
    if (args.status) params.append('status', args.status);
    if (args.project_id) params.append('project', args.project_id);
    if (args.limit) params.append('limit', args.limit);

    return await fetchJSON(`http://localhost:3000/api/tasks/recent?${params}`, 'GET');
  }

  if (toolName === 'get_task_stats') {
    const params = new URLSearchParams();
    if (args.hours) params.append('hours', args.hours);
    if (args.project_id) params.append('project', args.project_id);
    if (args.agent_id) params.append('agent', args.agent_id);

    return await fetchJSON(`http://localhost:3000/api/tasks/stats?${params}`, 'GET');
  }

  if (toolName === 'get_task_logs') {
    const agentId = resolveAgentScope(args, context);
    const taskId = await resolveTaskId(args, agentId);
    if (!taskId) {
      return { error: 'No task to inspect.' };
    }
    const params = new URLSearchParams();
    if (args.mode) params.append('mode', args.mode);
    if (args.lines) params.append('limit', args.lines);
    if (args.q) params.append('q', args.q);
    if (args.context) params.append('context', args.context);
    const qs = params.toString();
    return await fetchJSON(`http://localhost:3000/api/tasks/${taskId}/log${qs ? '?' + qs : ''}`, 'GET');
  }

  // ── LLM Rate Limit Tools ──
  if (toolName === 'list_llm_limit_tasks') {
    const data = await fetchJSON('http://localhost:3000/api/tasks/llm-limit', 'GET');
    return {
      count: data.count,
      tasks: (data.tasks || []).map(t => ({
        id: t.id,
        title: t.title,
        agent_id: t.agent_id,
        project_id: t.project_id,
        paused_at: t.paused_at,
        reset_at: t.llm_limit_reset_at,
      })),
    };
  }

  if (toolName === 'resume_llm_limit_tasks') {
    const data = await fetchJSON('http://localhost:3000/api/tasks/resume-llm-limit', 'POST', {});
    return {
      success: true,
      resumed: data.resumed || 0,
      failed: data.failed || 0,
      tasks: data.tasks || [],
      message: data.resumed > 0
        ? serverMsg().resumedTasks(data.resumed, data.failed)
        : serverMsg().noLlmTasks,
    };
  }

  // ── Project Tools ──
  if (toolName === 'create_project') {
    const result = await fetchJSON('http://localhost:3000/api/projects', 'POST', {
      name: args.name,
      context: args.context || '',
      lead_name: args.lead_name,
      lead_role: args.lead_role
    });
    return enrichWithSuggestions(result, toolName);
  }

  if (toolName === 'list_projects') {
    const result = await fetchJSON('http://localhost:3000/api/projects', 'GET');
    return enrichWithSuggestions(result, toolName);
  }

  if (toolName === 'project_status') {
    // Resolve project ID if name provided
    let projectId = args.project_id;

    // Check if it's a project ID (12 chars) or a name
    const isId = projectId?.length === 12 && !projectId.includes(' ');

    if (!isId) {
      // It's a project name, need to resolve it
      const project = await findProjectByName(projectId);
      if (!project) {
        throw new Error(`Project not found: ${projectId}`);
      }
      projectId = project.id;
    }

    return await fetchJSON(`http://localhost:3000/api/projects/${projectId}`, 'GET');
  }

  if (toolName === 'delete_project') {
    // Resolve project ID if name provided
    let projectId = args.project_id;
    const isId = projectId?.length === 12 && !projectId.includes(' ');
    if (!isId) {
      const project = await findProjectByName(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      projectId = project.id;
    }
    return await fetchJSON(`http://localhost:3000/api/projects/${projectId}`, 'DELETE');
  }

  if (toolName === 'rename_project') {
    // Resolve project ID if name provided
    let projectId = args.project_id;
    const isId = projectId?.length === 12 && !projectId.includes(' ');
    if (!isId) {
      const project = await findProjectByName(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      projectId = project.id;
    }
    return await fetchJSON(`http://localhost:3000/api/projects/${projectId}`, 'PUT', {
      name: args.new_name
    });
  }

  // ── Agent Tools ──
  if (toolName === 'assign_agent') {
    const { name, role, role_instructions, is_lead, is_manager } = args;

    // ─── Resolve the caller (cached for both project_id and parent_agent_id
    //     resolution below). Yabby super-agent has projectId=null in DB so
    //     its calls always take the standalone path — same as today. ──────
    let callerAgent = null;
    if (context?.agentId) {
      try {
        callerAgent = await getAgent(context.agentId);
      } catch (err) {
        log(`[TOOL-EXECUTOR] assign_agent: caller lookup failed (non-fatal): ${err.message}`);
      }
    }

    // ─── Resolve project_id (3-tier, alias-tolerant) ───────────────────
    // Accept several common aliases LLMs use because the prompt examples
    // and other tools (delete_project, etc.) use slightly different names.
    // Without this, an LLM that types `project_name_or_id` instead of
    // `project_id` falls all the way through to the standalone path,
    // creates a dedicated WhatsApp group, and breaks the project hierarchy.
    //   1. explicit alias in args  (wins — caller knows best)
    //   2. caller.projectId  (auto-inject when an agent inside a project
    //      forgets the field in its curl)
    //   3. null  (Yabby super-agent or true standalone-creating context)
    const PROJECT_ID_ALIASES = ['project_id', 'projectId', 'project_name_or_id', 'project'];
    let projectIdSource = null;
    let projectId = null;
    for (const alias of PROJECT_ID_ALIASES) {
      if (args[alias]) {
        projectId = args[alias];
        projectIdSource = `args.${alias}`;
        break;
      }
    }
    if (!projectId && callerAgent?.projectId) {
      projectId = callerAgent.projectId;
      projectIdSource = `caller.projectId (auto-injected from ${context?.agentId})`;
      log(`[TOOL-EXECUTOR] assign_agent: project_id missing — auto-resolved to caller's project ${projectId} (caller=${context.agentId})`);
    }

    // ─── Defensive rejection ────────────────────────────────────────────
    // If the LLM clearly signaled "this is a sub-agent in a project" but
    // we couldn't resolve a project_id, REJECT instead of silently falling
    // back to the standalone path. Without this rejection, the LLM gets
    // a successful response back, thinks the agent is properly attached,
    // and only realizes hours later that the hierarchy is broken (and by
    // then the agent has its own WhatsApp group, its own threads, its own
    // memory — all the cleanup is destructive).
    //
    // Sub-agent signals: passed parent_agent_id (any alias), or is_manager
    // is true (only sub-agents in a hierarchy are "managers" of others).
    const PARENT_ALIASES = ['parent_agent_id', 'parentAgentId', 'parent', 'parent_id'];
    let explicitParent = null;
    for (const alias of PARENT_ALIASES) {
      if (args[alias]) { explicitParent = args[alias]; break; }
    }
    const looksLikeSubAgent = !!explicitParent || is_manager === true;
    if (looksLikeSubAgent && !projectId) {
      const reason = explicitParent
        ? `parent_agent_id="${explicitParent}" was passed but no project_id resolved`
        : `is_manager=true was set but no project_id resolved`;
      log(`[TOOL-EXECUTOR] assign_agent: REJECTED — ${reason}`);
      return {
        error: `Cannot create sub-agent without a project_id. ${reason}. ` +
          `Pass "project_id" in args (canonical name), or call assign_agent from within a project agent's task so the server can auto-resolve. ` +
          `If you actually want a standalone agent (not in any project), don't pass parent_agent_id and don't set is_manager:true.`,
      };
    }

    // ─── Resolve parent_agent_id (4-tier fallback) ──────────────────────
    //   1. explicit args alias (parent_agent_id, parentAgentId, parent, parent_id)  — caller knows best
    //   2. parent_name resolved within the project  — for sub-sub-agents
    //      whose manager was just created and whose id the LLM doesn't have
    //      handy. Project-scoped lookup so cross-project name collisions
    //      can't reparent.
    //   3. context.agentId IF the caller is a lead  (lead spawning workers
    //      becomes their superior; managers/sub-agents must pass parent
    //      explicitly to avoid surprise re-parenting)
    //   4. project.leadAgentId  (defensive default — guarantees no project
    //      sub-agent ever lands with parent_agent_id=NULL silently because
    //      a CLI agent forgot the field in its curl)
    //
    // is_lead=true bypass: a project lead obviously has no parent — never
    // auto-attach a parent to it, even via the project.leadAgentId fallback.
    let parentAgentId = explicitParent || null;
    const parentName = args.parent_name || args.parentName || null;
    if (!parentAgentId && parentName && projectId && !is_lead) {
      try {
        const { findAgentByExactName } = await import("../db/queries/agents.js");
        const parent = await findAgentByExactName(parentName, projectId);
        if (parent && parent.projectId === projectId) {
          parentAgentId = parent.id;
          log(`[TOOL-EXECUTOR] assign_agent: parent_name="${parentName}" resolved to id=${parent.id} in project ${projectId}`);
        } else {
          log(`[TOOL-EXECUTOR] assign_agent: parent_name="${parentName}" not found in project ${projectId} — falling through to lead-default`);
        }
      } catch (lookupErr) {
        log(`[TOOL-EXECUTOR] assign_agent: parent_name lookup failed (non-fatal): ${lookupErr.message}`);
      }
    }
    if (!parentAgentId && projectId && !is_lead) {
      if (callerAgent?.isLead) {
        parentAgentId = callerAgent.id;
      }
      if (!parentAgentId) {
        try {
          const { getProject } = await import("../db/queries/projects.js");
          const project = await getProject(projectId);
          if (project?.leadAgentId) {
            parentAgentId = project.leadAgentId;
            log(`[TOOL-EXECUTOR] assign_agent: parent_agent_id missing — auto-resolved to project lead ${parentAgentId}`);
          }
        } catch (err) {
          log(`[TOOL-EXECUTOR] assign_agent: project lead lookup failed (non-fatal): ${err.message}`);
        }
      }
    }

    let result;
    if (projectId) {
      // Project agent
      log(`[TOOL-EXECUTOR] assign_agent: creating project agent (project=${projectId} via ${projectIdSource}, parent=${parentAgentId || 'NONE'})`);
      result = await fetchJSON(`http://localhost:3000/api/projects/${projectId}/agents`, 'POST', {
        name,
        role,
        role_instructions,
        is_lead: is_lead || false,
        is_manager: is_manager || false,
        parent_agent_id: parentAgentId,
      });
    } else {
      // Standalone agent — never inherits a parent (Yabby spawns these)
      log(`[TOOL-EXECUTOR] assign_agent: creating standalone agent (no project, caller=${context?.agentId || 'unknown'})`);
      result = await fetchJSON('http://localhost:3000/api/agents', 'POST', {
        name,
        role,
        role_instructions
      });
    }
    return enrichWithSuggestions(result, toolName);
  }

  if (toolName === 'talk_to_agent') {
    // Enqueue an instruction on a target agent's queue.
    //
    // If `next_tasks` is provided, a multi-agent cascade is created: the
    // initial agent runs first (position 0), then when it finishes all items
    // of position 1 fire in parallel; once all position 1 items are done,
    // position 2 fires; and so on. Same position = parallel, next position =
    // waits for the previous to complete.
    const { enqueueTask } = await import('../db/queries/agent-task-queue.js');
    const { processAgentQueue } = await import('../lib/agent-task-processor.js');

    const targetAgentId = args.agent_id;
    if (!targetAgentId) {
      return { error: 'talk_to_agent requires agent_id (the target agent\'s id or name).' };
    }
    const instruction = args.instruction || args.task;
    if (!instruction) {
      return { error: 'talk_to_agent requires an "instruction" string describing the work to do.' };
    }
    let agent = await getAgent(targetAgentId);
    if (!agent) agent = await findAgentByName(targetAgentId);
    if (!agent) return { error: `Agent "${targetAgentId}" not found` };

    const title = args.title || null;
    const nextTasks = Array.isArray(args.next_tasks) ? args.next_tasks : null;
    const callerAgentId = context?.agentId || agent.parentAgentId || agent.id;

    // ─── Hierarchy validation: only delegate to your direct reports ──────
    // Without this, a project director can bypass managers and hand work
    // directly to sub-sub-agents, leaving managers as empty shells. Cascade
    // is the whole point of having managers — enforce it.
    //
    // Skip when:
    //   • target is standalone (no project) — no hierarchy to enforce
    //   • caller is Yabby super-agent — Yabby owns standalones globally
    //   • caller is the target itself — self-resume / continuation
    //   • caller is the target's direct parent — normal delegation
    //   • we can't identify the caller as an agent in the same project
    //     (e.g. scheduled task, human via UI) — leave it permissive
    if (
      agent.projectId &&
      callerAgentId &&
      callerAgentId !== 'yabby-000000' &&
      callerAgentId !== agent.id
    ) {
      try {
        const callerAgent = await getAgent(callerAgentId);
        // Only validate when the caller is actually a known agent inside
        // the SAME project as the target. Cross-project / unknown callers
        // skip — they're handled by other safeguards.
        if (callerAgent && callerAgent.projectId === agent.projectId) {
          const isDirectReport = agent.parentAgentId === callerAgentId;
          if (!isDirectReport) {
            // Build a dynamic, context-rich error so the LLM has everything
            // it needs to redirect on the next turn.
            let actualParentName = 'NONE (the agent has no parent set)';
            let actualParentId = agent.parentAgentId || null;
            if (agent.parentAgentId) {
              try {
                const parent = await getAgent(agent.parentAgentId);
                if (parent) actualParentName = parent.name;
              } catch { /* fall through */ }
            }
            log(`[TOOL-EXECUTOR] talk_to_agent REJECTED: ${callerAgent.name} (${callerAgent.id}) tried to delegate to ${agent.name} (${agent.id}) but ${agent.name}'s parent is ${actualParentName} (${actualParentId || 'NULL'})`);
            return {
              error: `Hierarchy violation: ${callerAgent.name} (you, id=${callerAgent.id}) tried to delegate a task directly to ${agent.name} (id=${agent.id}, role="${agent.role}"), but ${agent.name} is NOT your direct report.`,
              context: {
                you: { id: callerAgent.id, name: callerAgent.name, role: callerAgent.role, isLead: !!callerAgent.isLead },
                target: { id: agent.id, name: agent.name, role: agent.role, parent_agent_id: actualParentId, parent_name: actualParentName },
                project_id: agent.projectId,
              },
              hint: actualParentId
                ? `${agent.name} reports to ${actualParentName} (id=${actualParentId}). Send this instruction to ${actualParentName} instead — they will decompose it and assign a piece of work to ${agent.name}. The cascade is the whole point of the manager layer; never bypass it.\n\nCorrect call:\n  POST /api/tools/execute\n  { "toolName": "talk_to_agent", "args": { "agent_id": "${actualParentId}", "instruction": "<your milestone-level instruction for the ${actualParentName} team, including what ${agent.name} should do>" } }`
                : `${agent.name} has no parent set in the database — this is a data inconsistency. Skip this delegation and report it to the operator.`,
            };
          }
        }
      } catch (validationErr) {
        // Non-fatal: if the validation itself crashes, log and proceed
        // (we don't want to block legitimate delegations on a bug here).
        log(`[TOOL-EXECUTOR] talk_to_agent hierarchy check failed (proceeding): ${validationErr.message}`);
      }
    }

    // Resume-task validation: when the caller passes resume_task_id, we
    // verify the task exists, belongs to this agent, and has a usable
    // session_id. If any check fails we degrade gracefully (no error, just
    // a notice in the response) and fall back to a fresh task.
    let resumeTaskId = null;
    let resumeNotice = null;
    if (args.resume_task_id) {
      try {
        const { getTask } = await import('../db/queries/tasks.js');
        const existingTask = await getTask(args.resume_task_id);
        if (!existingTask) {
          resumeNotice = `resume_task_id "${args.resume_task_id}" not found — a fresh task was created instead.`;
        } else if (existingTask.agentId !== agent.id) {
          resumeNotice = `resume_task_id "${args.resume_task_id}" belongs to a different agent — a fresh task was created instead.`;
        } else if (!existingTask.sessionId) {
          resumeNotice = `resume_task_id "${args.resume_task_id}" has no session_id — a fresh task was created instead.`;
        } else {
          resumeTaskId = existingTask.id;
        }
      } catch (err) {
        resumeNotice = `Could not validate resume_task_id: ${err.message} — falling back to a fresh task.`;
      }
    }

    // If a cascade is requested, create it BEFORE enqueueing step 0 so the
    // queue item can be linked to the cascade atomically.
    let cascadeId = null;
    if (nextTasks && nextTasks.length > 0) {
      try {
        const { createMultiAgentCascade } = await import('../db/queries/multi-agent-task-queue.js');
        const cascade = await createMultiAgentCascade({
          ownerAgentId: callerAgentId,
          projectId: agent.projectId || null,
          items: nextTasks,
          onError: args.on_error === 'continue' ? 'continue' : 'stop',
        });
        cascadeId = cascade.id;
        log(`[TOOL-EXECUTOR] 🧩 cascade ${cascadeId} created by ${callerAgentId} with ${nextTasks.length} follow-up item(s)`);
      } catch (err) {
        return { error: `Invalid next_tasks: ${err.message}` };
      }
    }

    // Encode the dispatch mode in source + source_id:
    //   api          → normal persistent resume
    //   api_resume   → explicit resume of a past task
    //   api_fork     → fork the agent's current session (domain shift)
    const isFork = args.fork_session === true;
    let queueSource = 'api';
    let queueSourceId = null;
    if (resumeTaskId) {
      queueSource = 'api_resume';
      queueSourceId = resumeTaskId;
    } else if (isFork) {
      queueSource = 'api_fork';
    }

    const queued = await enqueueTask(
      agent.id,
      instruction,
      queueSource,
      queueSourceId,
      50,
      title,
      cascadeId ? { multiAgentTaskId: cascadeId, multiAgentPosition: 0 } : {}
    );
    log(`[TOOL-EXECUTOR] 💬 talk_to_agent → queued #${queued.id} "${queued.title}" for ${agent.name} (${agent.id})${cascadeId ? ` [cascade ${cascadeId} step 0]` : ''}${resumeTaskId ? ` [resume task ${resumeTaskId}]` : ''}`);

    if (cascadeId) {
      const { startCascade } = await import('../lib/multi-agent-orchestrator.js');
      await startCascade(cascadeId, processAgentQueue);
    }

    setImmediate(() => {
      processAgentQueue(agent.id).catch(err => {
        log(`[TOOL-EXECUTOR] processAgentQueue failed for ${agent.id}: ${err.message}`);
      });
    });

    return {
      queue_id: queued.id,
      agent_id: agent.id,
      agent_name: agent.name,
      title: queued.title,
      status: 'queued',
      cascade_id: cascadeId,
      cascade_steps: cascadeId ? nextTasks.length + 1 : null,
      resume_task_id: resumeTaskId,
      ...(resumeNotice && { resume_notice: resumeNotice }),
      note: cascadeId
        ? `Instruction enqueued as step 0 of cascade ${cascadeId}. Follow-up steps will auto-trigger as each position completes. You'll receive a task_complete notification per agent as they finish.`
        : 'Instruction enqueued. You\'ll receive a task_complete message in your inbox when done.',
    };
  }

  if (toolName === 'agent_intervention') {
    // Alias of yabby_intervention scoped to a sub-agent. Same semantics:
    // pause the target agent's running task and resume it with a new
    // instruction, session preserved. Different name because "yabby_intervention"
    // is misleading when a lead intervenes on a sub-agent that isn't Yabby.
    // Graceful fallback: if no task is running, the instruction is queued
    // via talk_to_agent so it still gets done.
    const { enqueueTask } = await import('../db/queries/agent-task-queue.js');
    const { processAgentQueue } = await import('../lib/agent-task-processor.js');

    const targetAgentId = args.agent_id;
    if (!targetAgentId) {
      return { error: 'agent_intervention requires agent_id.' };
    }
    if (!args.instruction) {
      return { error: 'agent_intervention requires an "instruction" describing the correction/addition.' };
    }
    let agent = await getAgent(targetAgentId);
    if (!agent) agent = await findAgentByName(targetAgentId);
    if (!agent) return { error: `Agent "${targetAgentId}" not found` };

    const activeTaskId = await getActiveTaskId(agent.id);
    if (!activeTaskId) {
      // No running task — queue it as a normal task
      const queued = await enqueueTask(agent.id, args.instruction, 'intervention_fallback', null, 80, args.title || null);
      setImmediate(() => processAgentQueue(agent.id).catch(() => {}));
      return {
        agent_id: agent.id,
        agent_name: agent.name,
        fallback_applied: true,
        queue_id: queued.id,
        notice: `${agent.name} had no running task, so the instruction was queued instead of intervening. Next time, use agent_intervention ONLY while the agent is actively working; otherwise use talk_to_agent.`,
      };
    }

    log(`[TOOL-EXECUTOR] ⚡ agent_intervention on ${agent.name} (${agent.id}) — redirecting active task ${activeTaskId}`);
    return await fetchJSON('http://localhost:3000/api/tasks/intervene', 'POST', {
      agent_id: agent.id,
      instruction: args.instruction,
    });
  }

  if (toolName === 'agent_queue_status') {
    const agentId = args.agent_id;
    let agent = await getAgent(agentId);
    if (!agent) agent = await findAgentByName(agentId);
    if (!agent) return { error: `Agent ${agentId} not found` };

    return await fetchJSON(`http://localhost:3000/api/agents/${agent.id}/queue`, 'GET');
  }

  if (toolName === 'create_agent_thread') {
    // Channel is REQUIRED — no default. The caller must explicitly pick one
    // among the channels that are currently usable for this account
    // (adapter running + container paired, except WhatsApp which always
    // works because Yabby creates the group on the fly).
    const channel = args.channel;
    const supported = ['whatsapp', 'telegram', 'discord', 'slack'];
    if (!channel || !supported.includes(channel)) {
      const { listChannelsAvailableForAgentThreads } = await import('../lib/channels/agent-thread-creator.js');
      const { getChannel } = await import('../lib/channels/index.js');
      const available = await listChannelsAvailableForAgentThreads();
      // WhatsApp doesn't need a paired container — only check the adapter is up
      const wa = getChannel('whatsapp');
      if (wa?.running) available.unshift('whatsapp');
      return {
        error: 'Missing required parameter: channel',
        hint: 'You MUST specify which channel to create the thread on. Either ask the user, or pick from currently_available.',
        supported_channels: supported,
        currently_available: available,
        example: `create_agent_thread({ agent_id: "abc-123", channel: "${available[0] || 'whatsapp'}" })`,
      };
    }
    const port = process.env.PORT || 3000;
    const endpoint = {
      whatsapp: '/api/agents/whatsapp-thread',
      telegram: '/api/agents/telegram-thread',
      discord:  '/api/agents/discord-thread',
      slack:    '/api/agents/slack-thread',
    }[channel];
    return await fetchJSON(`http://localhost:${port}${endpoint}`, 'POST', {
      agent_id: args.agent_id,
    });
  }

  if (toolName === 'list_agents') {
    const params = new URLSearchParams();
    if (args.project_id) params.append('project_id', args.project_id);

    return await fetchJSON(`http://localhost:3000/api/agents?${params}`, 'GET');
  }

  if (toolName === 'remove_agent') {
    return await fetchJSON(`http://localhost:3000/api/agents/${args.agent_id}`, 'DELETE');
  }

  if (toolName === 'send_agent_message') {
    return await fetchJSON('http://localhost:3000/api/agent-messages', 'POST', {
      from_agent: args.from_agent,
      to_agent: args.to_agent,
      msg_type: args.msg_type || 'instruction',
      content: args.content
    });
  }

  // ── Skill Tools ──
  if (toolName === 'list_skills') {
    return await fetchJSON('http://localhost:3000/api/skills', 'GET');
  }

  if (toolName === 'add_skill_to_agent') {
    return await fetchJSON(`http://localhost:3000/api/agents/${args.agent_id}/skills`, 'POST', {
      skill_id: args.skill_id
    });
  }

  // ── Scheduling Tools ──
  if (toolName === 'create_scheduled_task') {
    return await fetchJSON('http://localhost:3000/api/scheduled-tasks', 'POST', {
      name: args.name,
      description: args.description,
      taskTemplate: args.task_template,
      scheduleType: args.schedule_type,
      scheduleConfig: args.schedule_config,
      agentId: args.agent_id,
      projectId: args.project_id
    });
  }

  if (toolName === 'list_scheduled_tasks') {
    const params = new URLSearchParams();
    if (args.agent_id) params.append('agent_id', args.agent_id);
    if (args.project_id) params.append('project_id', args.project_id);

    return await fetchJSON(`http://localhost:3000/api/scheduled-tasks?${params}`, 'GET');
  }

  if (toolName === 'delete_scheduled_task') {
    return await fetchJSON(`http://localhost:3000/api/scheduled-tasks/${args.scheduled_task_id}`, 'DELETE');
  }

  if (toolName === 'trigger_scheduled_task') {
    return await fetchJSON(`http://localhost:3000/api/scheduled-tasks/${args.scheduled_task_id}/trigger`, 'POST');
  }

  // ── Connector Tools ──
  if (toolName === 'list_connectors') {
    const params = new URLSearchParams();
    if (args.project_id) params.append('project_id', args.project_id);

    return await fetchJSON(`http://localhost:3000/api/connectors?${params}`, 'GET');
  }

  if (toolName === 'request_connector') {
    return await fetchJSON('http://localhost:3000/api/connector-requests', 'POST', {
      catalog_id: args.catalog_id,
      project_id: args.project_id,
      reason: args.reason || ''
    });
  }

  if (toolName.startsWith('conn_') || toolName.startsWith('mcp_')) {
    // Connector/MCP tool call
    return await fetchJSON('http://localhost:3000/api/connectors/tool-call', 'POST', {
      toolName,
      args
    });
  }

  // ── Plan Review Tools ──
  if (toolName === 'approve_plan') {
    // ✅ CORRECTION: Extract only defined params (AI may add extra params like 'status')
    const { review_id } = args;
    const result = await fetchJSON(`http://localhost:3000/api/plan-reviews/${review_id}/resolve`, 'POST', {
      status: 'approved'
    });
    return enrichWithSuggestions(result, toolName);
  }

  if (toolName === 'revise_plan') {
    // ✅ CORRECTION: Extract only defined params
    const { review_id, feedback } = args;
    const result = await fetchJSON(`http://localhost:3000/api/plan-reviews/${review_id}/resolve`, 'POST', {
      status: 'revised',
      feedback: feedback
    });
    return enrichWithSuggestions(result, toolName);
  }

  if (toolName === 'cancel_plan') {
    // ✅ CORRECTION: Extract only defined params
    const { review_id } = args;
    const result = await fetchJSON(`http://localhost:3000/api/plan-reviews/${review_id}/resolve`, 'POST', {
      status: 'cancelled'
    });
    return enrichWithSuggestions(result, toolName);
  }

  if (toolName === 'defer_plan_review') {
    return await fetchJSON(`http://localhost:3000/api/plan-reviews/${args.review_id}/defer`, 'POST', {});
  }

  if (toolName === 'open_plan_modal') {
    // Get review_id - either from args or fetch most recent pending
    let reviewId = args.review_id;

    if (!reviewId) {
      // Fetch most recent pending plan review
      const reviews = await fetchJSON('http://localhost:3000/api/plan-reviews', 'GET');
      if (reviews.length === 0) {
        return { error: "No pending plan" };
      }
      reviewId = reviews[0].id;
    }

    // Fetch the plan review details
    const review = await fetchJSON(`http://localhost:3000/api/plan-reviews/${reviewId}`, 'GET');

    // Return plan data - frontend will handle opening modal via SSE event simulation
    return {
      success: true,
      reviewId: review.id,
      planContent: review.planContent,
      projectId: review.projectId,
      projectName: review.projectName,
      agentId: review.agentId,
      agentName: review.agentName,
      version: review.version,
      // Signal to frontend to open modal
      action: 'open_modal'
    };
  }

  // ── Project Question Tools ──
  if (toolName === 'answer_project_question') {
    return await fetchJSON(`http://localhost:3000/api/project-questions/${args.question_id}/resolve`, 'POST', {
      answer: args.answer
    });
  }

  if (toolName === 'list_pending_questions') {
    const params = new URLSearchParams();
    if (args.project_id) params.append('project_id', args.project_id);

    return await fetchJSON(`http://localhost:3000/api/project-questions?${params}`, 'GET');
  }

  // ── Presentation Tools ──
  if (toolName === 'create_presentation') {
    const projectId = await resolveProjectId(args.project_name_or_id);
    if (!projectId) throw new Error(`Project not found: ${args.project_name_or_id}`);

    // Idempotency pre-check: surface a structured, helpful error before
    // hitting the DB unique constraint, mentioning the alternative tools.
    const { getActivePresentationByProject } = await import("../db/queries/presentations.js");
    const existing = await getActivePresentationByProject(projectId);
    if (existing) {
      return {
        error: `A presentation already exists for project ${projectId} (id=${existing.id}, status=${existing.status}).`,
        existing: {
          presentationId: existing.id,
          title: existing.title,
          status: existing.status,
          scriptPath: existing.scriptPath,
          createdAt: existing.createdAt,
          agentId: existing.agentId,
        },
        suggestion: "Use presentation_detail to read the current content, presentation_update to modify it (partial patch), or presentation_status to check its state. Do NOT call create_presentation again.",
      };
    }

    if (!args.script_path) {
      return {
        error: "create_presentation requires script_path. Create a start.sh at the project sandbox root (idempotent: kills stale processes on its ports, starts services, waits for them, exits 0 only when ready). Then call this tool again with the absolute path.",
      };
    }

    return await fetchJSON('http://localhost:3000/api/presentations', 'POST', {
      projectId,
      agentId: args.agent_id || context?.agentId || null,
      title: args.title,
      summary: args.summary || '',
      content: args.content,
      slides: args.slides || [],
      demoSteps: args.demo_steps || [],
      sandboxPath: args.sandbox_path || null,
      scriptPath: args.script_path,
      testAccesses: Array.isArray(args.test_accesses) ? args.test_accesses : [],
    });
  }

  if (toolName === 'presentation_status') {
    const projectId = await resolveProjectId(args.project_name_or_id);
    if (!projectId) throw new Error(`Project not found: ${args.project_name_or_id}`);

    const { getActivePresentationByProject } = await import("../db/queries/presentations.js");
    const existing = await getActivePresentationByProject(projectId);
    if (!existing) {
      return { exists: false, projectId };
    }
    return {
      exists: true,
      projectId,
      presentationId: existing.id,
      title: existing.title,
      status: existing.status,
      scriptPath: existing.scriptPath,
      lastRunStatus: existing.lastRunStatus,
      lastRunAt: existing.lastRunAt,
      createdAt: existing.createdAt,
      agentId: existing.agentId,
    };
  }

  if (toolName === 'presentation_detail') {
    const { getPresentation, getActivePresentationByProject } = await import("../db/queries/presentations.js");
    let presentation = null;
    if (args.presentation_id) {
      presentation = await getPresentation(args.presentation_id);
    } else if (args.project_name_or_id) {
      const projectId = await resolveProjectId(args.project_name_or_id);
      if (!projectId) throw new Error(`Project not found: ${args.project_name_or_id}`);
      presentation = await getActivePresentationByProject(projectId);
    } else {
      throw new Error("presentation_detail requires either presentation_id or project_name_or_id");
    }
    if (!presentation) {
      return { error: "No presentation found.", suggestion: "Use create_presentation if the project hasn't had one yet." };
    }
    return presentation;
  }

  if (toolName === 'presentation_update') {
    const { getPresentation, getActivePresentationByProject } = await import("../db/queries/presentations.js");

    // Resolve which presentation to patch.
    let presentationId = args.presentation_id || null;
    if (!presentationId) {
      if (!args.project_name_or_id) {
        throw new Error("presentation_update requires either presentation_id or project_name_or_id");
      }
      const projectId = await resolveProjectId(args.project_name_or_id);
      if (!projectId) throw new Error(`Project not found: ${args.project_name_or_id}`);
      const existing = await getActivePresentationByProject(projectId);
      if (!existing) {
        return { error: "No active presentation for this project — use create_presentation first." };
      }
      presentationId = existing.id;
    } else {
      const existing = await getPresentation(presentationId);
      if (!existing) throw new Error(`Presentation not found: ${presentationId}`);
    }

    // Build the patch from the args we recognize.
    const patch = {};
    if (args.title !== undefined) patch.title = args.title;
    if (args.summary !== undefined) patch.summary = args.summary;
    if (args.content !== undefined) patch.content = args.content;
    if (args.script_path !== undefined) patch.scriptPath = args.script_path;
    if (args.test_accesses !== undefined) patch.testAccesses = args.test_accesses;
    if (args.slides !== undefined) patch.slides = args.slides;
    if (args.demo_steps !== undefined) patch.demoSteps = args.demo_steps;
    if (args.last_run_status !== undefined) {
      patch.lastRunStatus = args.last_run_status;
      patch.lastRunAt = new Date().toISOString();
    }
    if (args.last_run_log !== undefined) {
      // Cap stored log to ~8 KB to keep the row sane.
      const raw = String(args.last_run_log);
      patch.lastRunLog = raw.length > 8192 ? raw.slice(raw.length - 8192) : raw;
    }

    if (Object.keys(patch).length === 0) {
      return { error: "presentation_update needs at least one field to change." };
    }

    return await fetchJSON(`http://localhost:3000/api/presentations/${presentationId}`, 'PATCH', patch);
  }

  // ── Media Tools ──

  if (toolName === 'web_screenshot') {
    const { navigateTo, screenshot } = await import("../lib/playwright.js");
    const { write: storeWrite } = await import("../lib/media/store.js");
    await navigateTo(args.url);
    const { buffer } = await screenshot({ fullPage: args.fullPage || false });
    const asset = await storeWrite(buffer, "image/png", { source: "tool", metadata: { url: args.url } });
    await dispatchMediaToAgent(asset.id, "image/png", context);
    return { assetId: asset.id, url: args.url };
  }

  if (toolName === 'html_screenshot') {
    const { setHtmlContent, screenshot } = await import("../lib/playwright.js");
    const { write: storeWrite } = await import("../lib/media/store.js");
    await setHtmlContent(args.html, { widthPx: args.widthPx, waitMs: args.waitMs });
    const { buffer } = await screenshot({ fullPage: args.fullPage || false });
    const asset = await storeWrite(buffer, "image/png", { source: "tool", metadata: { type: "html_screenshot" } });
    await dispatchMediaToAgent(asset.id, "image/png", context);
    return { assetId: asset.id };
  }

  if (toolName === 'search_images') {
    const { searchImages } = await import("../lib/tools/search-images.js");
    const result = await searchImages(args);
    // Dispatch each found image
    if (result?.assets) {
      for (const a of result.assets) {
        if (a.assetId) await dispatchMediaToAgent(a.assetId, "image/png", context);
      }
    }
    return result;
  }

  if (toolName === 'get_channel_files') {
    const { getChannelFiles } = await import("../lib/tools/get-channel-files.js");
    return await getChannelFiles(args, context);
  }

  if (toolName === 'store_file') {
    const { storeFile } = await import("../lib/tools/store-file.js");
    const result = await storeFile(args);
    await dispatchMediaToAgent(result.assetId, result.mime, context);
    return result;
  }

  if (toolName === 'send_media') {
    const { sendMedia } = await import("../lib/tools/send-media.js");
    const result = await sendMedia(args);
    // If called with agentId context, dispatch immediately to the agent's channel
    await dispatchMediaToAgent(result.assetId, result.mime, context);
    return result;
  }

  if (toolName === 'generate_image') {
    const { generate } = await import("../lib/imagegen/client.js");
    const result = await generate(args);
    if (result?.assetId) await dispatchMediaToAgent(result.assetId, "image/png", context);
    return result;
  }

  // Tool not found
  throw new Error(`Tool ${toolName} not implemented`);
}

/**
 * Helper: Fetch JSON from internal API
 */
async function fetchJSON(url, method, body) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };

  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    options.body = JSON.stringify(body);
  }

  const port = process.env.PORT || 3000;
  const resolvedUrl = url.replace('http://localhost:3000', `http://localhost:${port}`);
  const res = await fetch(resolvedUrl, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }

  return data;
}

export default router;
