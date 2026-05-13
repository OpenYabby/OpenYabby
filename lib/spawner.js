import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { readFile } from "fs/promises";
import { join } from "path";
import {
  createTask,
  updateTaskStatus,
  getTaskStatus,
  getTask,
  markTaskLlmLimited,
  updateTaskRunnerContext,
  getTaskRunnerContext,
} from "../db/queries/tasks.js";
import {
  getAgent,
  getSubAgents,
  getAgentRunnerSession,
  updateAgentRunnerSession,
} from "../db/queries/agents.js";
import { logEvent } from "../db/queries/events.js";
import { buildSkillsPrompt } from "../db/queries/skills.js";
import { getInbox, markProcessed } from "../db/queries/agent-messages.js";
import { getConversation, DEFAULT_CONV_ID } from "../db/queries/conversations.js";
import { BASE_PROMPT, buildYabbySuperAgentPrompt, buildStandaloneAgentCliPrompt, buildAgentContextBlock } from "./prompts.js";
import { getSandboxPath, getAgentWorkspacePath, getYabbyWorkspacePath } from "./sandbox.js";
import { log, emitTaskEvent, emitSpeakerNotification, emitPlanReviewEvent } from "./logger.js";
import { getPendingEmissionByTaskId, markPlanReviewEmitted, markPlanReviewShown } from "../db/queries/plan-reviews.js";
import { getProject } from "../db/queries/projects.js";
import { enqueueTask, getQueueLength } from "../db/queries/agent-task-queue.js";
import { query as pgQuery } from "../db/pg.js";
import { emitTaskCompleted } from "./task-completion-bus.js";
import { getConfig } from "./config.js";
import { agentSend } from "./agent-bus.js";
import { getRunnerProfile } from "./runner-profiles.js";
import { getThreadManager } from "./channels/thread-binding-manager.js";
import { serverMsg, getServerLanguage } from "./i18n.js";

// Callback for orchestrator — set via registerManagerTaskCallback to avoid circular imports
let _onManagerTaskComplete = null;
export function registerManagerTaskCallback(fn) { _onManagerTaskComplete = fn; }

// ───────────────────────────────────────────────────────────────────
// LLM rate limit detection
// Three signals are recognised:
//   1. Legacy user-visible message: "You've hit your limit · resets 2am (Europe/Paris)"
//   2. Structured rate_limit_event emitted by Claude CLI stream:
//        {"type":"rate_limit_event","rate_limit_info":{"status":"rejected", ...}}
//      with either overageStatus="rejected" (out_of_credits / org_level_disabled_until)
//      OR isUsingOverage=true (the user is running on overage already)
//   3. Plain error message variants ("Claude usage limit reached", etc.)
// ───────────────────────────────────────────────────────────────────
const LLM_LIMIT_PATTERN = /you['']ve hit your limit|claude usage limit reached|usage limit reached/i;
const LLM_RESET_PATTERN = /resets?\s+(\d+(?::\d+)?\s*(?:am|pm)?)\s*\(([^)]+)\)/i;

// Matches any structured rate_limit_event whose rate_limit_info.status is
// "rejected" — that's the ground truth from the Claude CLI stream and the
// most reliable signal. Overage status tells us whether retries would help.
const STRUCTURED_RATE_LIMIT_PATTERN =
  /"type"\s*:\s*"rate_limit_event"[^}]*?"rate_limit_info"\s*:\s*\{[^}]*?"status"\s*:\s*"rejected"/;

function detectLlmLimit(stdout, stderr) {
  const combined = `${stdout || ""}\n${stderr || ""}`;
  const textMatch = LLM_LIMIT_PATTERN.test(combined);
  const structuredMatch = STRUCTURED_RATE_LIMIT_PATTERN.test(combined);
  if (!textMatch && !structuredMatch) return null;

  // Try to extract a human-readable reset time; fall back to the Unix epoch
  // from the structured event if that's all we have.
  let resetAt = null;
  const textReset = combined.match(LLM_RESET_PATTERN);
  if (textReset) {
    resetAt = `${textReset[1]} (${textReset[2]})`;
  } else {
    const epochMatch = combined.match(/"resetsAt"\s*:\s*(\d+)/);
    if (epochMatch) {
      const ts = Number(epochMatch[1]);
      const d = new Date(ts < 10_000_000_000 ? ts * 1000 : ts);
      resetAt = d.toISOString();
    }
  }

  return { isLlmLimit: true, resetAt };
}

const LOGS_DIR = join(process.cwd(), "logs");
mkdirSync(LOGS_DIR, { recursive: true });

/**
 * Generate a .mcp.json in the task CWD so Claude CLI / Codex can use
 * BOTH global MCP servers AND Yabby's connected MCP connectors.
 *
 * Sources merged:
 * 1. Global MCP servers from root .mcp.json (chrome-devtools, playwright, puppeteer)
 * 2. Project-scoped connectors (if projectId) or all connected connectors
 */
async function generateMcpConfig(cwd, projectId) {
  try {
    const mcpServers = {};

    // ─── PART 1: Load Global MCP Servers from Root .mcp.json ───
    try {
      const rootMcpPath = join(process.cwd(), ".mcp.json");
      if (existsSync(rootMcpPath)) {
        const rootMcpContent = readFileSync(rootMcpPath, "utf-8");
        const rootMcp = JSON.parse(rootMcpContent);
        if (rootMcp.mcpServers && typeof rootMcp.mcpServers === "object") {
          Object.assign(mcpServers, rootMcp.mcpServers);
          log(`[MCP-CONFIG] Loaded ${Object.keys(rootMcp.mcpServers).length} global MCP servers from root .mcp.json`);
        }
      }
    } catch (err) {
      log(`[MCP-CONFIG] Could not load root .mcp.json: ${err.message}`);
    }

    // ─── PART 2: Add Yabby Connectors (MCP type only) ───
    const { listConnectors, getProjectConnectors, getGlobalConnectors } = await import("../db/queries/connectors.js");
    const { getCatalogEntry } = await import("./connectors/catalog.js");
    const { decryptCredentials } = await import("./crypto.js");

    let connectors;
    if (projectId && projectId !== "default") {
      // Project-scoped: linked connectors + global
      const [projectConns, globalConns] = await Promise.all([
        getProjectConnectors(projectId),
        getGlobalConnectors(),
      ]);
      const ids = new Set();
      connectors = [];
      for (const c of [...projectConns, ...globalConns]) {
        if (!ids.has(c.id) && c.status === "connected") {
          ids.add(c.id);
          connectors.push(c);
        }
      }
    } else {
      const all = await listConnectors();
      connectors = all.filter(c => c.status === "connected");
    }

    // Add MCP connectors from Yabby catalog
    for (const conn of connectors) {
      const catalog = getCatalogEntry(conn.catalogId);
      if (!catalog?.mcp) continue;

      const creds = decryptCredentials(conn.credentialsEncrypted);
      const serverName = conn.catalogId;

      // Resolve template variables in args and env
      const args = catalog.mcp.args.map(a =>
        a.replace(/\{\{(\w+)\}\}/g, (_, key) => creds[key] || "")
      );
      const env = {};
      for (const [key, val] of Object.entries(catalog.mcp.env || {})) {
        env[key] = String(val).replace(/\{\{(\w+)\}\}/g, (_, k) => creds[k] || "");
      }

      mcpServers[serverName] = {
        command: catalog.mcp.command,
        args,
        ...(Object.keys(env).length > 0 ? { env } : {}),
      };
    }

    // ─── PART 3: Write Merged Config ───
    if (Object.keys(mcpServers).length === 0) {
      log(`[MCP-CONFIG] No MCP servers to configure for ${cwd}`);
      return;
    }

    const mcpConfig = { mcpServers };
    writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(mcpConfig, null, 2));
    log(`[MCP-CONFIG] Generated .mcp.json in ${cwd} with ${Object.keys(mcpServers).length} servers:`, Object.keys(mcpServers).join(", "));
  } catch (err) {
    log(`[MCP-CONFIG] Could not generate .mcp.json: ${err.message}`);
  }
}

const defaultProjectRoot = process.env.CLAUDE_PROJECT_ROOT || process.cwd();

/**
 * Resolve the working directory for an agent based on its type.
 * Order matters — Yabby super agent MUST be checked first.
 *   1. Yabby super agent → Independent Tasks/yabby/
 *   2. Project agent     → Group Projects/{project}/
 *   3. Standalone agent  → Independent Tasks/{agent-name}/
 * Returns null on failure so caller can fall back to defaultProjectRoot.
 */
