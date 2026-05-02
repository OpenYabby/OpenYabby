/* ═══════════════════════════════════════════════════════
   YABBY — Task Forwarder
   ═══════════════════════════════════════════════════════
   When running in Docker (or remote), forward task spawn
   requests to a local Yabby instance that has Claude CLI.
*/

import { log } from "./logger.js";
import { getConfig } from "./config.js";

/**
 * Forward a task spawn to the configured remote URL.
 * Returns { taskId, status } from the remote.
 */
export async function forwardTask(taskId, sessionId, task, isResume, options = {}) {
  const forwardUrl = getConfig("tasks")?.forwardUrl;
  if (!forwardUrl) throw new Error("No tasks.forwardUrl configured");

  log(`[TASK-FORWARD] Forwarding ${taskId} to ${forwardUrl}`);

  const resp = await fetch(`${forwardUrl}/api/tasks/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task,
      task_id: taskId,
      session_id: sessionId,
      is_resume: isResume,
      agent_id: options.agentId,
      project_id: options.projectId,
      parent_task_id: options.parentTaskId,
      title: options.title,
      priority: options.priority,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Task forward failed (${resp.status}): ${errText.slice(0, 200)}`);
  }

  const result = await resp.json();
  log(`[TASK-FORWARD] ${taskId} forwarded → remote taskId: ${result.task_id || taskId}`);
  return result;
}

/**
 * Check if task forwarding is enabled.
 */
export function isForwardingEnabled() {
  return !!getConfig("tasks")?.forwardUrl;
}
