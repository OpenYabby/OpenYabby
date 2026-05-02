import { query } from "../pg.js";
import { redis, KEY } from "../redis.js";

const TTL = 86400; // 24h

export async function createProject(id, name, description, projectType, context) {
  await Promise.all([
    query(
      `INSERT INTO projects (id, name, description, project_type, context)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, name, description || null, projectType || null, context || null]
    ),
    redis.set(KEY(`project:${id}:status`), "active", { EX: TTL }),
  ]);
  return { id, name, description, projectType, context, status: "active" };
}

export async function getProject(id) {
  const r = await query("SELECT * FROM projects WHERE id = $1", [id]);
  if (!r.rows[0]) return null;
  const p = r.rows[0];
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    projectType: p.project_type,
    status: p.status,
    context: p.context,
    leadAgentId: p.lead_agent_id,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export async function listProjects(status = null) {
  const r = status
    ? await query("SELECT * FROM projects WHERE status = $1 ORDER BY updated_at DESC", [status])
    : await query("SELECT * FROM projects WHERE status != 'archived' ORDER BY updated_at DESC");
  return r.rows.map(p => ({
    id: p.id,
    name: p.name,
    description: p.description,
    projectType: p.project_type,
    status: p.status,
    leadAgentId: p.lead_agent_id,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  }));
}

export async function updateProject(id, fields) {
  const sets = [];
  const vals = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    const col = key === "projectType" ? "project_type"
      : key === "leadAgentId" ? "lead_agent_id"
      : key;
    sets.push(`${col} = $${idx}`);
    vals.push(value);
    idx++;
  }
  sets.push(`updated_at = NOW()`);
  vals.push(id);

  await query(`UPDATE projects SET ${sets.join(", ")} WHERE id = $${idx}`, vals);

  if (fields.status) {
    await redis.set(KEY(`project:${id}:status`), fields.status, { EX: TTL });
  }
}

export async function setProjectLead(projectId, agentId) {
  await query("UPDATE projects SET lead_agent_id = $1, updated_at = NOW() WHERE id = $2", [agentId, projectId]);
}

// Common filler words to ignore during fuzzy name matching
const STOP_WORDS = new Set(["le", "la", "les", "de", "du", "des", "un", "une", "en", "et", "ou", "à", "au", "aux", "pour", "sur", "dans", "par", "mon", "ma", "mes", "ton", "ta", "tes", "son", "sa", "ses", "ce", "cette", "ces", "the", "a", "an", "of", "for", "and", "or", "in", "on", "to", "my", "is", "it"]);

/**
 * Find a project by name (fuzzy search with stop-word filtering).
 * Returns the best match or null.
 */
export async function findProjectByName(name) {
  // Try exact match first
  let r = await query("SELECT * FROM projects WHERE LOWER(name) = LOWER($1) AND status != 'archived'", [name]);
  if (r.rows[0]) return formatProject(r.rows[0]);

  // Try ILIKE contains
  r = await query("SELECT * FROM projects WHERE name ILIKE $1 AND status != 'archived' ORDER BY updated_at DESC LIMIT 1", [`%${name}%`]);
  if (r.rows[0]) return formatProject(r.rows[0]);

  // Try matching each significant word (skip stop words)
  const words = name.split(/\s+/).filter(w => w.length > 1 && !STOP_WORDS.has(w.toLowerCase()));
  if (words.length > 0) {
    // Build AND condition: name must contain ALL significant words
    const conditions = words.map((_, i) => `name ILIKE $${i + 1}`);
    const params = words.map(w => `%${w}%`);
    r = await query(
      `SELECT * FROM projects WHERE ${conditions.join(" AND ")} AND status != 'archived' ORDER BY updated_at DESC LIMIT 1`,
      params
    );
    if (r.rows[0]) return formatProject(r.rows[0]);

    // Try ANY significant word as a last resort
    const orConditions = words.map((_, i) => `name ILIKE $${i + 1}`);
    r = await query(
      `SELECT * FROM projects WHERE (${orConditions.join(" OR ")}) AND status != 'archived' ORDER BY updated_at DESC LIMIT 1`,
      params
    );
    if (r.rows[0]) return formatProject(r.rows[0]);
  }

  return null;
}

export async function deleteProject(id) {
  // 1. Get all running tasks for this project
  const runningTasks = await query(
    "SELECT id FROM tasks WHERE project_id = $1 AND status IN ('running', 'paused')",
    [id]
  );

  // 2. Kill all running tasks (set status to killed, actual process termination happens in spawner)
  if (runningTasks.rows.length > 0) {
    await query(
      "UPDATE tasks SET status = 'killed', updated_at = NOW() WHERE project_id = $1 AND status IN ('running', 'paused')",
      [id]
    );

    // Clear task status from Redis
    for (const task of runningTasks.rows) {
      await redis.del(KEY(`task:${task.id}:status`));
      await redis.del(KEY(`task:${task.id}:result`));
    }
  }

  // 3. Detach tasks from the project's agents before deleting the agents
  //    themselves. Tasks are append-only history — we keep the rows but null
  //    out the agent reference so the fk_tasks_agent constraint doesn't
  //    block the DELETE. Migration 040 also sets ON DELETE SET NULL on this
  //    FK so this is defence-in-depth (works even on databases that haven't
  //    yet run that migration).
  const agents = await query("SELECT id FROM agents WHERE project_id = $1", [id]);
  if (agents.rows.length > 0) {
    await query("UPDATE tasks SET agent_id = NULL WHERE project_id = $1", [id]);
    for (const agent of agents.rows) {
      await redis.del(KEY(`agent:${agent.id}:status`));
      await redis.del(KEY(`agent:${agent.id}:session`));
    }
    await query("DELETE FROM agents WHERE project_id = $1", [id]);
  }

  // 4. Archive project and cancel pending items
  await Promise.all([
    query("UPDATE projects SET status = 'archived', updated_at = NOW() WHERE id = $1", [id]),
    query("UPDATE project_questions SET status = 'cancelled', resolved_at = NOW() WHERE project_id = $1 AND status = 'pending'", [id]),
    query("UPDATE plan_reviews SET status = 'cancelled', resolved_at = NOW() WHERE project_id = $1 AND status = 'pending'", [id]),
  ]);
}

export async function renameProject(id, newName) {
  await query("UPDATE projects SET name = $1, updated_at = NOW() WHERE id = $2", [newName, id]);
}

function formatProject(p) {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    projectType: p.project_type,
    status: p.status,
    context: p.context,
    leadAgentId: p.lead_agent_id,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}