async function resolveAgentWorkspace(agent, projectId) {
  try {
    // CASE 0: Custom workspace override — set by POST /api/agents/:id/change-workspace.
    // Highest priority — applies to all agent types (standalone, project, super).
    // Fallback silently to default resolution if the override path no longer exists.
    if (agent.workspacePath && existsSync(agent.workspacePath)) {
      return agent.workspacePath;
    }
    // CASE 1: Yabby super agent → dedicated fixed folder
    if (agent.isSuperAgent || agent.id === "yabby-000000") {
      return await getYabbyWorkspacePath();
    }
    // CASE 2: Project agent → project sandbox (Group Projects)
    if (projectId && projectId !== "default") {
      return await getSandboxPath(projectId, agent.projectName);
    }
    // CASE 3: Standalone agent → persistent agent workspace (Independent Tasks)
    return await getAgentWorkspacePath(agent.id, agent.name);
  } catch (err) {
    log(`[SPAWNER] Workspace resolution failed: ${err.message}`);
    return null;
  }
}

// In-memory process handles — shared with routes
export const processHandles = new Map();

/**
 * Kill a child process AND its entire tree (MCP servers, Chrome, etc.).
 * Children are in the same process group thanks to detached:true.
 * Negative PID = send signal to the whole group.
 */
export function killProcessTree(child, signal = "SIGTERM") {
  if (!child || !child.pid) return false;
  try {
    // Kill the process group (Claude CLI + all its descendants)
    process.kill(-child.pid, signal);
    return true;
  } catch (err) {
    // Fallback: kill just the direct child if process group kill fails
    try { child.kill(signal); return true; } catch { return false; }
  }
}

// Media assetIds collected from tool results during task execution.
// Key: taskId, Value: string[] of 12-hex assetIds.
export const taskMediaAssets = new Map();

export function genTaskId() {
  return randomUUID().slice(0, 8);
}

// Track which session IDs are currently in use by running tasks
const activeSessions = new Map(); // sessionId -> taskId

function markSessionActive(sessionId, taskId) {
  activeSessions.set(sessionId, taskId);
}

function markSessionFree(sessionId) {
  activeSessions.delete(sessionId);
}

async function isSessionInUse(sessionId) {
  if (!activeSessions.has(sessionId)) return false;
  // Double-check the task is still running
  const taskId = activeSessions.get(sessionId);
  return processHandles.has(taskId);
}

/**
 * Spawn a Claude CLI task.
 * options.agentId — if set, uses the agent's system prompt and session
 * options.projectId — if set, tags the task with a project
 */
