import { query } from "../pg.js";
import { redis, KEY } from "../redis.js";

const TASK_TTL = 86400; // 24 hours

export async function createTask(taskId, sessionId, projectId = null, agentId = null, options = {}) {
  const {
    parentTaskId = null,
    title = null,
    priority = "P2",
    // ✅ NOUVEAU: Contexte speaker
    conversationId = null,
    createdBySpeaker = false,
    parentTurnId = null,
    speakerMetadata = null,
    // ✅ NOUVEAU: Instruction originale (pour reprise après LLM limit)
    taskInstruction = null,
    // ✅ NOUVEAU: Phase tracking pour notifications intelligentes
    phase = null,
    metadata = {}
  } = options;

  const startTime = Date.now();
  await Promise.all([
    query(
      `INSERT INTO tasks (
        id, session_id, status, start_time, project_id, agent_id,
        parent_task_id, title, priority,
        conversation_id, created_by_speaker, parent_conversation_turn_id, speaker_metadata,
        task_instruction, phase, metadata
      ) VALUES ($1, $2, 'running', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        taskId, sessionId, startTime, projectId, agentId, parentTaskId, title, priority,
        conversationId, createdBySpeaker, parentTurnId,
        speakerMetadata ? JSON.stringify(speakerMetadata) : null,
        taskInstruction,
        phase,
        JSON.stringify(metadata)
      ]
    ),
    redis.set(KEY(`task:${taskId}:status`), "running", { EX: TASK_TTL }),
    // ✅ NOUVEAU: Cache conversation ID pour lookup rapide
    ...(conversationId
      ? [redis.set(KEY(`task:${taskId}:conversation`), conversationId, { EX: TASK_TTL })]
      : []
    ),
  ]);

  return { id: taskId, sessionId, status: "running", startTime };
}

export async function updateTaskStatus(taskId, status, result = null, error = null, elapsed = null) {
  const promises = [
    query(
      `UPDATE tasks SET status = $1, result = $2, error = $3, elapsed = $4, updated_at = NOW() WHERE id = $5`,
      [status, result, error, elapsed, taskId]
    ),
    redis.set(KEY(`task:${taskId}:status`), status, { EX: TASK_TTL }),
  ];
  if (result !== null) {
    promises.push(redis.set(KEY(`task:${taskId}:result`), result, { EX: TASK_TTL }));
  }
  await Promise.all(promises);
}

/**
 * Mark a task as paused due to LLM rate limit (Claude CLI quota reached).
 * Preserves original instruction and reset time so the task can be resumed
 * via voice command or the topbar button.
 */
export async function markTaskLlmLimited(taskId, resetAt = null, elapsed = null) {
  await Promise.all([
    query(
      `UPDATE tasks
       SET status = 'paused_llm_limit',
           llm_limit_reset_at = $2,
           paused_at = NOW(),
           elapsed = $3,
           error = 'LLM rate limit reached',
           updated_at = NOW()
       WHERE id = $1`,
      [taskId, resetAt, elapsed]
    ),
    redis.set(KEY(`task:${taskId}:status`), "paused_llm_limit", { EX: TASK_TTL }),
  ]);
}

/**
 * List all tasks currently paused due to LLM rate limit.
 * Used by the resume-llm-limit endpoint and the topbar badge counter.
 */
export async function listLlmLimitedTasks() {
  const r = await query(
    `SELECT id, session_id, project_id, agent_id, title, task_instruction,
            llm_limit_reset_at, paused_at, created_at
     FROM tasks
     WHERE status = 'paused_llm_limit'
     ORDER BY paused_at DESC NULLS LAST, created_at DESC`
  );
  return r.rows.map(t => ({
    id: t.id,
    session_id: t.session_id,
    project_id: t.project_id,
    agent_id: t.agent_id,
    title: t.title,
    task_instruction: t.task_instruction,
    llm_limit_reset_at: t.llm_limit_reset_at,
    paused_at: t.paused_at,
    created_at: t.created_at,
  }));
}

export async function getTask(taskId) {
  const r = await query("SELECT * FROM tasks WHERE id = $1", [taskId]);
  if (!r.rows[0]) return null;

  const task = r.rows[0];
  // Redis is the source of truth for live status
  const cachedStatus = await redis.get(KEY(`task:${taskId}:status`));
  if (cachedStatus) task.status = cachedStatus;

  return {
    id: task.id,
    sessionId: task.session_id,
    status: task.status,
    result: task.result,
    error: task.error,
    startTime: Number(task.start_time),
    elapsed: task.elapsed,
    // ✅ NOUVEAU: Retourner contexte speaker
    conversation_id: task.conversation_id,
    created_by_speaker: task.created_by_speaker,
    speaker_metadata: task.speaker_metadata,
    // ✅ FIX: Retourner agent_id et project_id pour routing des notifications
    agent_id: task.agent_id,
    project_id: task.project_id,
    // ✅ FIX: Retourner phase et metadata pour notification chain
    phase: task.phase,
    metadata: task.metadata,
  };
}

export async function getTaskStatus(taskId) {
  // Ultra-fast path: Redis only (used in polling loop)
  const status = await redis.get(KEY(`task:${taskId}:status`));
  if (status) return status;
  // Fallback to PG
  const r = await query("SELECT status FROM tasks WHERE id = $1", [taskId]);
  return r.rows[0]?.status || null;
}

export async function getTaskResult(taskId) {
  // Try Redis first
  const cached = await redis.get(KEY(`task:${taskId}:result`));
  if (cached) return cached;
  // Fallback to PG
  const r = await query("SELECT result FROM tasks WHERE id = $1", [taskId]);
  return r.rows[0]?.result || null;
}

export async function listTasks() {
  const r = await query(
    `SELECT id, session_id, status, result, error, start_time, elapsed,
            project_id, agent_id, title, created_at, updated_at
     FROM tasks WHERE status != 'archived'
     ORDER BY updated_at DESC NULLS LAST`
  );
  return r.rows.map(t => ({
    id: t.id,
    sessionId: t.session_id,
    status: t.status,
    result: t.result,
    error: t.error,
    startTime: Number(t.start_time),
    elapsed: t.elapsed,
    project_id: t.project_id,
    agent_id: t.agent_id,
    title: t.title,
    created_at: t.created_at,
    updated_at: t.updated_at,
  }));
}

export async function listSimpleTasks() {
  const r = await query(
    `SELECT id, session_id, status, result, error, start_time, elapsed, title, created_at
     FROM tasks WHERE project_id IS NULL AND agent_id IS NULL AND status != 'archived'
     ORDER BY created_at DESC LIMIT 100`
  );
  return r.rows.map(t => ({
    id: t.id,
    sessionId: t.session_id,
    status: t.status,
    result: t.result,
    error: t.error,
    startTime: Number(t.start_time),
    elapsed: t.elapsed,
    title: t.title,
    created_at: t.created_at,
  }));
}

/**
 * Get the most recent non-archived task for an agent (any status).
 * Fallback for "continue/inspect" when getActiveTaskId returns null
 * (e.g. agent just finished and user says "reprends").
 */
export async function getLatestTaskForAgent(agentId) {
  const r = await query(
    `SELECT id, session_id, status, title, updated_at
     FROM tasks
     WHERE agent_id = $1 AND status != 'archived'
     ORDER BY updated_at DESC NULLS LAST, created_at DESC
     LIMIT 1`,
    [agentId]
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    title: row.title,
    updated_at: row.updated_at,
  };
}

export async function archiveTask(taskId) {
  await Promise.all([
    query("UPDATE tasks SET status = 'archived', updated_at = NOW() WHERE id = $1", [taskId]),
    redis.set(KEY(`task:${taskId}:status`), "archived", { EX: TASK_TTL }),
  ]);
}

export async function recoverOrphanedTasks() {
  // Get all tasks that were running or paused when server stopped
  const r = await query(
    `SELECT id, session_id, project_id, agent_id, title, status
     FROM tasks WHERE status IN ('running', 'paused')`
  );

  // Don't mark as error - they will be resumed by recoverRunningTasks()
  return r.rows;
}

export async function getSubTasks(parentTaskId) {
  const r = await query(
    `SELECT id, title, status, priority, agent_id, elapsed, parent_task_id
     FROM tasks WHERE parent_task_id = $1 ORDER BY created_at`,
    [parentTaskId]
  );
  return r.rows.map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
    priority: t.priority,
    agentId: t.agent_id,
    elapsed: t.elapsed,
    parentTaskId: t.parent_task_id,
  }));
}

/**
 * Store runner-specific context for a task (e.g. Codex thread_id).
 * Safe to call before migration 035 is applied: silently no-op.
 */
export async function updateTaskRunnerContext(taskId, { runnerId, runnerThreadId } = {}) {
  const updates = [];
  const values = [];

  if (runnerId !== undefined) {
    values.push(runnerId);
    updates.push(`runner_id = $${values.length}`);
  }
  if (runnerThreadId !== undefined) {
    values.push(runnerThreadId);
    updates.push(`runner_thread_id = $${values.length}`);
  }

  if (updates.length === 0) return;

  values.push(taskId);
  try {
    await query(
      `UPDATE tasks
       SET ${updates.join(", ")}, updated_at = NOW()
       WHERE id = $${values.length}`,
      values,
    );
  } catch (err) {
    // Column not found: migration not applied yet
    if (err?.code !== "42703") throw err;
  }
}

/**
 * Read runner-specific context for task resume parity.
 * Safe before migration 035: returns null fields.
 */
export async function getTaskRunnerContext(taskId) {
  try {
    const r = await query(
      `SELECT runner_id, runner_thread_id
       FROM tasks
       WHERE id = $1`,
      [taskId],
    );
    const row = r.rows[0];
    return {
      runnerId: row?.runner_id || null,
      runnerThreadId: row?.runner_thread_id || null,
    };
  } catch (err) {
    if (err?.code !== "42703") throw err;
    return { runnerId: null, runnerThreadId: null };
  }
}

/**
 * Check if a task's dependencies are all done.
 * depends_on is a JSONB array of task IDs.
 */
export async function canTaskStart(taskId) {
  const r = await query("SELECT depends_on FROM tasks WHERE id = $1", [taskId]);
  if (!r.rows[0]) return false;
  const deps = r.rows[0].depends_on || [];
  if (deps.length === 0) return true;

  for (const depId of deps) {
    const status = await getTaskStatus(depId);
    if (status !== "done") return false;
  }
  return true;
}

/**
 * Search tasks by title/result content
 */
export async function searchTasksByText(searchQuery, filters = {}) {
  const { status, projectId, agentId, limit = 20 } = filters;

  const conditions = ["status != 'archived'"];
  const params = [];
  let paramIdx = 1;

  // Text search (ILIKE on title + result)
  if (searchQuery) {
    conditions.push(`(title ILIKE $${paramIdx} OR result ILIKE $${paramIdx})`);
    params.push(`%${searchQuery}%`);
    paramIdx++;
  }

  // Status filter
  if (status) {
    conditions.push(`status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  }

  // Project filter
  if (projectId) {
    conditions.push(`project_id = $${paramIdx}`);
    params.push(projectId);
    paramIdx++;
  }

  // Agent filter
  if (agentId) {
    conditions.push(`agent_id = $${paramIdx}`);
    params.push(agentId);
    paramIdx++;
  }

  params.push(limit);

  const r = await query(`
    SELECT id, title, status, result, project_id, agent_id,
           created_at, elapsed, start_time
    FROM tasks
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT $${paramIdx}
  `, params);

  return r.rows.map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
    result: t.result ? t.result.substring(0, 500) : null, // Preview only
    project_id: t.project_id,
    agent_id: t.agent_id,
    created_at: t.created_at,
    elapsed: t.elapsed,
    startTime: Number(t.start_time),
  }));
}

