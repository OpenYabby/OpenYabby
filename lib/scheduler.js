/* ═══════════════════════════════════════════════════════
   YABBY — Scheduled Task Scheduler Engine
   ═══════════════════════════════════════════════════════
   In-memory scheduler that:
   - Loads active scheduled tasks from DB
   - Ticks every 30s checking what's due
   - Spawns Claude CLI tasks via existing spawner
   - Tracks completion, handles retries
   - Recalculates next_run_at after each run
*/

import { randomUUID } from "crypto";
import { CronExpressionParser } from "cron-parser";
import {
  getActiveScheduledTasks,
  getScheduledTask,
  updateNextRun,
  incrementErrorCount,
  updateScheduledTask,
  createRun,
  updateRun,
  recoverOrphanedRuns,
  reconcileOrphanedRunsFromQueue,
} from "../db/queries/scheduled-tasks.js";
import { getTaskStatus, getTaskResult } from "../db/queries/tasks.js";
import { spawnClaudeTask, genTaskId, processHandles } from "./spawner.js";
import { log } from "./logger.js";
import { isStandaloneAgent } from "../db/queries/agents.js";
import { enqueueTask, getQueueTask } from "../db/queries/agent-task-queue.js";
import { processAgentQueue } from "./agent-task-processor.js";

const TICK_INTERVAL = 30_000; // 30 seconds

// In-memory state
let tickTimer = null;
let scheduledTasks = []; // Cached active tasks
const activeRuns = new Map(); // scheduledTaskId → { taskId, runId, retryNumber }

/** Initialize the scheduler — call after DB migrations */
export async function init() {
  // Pre-reconcile queue-based orphans BEFORE the brutal recovery runs.
  // Fix du bug "Server restarted" pour agents standalone avec use_continue=true.
  // Isolé en try/catch : si ça échoue, le comportement d'origine est strictement préservé.
  try {
    const { reconciledDone, reconciledError } = await reconcileOrphanedRunsFromQueue();
    if (reconciledDone > 0 || reconciledError > 0) {
      log(`[SCHEDULER] Reconciled queue-based orphans: ${reconciledDone} done, ${reconciledError} failed`);
    }
  } catch (err) {
    log(`[SCHEDULER] Queue reconciliation error (non-fatal):`, err.message);
  }

  // Recover orphaned runs from previous crash
  const recovered = await recoverOrphanedRuns();
  if (recovered > 0) {
    log(`[SCHEDULER] Recovered ${recovered} orphaned runs`);
  }

  // Load active tasks
  await reload();

  // Start tick loop
  tickTimer = setInterval(() => tick(), TICK_INTERVAL);
  log(`[SCHEDULER] Started — ${scheduledTasks.length} active tasks, tick every ${TICK_INTERVAL / 1000}s`);
}

/** Shutdown — stop the tick loop */
export function shutdown() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  log("[SCHEDULER] Shut down");
}

/** Reload scheduled tasks from DB (call after CRUD operations) */
export async function reload() {
  scheduledTasks = await getActiveScheduledTasks();
  log(`[SCHEDULER] Reloaded — ${scheduledTasks.length} active tasks`);
}

/** Manually trigger a scheduled task immediately */
export async function triggerNow(scheduledTaskId) {
  const task = await getScheduledTask(scheduledTaskId);
  if (!task) throw new Error("Scheduled task not found");
  if (activeRuns.has(scheduledTaskId)) throw new Error("Already running");
  await spawnRun(task);
}

/** Main tick — runs every TICK_INTERVAL */
async function tick() {
  const now = new Date();

  for (const task of scheduledTasks) {
    // Skip if already running
    if (activeRuns.has(task.id)) continue;

    // Skip manual tasks (only triggered via button)
    if (task.scheduleType === "manual") continue;

    // Skip if not due yet
    if (!task.nextRunAt || new Date(task.nextRunAt) > now) continue;

    try {
      await spawnRun(task);
    } catch (err) {
      log(`[SCHEDULER] Error spawning run for ${task.id}:`, err.message);
    }
  }
}

/** Spawn a new execution for a scheduled task */
async function spawnRun(scheduled, retryNumber = 0) {
  const taskId = genTaskId();
  const sessionId = randomUUID();
  const now = new Date();

  log(`[SCHEDULER] Spawning run for "${scheduled.name}" (${scheduled.id}) → task ${taskId}`);

  // CRITICAL: Preserve agent_id from scheduled task
  if (scheduled.agentId) {
    log(`[SCHEDULER] Task linked to agent: ${scheduled.agentId}`);
  }

  // Update last_run_at and calculate next_run_at
  const nextRunAt = calculateNextRun(scheduled.scheduleType, scheduled.scheduleConfig, now);
  await updateNextRun(scheduled.id, nextRunAt, now);

  // CRITICAL: Update in-memory object to prevent re-triggering in same tick cycle
  scheduled.nextRunAt = nextRunAt;
  scheduled.lastRunAt = now;

  // *** NOUVEAU: Si agent standalone avec use_continue=true, ajouter à la queue ***
  if (scheduled.agentId && scheduled.useContinue && await isStandaloneAgent(scheduled.agentId)) {
    log(`[SCHEDULER] Agent is standalone with use_continue, enqueueing task`);

    const queueItem = await enqueueTask(
      scheduled.agentId,
      scheduled.taskTemplate,
      'scheduled_task',
      scheduled.id,
      50 // Priority normale
    );

    const runId = await createRun(scheduled.id, null); // Pas de task_id immédiat
    activeRuns.set(scheduled.id, { taskId: null, runId, retryNumber, queueId: queueItem.id });

    // Déclencher le processor
    setImmediate(() => processAgentQueue(scheduled.agentId));

    // Monitor queue item completion to update run record
    monitorQueueCompletion(scheduled, runId, queueItem.id);

    return;
  }

  // Sinon, comportement normal (spawn direct)
  // Spawn the task first (creates the row in tasks table)
  await spawnClaudeTask(taskId, sessionId, scheduled.taskTemplate, false, {
    agentId: scheduled.agentId || null,
    projectId: scheduled.projectId || null,
    title: `[Planifié] ${scheduled.name}`,
  });

  // Create run record after task exists (FK constraint on task_id)
  const runId = await createRun(scheduled.id, taskId);

  // Track active run
  activeRuns.set(scheduled.id, { taskId, runId, retryNumber });

  // Monitor the process for completion
  monitorCompletion(scheduled, taskId, runId, retryNumber);
}

