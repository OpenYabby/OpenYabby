import { Router } from "express";
import { randomUUID } from "crypto";
import { execSync } from "child_process";
import { readFile } from "fs/promises";
import { existsSync, accessSync, mkdirSync, constants as fsConstants } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getTask, getTaskStatus, listTasks, listSimpleTasks, archiveTask, updateTaskStatus, searchTasksByText, getRecentTasks, getTaskStats, getTaskRunnerContext } from "../db/queries/tasks.js";
import { getAgent, findAgentByName, isStandaloneAgent, getActiveTaskId } from "../db/queries/agents.js";
import { getLockState, releaseLock } from "../db/queries/guilock.js";
import { spawnClaudeTask, genTaskId, processHandles, killProcessTree } from "../lib/spawner.js";
import { getRunnerProfile } from "../lib/runner-profiles.js";
import { log } from "../lib/logger.js";
import { getConfig } from "../lib/config.js";
import { enqueueTask, getQueueLength } from "../db/queries/agent-task-queue.js";
import { processAgentQueue } from "../lib/agent-task-processor.js";
import { query as pgQuery } from "../db/pg.js";

const LOGS_DIR = join(process.cwd(), "logs");

const router = Router();

function registerTaskControlRoute(path, handler) {
  router.post(`/claude/${path}`, handler);
  router.post(`/api/tasks/${path}`, handler);
}

async function resolveTaskResumeRunner(taskId) {
  const configuredRunnerId = getConfig("tasks")?.runner || "claude";
  try {
    const ctx = await getTaskRunnerContext(taskId);
    return ctx?.runnerId || configuredRunnerId;
  } catch {
    return configuredRunnerId;
  }
}