export async function spawnClaudeTask(taskId, sessionId, task, isResume, options = {}) {
  const {
    agentId, projectId, parentTaskId = null, title = null, priority = "P2",
    channelName = null, threadId = null, conversationId = null,
    // ✅ NOUVEAU: Contexte speaker
    createdBySpeaker = false, speakerMetadata = null,
    // ✅ NOUVEAU: Skip task creation (for retries)
    isRetry = false,
    // ✅ NOUVEAU: Phase + metadata pour notification chain (migration 026)
    phase = null, metadata = {},
    // ✅ NOUVEAU: Override system prompt (used by change-workspace endpoint to inject
    // previous session history into a fresh session in a new CWD)
    cliPromptOverride = null,
    // Optional runner override (used to pin resumes to original runner)
    runnerIdOverride = null,
  } = options;

  let systemPrompt = BASE_PROMPT;
  let cwd = defaultProjectRoot;
  // Captured for the PreToolUse hook env (see settings block below). When the
  // exiting agent is a lead, the hook gates Write/Edit/Bash with a bypass-ack
  // requirement so the director can't silently start solo-coding the project.
  let agentIsLead = false;

  // If an agent is specified, use its prompt, session, and skills
  if (agentId) {
    const agent = await getAgent(agentId);
    if (agent) {
      agentIsLead = !!agent.isLead;
      // ⚠️ SUPER AGENT: Build special prompt with conversation history
      if (agent.isSuperAgent) {
        log(`[SPAWN] Super agent detected: ${agent.id}, building Yabby super agent prompt`);
        let conversationHistory = '';
        try {
          const convData = await getConversation(DEFAULT_CONV_ID, 35);  // Fetch last 30 turns + 5 buffer
          if (convData.turns && convData.turns.length > 0) {
            const recentTurns = convData.turns.slice(-30); // Last 30 turns
            conversationHistory = `\n\n## HISTORIQUE DE CONVERSATION\n\nVoici les 30 dernières interactions avec l'utilisateur:\n\n${
              recentTurns.map(t => `${t.role === 'user' ? 'Utilisateur' : 'Yabby'}: ${t.text}`).join('\n\n')
            }\n\n---\n\nUtilise cet historique pour comprendre le contexte complet des demandes.\n`;
          }
        } catch (err) {
          log(`[SPAWN] Error fetching conversation history for super agent:`, err.message);
        }

        // Use special Yabby super agent prompt
        systemPrompt = await buildYabbySuperAgentPrompt(
          agent.name,
          agent.role,
          agent.roleInstructions || '',
          conversationHistory
        );
      } else if (cliPromptOverride) {
        // Override used by change-workspace endpoint to inject previous session
        // history into a fresh session spawning in a new CWD.
        systemPrompt = cliPromptOverride;
      } else {
        // Normal agent: use CLI-specific prompt (no yabby_execute/yabby_intervention
        // mentions — those tools don't exist in Claude Code CLI).
        // Fallback to agent.systemPrompt for legacy agents created before migration 028.
        systemPrompt = agent.cliSystemPrompt || agent.systemPrompt;
      }

      // Fetch skills, inbox, and workspace in parallel (P4)
      // Workspace resolution: 3 cases (Yabby super agent, project, standalone)
      const [skillsPrompt, pendingMsgs, sandboxPath] = await Promise.all([
        buildSkillsPrompt(agentId),
        getInbox(agentId, "pending"),
        resolveAgentWorkspace(agent, projectId),
      ]);

      // Only add skills for non-super agents (super agents have everything in their prompt)
      if (skillsPrompt && !agent.isSuperAgent) {
        systemPrompt += skillsPrompt;
      }

      // Inject media tools docs for all non-super agents (super agents have
      // their own docs in buildYabbySuperAgentPrompt). This ensures agents
      // created before the media feature still get the tools section.
      if (!agent.isSuperAgent && !systemPrompt.includes('__MEDIA_TOOLS_INJECTED__')) {
        const mediaApiPort = process.env.PORT || 3000;
        systemPrompt += `\n\n<!-- __MEDIA_TOOLS_INJECTED__ -->\n# MEDIA TOOLS (images, screenshots, PDFs)

You can send images and files to the user via these HTTP tools. All return an assetId — the media is automatically delivered to the user's channel (WhatsApp, Telegram, etc.) immediately.

IMPORTANT: Always include "context": {"agentId": "${agentId}"} so the media is delivered to your channel thread.

### Take a screenshot of a URL
curl -s -X POST http://localhost:${mediaApiPort}/api/tools/execute \\
  -H "Content-Type: application/json" \\
  -d '{"toolName": "web_screenshot", "args": {"url": "https://example.com"}, "context": {"agentId": "${agentId}"}}'

### Render HTML to image (charts, diagrams — supports Chart.js, Mermaid, D3 via CDN)
curl -s -X POST http://localhost:${mediaApiPort}/api/tools/execute \\
  -H "Content-Type: application/json" \\
  -d '{"toolName": "html_screenshot", "args": {"html": "<html>...</html>", "waitMs": 2000}, "context": {"agentId": "${agentId}"}}'

### Search for images on the web
curl -s -X POST http://localhost:${mediaApiPort}/api/tools/execute \\
  -H "Content-Type: application/json" \\
  -d '{"toolName": "search_images", "args": {"query": "sunset beach", "count": 4}, "context": {"agentId": "${agentId}"}}'

### Re-send a previously stored media asset
curl -s -X POST http://localhost:${mediaApiPort}/api/tools/execute \\
  -H "Content-Type: application/json" \\
  -d '{"toolName": "send_media", "args": {"asset_id": "abc123def456"}, "context": {"agentId": "${agentId}"}}'

Any files you create locally (PDFs, images) are also auto-detected and sent when your task completes.

### Find files sent by users
curl -s -X POST http://localhost:${mediaApiPort}/api/tools/execute \\
  -H "Content-Type: application/json" \\
  -d '{"toolName": "get_channel_files", "args": {"filename": "report"}, "context": {"agentId": "${agentId}"}}'

Returns local paths you can read/process directly. Use when the user says "analyze this file" or "look at what I sent".

# TOOL DISCOVERY — MANDATORY

Before attempting ANY tool you haven't used before:
  curl -s "http://localhost:${mediaApiPort}/api/tools/list?format=summary" | jq .
This is the ONLY authoritative catalog. NEVER guess tool names or parameters. If a tool doesn't appear in this list, it doesn't exist.`;
      }

      // Inject pending messages into task context (capped at 5 most recent, 3000 chars)
      if (pendingMsgs.length > 0) {
        const MAX_INJECT = 5;
        const MAX_CHARS = 3000;
        const recent = pendingMsgs.slice(-MAX_INJECT);
        const omitted = pendingMsgs.length - recent.length;
        let msgBlock = recent
          .map(m => `[Message de ${m.fromName} (${m.fromRole})]: ${m.content}`)
          .join("\n");
        if (msgBlock.length > MAX_CHARS) msgBlock = msgBlock.slice(0, MAX_CHARS) + "\n...(tronqué)";
        if (omitted > 0) {
          msgBlock = `(${omitted} messages antérieurs — consulte: curl -s http://localhost:${process.env.PORT || 3000}/api/agents/${agentId}/inbox?status=pending)\n` + msgBlock;
        }
        task = `MESSAGES EN ATTENTE:\n${msgBlock}\n\n---\n\nTÂCHE PRINCIPALE:\n${task}`;
        // Mark ALL messages as processed (including omitted — still accessible via API)
        for (const m of pendingMsgs) {
          await markProcessed(m.id);
        }
      }

      if (sandboxPath) cwd = sandboxPath;

      // Inject runtime agent context block (identity + current workspace + date)
      // so the CLI agent always knows exactly where it is, even after a
      // change-workspace. We skip this for Yabby super agent (its prompt
      // already embeds conversation history and is self-describing) and
      // when a cliPromptOverride is active (change-workspace bootstrap).
      if (!agent.isSuperAgent && !cliPromptOverride) {
        const contextBlock = buildAgentContextBlock({
          name: agent.name,
          role: agent.role,
          agentId: agent.id,
          workspacePath: agent.workspacePath,
          defaultWorkspace: cwd,
        });
        systemPrompt = contextBlock + '\n' + systemPrompt;
      }

      if (!isResume) {
        sessionId = randomUUID();
      }
    }
  } else if (projectId && projectId !== "default") {
    // No agent but has project — still use sandbox
    try {
      cwd = await getSandboxPath(projectId);
    } catch (err) {
      log(`[TASK ${taskId}] Sandbox error, using default CWD:`, err.message);
    }
  }

  // Resolve runner profile from config
  const tasksConfig = getConfig("tasks");
  const configuredRunnerId = tasksConfig?.runner || "claude";
  const parityV2Enabled = tasksConfig?.enableRunnerParityV2 !== false;
  let runnerId = runnerIdOverride || configuredRunnerId;

  // For resume flows, pin to the original task runner to avoid cross-runner
  // session mismatches when settings changed mid-task.
  let taskRunnerContext = null;
  if (isResume && parityV2Enabled && !runnerIdOverride) {
    try {
      taskRunnerContext = await getTaskRunnerContext(taskId);
      if (taskRunnerContext?.runnerId && taskRunnerContext.runnerId !== configuredRunnerId) {
        runnerId = taskRunnerContext.runnerId;
        log(`[TASK ${taskId}] Resume pinned to original runner=${runnerId} (configured=${configuredRunnerId})`);
      }
    } catch (err) {
      log(`[TASK ${taskId}] Failed to resolve original runner for resume: ${err.message}`);
    }
  }

  const profile = getRunnerProfile(runnerId);
  const isVerbose = tasksConfig?.verbose ?? true;
  let resumeAgentId = agentId || null;
  if (isResume && !resumeAgentId) {
    try {
      const taskRecord = await getTask(taskId);
      resumeAgentId = taskRecord?.agent_id || null;
    } catch (err) {
      log(`[TASK ${taskId}] Failed to resolve task agent for resume parity: ${err.message}`);
    }
  }
  const persistAgentRunnerSession = (runnerSessionKey) => {
    if (!parityV2Enabled || !resumeAgentId || !runnerSessionKey) return;
    updateAgentRunnerSession(resumeAgentId, runnerId, runnerSessionKey).catch((err) => {
      log(`[TASK ${taskId}] Failed to persist runner session for agent ${resumeAgentId}: ${err.message}`);
    });
  };

  // Runner-native resume key can differ from our logical session_id
  // (Codex uses thread_id, not task session UUID).
  let runnerResumeKey = sessionId;
  if (isResume && runnerId === "codex" && parityV2Enabled) {
    try {
      const ctx = taskRunnerContext || await getTaskRunnerContext(taskId);
      if (ctx?.runnerThreadId) {
        runnerResumeKey = ctx.runnerThreadId;
      } else if (resumeAgentId) {
        const agentThreadId = await getAgentRunnerSession(resumeAgentId, "codex");
        if (agentThreadId) {
          runnerResumeKey = agentThreadId;
          log(`[TASK ${taskId}] Using agent-level Codex thread_id fallback for ${resumeAgentId}`);
        } else {
          log(`[TASK ${taskId}] No stored Codex thread_id, falling back to session_id`);
        }
      } else {
        log(`[TASK ${taskId}] No stored Codex thread_id, falling back to session_id`);
      }
    } catch (err) {
      log(`[TASK ${taskId}] Failed to load runner context: ${err.message}`);
    }
  }

  // Check resume support
  if (isResume && !profile.supportsResume) {
    const msg = serverMsg().runnerNoResume(profile.label);
    await updateTaskStatus(taskId, "error", msg, msg);
    emitTaskEvent(taskId, "status", { status: "error", error: msg });
    return;
  }

  // Generate .mcp.json in the task CWD so CLI runners can use Yabby's connectors
  if (!isResume) {
    await generateMcpConfig(cwd, projectId);
  }

  // Ensure .claudeignore exists (backfill for sandboxes created before this feature)
  try {
    const { ensureClaudeIgnore } = await import("./sandbox.js");
    await ensureClaudeIgnore(cwd);
  } catch {}


  // Generate per-task Claude Code settings with PreToolUse hooks:
  //   1. block-cd     — forbids `cd /absolute/path` (doesn't persist between
  //                     tasks; forces use of change-workspace or absolute paths)
  //   2. block-lead-coding — for LEAD agents only, gates Write/Edit/Bash
  //                     behind a file-based bypass ack so directors don't
  //                     silently solo-code the project instead of delegating
  //                     via assign_agent / talk_to_agent.
  // Both hooks no-op for the Yabby super agent (managed elsewhere).
  let settingsPath = null;
  if (runnerId === "claude" && agentId && agentId !== "yabby-000000") {
    try {
      const cdHookScript = join(process.cwd(), "scripts/claude-hook-block-cd.js");
      const leadHookScript = join(process.cwd(), "scripts/claude-hook-block-lead-coding.js");
      const preToolUse = [
        {
          matcher: "Bash",
          hooks: [
            {
              type: "command",
              if: "Bash(cd *)",
              command: `node ${cdHookScript}`,
              timeout: 5,
            },
          ],
        },
      ];
      // Lead-coding gate: only attached when the agent is a lead. The hook
      // itself also reads YABBY_AGENT_IS_LEAD as defence-in-depth, but
      // skipping registration entirely on non-leads keeps overhead at zero.
      if (agentIsLead) {
        preToolUse.push({
          // Match any filesystem-mutating tool, including MCP filesystem
          // tools the lead might use to route around native Write/Edit.
          // The hook itself does final tool-name + bypass-file checks.
          matcher: "Write|Edit|Bash|NotebookEdit|mcp__filesystem__.*",
          hooks: [
            {
              type: "command",
              command: `node ${leadHookScript}`,
              timeout: 5,
            },
          ],
        });
      }
      // 3. bg-pid-capture — wraps Bash(run_in_background=true) commands with
      //    `sh -c 'echo $$ > /tmp/yabby-bg/<tool_use_id>.pid; exec <orig>'`
      //    so the watcher knows the host-OS PID and can detect completion
      //    via `kill -0 <pid>` independently of the parent CLI.
      const bgPidHookScript = join(process.cwd(), "scripts/claude-hook-bg-pid-capture.js");
      preToolUse.push({
        matcher: "Bash",
        hooks: [
          {
            type: "command",
            command: `node ${bgPidHookScript}`,
            timeout: 5,
          },
        ],
      });
      const settings = { hooks: { PreToolUse: preToolUse } };
      settingsPath = join(cwd, ".claude-settings.json");
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    } catch (err) {
      log(`[TASK ${taskId}] Failed to write .claude-settings.json: ${err.message}`);
      settingsPath = null;
    }
  }

  const taskWithContext = `[TASK_ID: ${taskId}]\n\n${task}`;

  const args = isResume
    ? profile.buildResumeArgs(taskWithContext, { sessionId: runnerResumeKey, isVerbose, settingsPath, forkSession: options.forkSession || false })
    : profile.buildArgs(taskWithContext, { sessionId, systemPrompt, isVerbose, cwd, settingsPath });

  // runnerPath in config applies to the currently selected runner only.
  // If we pinned resume to a different runner, ignore runnerPath override.
  const runnerCmdConfig = runnerId !== configuredRunnerId
    ? { ...tasksConfig, runnerPath: null }
    : tasksConfig;
  const runnerCmd = profile.getCommand(runnerCmdConfig);

  log(`[TASK ${taskId}] ${isResume ? "RESUMING" : "STARTING"} runner=${runnerId} session=${sessionId}${runnerResumeKey !== sessionId ? ` resume_key=${runnerResumeKey}` : ""}`);
  log(`[TASK ${taskId}] CWD:`, cwd);
  log(`[TASK ${taskId}] Settings: ${settingsPath || "(none)"}`);
  if (settingsPath) {
    log(`[TASK ${taskId}] Args includes --settings: ${args.includes("--settings")}`);
  }

  markSessionActive(sessionId, taskId);

  if (!isResume && !isRetry) {
    await createTask(taskId, sessionId, projectId, agentId, {
      parentTaskId,
      title,
      priority,
      // ✅ NOUVEAU: Contexte speaker
      conversationId,
      createdBySpeaker,
      parentTurnId: null, // TODO: récupérer depuis conversation si nécessaire
      speakerMetadata,
      // ✅ NOUVEAU: Préserver l'instruction originale pour reprise après LLM limit
      taskInstruction: task,
      // ✅ NOUVEAU: Phase + metadata pour notification chain (migration 026)
      phase,
      metadata,
    });

    // Auto-bind thread si spawn depuis un channel avec threadId
    if (channelName && threadId && agentId) {
      try {
        const manager = getThreadManager(channelName, "main");
        await manager.bindThread({
          threadId,
          conversationId: conversationId || taskId,  // Fallback: utiliser taskId si pas de conversationId
          agentId,
          sessionKey: sessionId,
          idleTimeoutMs: 86400000  // 24h
        });
        log(`[TASK ${taskId}] Auto-bound thread ${threadId} → agent ${agentId} (channel: ${channelName})`);
      } catch (err) {
        log(`[TASK ${taskId}] Failed to auto-bind thread: ${err.message}`);
        // Non-fatal: continue task execution
      }
    }
  } else if (isRetry) {
    // Retry: task already exists, just mark as running
    await updateTaskStatus(taskId, "running");
  } else {
    await updateTaskStatus(taskId, "running");
  }

  // Persist runner metadata for cross-runner resume parity.
  // For fresh starts/retries we clear native thread id until the CLI emits one.
  if (parityV2Enabled) {
    await updateTaskRunnerContext(taskId, {
      runnerId,
      ...(isResume ? {} : { runnerThreadId: null }),
    });
  }
  if (runnerId !== "codex") {
    persistAgentRunnerSession(sessionId);
  } else if (isResume && runnerResumeKey) {
    persistAgentRunnerSession(runnerResumeKey);
  }

  // Log event
  await logEvent("task_started", {
    projectId, agentId, taskId,
    detail: { task: task.slice(0, 200), isResume, runner: runnerId },
  });

  const startTime = Date.now();
  // Ensure /opt/homebrew/bin is in PATH for macOS (node, claude, etc.)
  const envPath = process.env.PATH || "";
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin"].filter(p => !envPath.includes(p));
  const fullPath = extraPaths.length ? extraPaths.join(":") + ":" + envPath : envPath;

  const baseEnv = {
    ...process.env,
    PATH: fullPath,
    // Expose agent identity + language to PreToolUse hooks (see
    // scripts/claude-hook-block-cd.js and scripts/claude-hook-block-lead-coding.js).
    // The hooks run as fresh Node processes per tool call and can't import
    // the full i18n module — they read YABBY_LANG to pick a localized
    // deny message from a small inline dictionary.
    YABBY_AGENT_ID: agentId || "",
    YABBY_AGENT_IS_LEAD: agentIsLead ? "1" : "0",
    YABBY_LANG: getServerLanguage(),
    YABBY_API_PORT: process.env.PORT || "3000",
  };
  const child = spawn(runnerCmd, args, {
    cwd: cwd,
    env: profile.envOverrides(baseEnv),
    stdio: ["ignore", "pipe", "pipe"],
    // detached:true creates a new process group so we can kill the entire
    // tree (Claude CLI + its MCP server children) via kill(-pid) later.
    detached: true,
  });

  processHandles.set(taskId, child);
  log(`[TASK ${taskId}] Spawned PID:`, child.pid);

  // --- Verbose log files ---
  const rawLogPath = join(LOGS_DIR, `${taskId}-raw.log`);
  const activityLogPath = join(LOGS_DIR, `${taskId}-activity.log`);
  const rawStream = createWriteStream(rawLogPath, { flags: "a" });
  const activityStream = createWriteStream(activityLogPath, { flags: "a" });

  const logTimestamp = () => new Date().toISOString();
  activityStream.write(`[${logTimestamp()}] TASK STARTED: ${task.slice(0, 500)}\n`);
  if (agentId) activityStream.write(`[${logTimestamp()}] AGENT: ${agentId}\n`);
  if (projectId) activityStream.write(`[${logTimestamp()}] PROJECT: ${projectId}\n`);

  // CRITICAL: Bound stdout/stderr in memory to prevent OOM on long tasks.
  // Claude CLI emits 100s of MB of stream-json over a long video/audio task.
  // The full stream is already written to disk (rawStream); we only keep a
  // sliding TAIL in memory — all downstream consumers (detectLlmLimit, error
  // extraction, result fallback) read end-of-stream content anyway.
  const STDOUT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB tail
  const STDERR_MAX_BYTES = 256 * 1024;       // 256 KB tail
  let stdout = "";
  let stderr = "";
  let stdoutTotalBytes = 0;
  let chunkCount = 0;
  // Structured activity entries for quick access.
  // CRITICAL: cap the array — only the most recent entries are used (the
  // builder reads the LAST result entry or last 3 text entries). A long task
  // with hundreds of tool calls can otherwise hold 50+ MB in memory.
  const ACTIVITY_ENTRIES_MAX = 200;
  const activityEntries = [];
  const pushActivityEntry = (entry) => {
    activityEntries.push(entry);
    if (activityEntries.length > ACTIVITY_ENTRIES_MAX) {
      activityEntries.splice(0, activityEntries.length - ACTIVITY_ENTRIES_MAX);
    }
  };
  // Retry-loop check cadence (watch only, non-blocking)
  let lastRetryCheckTime = Date.now();

  // ── Adaptive FINAL_OUTPUT watchdog ──
  // The CLI emits a 'result' event when its turn is over, but a Bash(run_in_background)
  // child can keep running long after. We arm a 10s SIGTERM watchdog ONLY when
  // final result has been seen AND no bg tasks are tracked active. Every bg
  // started/completed event re-evaluates the condition.
  const activeBgTasks = new Set();
  let finalResultSeen = false;
  let finalOutputWatchdog = null;
  let killedAfterFinalOutput = false;
  // Decouple slot from CLI lifetime: once the CLI emits its `result`, the
  // agent's turn is logically over even if bg jobs are still running. We
  // release the slot immediately so the queue can pick the next instruction.
  // The CLI process may stay alive for bg observation; the bg-watcher
  // handles late completion via OS PID polling, independent of CLI lifetime.
  let slotReleased = false;

  const armWatchdogIfReady = () => {
    if (!finalResultSeen) return;
    if (finalOutputWatchdog) return;
    // Skip if a tracked bg task is still active: killing the CLI process
    // group would also kill the bg child (Bash(run_in_background) lives in
    // the CLI's pgid, not a detached one). We learned this the hard way:
    // Matteo's 200-email batch was killed after 6 min instead of running
    // 1h30. The bg-watcher takes over: when the bg finishes naturally, it
    // calls onBgTaskNotification which removes it from activeBgTasks and
    // re-evaluates here. The CLI exits cleanly afterwards.
    if (activeBgTasks.size > 0) return;
    finalOutputWatchdog = setTimeout(() => {
      if (!processHandles.has(taskId)) return;
      log(`[TASK ${taskId}] FINAL_OUTPUT grace expired — terminating CLI`);
      activityStream.write(`[${logTimestamp()}] FINAL_OUTPUT grace expired — terminating\n`);
      killedAfterFinalOutput = true;
      killProcessTree(child, "SIGTERM");
      setTimeout(() => {
        if (processHandles.has(taskId)) killProcessTree(child, "SIGKILL");
      }, 2000);
    }, 10_000);
  };

  const disarmWatchdog = () => {
    if (finalOutputWatchdog) {
      clearTimeout(finalOutputWatchdog);
      finalOutputWatchdog = null;
    }
  };

  // Parse callbacks — profile.parseStdoutLine dispatches to these
  const sseLimit = isVerbose ? 2000 : 300;
  const emitRunnerEvent = (runnerType, legacyType, detail) => {
    if (parityV2Enabled) {
      // New normalized event family
      emitTaskEvent(taskId, runnerType, detail);
      // Legacy compatibility alias (kept for one migration cycle)
      if (legacyType && legacyType !== runnerType) {
        emitTaskEvent(taskId, legacyType, detail);
      }
    } else {
      emitTaskEvent(taskId, legacyType || runnerType, detail);
    }
  };
  const parseCallbacks = {
    onThreadStarted(threadId) {
      if (runnerId !== "codex" || !parityV2Enabled) return;
      log(`[TASK ${taskId}] Codex thread started: ${threadId}`);
      updateTaskRunnerContext(taskId, {
        runnerId: "codex",
        runnerThreadId: threadId,
      }).catch((err) => {
        log(`[TASK ${taskId}] Failed to persist Codex thread_id: ${err.message}`);
      });
      if (resumeAgentId) {
        updateAgentRunnerSession(resumeAgentId, "codex", threadId).catch((err) => {
          log(`[TASK ${taskId}] Failed to persist Codex thread_id for agent ${resumeAgentId}: ${err.message}`);
        });
      }
    },
    onToolUse(toolName, detailShort, detailFull, toolId) {
      log(`[TASK ${taskId}] TOOL: ${toolName} → ${detailShort}`);
      const payload = {
        tool: toolName,
        detail: detailShort,
        ...(isVerbose ? { fullInput: detailFull, toolId } : {}),
      };
      emitRunnerEvent("runner_tool_use", "tool_use", payload);
      activityStream.write(`[${logTimestamp()}] TOOL: ${toolName} → ${isVerbose ? detailFull : detailShort}\n`);
      pushActivityEntry({ type: "tool", tool: toolName, detail: detailShort, time: logTimestamp() });

      // Retry-loop watch: every 60s, scan the last 30 monitored tool calls
      // (Bash + MCP only, see retry-detector.js) and emit a warning if the
      // same normalized call repeats beyond the threshold. Non-killing by
      // design — the agent sees the warning and can change approach; if it
      // stays stuck, the normal task timeout takes over.
      const now = Date.now();
      if (now - lastRetryCheckTime > 60000) {
        lastRetryCheckTime = now;
        (async () => {
          try {
            const { checkAndWarnRetryLoop } = await import('./retry-detector.js');
            const currentActivityLog = activityStream.path ? await readFile(activityStream.path, 'utf-8') : '';
            await checkAndWarnRetryLoop(taskId, currentActivityLog);
          } catch (err) {
            log(`[RETRY-DETECTOR] Error checking retry loop for task ${taskId}:`, err.message);
          }
        })();
      }
    },
    onText(textContent) {
      log(`[TASK ${taskId}] RUNNER: ${textContent.slice(0, 300)}`);
      emitRunnerEvent("runner_text", "claude_text", { text: textContent.slice(0, sseLimit) });
      activityStream.write(`[${logTimestamp()}] RUNNER: ${textContent}\n`);
      pushActivityEntry({ type: "text", text: textContent, time: logTimestamp() });
    },
    onToolResult(toolId, output) {
      if (isVerbose) {
        emitRunnerEvent("runner_tool_result", "tool_result", { toolId, output });
        activityStream.write(`[${logTimestamp()}] TOOL_RESULT: ${output}\n`);
      }
      // Extract media assetIds from tool results for post-task dispatch
      try {
        const parsed = typeof output === "string" ? JSON.parse(output) : output;
        if (parsed?.assetId && /^[a-f0-9]{12}$/i.test(parsed.assetId)) {
          if (!taskMediaAssets.has(taskId)) taskMediaAssets.set(taskId, []);
          taskMediaAssets.get(taskId).push(parsed.assetId);
        }
        if (Array.isArray(parsed?.assets)) {
          for (const a of parsed.assets) {
            if (a?.assetId && /^[a-f0-9]{12}$/i.test(a.assetId)) {
              if (!taskMediaAssets.has(taskId)) taskMediaAssets.set(taskId, []);
              taskMediaAssets.get(taskId).push(a.assetId);
            }
          }
        }
      } catch {}
    },
    onResult(costUsd, durationMs, resultData) {
      const resultInfo = `cost=$${costUsd?.toFixed(4) || "?"} duration=${durationMs || "?"}ms`;
      log(`[TASK ${taskId}] RESULT: ${resultInfo}`);
      emitRunnerEvent("runner_result", "result", { cost: costUsd, duration: durationMs });
      activityStream.write(`[${logTimestamp()}] RESULT: ${resultInfo}\n`);
      if (resultData) {
        const resultText = typeof resultData === "string" ? resultData : JSON.stringify(resultData);
        const limit = isVerbose ? 10000 : 5000;
        activityStream.write(`[${logTimestamp()}] FINAL_OUTPUT: ${resultText.slice(0, limit)}\n`);
        pushActivityEntry({ type: "result", text: resultText.slice(0, 3000), cost: costUsd, time: logTimestamp() });
      }
      // Adaptive watchdog: arm only if no bg tasks are still running.
      finalResultSeen = true;
      armWatchdogIfReady();
    },
    onBgTaskStarted(event) {
      const cliTaskId = event.task_id;
      if (!cliTaskId) return;
      activeBgTasks.add(cliTaskId);
      // Disarm any pending watchdog: a new bg job just started, killing
      // the CLI process group would kill the bg child too (same pgid).
      disarmWatchdog();
      log(`[TASK ${taskId}] BG_STARTED: ${cliTaskId} (${event.description || "no desc"})`);
      activityStream.write(`[${logTimestamp()}] BG_STARTED: ${cliTaskId} ${event.description || ""}\n`);
      emitTaskEvent(taskId, "bg_started", {
        cliTaskId,
        description: event.description,
        taskType: event.task_type,
      });
      // PID capture: the PreToolUse hook wrapped the bash command so the
      // spawned shell wrote its PID to /tmp/yabby-bg/<tool_use_id>.pid
      // *before* exec'ing the real command (so the PID survives the exec).
      // We poll briefly because the hook + shell may not have completed
      // by the time we observe `task_started`.
      const toolUseId = event.tool_use_id;
      const pidFile = toolUseId ? `/tmp/yabby-bg/${toolUseId}.pid` : null;
      (async () => {
        let pid = null;
        if (pidFile) {
          for (let i = 0; i < 10; i++) {
            try {
              const raw = await readFile(pidFile, "utf-8");
              const parsed = parseInt(raw.trim(), 10);
              if (Number.isFinite(parsed) && parsed > 0) {
                pid = parsed;
                break;
              }
            } catch { /* not yet */ }
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        if (pid) {
          log(`[TASK ${taskId}] BG_PID: ${cliTaskId} pid=${pid} file=${pidFile}`);
        } else if (pidFile) {
          log(`[TASK ${taskId}] BG_PID: ${cliTaskId} no pid file (hook may not have wrapped — fallback to CLI task_notification)`);
        }
        try {
          const { createBgTask } = await import("../db/queries/bg-tasks.js");
          await createBgTask({
            cliTaskId,
            yabbyTaskId: taskId,
            agentId,
            sessionId,
            toolUseId,
            description: event.description,
            taskType: event.task_type,
            pid,
            pidFile,
          });
        } catch (err) {
          log(`[BG] createBgTask failed: ${err.message}`);
        }
      })();
    },
    onBgTaskNotification(event) {
      const cliTaskId = event.task_id;
      if (!cliTaskId) return;
      const status = event.status; // completed | stopped | failed
      activeBgTasks.delete(cliTaskId);
      log(`[TASK ${taskId}] BG_NOTIF: ${cliTaskId} → ${status}`);
      activityStream.write(`[${logTimestamp()}] BG_NOTIF: ${cliTaskId} → ${status}\n`);
      emitTaskEvent(taskId, "bg_notification", { cliTaskId, status, summary: event.summary });
      import("../db/queries/bg-tasks.js").then(({ markBgTaskNotification }) =>
        markBgTaskNotification(cliTaskId, {
          status,
          outputFile: event.output_file,
          summary: event.summary,
          usage: event.usage || null,
        }).catch((err) => log(`[BG] markBgTaskNotification failed: ${err.message}`))
      );
      // A bg slot freed — re-evaluate the watchdog. When all tracked bg
      // jobs are done, this arms the 10s grace before terminating the CLI.
      // The bg-watcher (lib/bg-watcher.js) handles bridge enqueue centrally
      // for bg jobs that outlive the CLI (detached via process group).
      armWatchdogIfReady();
    },
  };

  child.stdout.on("data", (chunk) => {
    chunkCount++;
    const text = chunk.toString();
    stdoutTotalBytes += text.length;
    // Sliding tail: append, then trim to last STDOUT_MAX_BYTES if oversized.
    stdout += text;
    if (stdout.length > STDOUT_MAX_BYTES) {
      stdout = stdout.slice(stdout.length - STDOUT_MAX_BYTES);
    }
    rawStream.write(text);
    const preview = text.slice(0, 500).trim();
    log(`[TASK ${taskId}] stdout #${chunkCount}:`, preview);

    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      profile.parseStdoutLine(trimmed, parseCallbacks, isVerbose);
    }
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    // Sliding tail for stderr too.
    stderr += text;
    if (stderr.length > STDERR_MAX_BYTES) {
      stderr = stderr.slice(stderr.length - STDERR_MAX_BYTES);
    }
    rawStream.write(`[STDERR] ${text}`);
    const limit = isVerbose ? 2000 : 500;
    const preview = text.slice(0, limit).trim();
    log(`[TASK ${taskId}] stderr:`, preview.slice(0, 500));
    emitTaskEvent(taskId, "stderr", { text: preview });
    activityStream.write(`[${logTimestamp()}] STDERR: ${preview}\n`);
  });

  child.on("close", async (code) => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    log(`[TASK ${taskId}] Exited code=${code} in ${elapsed}s (${chunkCount} chunks, ${stdoutTotalBytes} total bytes, tail ${stdout.length})`);
    activityStream.write(`[${logTimestamp()}] EXITED: code=${code} elapsed=${elapsed}s\n`);

    // Clear the adaptive watchdog if still armed (natural exit or watchdog-driven).
    disarmWatchdog();

    // Any bg task still 'running' in DB at close is now orphaned — the parent
    // CLI is gone and won't emit task_notification anymore. SIGTERM of the
    // process group typically kills bg children too, but a detached (nohup)
    // child could survive; either way, we mark the DB row 'orphaned' so the
    // UI doesn't show stale 'running' entries forever.
    import("../db/queries/bg-tasks.js")
      .then(({ markOrphanedBgTasksDead }) => markOrphanedBgTasksDead(taskId))
      .then((orphaned) => {
        if (orphaned && orphaned.length > 0) {
          log(`[TASK ${taskId}] marked ${orphaned.length} orphaned bg_tasks: ${orphaned.join(", ")}`);
        }
      })
      .catch((err) => log(`[BG] markOrphanedBgTasksDead failed: ${err.message}`));

    rawStream.end();
    activityStream.end();

    processHandles.delete(taskId);
    markSessionFree(sessionId);

    // ✅ FIX: If agentId/projectId not in closure (continued task), read from DB
    let taskAgentId = agentId;
    let taskProjectId = projectId;

    if (!taskAgentId || !taskProjectId) {
      try {
        const taskRecord = await getTask(taskId);
        if (!taskAgentId) taskAgentId = taskRecord?.agent_id;
        if (!taskProjectId) taskProjectId = taskRecord?.project_id;
        log(`[TASK ${taskId}] ✅ Retrieved from DB: agentId=${taskAgentId || 'none'}, projectId=${taskProjectId || 'none'}`);
      } catch (err) {
        log(`[TASK ${taskId}] ⚠️ Could not read task from DB:`, err.message);
      }
    }

    const currentStatus = await getTaskStatus(taskId);
    if (currentStatus === "paused" || currentStatus === "killed") {
      emitTaskEvent(taskId, "status", { status: currentStatus, elapsed });
      return;
    }

    // ───────────────────────────────────────────────────────────────
    // LLM RATE LIMIT DETECTION (must come BEFORE error handling)
    // If Claude CLI hit its daily quota, mark task as paused_llm_limit
    // so it can be resumed manually (voice command or topbar button).
    // ───────────────────────────────────────────────────────────────
    if (code !== 0) {
      const limitInfo = detectLlmLimit(stdout, stderr);
      if (limitInfo) {
        log(`[TASK ${taskId}] LLM limit reached (reset: ${limitInfo.resetAt || "unknown"})`);
        await markTaskLlmLimited(taskId, limitInfo.resetAt, elapsed);
        emitTaskEvent(taskId, "status", {
          status: "paused_llm_limit",
          elapsed,
          resetAt: limitInfo.resetAt,
        });
        await logEvent("task_llm_limit", {
          projectId: taskProjectId, agentId: taskAgentId, taskId,
          detail: { resetAt: limitInfo.resetAt, elapsed },
        });
        return; // CRITICAL: do NOT fall through to error handling
      }
    }

    // Build a structured summary from activity entries for DB storage
    let resultSummary = "";
    const textEntries = activityEntries.filter(e => e.type === "text");
    const resultEntries = activityEntries.filter(e => e.type === "result");
    const toolEntries = activityEntries.filter(e => e.type === "tool");

    if (resultEntries.length > 0) {
      resultSummary = resultEntries[resultEntries.length - 1].text;
    } else if (textEntries.length > 0) {
      // Use the last few text entries as summary
      resultSummary = textEntries.slice(-3).map(e => e.text).join("\n\n");
    }

    if (code !== 0 && !killedAfterFinalOutput) {
      // killedAfterFinalOutput=true means the watchdog SIGTERM'd the CLI
      // after a clean final_result with no active bg tasks — that's a
      // successful task, not an error. Skip the error branch.
      // Check for session errors in both stderr and stdout (Claude CLI outputs error JSON to stdout)
      const errMsg = stderr || stdout || `Process exited avec code ${code}`;

      // A session is actually "stale" only when Claude Code says it couldn't find
      // the .jsonl file on disk. error_during_execution is NOT a stale session — it's
      // a mid-turn failure (network, tool crash, API error) and the session is still
      // resumable. See: https://code.claude.com/docs/en/agent-sdk/sessions
      const isTrueStaleSession = /No conversation found with session ID|no rollout found for thread id/i.test(errMsg);
      if (isResume && isTrueStaleSession) {
        log(`[TASK ${taskId}] Resume failed (stale session) — retrying with fresh session`);
        try {
          const { default: pool } = await import("../db/pg.js");
          const freshSessionId = randomUUID();

          // ✅ FIX: Keep SAME taskId for agent tasks (persistent), only create new task for standalone
          if (taskAgentId) {
            // Agent task: update session_id but keep taskId
            log(`[TASK ${taskId}] Agent task detected — keeping same taskId, updating session`);
            await pool.query(`UPDATE agents SET session_id = $1 WHERE id = $2`, [freshSessionId, taskAgentId]);
            await pool.query(`UPDATE tasks SET session_id = $1 WHERE id = $2`, [freshSessionId, taskId]);

            // Re-spawn with SAME taskId but fresh session (isRetry=true skips createTask)
            await spawnClaudeTask(taskId, freshSessionId, task, false, {
              agentId: taskAgentId,
              projectId: taskProjectId,
              title: title,
              isRetry: true, // Skip task creation
              runnerIdOverride: runnerId,
            });
            log(`[TASK ${taskId}] Retried with fresh session ${freshSessionId} (same taskId)`);
            return; // Don't process further
          } else {
            // Standalone task: create brand new task
            const freshTaskId = randomUUID().slice(0, 8);
            await updateTaskStatus(taskId, "error", null, "Stale session — retried as " + freshTaskId, elapsed);

            await spawnClaudeTask(freshTaskId, freshSessionId, task, false, {
              agentId: taskAgentId,
              projectId: taskProjectId,
              title: title ? title.replace(/\[retry\]/g, '') + ' [retry]' : '[Retry] Task',
              runnerIdOverride: runnerId,
            });
            log(`[TASK ${taskId}] Retried as new task ${freshTaskId} with fresh session`);
            return;
          }
        } catch (retryErr) {
          log(`[TASK ${taskId}] Fresh session retry also failed: ${retryErr.message}`);
          // Fall through to normal error handling
        }
      }

      // Retry once on transient mid-turn failures (error_during_execution).
      // These are network/tool/API hiccups — the session is still on disk and resumable.
      // We only retry if this wasn't already a retry (to avoid infinite loops).
      const isTransientFailure = /error_during_execution/i.test(errMsg);
      if (isResume && isTransientFailure && !isRetry) {
        log(`[TASK ${taskId}] Transient mid-turn failure detected — retrying once with same session`);
        try {
          await spawnClaudeTask(taskId, sessionId, task, true, {
            agentId: taskAgentId,
            projectId: taskProjectId,
            title,
            isRetry: true,
            runnerIdOverride: runnerId,
          });
          log(`[TASK ${taskId}] Transient retry completed`);
          return;
        } catch (retryErr) {
          log(`[TASK ${taskId}] Transient retry failed: ${retryErr.message}`);
          // Fall through to normal error handling
        }
      }

      await updateTaskStatus(taskId, "error", "Error: " + errMsg, errMsg, elapsed);

      // Notify error for simple tasks (no agent)
      if (!taskAgentId) {
        // ✅ NOUVEAU: Récupérer le contexte de création
        const taskRecord = await getTask(taskId);
        const createdBySpeaker = taskRecord?.created_by_speaker;
        const taskConversationId = taskRecord?.conversation_id;
        const speakerMeta = taskRecord?.speaker_metadata;

        let notifMessage;
        let enrichedContext = {};

        const m = serverMsg();
        if (createdBySpeaker && speakerMeta) {
          const utterance = speakerMeta.utterance || m.userTask;
          const createdAt = speakerMeta.timestamp
            ? new Date(speakerMeta.timestamp).toLocaleString('en-US')
            : null;

          const contextPrefix = m.contextPrefix(utterance, createdAt);
          notifMessage = `${contextPrefix}\n\n${m.taskFailedFull(elapsed, errMsg.slice(0, 200))}`;
          enrichedContext = { conversationId: taskConversationId, taskId, speakerMetadata: speakerMeta };
        } else {
          notifMessage = m.taskFailed(taskId.substring(0, 8), elapsed, errMsg.substring(0, 200));
        }

        emitSpeakerNotification(null, taskProjectId, "error", notifMessage, enrichedContext);
      }
    } else {
      let result = resultSummary || stdout || serverMsg().taskCompletedNoResult;
      // Store more in DB (up to 10KB) — full logs are on disk
      if (result.length > 10000) {
        result = result.slice(0, 9500) + `\n\n[... tronqué, ${result.length} chars total. Logs complets: logs/${taskId}-activity.log]`;
      }
      await updateTaskStatus(taskId, "done", result, null, elapsed);

      // Notify completion for simple tasks (no agent)
      if (!taskAgentId) {
        // ✅ NOUVEAU: Récupérer le contexte de création
        const taskRecord = await getTask(taskId);
        const createdBySpeaker = taskRecord?.created_by_speaker;
        const taskConversationId = taskRecord?.conversation_id;
        const speakerMeta = taskRecord?.speaker_metadata;

        let notifMessage;
        let enrichedContext = {};

        const m = serverMsg();
        if (createdBySpeaker && speakerMeta) {
          const utterance = speakerMeta.utterance || m.userTask;
          const createdAt = speakerMeta.timestamp
            ? new Date(speakerMeta.timestamp).toLocaleString('en-US')
            : null;

          const contextPrefix = m.contextPrefix(utterance, createdAt);
          notifMessage = `${contextPrefix}\n\n${m.taskCompletedFull(elapsed, result.slice(0, 300))}`;
          enrichedContext = { conversationId: taskConversationId, taskId, speakerMetadata: speakerMeta };
        } else {
          notifMessage = m.taskCompleted(taskId.substring(0, 8), elapsed, result.slice(0, 200));
        }

        emitSpeakerNotification(null, taskProjectId, "complete", notifMessage, enrichedContext);
      }
    }

    await logEvent("task_completed", {
      projectId: taskProjectId, agentId: taskAgentId, taskId,
      detail: { code, elapsed, toolsUsed: toolEntries.length, logFile: `logs/${taskId}-activity.log` },
    });

    // === AUTO-NOTIFICATION CHAIN (MULTI-LEVEL) ===
    if (taskAgentId) {
      try {
        const completedAgent = await getAgent(taskAgentId);

        if (!completedAgent) { /* agent deleted? skip */ }
        else {
          if (code === 0 || killedAfterFinalOutput) {
            // SUCCESS NOTIFICATIONS
            // killedAfterFinalOutput=true means the watchdog SIGTERM'd the CLI
            // after a clean final_result with no active bg tasks — treat as
            // success (exit code is 143 from SIGTERM, not a real failure).
            // 1. Agent with parent → notify parent
            if (completedAgent.parentAgentId) {
              const summaryForParent = resultSummary ? resultSummary.slice(0, 2000) : serverMsg().taskCompletedNoResult;
              await agentSend(taskAgentId, completedAgent.parentAgentId, completedAgent.projectId,
                serverMsg().agentTaskDone(completedAgent.name, completedAgent.role, elapsed, summaryForParent),
                "task_complete"
              );
              log(`[NOTIFY] ${completedAgent.name} → parent ${completedAgent.parentAgentId}: task complete`);
            }

            // 2. Top-level agent (no parent) → notify speaker with result
            if (!completedAgent.parentAgentId) {
              const taskResult = resultSummary || stdout || "";
              // Extract the last agent_message from raw output if available
              let resultText = "";
              try {
                const lines = (stdout || "").split("\n").filter(l => l.trim());
                for (let i = lines.length - 1; i >= 0; i--) {
                  const parsed = JSON.parse(lines[i]);
                  if (parsed.type === "item.completed" && parsed.item?.type === "agent_message" && parsed.item?.text) {
                    resultText = parsed.item.text;
                    break;
                  }
                }
              } catch {}
              const resultPreview = resultText || taskResult.slice(0, 2000) || "Task completed.";
              // Cap at 4000 chars for channel messages
              const cappedResult = resultPreview.length > 4000 ? resultPreview.slice(0, 3900) + "\n\n[... truncated]" : resultPreview;

              // ✅ FIX: Fetch phase from DB (was previously referencing undeclared `taskMetadata`
              // which threw a ReferenceError and silently killed the entire notification chain,
              // causing Yabby's persistent queue tasks to never emit speaker notifications —
              // especially visible when voice was in sleep mode).
              const taskRecord = await getTask(taskId);
              const taskPhase = taskRecord?.phase;

              // Yabby super-agent ALWAYS uses the full notification path so the user gets the
              // result on web chat + WhatsApp even when voice is in sleep mode. Only project lead
              // agents in genuine discovery phase get the light SSE-only notification.
              if (taskPhase === 'discovery' && !completedAgent.isSuperAgent) {
                // Discovery phase: light notification only (SSE, no channels)
                log(`[TASK ${taskId}] Discovery phase task completed - light notification only`);
                const { emitDiscoveryQuestionNotification } = await import("./logger.js");
                emitDiscoveryQuestionNotification(completedAgent, completedAgent.projectId, {
                  question: cappedResult.substring(0, 200),
                  elapsed
                });
              } else {
                // Detect agents that have their own WhatsApp delivery path
                // (sendResultToWhatsAppThread in agent-task-processor.js). For those agents,
                // emitting a milestone notification here would result in DUPLICATE messages
                // in their WhatsApp thread — path A reformulation here + path B raw send from
                // sendResultToWhatsAppThread. Suppress path A; path B handles delivery and
                // also emits its own conversation_update SSE event.
                //
                // The Yabby super-agent NEVER has an agent_whatsapp_groups row (it uses the
                // shared main group via _yabbyGroupId), so it falls through this gate and
                // keeps emitting milestones — main group + web Yabby chat keep working.
                // Channel delivery (WhatsApp / Telegram / Discord / Slack +
                // web chat refresh) is now handled centrally by
                // sendResultToWhatsAppThread → deliverTaskMessage in
                // agent-task-processor.js, which fires for EVERY queued task
                // (including Yabby super-agent and agents with any binding).
                //
                // We still want the SSE `speaker_notify` event to fire so the
                // voice toast / WS clients learn about the completion — but
                // we MUST skip the broadcastToChannels call inside
                // emitSpeakerNotification, otherwise the same completion +
                // reformulated follow-up are written twice into the agent
                // conversation (and sent twice to WhatsApp / Telegram).
                //
                // Pre-Phase-1 the suppression was gated on getAgentWhatsAppGroup
                // and Yabby super-agent fell through to emit a duplicate path;
                // that path is no longer needed because deliverTaskMessage
                // covers Yabby via _yabbyGroupId + queueTask.source_id origin.
                emitSpeakerNotification(
                  completedAgent,
                  completedAgent.projectId,
                  "milestone",
                  serverMsg().taskCompletedFull(elapsed, cappedResult),
                  { skipChannelBroadcast: true }
                );
                log(`[NOTIFY] Top-level ${completedAgent.name} → speaker SSE only (deliverTaskMessage handles channels)`);
              }
            }

            // 3. Manager (has children or isLead) → trigger orchestrator to check inbox
            const children = await getSubAgents(taskAgentId);
            if (children.length > 0 || completedAgent.isLead) {
              if (_onManagerTaskComplete) _onManagerTaskComplete(completedAgent.id, completedAgent.projectId);
            }

            // 4. Lead auto-poke: if this lead has nothing else queued/running
            // and the project is still active, drop a single "continue" on
            // their queue. Their existing system prompt knows what to do —
            // re-read PLAN.md, advance the next milestone, or mark the
            // project completed. Without this poke, leads can stall after a
            // task finishes when no sub-agent fires task_complete to wake
            // the orchestrator review path.
            //
            // Skipped while a plan_review is pending — the lead just
            // submitted a plan and explicitly ended their task to await
            // user decision. Poking them now causes them to start PHASE 2
            // (creating agents, dispatching work) on an unapproved plan.
            // Wait until the user resolves the plan_review (approve →
            // routes/plan-reviews.js enqueues the kickoff task; revise →
            // enqueues the re-plan task; cancel → archives the project).
            if (completedAgent.isLead && completedAgent.projectId) {
              try {
                const project = await getProject(completedAgent.projectId);
                if (project && project.status === "active") {
                  // Both gates check the same pattern: lead submitted
                  // something that requires a user decision and explicitly
                  // ended their task. Auto-poking now would race the user.
                  const pendingPlan = await pgQuery(
                    `SELECT 1 FROM plan_reviews
                     WHERE project_id = $1 AND status = 'pending' LIMIT 1`,
                    [completedAgent.projectId]
                  );
                  const pendingQuestion = await pgQuery(
                    `SELECT 1 FROM project_questions
                     WHERE project_id = $1 AND status = 'pending' LIMIT 1`,
                    [completedAgent.projectId]
                  );
                  // Project is delivered when an active presentation has its
                  // demo passing — re-poking the lead would loop on "done"
                  // replies (see Comedy Club incident 2026-05-12).
                  const presentationPassed = await pgQuery(
                    `SELECT 1 FROM presentations
                     WHERE project_id = $1
                       AND status = 'ready'
                       AND last_run_status = 'passed'
                     LIMIT 1`,
                    [completedAgent.projectId]
                  );
                  if (pendingPlan.rows.length > 0) {
                    log(`[CONTINUE] Lead ${completedAgent.name} has a pending plan_review — skipping auto-poke (waiting for user decision)`);
                  } else if (pendingQuestion.rows.length > 0) {
                    log(`[CONTINUE] Lead ${completedAgent.name} has pending project_questions — skipping auto-poke (waiting for user answers)`);
                  } else if (presentationPassed.rows.length > 0) {
                    log(`[CONTINUE] Lead ${completedAgent.name} — presentation passed, project delivered — skipping auto-poke`);
                  } else {
                    const queueLen = await getQueueLength(completedAgent.id);
                    const runningOther = await pgQuery(
                      `SELECT 1 FROM tasks
                       WHERE agent_id = $1 AND status = 'running' AND id <> $2 LIMIT 1`,
                      [completedAgent.id, taskId]
                    );
                    if (queueLen === 0 && runningOther.rows.length === 0) {
                      await enqueueTask(
                        completedAgent.id,
                        "continue\n\nIf the project is fully delivered, the last step is the presentation: call presentation_status, and if none exists yet, create_presentation with a working start.sh. The project is not done until the user has a runnable demo.",
                        "plan_continuation",
                        null,
                        50,
                        "Continue"
                      );
                      log(`[CONTINUE] Lead ${completedAgent.name} idle on active project — enqueued 'continue' poke`);
                      setImmediate(async () => {
                        try {
                          const { processAgentQueue } = await import("./agent-task-processor.js");
                          await processAgentQueue(completedAgent.id);
                        } catch (err) {
                          log(`[CONTINUE] processAgentQueue failed: ${err.message}`);
                        }
                      });
                    }
                  }
                }
              } catch (err) {
                log(`[CONTINUE] auto-poke failed for ${completedAgent.name}: ${err.message}`);
              }
            }
          } else {
            // ERROR NOTIFICATIONS
            const errMsg = stderr || `Process exited with code ${code}`;
            const shortErr = errMsg.substring(0, 200);

            // Notify parent or speaker about error
            if (completedAgent.parentAgentId) {
              await agentSend(taskAgentId, completedAgent.parentAgentId, completedAgent.projectId,
                serverMsg().agentTaskFailed(completedAgent.name, elapsed, shortErr),
                "task_error"
              );
            } else {
              emitSpeakerNotification(completedAgent, completedAgent.projectId, "error",
                serverMsg().agentTaskFailed(completedAgent.name, elapsed, shortErr)
              );
            }
          }
        }
      } catch (err) {
        log(`[NOTIFY] Chain error:`, err.message);
      }
    }

    // ─── DEFERRED PLAN REVIEW EMISSION ────────────────────────────────
    // When a lead agent submitted a plan via POST /api/plan-reviews while
    // its CLI task was still running, the row was persisted with
    // pending_emission=TRUE and modal/voice notifications were withheld.
    // Now that the task has exited, we fire the consolidated emission
    // ONCE: modal opens for the user, voice announces the plan is ready,
    // and we flip pending_emission=FALSE so a resume / retry doesn't
    // re-trigger the modal.
    //
    // Fires regardless of exit code — if the task crashed AFTER submitting
    // the plan, the user can still review what was proposed and decide
    // whether to approve, revise, or cancel.
    try {
      const pendingReview = await getPendingEmissionByTaskId(taskId);
      if (pendingReview) {
        log(`[PLAN-DEFER] Task ${taskId} exited (code=${code}) — firing deferred plan_review ${pendingReview.id} (v${pendingReview.version})`);
        let projectName = pendingReview.projectId;
        let leadAgentName = pendingReview.agentId;
        try {
          const project = await getProject(pendingReview.projectId);
          if (project?.name) projectName = project.name;
          const reviewAgent = await getAgent(pendingReview.agentId);
          if (reviewAgent?.name) leadAgentName = reviewAgent.name;
          // Notification message is intentionally short — the modal carries
          // the full plan content. Channels get the clean short FR reply
          // forwarded by notification-listener once Realtime persists its
          // reply to handleSSEPlanReview.
          const notifMessage = `${leadAgentName} has submitted a plan for "${projectName}" (v${pendingReview.version}). Open the dashboard to review and approve, revise, or cancel.`;
          emitSpeakerNotification(reviewAgent || null, pendingReview.projectId, "milestone", notifMessage, {
            skipVoiceAnnouncement: true,
            skipChannelBroadcast: true,
          });
          // Generate a short voice-friendly summary of the plan (in the
          // user's language) so the speaker can announce the gist instead
          // of a generic "plan ready" — frontend handleSSEPlanReview uses
          // it to drive Realtime's spoken reply.
          let planSummary = null;
          try {
            const { summarizePlanForVoice } = await import("./channels/notification-listener.js");
            planSummary = await summarizePlanForVoice(pendingReview.planContent, leadAgentName, projectName);
            if (planSummary) {
              log(`[PLAN-DEFER] Voice summary: "${planSummary.slice(0, 80)}..."`);
            }
          } catch (sumErr) {
            log(`[PLAN-DEFER] Voice summary generation failed (will fall back to generic prompt): ${sumErr.message}`);
          }
          emitPlanReviewEvent({
            reviewId: pendingReview.id,
            planContent: pendingReview.planContent,
            planSummary,
            projectId: pendingReview.projectId,
            projectName,
            agentId: pendingReview.agentId,
            agentName: leadAgentName,
            version: pendingReview.version,
          });
          await markPlanReviewShown(pendingReview.id);
        } catch (emitErr) {
          log(`[PLAN-DEFER] Emission threw (still flipping flag to avoid re-fire): ${emitErr.message}`);
        }
        // Flip the flag last so a partial failure above can be diagnosed
        // from the remaining pending_emission=TRUE row, but a successful
        // emission cleanly closes the loop.
        try {
          await markPlanReviewEmitted(pendingReview.id);
          log(`[PLAN-DEFER] ✅ plan_review ${pendingReview.id} emitted; pending_emission flipped to FALSE`);
        } catch (markErr) {
          log(`[PLAN-DEFER] markEmitted failed (will re-fire on next task exit if any): ${markErr.message}`);
        }
      }
    } catch (deferErr) {
      log(`[PLAN-DEFER] Deferred-emission lookup failed (non-fatal): ${deferErr.message}`);
    }

    const finalStatus = await getTaskStatus(taskId);
    emitTaskEvent(taskId, "status", { status: finalStatus, elapsed, code });
    // Emit on the task-completion bus so agent-task-processor can finalize
    // the queue item without polling. Only terminal statuses are broadcast;
    // the bus itself filters non-terminal ones.
    emitTaskCompleted(taskId, { status: finalStatus, code, elapsed });
  });

  child.on("error", async (err) => {
    log(`[TASK ${taskId}] Spawn error:`, err.message);
    processHandles.delete(taskId);
    markSessionFree(sessionId);
    await updateTaskStatus(taskId, "error", "Error: " + err.message, err.message);
    emitTaskEvent(taskId, "status", { status: "error", error: err.message });
    emitTaskCompleted(taskId, { status: "error", error: err.message });
  });
}
