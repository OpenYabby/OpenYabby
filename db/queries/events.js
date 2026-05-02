import { query } from "../pg.js";

export async function logEvent(eventType, { projectId = null, agentId = null, taskId = null, detail = {} } = {}) {
  await query(
    `INSERT INTO event_log (project_id, agent_id, task_id, event_type, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [projectId, agentId, taskId, eventType, JSON.stringify(detail)]
  );
}

export async function getProjectEvents(projectId, limit = 50) {
  const r = await query(
    `SELECT * FROM event_log WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [projectId, limit]
  );
  return r.rows.map(e => ({
    id: e.id,
    projectId: e.project_id,
    agentId: e.agent_id,
    taskId: e.task_id,
    eventType: e.event_type,
    detail: e.detail,
    createdAt: e.created_at,
  }));
}

export async function getRecentEvents(limit = 100) {
  const r = await query(
    `SELECT * FROM event_log ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return r.rows.map(e => ({
    id: e.id,
    projectId: e.project_id,
    agentId: e.agent_id,
    taskId: e.task_id,
    eventType: e.event_type,
    detail: e.detail,
    createdAt: e.created_at,
  }));
}
