import { query } from "../pg.js";

function mapRow(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    taskTemplate: r.task_template,
    scheduleType: r.schedule_type,
    scheduleConfig: r.schedule_config || {},
    status: r.status,
    projectId: r.project_id,
    agentId: r.agent_id,
    maxRetries: r.max_retries,
    retryDelayMs: r.retry_delay_ms,
    lastRunAt: r.last_run_at,
    nextRunAt: r.next_run_at,
    runCount: r.run_count,
    errorCount: r.error_count,
    lastError: r.last_error,
    useContinue: r.use_continue,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export async function createScheduledTask(data) {
  const r = await query(
    `INSERT INTO scheduled_tasks (name, description, task_template, schedule_type, schedule_config,
       status, project_id, agent_id, max_retries, retry_delay_ms, next_run_at, use_continue)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      data.name,
      data.description || null,
      data.taskTemplate,
      data.scheduleType,
      JSON.stringify(data.scheduleConfig || {}),
      data.status || "active",
      data.projectId || null,
      data.agentId || null,
      data.maxRetries ?? 3,
      data.retryDelayMs ?? 60000,
      data.nextRunAt || null,
      data.useContinue ?? false,
    ]
  );
  return mapRow(r.rows[0]);
}

export async function getScheduledTask(id) {
  const r = await query("SELECT * FROM scheduled_tasks WHERE id = $1", [id]);
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export async function listScheduledTasks(filters = {}) {
  let sql = "SELECT * FROM scheduled_tasks WHERE status != 'archived'";
  const params = [];

  if (filters.agentId) {
    params.push(filters.agentId);
    sql += ` AND agent_id = $${params.length}`;
  }

  if (filters.projectId) {
    params.push(filters.projectId);
    sql += ` AND project_id = $${params.length}`;
  }

  sql += " ORDER BY created_at DESC";

  const r = await query(sql, params);
  return r.rows.map(mapRow);
}

export async function getActiveScheduledTasks() {
  const r = await query(
    "SELECT * FROM scheduled_tasks WHERE status = 'active' ORDER BY next_run_at ASC NULLS LAST"
  );
  return r.rows.map(mapRow);
}

export async function updateScheduledTask(id, fields) {
  const sets = [];
  const vals = [];
  let idx = 1;

  const fieldMap = {
    name: "name", description: "description", taskTemplate: "task_template",
    scheduleType: "schedule_type", scheduleConfig: "schedule_config",
    status: "status", projectId: "project_id", agentId: "agent_id",
    maxRetries: "max_retries", retryDelayMs: "retry_delay_ms",
    nextRunAt: "next_run_at",
  };

  for (const [jsKey, dbCol] of Object.entries(fieldMap)) {
    if (fields[jsKey] !== undefined) {
      const val = jsKey === "scheduleConfig" ? JSON.stringify(fields[jsKey]) : fields[jsKey];
      sets.push(`${dbCol} = $${idx++}`);
      vals.push(val);
    }
  }

  if (sets.length === 0) return getScheduledTask(id);

  sets.push("updated_at = NOW()");
  vals.push(id);

  const r = await query(
    `UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`,
    vals
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export async function archiveScheduledTask(id) {
  await query(
    "UPDATE scheduled_tasks SET status = 'archived', updated_at = NOW() WHERE id = $1",
    [id]
  );
}

export async function updateNextRun(id, nextRunAt, lastRunAt) {
  await query(
    `UPDATE scheduled_tasks
     SET next_run_at = $1, last_run_at = $2, run_count = run_count + 1, updated_at = NOW()
     WHERE id = $3`,
    [nextRunAt, lastRunAt, id]
  );
}

export async function incrementErrorCount(id, error) {
  await query(
    `UPDATE scheduled_tasks
     SET error_count = error_count + 1, last_error = $1, updated_at = NOW()
     WHERE id = $2`,
    [error, id]
  );
}

// ── Runs ──

export async function createRun(scheduledTaskId, taskId) {
  const r = await query(
    `INSERT INTO scheduled_task_runs (scheduled_task_id, task_id, status, started_at)
     VALUES ($1, $2, 'running', NOW()) RETURNING id`,
    [scheduledTaskId, taskId]
  );
  return r.rows[0].id;
}

export async function updateRun(runId, status, result = null, error = null) {
  await query(
    `UPDATE scheduled_task_runs
     SET status = $1, result = $2, error = $3, completed_at = CASE WHEN $1 IN ('done','error') THEN NOW() ELSE completed_at END
     WHERE id = $4`,
    [status, result, error, runId]
  );
}

export async function listRuns(scheduledTaskId, limit = 20) {
  const r = await query(
    `SELECT id, scheduled_task_id, task_id, status, started_at, completed_at, result, error, retry_number, created_at
     FROM scheduled_task_runs WHERE scheduled_task_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [scheduledTaskId, limit]
  );
  return r.rows.map(r => ({
    id: r.id,
    scheduledTaskId: r.scheduled_task_id,
    taskId: r.task_id,
    status: r.status,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    result: r.result,
    error: r.error,
    retryNumber: r.retry_number,
    createdAt: r.created_at,
  }));
}

export async function recoverOrphanedRuns() {
  const r = await query(
    `UPDATE scheduled_task_runs SET status = 'error', error = 'Server restarted', completed_at = NOW()
     WHERE status = 'running' RETURNING id`
  );
  return r.rows.length;
}

/**
 * Réconcilie les runs orphelines du chemin queue-based en les croisant avec agent_task_queue.
 *
 * Le chemin "queue-based" du scheduler (pour agents standalone avec use_continue=true)
 * crée des runs avec task_id=NULL puis se repose sur un setInterval en mémoire pour
 * les marquer "done" quand le queue item correspondant est complété. Ce setInterval
 * est perdu à chaque restart serveur — et recoverOrphanedRuns() les marque alors
 * brutalement en "Server restarted" sans vérifier l'état réel du queue.
 *
 * Cette fonction répare ça AVANT que recoverOrphanedRuns() ne tourne :
 * - Cherche runs (status='running' AND task_id IS NULL)
 * - Pour chaque, cherche le queue item via (source='scheduled_task' + source_id + fenêtre temporelle)
 * - Si queue.status='completed' → run passe à 'done' avec le résultat
 * - Si queue.status='failed'    → run passe à 'error' avec l'erreur du queue
 * - Sinon (pending/processing ou pas trouvé) → laisse intact, recoverOrphanedRuns() fera son taf
 *
 * Purement additif. Ne touche QUE des runs dans un état précis (running + task_id NULL).
 * Idempotente : un rerun ne refait rien sur les runs déjà passées en done/error.
 *
 * @returns {Promise<{reconciledDone: number, reconciledError: number}>}
 */
export async function reconcileOrphanedRunsFromQueue() {
  // 1. Trouver les runs queue-based orphelines
  const orphans = await query(
    `SELECT id, scheduled_task_id, started_at
     FROM scheduled_task_runs
     WHERE status = 'running' AND task_id IS NULL`
  );

  let reconciledDone = 0;
  let reconciledError = 0;

  for (const row of orphans.rows) {
    // 2. Chercher le queue item correspondant
    // Fenêtre temporelle : créé entre (started_at - 1 min) et (started_at + 10 min)
    // On ne matche QUE les items résolus (completed/failed) — les pending/processing
    // sont laissés à recoverOrphanedRuns() (ou au monitor vivant si tâche en cours)
    const queueMatch = await query(
      `SELECT id, status, result, error, completed_at
       FROM agent_task_queue
       WHERE source = 'scheduled_task'
         AND source_id = $1
         AND created_at >= $2::timestamptz - INTERVAL '1 minute'
         AND created_at <= $2::timestamptz + INTERVAL '10 minutes'
         AND status IN ('completed', 'failed')
       ORDER BY created_at ASC
       LIMIT 1`,
      [row.scheduled_task_id, row.started_at]
    );

    if (queueMatch.rows.length === 0) continue;

    const q = queueMatch.rows[0];

    if (q.status === 'completed') {
      await query(
        `UPDATE scheduled_task_runs
         SET status = 'done',
             result = $2,
             completed_at = COALESCE($3, NOW())
         WHERE id = $1 AND status = 'running' AND task_id IS NULL`,
        [row.id, q.result ? String(q.result).slice(0, 5000) : null, q.completed_at]
      );
      reconciledDone++;
    } else if (q.status === 'failed') {
      await query(
        `UPDATE scheduled_task_runs
         SET status = 'error',
             error = $2,
             completed_at = COALESCE($3, NOW())
         WHERE id = $1 AND status = 'running' AND task_id IS NULL`,
        [row.id, q.error ? String(q.error).slice(0, 2000) : 'Queue task failed', q.completed_at]
      );
      reconciledError++;
    }
  }

  return { reconciledDone, reconciledError };
}