/** Poll the process handle to detect task completion */
function monitorCompletion(scheduled, taskId, runId, retryNumber) {
  const checkInterval = setInterval(async () => {
    // If process is still running, wait
    if (processHandles.has(taskId)) return;

    clearInterval(checkInterval);

    try {
      const status = await getTaskStatus(taskId);
      const result = await getTaskResult(taskId);

      if (status === "done") {
        await onTaskComplete(scheduled, taskId, runId, "done", result);
      } else {
        await onTaskComplete(scheduled, taskId, runId, "error", null, result || status || "Unknown error");
      }
    } catch (err) {
      log(`[SCHEDULER] Monitor error for ${taskId}:`, err.message);
      activeRuns.delete(scheduled.id);
    }
  }, 3000); // Check every 3 seconds
}

/** Poll queue item status to update scheduled run record (for queue-based runs) */
function monitorQueueCompletion(scheduled, runId, queueId) {
  const checkInterval = setInterval(async () => {
    try {
      const queueTask = await getQueueTask(queueId);
      if (!queueTask) {
        clearInterval(checkInterval);
        activeRuns.delete(scheduled.id);
        return;
      }
      if (queueTask.status === 'completed') {
        clearInterval(checkInterval);
        await updateRun(runId, "done", queueTask.result?.slice(0, 5000));
        activeRuns.delete(scheduled.id);
        log(`[SCHEDULER] Queue run done for "${scheduled.name}"`);
      } else if (queueTask.status === 'failed') {
        clearInterval(checkInterval);
        await onTaskComplete(scheduled, null, runId, "error", null, queueTask.error);
      }
    } catch (err) {
      log(`[SCHEDULER] Queue monitor error:`, err.message);
      clearInterval(checkInterval);
      activeRuns.delete(scheduled.id);
    }
  }, 5000);
}

/** Handle task completion (success or error) */
async function onTaskComplete(scheduled, taskId, runId, status, result, error) {
  activeRuns.delete(scheduled.id);

  if (status === "done") {
    await updateRun(runId, "done", result?.slice(0, 5000));
    log(`[SCHEDULER] Run done for "${scheduled.name}" (task ${taskId})`);
  } else {
    await updateRun(runId, "error", null, error?.slice(0, 2000));

    const currentRetry = activeRuns.get(scheduled.id)?.retryNumber || 0;
    const maxRetries = scheduled.maxRetries ?? 3;

    if (currentRetry < maxRetries - 1) {
      // Schedule retry
      const retryAt = new Date(Date.now() + (scheduled.retryDelayMs || 60000));
      await updateScheduledTask(scheduled.id, { nextRunAt: retryAt });
      log(`[SCHEDULER] Run failed for "${scheduled.name}", retry ${currentRetry + 1}/${maxRetries} at ${retryAt.toISOString()}`);

      // Re-fetch and schedule
      const updated = await getScheduledTask(scheduled.id);
      if (updated && updated.status === "active") {
        // Will be picked up on next tick
      }
    } else {
      await incrementErrorCount(scheduled.id, error?.slice(0, 1000));
      log(`[SCHEDULER] Run failed for "${scheduled.name}", no retries left`);
    }
  }

  // Reload to pick up any changes
  await reload();
}

/** Calculate the next run time based on schedule type and config */
function calculateNextRun(scheduleType, config, fromDate = new Date()) {
  if (scheduleType === "manual") return null;

  if (scheduleType === "interval") {
    const intervalMs = config.interval_ms || config.intervalMs; // Support both formats
    if (!intervalMs || intervalMs < 60000) return null; // Min 1 minute
    return new Date(fromDate.getTime() + intervalMs);
  }

  if (scheduleType === "cron") {
    const cronExpr = config.cronExpression || config.cron; // Support both for backwards compatibility
    if (!cronExpr) return null;
    try {
      const interval = CronExpressionParser.parse(cronExpr, { currentDate: fromDate });
      return interval.next().toDate();
    } catch (err) {
      log(`[SCHEDULER] Invalid cron expression "${cronExpr}":`, err.message);
      return null;
    }
  }

  // 'once' — fires exactly one time at config.runAt, then naturally stops
  // (returns null on the post-run recalc when target <= fromDate).
  if (scheduleType === "once") {
    const runAt = config.runAt || config.run_at;
    if (!runAt) return null;
    const target = new Date(runAt);
    if (Number.isNaN(target.getTime())) return null;
    return target > fromDate ? target : null;
  }

  return null;
}

/** Exported for routes to use when activating a task */
export { calculateNextRun };
