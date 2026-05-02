import { query } from "../pg.js";

export async function recordHeartbeat(agentId, projectId, taskId, status, progress, summary) {
  const r = await query(
    `INSERT INTO agent_heartbeats (agent_id, project_id, task_id, status, progress, summary)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [agentId, projectId || null, taskId || null, status || "working", progress || 0, summary || ""]
  );
  return r.rows[0];
}

export async function getLatestHeartbeats(projectId) {
  const r = await query(
    `SELECT DISTINCT ON (agent_id) agent_id, project_id, task_id, status, progress, summary, created_at
     FROM agent_heartbeats
     WHERE project_id = $1
     ORDER BY agent_id, created_at DESC`,
    [projectId]
  );
  return r.rows.map(h => ({
    agentId: h.agent_id,
    projectId: h.project_id,
    taskId: h.task_id,
    status: h.status,
    progress: h.progress,
    summary: h.summary,
    createdAt: h.created_at,
  }));
}

export async function getAgentHeartbeats(agentId, limit = 20) {
  const r = await query(
    `SELECT * FROM agent_heartbeats WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [agentId, limit]
  );
  return r.rows.map(h => ({
    agentId: h.agent_id,
    projectId: h.project_id,
    taskId: h.task_id,
    status: h.status,
    progress: h.progress,
    summary: h.summary,
    createdAt: h.created_at,
  }));
}