/**
 * Get recent tasks (last N hours)
 */
export async function getRecentTasks(hours = 24, filters = {}) {
  const { status, projectId, limit = 50 } = filters;
  const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);

  const conditions = [
    "status != 'archived'",
    `created_at >= to_timestamp($1 / 1000.0)`
  ];
  const params = [cutoffTime];
  let paramIdx = 2;

  if (status) {
    conditions.push(`status = $${paramIdx}`);
    params.push(status);
    paramIdx++;
  }

  if (projectId) {
    conditions.push(`project_id = $${paramIdx}`);
    params.push(projectId);
    paramIdx++;
  }

  params.push(limit);

  const r = await query(`
    SELECT id, title, status, result, project_id, agent_id,
           created_at, elapsed, start_time
    FROM tasks
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT $${paramIdx}
  `, params);

  return r.rows.map(t => ({
    id: t.id,
    title: t.title,
    status: t.status,
    result: t.result ? t.result.substring(0, 500) : null, // Preview only
    project_id: t.project_id,
    agent_id: t.agent_id,
    created_at: t.created_at,
    elapsed: t.elapsed,
    startTime: Number(t.start_time),
  }));
}

/**
 * Get task statistics
 */
export async function getTaskStats(filters = {}) {
  const { projectId, agentId, hours } = filters;
  const conditions = ["status != 'archived'"];
  const params = [];
  let paramIdx = 1;

  if (hours) {
    const cutoffTime = Date.now() - (hours * 60 * 60 * 1000);
    conditions.push(`created_at >= to_timestamp($${paramIdx} / 1000.0)`);
    params.push(cutoffTime);
    paramIdx++;
  }

  if (projectId) {
    conditions.push(`project_id = $${paramIdx}`);
    params.push(projectId);
    paramIdx++;
  }

  if (agentId) {
    conditions.push(`agent_id = $${paramIdx}`);
    params.push(agentId);
    paramIdx++;
  }

  const r = await query(`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'running') as running,
      COUNT(*) FILTER (WHERE status = 'done') as completed,
      COUNT(*) FILTER (WHERE status = 'error') as failed,
      COUNT(*) FILTER (WHERE status = 'paused') as paused
    FROM tasks
    WHERE ${conditions.join(" AND ")}
  `, params);

  return {
    total: parseInt(r.rows[0].total),
    running: parseInt(r.rows[0].running),
    completed: parseInt(r.rows[0].completed),
    failed: parseInt(r.rows[0].failed),
    paused: parseInt(r.rows[0].paused),
  };
}
