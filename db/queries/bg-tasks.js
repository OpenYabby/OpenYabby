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
  exitFile = null,
  isService = false,
}) {
  const result = await query(
    `INSERT INTO bg_tasks
       (cli_task_id, yabby_task_id, agent_id, session_id,
        tool_use_id, description, task_type, status, pid, pid_file,
        exit_file, is_service)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'running', $8, $9, $10, $11)
     ON CONFLICT (cli_task_id) DO NOTHING
     RETURNING *`,
    [cliTaskId, yabbyTaskId, agentId, sessionId, toolUseId, description, taskType,
     pid, pidFile, exitFile, !!isService]
  );
  return result.rows[0] || null;
}

/**
 * Mark a bg task as exited with full exit metadata. Used by the watcher
 * when it detects the OS-level PID is gone.
 */
export async function markBgTaskExit(cliTaskId, { status, exitCode = null, exitSignal = null, summary = null }) {
  const result = await query(
    `UPDATE bg_tasks
        SET status      = $2,
            exit_code   = COALESCE($3, exit_code),
            exit_signal = COALESCE($4, exit_signal),
            summary     = COALESCE($5, summary),
            ended_at    = NOW()
      WHERE cli_task_id = $1
      RETURNING *`,
    [cliTaskId, status, exitCode, exitSignal, summary]
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
 * Read a single bg_task row by its CLI-side task id.
 */
export async function getBgTaskByCliId(cliTaskId) {
  const result = await query(
    `SELECT * FROM bg_tasks WHERE cli_task_id = $1`,
    [cliTaskId]
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
 * Global listing: every bg_task across all agents, with the agent's name
 * joined in so the UI can display it without N+1 lookups. Optional status
 * filter (e.g. 'running'), default limit 200, newest first.
 */
export async function getAllBgTasks({ status = null, limit = 200 } = {}) {
  const where = status ? "WHERE bt.status = $1" : "";
  const params = status ? [status, limit] : [limit];
  const limitIdx = status ? "$2" : "$1";
  const result = await query(
    `SELECT bt.*, a.name AS agent_name, a.role AS agent_role
       FROM bg_tasks bt
       LEFT JOIN agents a ON a.id = bt.agent_id
       ${where}
      ORDER BY bt.started_at DESC
      LIMIT ${limitIdx}`,
    params
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
 * On parent CLI close, mark only the bg tasks whose OS-level PID is GONE
 * as 'orphaned'. Rows whose PID is still alive are kept 'running' so the
 * bg-watcher continues polling them — a long-running bg job started by an
 * already-exited CLI is the normal case (Matteo's 1h30 email batch).
 */
export async function markOrphanedBgTasksDead(yabbyTaskId) {
  const candidates = await query(
    `SELECT cli_task_id, pid FROM bg_tasks
      WHERE yabby_task_id = $1 AND status = 'running'`,
    [yabbyTaskId]
  );
  const orphaned = [];
  for (const r of candidates.rows) {
    let alive = false;
    if (r.pid && r.pid > 0) {
      try { process.kill(r.pid, 0); alive = true; }
      catch (err) {
        if (err.code === "EPERM") alive = true;
      }
    }
    if (!alive) {
      await query(
        `UPDATE bg_tasks SET status = 'orphaned', ended_at = NOW() WHERE cli_task_id = $1`,
        [r.cli_task_id]
      );
      orphaned.push(r.cli_task_id);
    }
  }
  return orphaned;
}
