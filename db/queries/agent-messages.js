import { query } from "../pg.js";

export async function sendMessage(fromAgent, toAgent, projectId, content, msgType = "message") {
  const r = await query(
    `INSERT INTO agent_messages (from_agent, to_agent, project_id, content, msg_type)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [fromAgent, toAgent, projectId, content, msgType]
  );
  return r.rows[0];
}

export async function getInbox(agentId, status = null) {
  const r = status
    ? await query(
        `SELECT m.*, a.name as from_name, a.role as from_role
         FROM agent_messages m JOIN agents a ON a.id = m.from_agent
         WHERE m.to_agent = $1 AND m.status = $2
         ORDER BY m.created_at DESC LIMIT 50`,
        [agentId, status]
      )
    : await query(
        `SELECT m.*, a.name as from_name, a.role as from_role
         FROM agent_messages m JOIN agents a ON a.id = m.from_agent
         WHERE m.to_agent = $1
         ORDER BY m.created_at DESC LIMIT 50`,
        [agentId]
      );
  return r.rows.map(m => ({
    id: m.id,
    fromAgent: m.from_agent,
    fromName: m.from_name,
    fromRole: m.from_role,
    toAgent: m.to_agent,
    projectId: m.project_id,
    content: m.content,
    msgType: m.msg_type,
    status: m.status,
    createdAt: m.created_at,
  }));
}

export async function markRead(messageId) {
  await query(
    `UPDATE agent_messages SET status = 'read' WHERE id = $1`,
    [messageId]
  );
}

export async function markProcessed(messageId) {
  await query(
    `UPDATE agent_messages SET status = 'processed' WHERE id = $1`,
    [messageId]
  );
}

export async function getProjectMessages(projectId, limit = 50) {
  const r = await query(
    `SELECT m.*, fa.name as from_name, fa.role as from_role, ta.name as to_name, ta.role as to_role
     FROM agent_messages m
     JOIN agents fa ON fa.id = m.from_agent
     JOIN agents ta ON ta.id = m.to_agent
     WHERE m.project_id = $1
     ORDER BY m.created_at DESC LIMIT $2`,
    [projectId, limit]
  );
  return r.rows.map(m => ({
    id: m.id,
    fromAgent: m.from_agent,
    fromName: m.from_name,
    fromRole: m.from_role,
    toAgent: m.to_agent,
    toName: m.to_name,
    toRole: m.to_role,
    content: m.content,
    msgType: m.msg_type,
    status: m.status,
    createdAt: m.created_at,
  }));
}

export async function getPendingCount(agentId) {
  const r = await query(
    `SELECT COUNT(*) as count FROM agent_messages WHERE to_agent = $1 AND status = 'pending'`,
    [agentId]
  );
  return parseInt(r.rows[0].count);
}
