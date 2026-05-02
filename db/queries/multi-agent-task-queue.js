import { query } from "../pg.js";

/**
 * Normalise et valide la liste d'items d'une cascade.
 * Chaque item doit avoir: { position: int >= 1, agent_id, title, instruction }.
 */
function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('next_tasks must be a non-empty array');
  }
  return items.map((it, idx) => {
    const position = Number(it.position);
    if (!Number.isInteger(position) || position < 1) {
      throw new Error(`next_tasks[${idx}].position must be an integer >= 1`);
    }
    if (!it.agent_id || typeof it.agent_id !== 'string') {
      throw new Error(`next_tasks[${idx}].agent_id is required`);
    }
    if (!it.instruction || typeof it.instruction !== 'string') {
      throw new Error(`next_tasks[${idx}].instruction is required`);
    }
    return {
      position,
      agent_id: it.agent_id,
      title: (it.title && String(it.title).trim().slice(0, 120)) || null,
      instruction: it.instruction,
    };
  });
}

/**
 * Crée une cascade multi-agent.
 * `items` contient TOUS les steps sauf le step 0 (l'agent initial enqueué
 * à côté dans agent_task_queue avec multi_agent_position=0).
 */
export async function createMultiAgentCascade({ ownerAgentId, projectId, items, onError = 'stop' }) {
  const validated = validateItems(items);
  const r = await query(
    `INSERT INTO multi_agent_task_queue (owner_agent_id, project_id, items, on_error, status, current_position)
     VALUES ($1, $2, $3, $4, 'running', 0)
     RETURNING *`,
    [ownerAgentId, projectId || null, JSON.stringify(validated), onError]
  );
  return r.rows[0];
}

export async function getMultiAgentCascade(id) {
  const r = await query(`SELECT * FROM multi_agent_task_queue WHERE id = $1`, [id]);
  return r.rows[0] || null;
}

export async function setCascadePosition(cascadeId, position) {
  await query(
    `UPDATE multi_agent_task_queue SET current_position = $2 WHERE id = $1`,
    [cascadeId, position]
  );
}

export async function markCascadeCompleted(cascadeId) {
  await query(
    `UPDATE multi_agent_task_queue
     SET status = 'completed', completed_at = NOW()
     WHERE id = $1`,
    [cascadeId]
  );
}

export async function markCascadeFailed(cascadeId, reason = null) {
  await query(
    `UPDATE multi_agent_task_queue
     SET status = 'failed', completed_at = NOW()
     WHERE id = $1`,
    [cascadeId]
  );
}

export async function markCascadeStarted(cascadeId) {
  await query(
    `UPDATE multi_agent_task_queue
     SET status = 'running', started_at = COALESCE(started_at, NOW())
     WHERE id = $1`,
    [cascadeId]
  );
}

/**
 * Récupère le statut global d'une position de cascade — a-t-elle tous ses
 * items terminés (completed OU failed) pour que l'on puisse avancer ?
 */
export async function isCascadePositionDone(cascadeId, position) {
  const r = await query(
    `SELECT COUNT(*) FILTER (WHERE status IN ('pending', 'processing'))::int AS pending_count,
            COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
            COUNT(*)::int AS total
     FROM agent_task_queue
     WHERE multi_agent_task_id = $1 AND multi_agent_position = $2`,
    [cascadeId, position]
  );
  const row = r.rows[0];
  return {
    done: row.pending_count === 0,
    hasFailures: row.failed_count > 0,
    total: row.total,
  };
}
