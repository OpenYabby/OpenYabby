import { query } from "../pg.js";

/**
 * Ajouter une instruction à la file d'attente d'un agent.
 * @param {string} agentId
 * @param {string} instruction
 * @param {string} source - 'voice' | 'api' | 'scheduled_task' | 'user_interrupt' | 'multi_agent' | ...
 * @param {string|null} sourceId
 * @param {number} priority - 0-100 (100=urgent, 50=normal)
 * @param {string|null} title
 * @param {{multiAgentTaskId?: number, multiAgentPosition?: number}} [opts]
 */
export async function enqueueTask(
  agentId,
  instruction,
  source,
  sourceId = null,
  priority = 50,
  title = null,
  opts = {}
) {
  const resolvedTitle = (title && String(title).trim().slice(0, 120))
    || (String(instruction || '').split('\n')[0].trim().slice(0, 120))
    || null;

  const multiAgentTaskId = opts.multiAgentTaskId ?? null;
  const multiAgentPosition = opts.multiAgentPosition ?? null;

  const result = await query(
    `INSERT INTO agent_task_queue
       (agent_id, instruction, source, source_id, priority, title,
        multi_agent_task_id, multi_agent_position)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [agentId, instruction, source, sourceId, priority, resolvedTitle, multiAgentTaskId, multiAgentPosition]
  );
  return result.rows[0];
}

/**
 * Obtenir la prochaine tâche en attente pour un agent
 * Ordre: priority DESC, created_at ASC (plus urgente et plus ancienne d'abord)
 */
export async function getNextPendingTask(agentId) {
  const result = await query(
    `SELECT * FROM agent_task_queue
     WHERE agent_id = $1 AND status = 'pending'
     ORDER BY priority DESC, created_at ASC
     LIMIT 1`,
    [agentId]
  );
  return result.rows[0] || null;
}

/**
 * Marquer une tâche de queue comme en cours de traitement
 */
export async function markTaskProcessing(queueId) {
  await query(
    `UPDATE agent_task_queue
     SET status = 'processing', started_at = NOW()
     WHERE id = $1`,
    [queueId]
  );
}

/**
 * Marquer une tâche de queue comme complétée
 */
export async function markTaskCompleted(queueId, result) {
  await query(
    `UPDATE agent_task_queue
     SET status = 'completed', completed_at = NOW(), result = $2
     WHERE id = $1`,
    [queueId, result?.slice(0, 5000)]
  );
}

/**
 * Marquer une tâche de queue comme échouée
 */
export async function markTaskFailed(queueId, error) {
  await query(
    `UPDATE agent_task_queue
     SET status = 'failed', completed_at = NOW(), error = $2
     WHERE id = $1`,
    [queueId, error?.slice(0, 2000)]
  );
}

/**
 * Obtenir toutes les tâches en attente pour un agent
 */
export async function getQueuedTasks(agentId, limit = 20) {
  const result = await query(
    `SELECT * FROM agent_task_queue
     WHERE agent_id = $1 AND status = 'pending'
     ORDER BY priority DESC, created_at ASC
     LIMIT $2`,
    [agentId, limit]
  );
  return result.rows;
}

/**
 * Compter les tâches en attente pour un agent
 */
export async function getQueueLength(agentId) {
  const result = await query(
    `SELECT COUNT(*) as count FROM agent_task_queue
     WHERE agent_id = $1 AND status = 'pending'`,
    [agentId]
  );
  return parseInt(result.rows[0].count);
}

/**
 * Annuler toutes les tâches en attente pour un agent
 */
export async function cancelPendingTasks(agentId) {
  await query(
    `UPDATE agent_task_queue
     SET status = 'cancelled', completed_at = NOW()
     WHERE agent_id = $1 AND status = 'pending'`,
    [agentId]
  );
}

/**
 * Obtenir l'historique complet de la queue d'un agent (incluant completed/failed)
 */
export async function getQueueHistory(agentId, limit = 50) {
  const result = await query(
    `SELECT * FROM agent_task_queue
     WHERE agent_id = $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [agentId, limit]
  );
  return result.rows;
}

/**
 * Obtenir une tâche de queue par son ID
 * @param {number} queueId - ID de la tâche dans la queue
 * @returns {Promise<object|null>} La tâche ou null
 */
export async function getQueueTask(queueId) {
  const result = await query(
    `SELECT * FROM agent_task_queue WHERE id = $1`,
    [queueId]
  );
  return result.rows[0] || null;
}
