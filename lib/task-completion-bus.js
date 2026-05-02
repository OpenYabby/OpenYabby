/**
 * Task Completion Bus — in-memory event bus linking the spawner (who knows
 * when a Claude task exits) to the agent task-queue processor (who needs to
 * run post-completion logic: mark the queue item done, auto-notify the
 * parent lead, advance cascades, pick the next queue item).
 *
 * Replaces the old DB-polling loop in waitForTaskCompletion, which timed
 * out after 10 minutes and incorrectly flagged long-running tasks as failed.
 *
 * Design:
 *   - Listeners are ONE-SHOT and keyed by taskId.
 *   - The bus also caches the most recent terminal event per taskId so a
 *     listener that registers AFTER the event fired still receives it
 *     (avoids a race between spawn ack and registration).
 *   - Terminal statuses: 'done' | 'error' | 'killed' | 'paused_llm_limit'.
 *   - Non-terminal statuses are ignored (paused, running, etc.).
 */

import { log } from "./logger.js";

const TERMINAL_STATUSES = new Set(["done", "error", "killed", "paused_llm_limit"]);

// taskId → handler function (one-shot)
const waiters = new Map();
// taskId → { status, emittedAt } — for late-binding listeners
const recentEvents = new Map();
const RECENT_TTL_MS = 60_000;

function prune() {
  const cutoff = Date.now() - RECENT_TTL_MS;
  for (const [taskId, evt] of recentEvents) {
    if (evt.emittedAt < cutoff) recentEvents.delete(taskId);
  }
}

/**
 * Register a one-shot listener for a task's terminal completion.
 * If the task already completed (event cached within the TTL), the handler
 * fires immediately on next tick.
 */
export function onTaskCompleted(taskId, handler) {
  if (!taskId || typeof handler !== "function") return;

  const cached = recentEvents.get(taskId);
  if (cached) {
    recentEvents.delete(taskId);
    setImmediate(() => {
      try {
        handler(cached);
      } catch (err) {
        log(`[TASK-BUS] handler error for ${taskId}: ${err.message}`);
      }
    });
    return;
  }

  waiters.set(taskId, handler);
}

/**
 * Emit a terminal completion event for a task. Fires the registered listener
 * (if any), or caches the event briefly for late-binding listeners.
 */
export function emitTaskCompleted(taskId, payload = {}) {
  if (!taskId) return;
  const status = payload.status;
  if (!TERMINAL_STATUSES.has(status)) return;

  prune();

  const event = { ...payload, taskId, emittedAt: Date.now() };
  const handler = waiters.get(taskId);
  if (handler) {
    waiters.delete(taskId);
    setImmediate(() => {
      try {
        handler(event);
      } catch (err) {
        log(`[TASK-BUS] handler error for ${taskId}: ${err.message}`);
      }
    });
    return;
  }

  // No listener yet — cache for ~60s so a slow register still gets it
  recentEvents.set(taskId, event);
}

/**
 * Remove a pending listener (e.g. on shutdown). Non-fatal if none exists.
 */
export function cancelTaskCompletionListener(taskId) {
  waiters.delete(taskId);
}