// List all tasks
router.get("/api/tasks", async (_req, res) => {
  try {
    const allTasks = await listTasks();
    const lock = await getLockState();
    const list = allTasks.map(t => {
      // Get last log timestamp for more accurate sorting
      let lastLogTime = t.updated_at || t.created_at;
      try {
        const activityLogPath = join(LOGS_DIR, `${t.id}-activity.log`);
        if (existsSync(activityLogPath)) {
          const stats = require('fs').statSync(activityLogPath);
          lastLogTime = stats.mtime;
        }
      } catch {}

      return {
        id: t.id,
        sessionId: t.sessionId,
        status: t.status,
        elapsed: t.elapsed || Math.round((Date.now() - t.startTime) / 1000),
        startTime: t.startTime,
        result: t.status === "done" || t.status === "error" ? t.result?.slice(0, 500) : undefined,
        project_id: t.project_id,
        agent_id: t.agent_id,
        title: t.title,
        created_at: t.created_at,
        updated_at: t.updated_at,
        last_log_time: lastLogTime,
      };
    });
    res.json({ tasks: list, guiLock: lock });
  } catch (err) {
    log("[TASKS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Start a new task
registerTaskControlRoute("start", async (req, res) => {
  const {
    task, agent_id, project_id, title,
    // Speaker context
    conversation_id, created_by_speaker, speaker_metadata,
    // Channel origin (for routing the result back to Telegram/Discord/etc.)
    origin_channel, origin_channel_id,
    // Caller identity (for hierarchy validation when an LLM agent dispatches
    // a task to another agent). Optional: when missing, no validation runs.
    from_agent_id, fromAgentId, caller_agent_id,
  } = req.body;
  log(`[START] ════════════════════ NEW TASK ════════════════════`);
  log(`[START] agent_id: ${agent_id || '(none)'}`);
  log(`[START] project_id: ${project_id || '(none)'}`);
  log(`[START] task (${task?.length || 0} chars):`);
  log(`[START] ┌─────────────────────────────────────────────`);
  (task || '').split('\n').forEach(line => {
    log(`[START] │ ${line}`);
  });
  log(`[START] └─────────────────────────────────────────────`);

  if (!task || typeof task !== "string") {
    return res.status(400).json({ error: "Missing task string" });
  }

  // ─── Hierarchy validation: caller can only dispatch to direct reports ──
  // Same logic as in talk_to_agent — when an LLM agent inside a project
  // tries to start a task for another project agent, validate that the
  // target is its direct report. Skip when:
  //   • no from_agent_id was passed (legacy / human / scheduled)
  //   • caller is Yabby super-agent
  //   • caller targets itself
  //   • target agent is standalone (no project)
  const fromId = from_agent_id || fromAgentId || caller_agent_id || null;
  if (fromId && agent_id && fromId !== 'yabby-000000') {
    try {
      const targetAgent = await getAgent(agent_id) || await findAgentByName(agent_id);
      if (targetAgent && targetAgent.projectId && targetAgent.id !== fromId) {
        const callerAgent = await getAgent(fromId);
        if (callerAgent && callerAgent.projectId === targetAgent.projectId) {
          const isDirectReport = targetAgent.parentAgentId === fromId;
          if (!isDirectReport) {
            let actualParentName = 'NONE (the agent has no parent set)';
            const actualParentId = targetAgent.parentAgentId || null;
            if (targetAgent.parentAgentId) {
              try {
                const parent = await getAgent(targetAgent.parentAgentId);
                if (parent) actualParentName = parent.name;
              } catch { /* fall through */ }
            }
            log(`[START] ❌ REJECTED: ${callerAgent.name} (${callerAgent.id}) tried to start a task for ${targetAgent.name} (${targetAgent.id}) but ${targetAgent.name}'s parent is ${actualParentName} (${actualParentId || 'NULL'})`);
            return res.status(400).json({
              error: `Hierarchy violation: ${callerAgent.name} (you, id=${callerAgent.id}) tried to start a task for ${targetAgent.name} (id=${targetAgent.id}, role="${targetAgent.role}"), but ${targetAgent.name} is NOT your direct report.`,
              context: {
                you: { id: callerAgent.id, name: callerAgent.name, role: callerAgent.role, isLead: !!callerAgent.isLead },
                target: { id: targetAgent.id, name: targetAgent.name, role: targetAgent.role, parent_agent_id: actualParentId, parent_name: actualParentName },
                project_id: targetAgent.projectId,
              },
              hint: actualParentId
                ? `${targetAgent.name} reports to ${actualParentName} (id=${actualParentId}). Send this task to ${actualParentName} instead — they will decompose it and assign a piece to ${targetAgent.name}. Never bypass managers; the cascade is what makes the team scale.\n\nCorrect call:\n  POST /api/tools/execute  body={"toolName":"talk_to_agent","args":{"agent_id":"${actualParentId}","instruction":"<your milestone-level instruction including what ${targetAgent.name} should do>"}}`
                : `${targetAgent.name} has no parent set in the database — this is a data inconsistency. Skip this delegation and report it to the operator.`,
            });
          }
        }
      }
    } catch (validationErr) {
      log(`[START] hierarchy check failed (proceeding): ${validationErr.message}`);
    }
  }

  const taskId = genTaskId();
  let sessionId = randomUUID();
  let resolvedProjectId = project_id || null;

  // If agent_id is provided, use agent's session and resolve its project
  // Support both UUID and name resolution
  let resolvedAgentId = null;
  let resolvedAgentName = null;
  if (agent_id) {
    // Try exact ID first
    let agent = await getAgent(agent_id);

    // If not found, try name resolution
    if (!agent) {
      agent = await findAgentByName(agent_id);
    }

    // CRITICAL: Only use agent_id if we found a valid agent
    if (agent) {
      resolvedAgentId = agent.id; // Use the resolved UUID
      resolvedAgentName = agent.name;
      sessionId = agent.sessionId;
      // Auto-resolve project from agent if not explicitly provided
      if (!resolvedProjectId && agent.projectId) {
        resolvedProjectId = agent.projectId;
      }
    } else {
      // Agent not found - return error instead of crashing
      log(`[START] ERROR: Agent '${agent_id}' not found`);
      return res.status(404).json({
        error: `Agent not found: ${agent_id}. Please check the agent ID or name.`
      });
    }
  }

  // If agent is standalone, add to queue instead of direct spawn
  if (resolvedAgentId && await isStandaloneAgent(resolvedAgentId)) {
    log(`[START] Agent is standalone, enqueueing task`);

    try {
      const sourceId = (origin_channel && origin_channel_id)
        ? `${origin_channel}:${origin_channel_id}`
        : null;
      const queueItem = await enqueueTask(resolvedAgentId, task, 'api', sourceId, 50);
      const queueLength = await getQueueLength(resolvedAgentId);

      // Trigger the processor
      setImmediate(() => processAgentQueue(resolvedAgentId));

      // Return the active task ID (or null if first time)
      const activeTaskId = await getActiveTaskId(resolvedAgentId);

      return res.json({
        queued: true,
        queue_id: queueItem.id,
        queue_position: queueLength,
        task_id: activeTaskId, // May be null if first task
        status: "queued",
        message: `Instruction added to queue (${queueLength} task(s) pending)`
      });
    } catch (err) {
      log("[START] Error enqueueing task:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // Only the Yabby super-agent lands here (every other agent is routed through
  // the queue above). Title format: "[AgentName] Persistent task".
  const agentPrefix = resolvedAgentName ? `[${resolvedAgentName}] ` : '';
  const resolvedTitle = (title && String(title).trim().slice(0, 80)) || `${agentPrefix}Persistent task`;

  try {
    await spawnClaudeTask(taskId, sessionId, task, false, {
      agentId: resolvedAgentId,
      projectId: resolvedProjectId,
      title: resolvedTitle,
      // Pass speaker context to spawner
      conversationId: conversation_id,
      createdBySpeaker: created_by_speaker,
      speakerMetadata: speaker_metadata,
    });

    log(`[START] Task launched: ${taskId} — "${resolvedTitle}"`);
    res.json({ task_id: taskId, status: "running", title: resolvedTitle });
  } catch (err) {
    log("[START] Error spawning task:", err.message);
    // Handle database constraint errors gracefully
    if (err.code === '23503') {
      return res.status(400).json({
        error: "Invalid agent_id or project_id - referenced entity does not exist"
      });
    }
    return res.status(500).json({ error: err.message });
  }
});

// Check status of one or more tasks
registerTaskControlRoute("check", async (req, res) => {
  const { task_ids } = req.body;
  log("[CHECK] Checking:", task_ids);

  if (!task_ids || !Array.isArray(task_ids)) {
    return res.status(400).json({ error: "Missing task_ids array" });
  }

  const MAX_WAIT = 120_000;
  const POLL_INTERVAL = 1000;
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT) {
    const statuses = await Promise.all(task_ids.map(id => getTaskStatus(id)));
    const allDone = statuses.every(s => !s || s !== "running");
    if (allDone) break;

    const elapsed = Math.round((Date.now() - start) / 1000);
    if (elapsed > 0 && elapsed % 10 === 0) {
      log("[CHECK] Still waiting...", elapsed + "s");
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  const results = await Promise.all(task_ids.map(async (id) => {
    const entry = await getTask(id);
    if (!entry) return { id, status: "not_found" };
    const elapsed = entry.elapsed || Math.round((Date.now() - entry.startTime) / 1000);
    const out = { id, status: entry.status, elapsed };
    if (entry.status === "done" || entry.status === "error") {
      out.result = entry.result;
    }
    return out;
  }));

  log("[CHECK] Results:", results.map(r => `${r.id}=${r.status}`).join(", "));
  res.json({ tasks: results });
});

// Pause a running task
registerTaskControlRoute("pause", async (req, res) => {
  const { task_id } = req.body;
  log("[PAUSE] task_id:", task_id);

  if (!task_id) return res.status(400).json({ error: "Missing task_id" });

  const entry = await getTask(task_id);
  if (!entry) return res.status(404).json({ error: "Task not found: " + task_id });

  if (entry.status !== "running") {
    return res.json({ task_id, status: entry.status, message: "Task is not running" });
  }

  // CRITICAL: mark the task paused BEFORE sending SIGTERM. The spawner's
  // child.on("close") handler reads the task status from the DB and returns
  // early when it sees "paused"/"killed" — otherwise it falls into the error
  // branch and overwrites this with status="error".
  await updateTaskStatus(task_id, "paused", entry.result || "Task paused by the user.");
  await releaseLock(task_id);

  const child = processHandles.get(task_id);
  if (child) {
    try { killProcessTree(child, "SIGTERM"); } catch {}

    // Clean up the handle after 3s (give the process time to terminate)
    setTimeout(() => {
      processHandles.delete(task_id);
      log(`[PAUSE] Cleaned up process handle for ${task_id}`);
    }, 3000);
  }

  log("[PAUSE] Task paused:", task_id);
  res.json({ task_id, status: "paused" });
});

// Kill a task
registerTaskControlRoute("kill", async (req, res) => {
  const { task_id } = req.body;
  log("[KILL] task_id:", task_id);

  if (!task_id) return res.status(400).json({ error: "Missing task_id" });

  const entry = await getTask(task_id);
  if (!entry) return res.status(404).json({ error: "Task not found: " + task_id });

  if (entry.status !== "running" && entry.status !== "paused") {
    return res.json({ task_id, status: entry.status, message: "Task already finished" });
  }

  // CRITICAL: mark killed in DB BEFORE SIGKILL so the spawner's close
  // handler returns early instead of overwriting with status="error".
  await updateTaskStatus(task_id, "killed", "Task cancelled by the user.");
  await releaseLock(task_id);

  const child = processHandles.get(task_id);
  if (child) {
    try { killProcessTree(child, "SIGKILL"); } catch {}
  }

  log("[KILL] Task killed:", task_id);
  res.json({ task_id, status: "killed" });
});

// Intervene on a task: pause the running task and resume it with a new instruction.
// This is an atomic operation used by yabby_intervention — the session is preserved
// (same session_id, same taskId) so the agent keeps its context.
registerTaskControlRoute("intervene", async (req, res) => {
  const { agent_id, instruction } = req.body;
  log("[INTERVENE] agent_id:", agent_id, "instruction:", instruction?.substring(0, 100));

  if (!instruction) {
    return res.status(400).json({ error: "Missing instruction" });
  }
  if (!agent_id) {
    return res.status(400).json({ error: "Missing agent_id" });
  }

  // Resolve agent
  let agent = await getAgent(agent_id);
  if (!agent) agent = await findAgentByName(agent_id);
  if (!agent) {
    return res.status(404).json({ error: `Agent not found: ${agent_id}` });
  }

  // Find the currently active task for this agent
  const activeTaskId = await getActiveTaskId(agent.id);
  if (!activeTaskId) {
    return res.status(404).json({
      error: `Agent ${agent.name} has no active task to intervene on. Use yabby_execute to start a new task.`
    });
  }

  const entry = await getTask(activeTaskId);
  if (!entry) {
    return res.status(404).json({ error: `Task ${activeTaskId} not found in DB` });
  }

  // Check runner supports resume
  const runnerId = await resolveTaskResumeRunner(activeTaskId);
  const profile = getRunnerProfile(runnerId);
  if (!profile.supportsResume) {
    return res.status(400).json({ error: `Le runner ${profile.label} ne supporte pas l'intervention.` });
  }

  // Step 1: Pause the running task if it's still running
  if (entry.status === "running") {
    // CRITICAL: mark paused in DB BEFORE SIGTERM so the spawner's close
    // handler returns early instead of overwriting with status="error".
    await updateTaskStatus(activeTaskId, "paused", "Interrompue par yabby_intervention");
    await releaseLock(activeTaskId);

    const child = processHandles.get(activeTaskId);
    if (child) {
      log(`[INTERVENE] Killing running task ${activeTaskId} (PID ${child.pid})`);
      try { killProcessTree(child, "SIGTERM"); } catch {}

      // Wait briefly for the process to exit cleanly
      await new Promise((resolve) => {
        let done = false;
        const onExit = () => { if (!done) { done = true; resolve(); } };
        child.once("exit", onExit);
        setTimeout(onExit, 2000); // Hard timeout 2s
      });

      processHandles.delete(activeTaskId);
    }
    log(`[INTERVENE] Task ${activeTaskId} paused`);
  } else {
    log(`[INTERVENE] Task ${activeTaskId} was not running (status: ${entry.status})`);
  }

  // Step 2: Resume the task with the new instruction
  // Same taskId, same sessionId → the agent keeps its full context via --resume
  const interventionMessage = `[INTERVENTION UTILISATEUR] ${instruction}`;
  log(`[INTERVENE] Resuming task ${activeTaskId} with new instruction`);

  try {
    await spawnClaudeTask(activeTaskId, entry.sessionId, interventionMessage, true, {
      agentId: agent.id,
      projectId: entry.project_id,
      title: entry.title,
      isRetry: true, // Skip createTask (task already exists)
      runnerIdOverride: runnerId,
    });

    res.json({
      intervened: true,
      task_id: activeTaskId,
      agent_id: agent.id,
      status: "running",
      message: `Intervention sent to ${agent.name}, task resumed with the new instruction.`
    });
  } catch (err) {
    log(`[INTERVENE] Resume failed: ${err.message}`);
    res.status(500).json({ error: `Failed to resume task: ${err.message}` });
  }
});

// Continue an existing task
registerTaskControlRoute("continue", async (req, res) => {
  const { task_id, task } = req.body;
  log("[CONTINUE] task_id:", task_id, "task:", task);

  if (!task_id || !task) return res.status(400).json({ error: "Missing task_id or task" });

  const entry = await getTask(task_id);
  if (!entry) return res.status(404).json({ error: "Task not found: " + task_id });

  if (entry.status === "running") {
    return res.status(409).json({ error: "Task is still running" });
  }
  if (entry.status === "killed") {
    return res.status(410).json({ error: "Task was killed" });
  }

  // Check if current runner supports resume
  const runnerId = await resolveTaskResumeRunner(task_id);
  const profile = getRunnerProfile(runnerId);
  if (!profile.supportsResume) {
    return res.status(400).json({ error: `The runner ${profile.label} does not support task resume.` });
  }

  await spawnClaudeTask(task_id, entry.sessionId, task, true, {
    runnerIdOverride: runnerId,
  });

  log("[CONTINUE] Task resumed:", task_id);
  res.json({ task_id, status: "running" });
});

// ── Runner detection ──

const KNOWN_RUNNERS = [
  { id: "claude",   binary: "claude",  name: "Claude Code",   beta: false, needs: "Claude Pro/Max subscription ($20-200/mo)", installCmd: "npm i -g @anthropic-ai/claude-code" },
  { id: "codex",    binary: "codex",   name: "OpenAI Codex",  beta: false, needs: "ChatGPT Plus subscription",                  installCmd: "npm i -g @openai/codex" },
  { id: "aider",    binary: "aider",   name: "Aider",         beta: true,  needs: "API key from an LLM provider",              installCmd: "pip install aider-chat" },
  { id: "goose",    binary: "goose",   name: "Goose (Block)", beta: true,  needs: "API key from an LLM provider",              installCmd: "brew install block/tap/goose" },
  { id: "cline",    binary: "cline",   name: "Cline CLI",     beta: true,  needs: "API key from an LLM provider",              installCmd: "npm i -g cline" },
  { id: "continue", binary: "cn",      name: "Continue CLI",  beta: true,  needs: "API key from an LLM provider",              installCmd: "npm i -g @continuedev/cli" },
];

const envPath = process.env.PATH || "";
const extraBinPaths = ["/opt/homebrew/bin", "/usr/local/bin"].filter(p => !envPath.includes(p));
const runnerDetectPath = extraBinPaths.length ? extraBinPaths.join(":") + ":" + envPath : envPath;

function detectRunner(binary) {
  try {
    const binPath = execSync(`which ${binary}`, { timeout: 3000, env: { ...process.env, PATH: runnerDetectPath } }).toString().trim();
    if (!binPath) return { found: false };
    let version = null;
    try {
      version = execSync(`${binPath} --version 2>/dev/null`, { timeout: 5000, env: { ...process.env, PATH: runnerDetectPath } }).toString().trim().split("\n")[0].slice(0, 80);
    } catch { version = "installed"; }
    return { found: true, path: binPath, version };
  } catch {
    return { found: false };
  }
}

function detectCodexReadiness(binaryPath) {
  const readiness = { authReady: null, authMessage: null, sessionsWritable: null };
  try {
    const raw = execSync(`${binaryPath} login status --json`, {
      timeout: 5000,
      env: { ...process.env, PATH: runnerDetectPath },
    }).toString().trim();
    if (raw) {
      const parsed = JSON.parse(raw);
      readiness.authReady = !!parsed.loggedIn;
      readiness.authMessage = parsed.loggedIn ? "authenticated" : "not authenticated";
    }
  } catch {
    // Best effort only; keep nulls if CLI doesn't support this command.
  }
  try {
    const sessionsDir = join(homedir(), ".codex", "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    accessSync(sessionsDir, fsConstants.W_OK);
    readiness.sessionsWritable = true;
  } catch {
    readiness.sessionsWritable = false;
  }
  return readiness;
}

router.get("/api/tasks/runners", (_req, res) => {
  const tasksConfig = getConfig("tasks");
  const results = KNOWN_RUNNERS.map(runner => {
    const customPath = (runner.id === tasksConfig?.runner && tasksConfig?.runnerPath) ? tasksConfig.runnerPath : null;
    const detection = detectRunner(customPath || runner.binary);
    const readiness = runner.id === "codex" && detection.found
      ? detectCodexReadiness(detection.path)
      : {};
    return {
      ...runner,
      ...detection,
      ...readiness,
      isActive: tasksConfig?.runner === runner.id,
    };
  });
  res.json({ runners: results, current: tasksConfig?.runner || "claude" });
});

// Search tasks (MUST be before /:id route)
router.get("/api/tasks/search", async (req, res) => {
  try {
    const { q, status, project, agent, limit } = req.query;

    if (!q) {
      return res.status(400).json({ error: "Missing search query 'q'" });
    }

    const tasks = await searchTasksByText(q, {
      status,
      projectId: project,
      agentId: agent,
      limit: limit ? parseInt(limit) : 20
    });

    res.json({ tasks, count: tasks.length });
  } catch (err) {
    log("[API] /api/tasks/search error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get recent tasks (MUST be before /:id route)
router.get("/api/tasks/recent", async (req, res) => {
  try {
    const { hours = 24, status, project, limit } = req.query;

    const tasks = await getRecentTasks(parseInt(hours), {
      status,
      projectId: project,
      limit: limit ? parseInt(limit) : 50
    });

    res.json({ tasks, count: tasks.length, hours: parseInt(hours) });
  } catch (err) {
    log("[API] /api/tasks/recent error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get task statistics (MUST be before /:id route)
router.get("/api/tasks/stats", async (req, res) => {
  try {
    const { hours, project, agent } = req.query;

    const stats = await getTaskStats({
      hours: hours ? parseInt(hours) : undefined,
      projectId: project,
      agentId: agent
    });

    res.json(stats);
  } catch (err) {
    log("[API] /api/tasks/stats error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// LLM RATE LIMIT — list and resume paused tasks
// MUST come BEFORE /api/tasks/:id to avoid Express matching :id="llm-limit"
// ──────────────────────────────────────────────────────────────────

// List all tasks currently paused due to LLM rate limit
router.get("/api/tasks/llm-limit", async (_req, res) => {
  try {
    const { listLlmLimitedTasks } = await import("../db/queries/tasks.js");
    const tasks = await listLlmLimitedTasks();
    res.json({ count: tasks.length, tasks });
  } catch (err) {
    log("[LLM-LIMIT] List error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resume all tasks paused due to LLM rate limit
// Spawns each one with isResume=true to reuse session_id (with stale-session fallback)
router.post("/api/tasks/resume-llm-limit", async (_req, res) => {
  try {
    const { listLlmLimitedTasks } = await import("../db/queries/tasks.js");
    const tasks = await listLlmLimitedTasks();

    if (tasks.length === 0) {
      return res.json({
        resumed: 0,
        failed: 0,
        tasks: [],
        message: "No paused_llm_limit tasks",
      });
    }

    const resumed = [];
    const failed = [];

    for (const task of tasks) {
      try {
        const instruction = task.task_instruction || "Continue from where you left off.";
        const runnerId = await resolveTaskResumeRunner(task.id);
        const profile = getRunnerProfile(runnerId);
        if (!profile.supportsResume) {
          throw new Error(`Runner ${profile.label} does not support resume`);
        }
        // isResume=true → uses --resume {session_id}
        // The spawner has built-in fallback (stale session retry) at lines 462-486
        await spawnClaudeTask(
          task.id,
          task.session_id,
          instruction,
          true,
          {
            agentId: task.agent_id,
            projectId: task.project_id,
            title: task.title,
            runnerIdOverride: runnerId,
          }
        );
        resumed.push({ id: task.id, title: task.title });
        log(`[LLM-LIMIT] Resumed task ${task.id} (${task.title || "untitled"})`);
      } catch (err) {
        log(`[LLM-LIMIT] Failed to resume ${task.id}: ${err.message}`);
        failed.push({ id: task.id, title: task.title, error: err.message });
      }
    }

    res.json({
      resumed: resumed.length,
      failed: failed.length,
      tasks: resumed,
      errors: failed,
    });
  } catch (err) {
    log("[LLM-LIMIT] Resume error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get detailed task info including result and logs
router.get("/api/tasks/:id", async (req, res) => {
  try {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // Read activity log if available
    const activityLogPath = join(LOGS_DIR, `${req.params.id}-activity.log`);
    let activityLog = null;
    if (existsSync(activityLogPath)) {
      try {
        activityLog = await readFile(activityLogPath, "utf-8");
      } catch {}
    }

    res.json({
      ...task,
      activityLog: activityLog ? activityLog.slice(0, 20000) : null,
      logFile: existsSync(activityLogPath) ? `logs/${req.params.id}-activity.log` : null,
    });
  } catch (err) {
    log("[TASK-DETAIL] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get task activity log (for voice model to read)
/**
 * Smart task log endpoint — multiple modes to read logs efficiently without
 * loading the entire file into memory (critical for 50 MB+ activity logs).
 *
 * Modes:
 *   tail   — last N lines (default 100). Cheapest.
 *   head   — first N lines.
 *   search — grep-like search with context lines.
 *   summary — tool call counts, exit info, duration. Zero raw content.
 *   tools  — structured list of tool calls (name + short description).
 *   errors — lines containing STDERR / is_error / Error.
 *
 * All modes cap output at ~1 MB to prevent agents from ingesting giant logs.
 */
router.get("/api/tasks/:id/log", async (req, res) => {
  try {
    const taskId = req.params.id;
    const activityLogPath = join(LOGS_DIR, `${taskId}-activity.log`);
    if (!existsSync(activityLogPath)) {
      return res.status(404).json({ error: "No log file for this task" });
    }

    const mode = req.query.mode || "tail";
    const limit = Math.min(parseInt(req.query.limit) || 100, 2000);
    const MAX_BYTES = 1_000_000; // 1 MB output cap

    // For modes that need the full file, we stream-read up to MAX_BYTES
    // from the appropriate end. For search, we scan line-by-line.
    const { createReadStream, statSync } = await import("fs");
    const stat = statSync(activityLogPath);
    const fileSize = stat.size;

    if (mode === "summary") {
      // Fast summary: scan the whole file for patterns but return only aggregated data
      const content = await readFile(activityLogPath, "utf-8");
      const allLines = content.split("\n").filter(l => l.trim());
      const toolLines = allLines.filter(l => l.includes("TOOL:"));
      const toolCounts = {};
      for (const l of toolLines) {
        const m = l.match(/TOOL:\s+(\w+)/);
        if (m) toolCounts[m[1]] = (toolCounts[m[1]] || 0) + 1;
      }
      const exitLine = allLines.find(l => l.includes("EXITED:")) || null;
      const resultLine = allLines.find(l => l.includes("FINAL_OUTPUT:")) || null;

      return res.json({
        taskId,
        mode: "summary",
        fileSize,
        totalLines: allLines.length,
        toolCallCount: toolLines.length,
        toolBreakdown: toolCounts,
        exitInfo: exitLine ? exitLine.replace(/^\[.*?\]\s*/, "") : null,
        finalOutputPreview: resultLine ? resultLine.replace(/^\[.*?\]\s*FINAL_OUTPUT:\s*/, "").slice(0, 500) : null,
      });
    }

    if (mode === "tools") {
      const content = await readFile(activityLogPath, "utf-8");
      const toolEntries = content.split("\n")
        .filter(l => l.includes("TOOL:"))
        .slice(-limit)
        .map(l => {
          const ts = l.match(/^\[(.*?)\]/)?.[1] || "";
          const toolMatch = l.match(/TOOL:\s+(\w+)\s+→\s+(.*)/);
          return toolMatch ? { time: ts, tool: toolMatch[1], detail: toolMatch[2].slice(0, 200) } : null;
        })
        .filter(Boolean);

      return res.json({ taskId, mode: "tools", count: toolEntries.length, tools: toolEntries });
    }

    if (mode === "errors") {
      const content = await readFile(activityLogPath, "utf-8");
      const errorLines = content.split("\n")
        .filter(l => /STDERR|is_error.*true|Error:|FAILED|error.*true/i.test(l))
        .slice(-limit)
        .map(l => l.slice(0, 500));

      return res.json({ taskId, mode: "errors", count: errorLines.length, errors: errorLines });
    }

    if (mode === "search") {
      const query = req.query.q || "";
      const context = Math.min(parseInt(req.query.context) || 2, 10);
      if (!query) return res.status(400).json({ error: "search mode requires ?q= parameter" });

      const content = await readFile(activityLogPath, "utf-8");
      const allLines = content.split("\n");
      const matches = [];
      let outputSize = 0;

      for (let i = 0; i < allLines.length && outputSize < MAX_BYTES; i++) {
        if (allLines[i].toLowerCase().includes(query.toLowerCase())) {
          const start = Math.max(0, i - context);
          const end = Math.min(allLines.length, i + context + 1);
          const snippet = allLines.slice(start, end).join("\n");
          matches.push({ line: i + 1, snippet: snippet.slice(0, 2000) });
          outputSize += snippet.length;
        }
      }

      return res.json({ taskId, mode: "search", query, matchCount: matches.length, matches: matches.slice(0, 50) });
    }

    // tail / head modes — read only what we need
    const content = await readFile(activityLogPath, "utf-8");
    const allLines = content.split("\n").filter(l => l.trim());
    const lines = mode === "head"
      ? allLines.slice(0, limit)
      : allLines.slice(-limit);

    // Cap total output
    let output = lines;
    let totalChars = lines.reduce((s, l) => s + l.length, 0);
    while (totalChars > MAX_BYTES && output.length > 1) {
      output = output.slice(mode === "head" ? 0 : 1);
      totalChars = output.reduce((s, l) => s + l.length, 0);
    }

    res.json({ taskId, mode, lines: output, total: allLines.length, fileSize, capped: totalChars >= MAX_BYTES });
  } catch (err) {
    log("[TASK-LOG] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// List simple tasks (no project, no agent)
router.get("/api/simple-tasks", async (_req, res) => {
  try {
    const tasks = await listSimpleTasks();
    const list = tasks.map(t => ({
      id: t.id,
      status: t.status,
      elapsed: t.elapsed || Math.round((Date.now() - t.startTime) / 1000),
      startTime: t.startTime,
      result: t.status === "done" || t.status === "error" ? t.result?.slice(0, 500) : undefined,
      title: t.title,
      created_at: t.created_at,
    }));
    res.json({ tasks: list });
  } catch (err) {
    log("[SIMPLE-TASKS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Archive a task (soft delete)
/**
 * POST /api/tasks/:id/recover
 *
 * Fork the underlying Claude session by extracting the latest user
 * message and seeding a brand-new session with just that message.
 * Prior history is preserved as a backup but DROPPED from the new
 * session — this kills any poisoned payload (oversized images,
 * orphan tool_use blocks, corrupted JSON, persistent tool errors,
 * etc.) regardless of where in history it lives. The original
 * .jsonl is never modified; it's renamed to .bak-pre-recover-<ts>.
 *
 * Body: { seedText?: string } — optional override for the seed prompt
 * Response: { taskId, oldSessionId, newSessionId, mode, reason,
 *             seedPreview, seedLength, priorLines, backupPath }
 */
// ─────────────────────────────────────────────────────────────────────
// Recovery — fork from latest user message
// ─────────────────────────────────────────────────────────────────────
//
// Approach: tail-truncation can't cure poison that lives mid-history
// (e.g. an oversized image at line 167 of 1337) — and chasing every
// failure mode (orphan tool_use, repeated tool_result errors, corrupted
// JSON, etc.) is a maintenance treadmill. The robust fix is to walk
// back, find the latest *real* user message, and start a fresh session
// containing only that message. Whatever poison lived in prior history
// is gone.
//
// "Real" excludes the wrappers Yabby injects on every CLI invocation:
//   - "[TASK_ID: …]" + "[CLI REMINDER …]" — agent identity preamble
//   - "Continue from where you left off." — auto-retry filler
//   - "[Request interrupted by user]" — stop marker
//   - "<task-notification>" — Claude background-task plumbing
//   - "[Image: original …]" — vision tool image header
//   - pure tool_result content blocks
//   - any line with isMeta=true (Yabby's own retry tag)
//
// When the wrapper IS a CLI REMINDER, the actual user prompt sits
// after "=== USER INSTRUCTION ===" — we extract that and use it as the
// fresh seed. If we can't find any usable seed, we fall back to a
// generic "Continue from where you left off" so the agent at least
// reboots cleanly on its own state instead of staying wedged.

function parseLineSafe(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function flatUserText(d) {
  // Flatten user message content (string OR array) into a single string
  // for substring/regex inspection.
  const c = d?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c.filter(x => x?.type === "text").map(x => x.text || "").join("\n");
  }
  return "";
}

function isInternalUserMessage(d) {
  if (!d || d.type !== "user") return false;
  if (d.isMeta === true) return true; // Yabby tags its own retries
  const c = d.message?.content;
  // Pure tool_result blocks are internal Claude flow, never user input
  if (Array.isArray(c) && c.length > 0 && c.every(x => x?.type === "tool_result")) return true;
  const t = flatUserText(d).trim();
  if (!t) return true;
  // Yabby-injected envelopes — these wrap a real user prompt that
  // extractUserPrompt() will pull out separately.
  if (/\[TASK_ID:/i.test(t)) return true;
  if (/\[CLI REMINDER/i.test(t)) return true;
  if (/<task-notification>/i.test(t)) return true;
  if (/^\[Image: original \d/i.test(t)) return true;
  if (/^\[Request interrupted by user\]\s*$/.test(t)) return true;
  if (/^Continue from where you left off\.?\s*$/i.test(t)) return true;
  return false;
}

/**
 * Extract the user-typed prompt out of a wrapped CLI message.
 * Yabby's CLI reminder format puts the actual user instruction after
 * "=== USER INSTRUCTION ===". If that marker is absent, returns the
 * raw text minus the TASK_ID/CLI REMINDER preamble (best-effort).
 */
function extractUserPrompt(rawText) {
  if (!rawText) return null;
  const marker = /===\s*USER INSTRUCTION\s*===\s*\n?/i;
  const m = rawText.split(marker);
  if (m.length >= 2) {
    const tail = m[m.length - 1].trim();
    if (tail) return tail;
  }
  // No marker — strip the obvious preamble lines
  const stripped = rawText
    .replace(/^\[TASK_ID:[^\]]+\]\s*/i, "")
    .replace(/\[CLI REMINDER[\s\S]*?(?=\n\n[A-Z]|$)/i, "")
    .trim();
  return stripped || null;
}

/**
 * Walk the .jsonl from the tail and return the latest user message
 * suitable to seed a fresh forked session.
 *
 * Returns { text, sourceLine } or null.
 */
function findLatestUserMessage(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const d = parseLineSafe(lines[i]);
    if (!d || d.type !== "user") continue;
    if (!isInternalUserMessage(d)) {
      // Non-wrapped user input (rare for agent tasks but covers it)
      const t = flatUserText(d).trim();
      if (t) return { text: t, sourceLine: i + 1, wrapped: false };
    } else {
      // Wrapped — try to extract the embedded USER INSTRUCTION
      const t = flatUserText(d);
      const extracted = extractUserPrompt(t);
      if (extracted && extracted.length > 1 && !/^Continue from where you left off/i.test(extracted)) {
        return { text: extracted, sourceLine: i + 1, wrapped: true };
      }
    }
  }
  return null;
}

router.post("/api/tasks/:id/recover", async (req, res) => {
  try {
    const { rename, copyFile, readFile: rfPromise } = await import("fs/promises");
    const taskId = req.params.id;

    const task = await getTask(taskId);
    if (!task) return res.status(404).json({ error: `Task ${taskId} not found` });
    if (task.status === "running") {
      return res.status(409).json({ error: "Cannot recover a running task — pause or kill it first" });
    }
    if (!task.sessionId) {
      return res.status(400).json({ error: "Task has no session_id, nothing to recover" });
    }
    if (!task.agent_id) {
      return res.status(400).json({ error: "Recover only supports agent-bound tasks (no agent_id on this task)" });
    }

    const runnerId = await resolveTaskResumeRunner(taskId);
    if (runnerId !== "claude") {
      return res.status(400).json({ error: `Recover currently only supports the claude runner (got: ${runnerId})` });
    }

    const agent = await getAgent(task.agent_id);
    if (!agent) return res.status(404).json({ error: `Agent ${task.agent_id} not found` });

    // Resolve cwd → directory hash that Claude Code uses for session storage
    // (~/.claude/projects/<cwd-with-slashes-replaced-by-dashes>/<session-id>.jsonl)
    const { getAgentWorkspaceInfo } = await import("../db/queries/agents.js");
    const workspaceInfo = await getAgentWorkspaceInfo(task.agent_id);
    const cwd = workspaceInfo?.path;
    if (!cwd) {
      return res.status(400).json({ error: "Could not resolve agent workspace path" });
    }

    // Claude Code stores sessions under ~/.claude/projects/<dir-name>/ where
    // dir-name is the absolute cwd with EVERY non-alphanumeric character
    // replaced by '-'. So "/Users/foo/Yabby Workspace/Independent Tasks/julien"
    // becomes "-Users-foo-Yabby-Workspace-Independent-Tasks-julien". Slashes
    // alone aren't enough — spaces, accents, commas, parens are also folded.
    const projectDirName = cwd.replace(/[^A-Za-z0-9]/g, "-");
    const sessionDir = join(homedir(), ".claude", "projects", projectDirName);
    const sourcePath = join(sessionDir, `${task.sessionId}.jsonl`);

    if (!existsSync(sourcePath)) {
      return res.status(404).json({
        error: `Session file not found at ${sourcePath} — cannot recover`,
        debug: { cwd, projectDirName, sessionId: task.sessionId },
      });
    }

    // Read the source, find the latest real user message
    const raw = await rfPromise(sourcePath, "utf-8");
    const allLines = raw.split("\n");
    const last = allLines.length - 1;
    const totalLines = allLines[last] === "" ? last : allLines.length;
    const lines = allLines.slice(0, totalLines);

    // Pick a seed for the fresh session:
    //   1. Explicit body override (power users / scripts) wins.
    //   2. Otherwise walk back and extract the latest user-typed prompt
    //      out of any wrapping CLI REMINDER / TASK_ID envelope.
    //   3. Fallback: a generic "Continue from where you left off." so
    //      the agent reboots cleanly even if we can't find anything.
    let seedText;
    let recoveryMode;
    let recoveryReason;
    if (req.body?.seedText && typeof req.body.seedText === "string") {
      seedText = req.body.seedText.trim();
      recoveryMode = "manual";
      recoveryReason = `Manual seed: starting a fresh session with the provided text.`;
    } else {
      const found = findLatestUserMessage(lines);
      if (found) {
        seedText = found.text;
        recoveryMode = found.wrapped ? "fork-from-latest-user" : "fork-from-latest-user-raw";
        recoveryReason = `Forked from your latest message (line ${found.sourceLine} of ${totalLines}). Prior history dropped to clear any poisoned payload.`;
      } else {
        seedText = "Continue from where you left off.";
        recoveryMode = "fork-blank";
        recoveryReason = `No identifiable user message found; starting a fresh session with a generic prompt.`;
      }
    }

    if (!seedText || seedText.length < 1) {
      return res.status(400).json({ error: "Could not determine a seed message for the fresh session." });
    }

    // Build the fresh .jsonl. Claude Code resumes a session by reading
    // the file at ~/.claude/projects/<dir>/<sessionId>.jsonl. The minimum
    // valid resume corpus is a single user-role message with parentUuid
    // null. We copy cwd / version / gitBranch / userType from the source
    // when available so the new session inherits the same workspace
    // metadata.
    let envelope = {
      cwd,
      version: "2.1.86",
      gitBranch: "main",
      userType: "external",
      entrypoint: "sdk-cli",
    };
    for (const ln of lines.slice(0, 50)) {
      const d = parseLineSafe(ln);
      if (!d) continue;
      if (d.cwd) envelope.cwd = d.cwd;
      if (d.version) envelope.version = d.version;
      if (d.gitBranch) envelope.gitBranch = d.gitBranch;
      if (d.userType) envelope.userType = d.userType;
      if (d.entrypoint) envelope.entrypoint = d.entrypoint;
    }

    const newSessionId = randomUUID();
    const targetPath = join(sessionDir, `${newSessionId}.jsonl`);
    const backupPath = `${sourcePath}.bak-pre-recover-${Date.now()}`;
    const seedRecord = {
      parentUuid: null,
      isSidechain: false,
      promptId: randomUUID(),
      type: "user",
      message: { role: "user", content: seedText },
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      userType: envelope.userType,
      entrypoint: envelope.entrypoint,
      cwd: envelope.cwd,
      sessionId: newSessionId,
      version: envelope.version,
      gitBranch: envelope.gitBranch,
    };

    // Lock the agent's session_id to a sacrificial UUID FIRST so any
    // --resume that lands during the file ops fails fast rather than
    // reading a half-written fork. Restore at the end. Same pg type
    // gymnastic as before — varchar slot vs jsonb-cast slot can't reuse
    // the same placeholder.
    const sacrificialUuid = randomUUID();
    await pgQuery(
      `UPDATE agents
         SET session_id = $1,
             runner_sessions = jsonb_set(COALESCE(runner_sessions, '{}'::jsonb), '{claude}', to_jsonb($2::text))
       WHERE id = $3`,
      [sacrificialUuid, sacrificialUuid, task.agent_id]
    );

    try {
      await copyFile(sourcePath, backupPath);
      const { writeFile } = await import("fs/promises");
      await writeFile(targetPath, JSON.stringify(seedRecord) + "\n", "utf-8");

      await pgQuery(
        `UPDATE agents
           SET session_id = $1,
               runner_sessions = jsonb_set(COALESCE(runner_sessions, '{}'::jsonb), '{claude}', to_jsonb($2::text)),
               active_task_id = $3,
               task_status = 'idle'
         WHERE id = $4`,
        [newSessionId, newSessionId, taskId, task.agent_id]
      );
      await pgQuery(
        `UPDATE tasks
           SET status = 'done',
               session_id = $1,
               result = $2
         WHERE id = $3`,
        [
          newSessionId,
          `[RECOVERED] Fresh fork from latest user message: ${task.sessionId} → ${newSessionId} (mode=${recoveryMode}, prior history dropped). Backup: ${backupPath}`,
          taskId,
        ]
      );
    } catch (err) {
      try {
        await pgQuery(
          `UPDATE agents
             SET session_id = $1,
                 runner_sessions = jsonb_set(COALESCE(runner_sessions, '{}'::jsonb), '{claude}', to_jsonb($2::text))
           WHERE id = $3`,
          [task.sessionId, task.sessionId, task.agent_id]
        );
      } catch {}
      throw err;
    }

    log(`[RECOVER] Task ${taskId}: ${task.sessionId} → ${newSessionId} (mode=${recoveryMode}, seed=${seedText.length} chars, backup ${backupPath})`);
    res.json({
      taskId,
      oldSessionId: task.sessionId,
      newSessionId,
      mode: recoveryMode,
      reason: recoveryReason,
      seedPreview: seedText.length > 200 ? seedText.slice(0, 200) + "…" : seedText,
      seedLength: seedText.length,
      priorLines: totalLines,
      backupPath,
      message: `Session forked from your latest message. ${agent.name} will resume from a clean slate.`,
    });
  } catch (err) {
    log("[RECOVER] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/tasks/:id/archive", async (req, res) => {
  try {
    const task = await getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    if (task.status === "running") {
      return res.status(409).json({ error: "Cannot archive a running task" });
    }
    await archiveTask(req.params.id);
    log("[ARCHIVE] Task archived:", req.params.id);
    res.json({ id: req.params.id, status: "archived" });
  } catch (err) {
    log("[ARCHIVE] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
