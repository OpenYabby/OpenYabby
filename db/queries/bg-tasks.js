import { query } from "../pg.js";

/**
 * Record a new CLI-side background task (Bash run_in_background=true).
 * Called from the spawner when the CLI emits {type:"system", subtype:"task_started"}.
 */
export async function createBgTask({
  cliTaskId,
  yabbyTaskId,
  agentId = null,
  sessionId,
  toolUseId = null,
  description = null,
  taskType = null,
  pid = null,
  pidFile = null,
}) {
  const result = await query(
    `INSERT INTO bg_tasks
       (cli_task_id, yabby_task_id, agent_id, session_id,
        tool_use_id, description, task_type, status, pid, pid_file)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9)
     ON CONFLICT (cli_task_id) DO NOTHING
     RETURNING *`,
    [cliTaskId, yabbyTaskId, agentId, sessionId, toolUseId, description, taskType, pid, pidFile]
  );
  return result.rows[0] || null;
}

/**
 * Backfill the PID and pid_file of an existing bg_task row. Called when the
 * PreToolUse hook captures the PID asynchronously (file appears between
 * task_started emission and our read attempt).
 */
export async function updateBgTaskPid(cliTaskId, { pid, pidFile }) {
  const result = await query(
    `UPDATE bg_tasks
        SET pid = COALESCE($2, pid),
            pid_file = COALESCE($3, pid_file)
      WHERE cli_task_id = $1
      RETURNING *`,
    [cliTaskId, pid, pidFile]
  );
  return result.rows[0] || null;
}

/**
 * List all bg_tasks currently 'running' with a known PID — used by the watcher
 * to poll OS-level liveness.
 */
export async function getRunningBgTasksWithPid() {
  const result = await query(
    `SELECT * FROM bg_tasks WHERE status = 'running' AND pid IS NOT NULL`
  );
  return result.rows;
}

/**
 * Mark a bg task as finished. Called on {subtype:"task_notification"}.
 * status: 'completed' | 'stopped' | 'failed'
 */
export async function markBgTaskNotification(cliTaskId, { status, outputFile = null, summary = null, usage = null }) {
  const result = await query(
    `UPDATE bg_tasks
        SET status      = $2,
            output_file = COALESCE($3, output_file),
            summary     = COALESCE($4, summary),
            usage_json  = COALESCE($5, usage_json),
            ended_at    = NOW()
      WHERE cli_task_id = $1
      RETURNING *`,
    [cliTaskId, status, outputFile, summary, usage ? JSON.stringify(usage) : null]
  );
  return result.rows[0] || null;
}

/**
 * List bg tasks (active + historical) attached to a Yabby task.
 */
export async function getBgTasksForTask(yabbyTaskId) {
  const result = await query(
    `SELECT * FROM bg_tasks WHERE yabby_task_id = $1 ORDER BY started_at DESC`,
    [yabbyTaskId]
  );
  return result.rows;
}

/**
 * List bg tasks for an agent. Optional status filter (e.g. 'running').
 */
export async function getBgTasksForAgent(agentId, { status = null } = {}) {
  const sql = status
    ? `SELECT * FROM bg_tasks WHERE agent_id = $1 AND status = $2 ORDER BY started_at DESC`
    : `SELECT * FROM bg_tasks WHERE agent_id = $1 ORDER BY started_at DESC LIMIT 200`;
  const params = status ? [agentId, status] : [agentId];
  const result = await query(sql, params);
  return result.rows;
}

/**
 * On parent CLI close, any bg task still 'running' is orphaned (the CLI
 * died before emitting task_notification). Mark them so they don't linger.
 */
export async function markOrphanedBgTasksDead(yabbyTaskId) {
  const result = await query(
    `UPDATE bg_tasks
        SET status   = 'orphaned',
            ended_at = NOW()
      WHERE yabby_task_id = $1 AND status = 'running'
      RETURNING cli_task_id`,
    [yabbyTaskId]
  );
  return result.rows.map((r) => r.cli_task_id);
}
