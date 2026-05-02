import { query } from "../pg.js";
import { redis, KEY } from "../redis.js";
import { randomUUID } from "crypto";

const TTL = 86400;
function normalizeRunnerSessions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

export async function createAgent(id, projectId, name, role, systemPrompt, metadata = {}) {
  console.log(`[createAgent] Saving agent ${name} with system_prompt length:`, systemPrompt?.length || 0);

  const sessionId = randomUUID();
  const parentAgentId = metadata.parentAgentId || null;
  const isLead = !!metadata.isLead;
  const cliSystemPrompt = metadata.cliSystemPrompt || null;
  await Promise.all([
    query(
      `INSERT INTO agents (id, project_id, name, role, system_prompt, cli_system_prompt, session_id, metadata, parent_agent_id, is_lead)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, projectId, name, role, systemPrompt, cliSystemPrompt, sessionId, JSON.stringify(metadata), parentAgentId, isLead]
    ),
    redis.set(KEY(`agent:${id}:status`), "active", { EX: TTL }),
    redis.set(KEY(`agent:${id}:session`), sessionId, { EX: TTL }),
  ]);

  // Verify saved
  const saved = await query("SELECT system_prompt FROM agents WHERE id = $1", [id]);
  console.log(`[createAgent] Verified saved system_prompt length:`, saved.rows[0]?.system_prompt?.length || 0);

  return { id, projectId, name, role, sessionId, status: "active", parentAgentId, isLead };
}

export async function getAgent(id) {
  const r = await query("SELECT * FROM agents WHERE id = $1", [id]);
  if (!r.rows[0]) return null;
  const a = r.rows[0];
  return {
    id: a.id,
    projectId: a.project_id,
    name: a.name,
    role: a.role,
    systemPrompt: a.system_prompt,
    cliSystemPrompt: a.cli_system_prompt || null,
    workspacePath: a.workspace_path || null,
    status: a.status,
    sessionId: a.session_id,
    runnerSessions: normalizeRunnerSessions(a.runner_sessions),
    metadata: a.metadata || {},
    parentAgentId: a.parent_agent_id || null,
    isLead: !!a.is_lead,
    isSuperAgent: !!a.is_super_agent,
    taskStatus: a.task_status || 'idle',
    activeTaskId: a.active_task_id || null,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

export async function getProjectAgents(projectId) {
  const r = await query(
    "SELECT * FROM agents WHERE project_id = $1 AND status = 'active' ORDER BY created_at ASC",
    [projectId]
  );
  return r.rows.map(a => ({
    id: a.id,
    projectId: a.project_id,
    name: a.name,
    role: a.role,
    status: a.status,
    sessionId: a.session_id,
    runnerSessions: normalizeRunnerSessions(a.runner_sessions),
    metadata: a.metadata || {},
    parentAgentId: a.parent_agent_id || null,
    isLead: !!a.is_lead,
    // Exposed so the frontend can show a yellow "running" dot + badge on
    // agents that are currently executing a task. Heartbeat-only status
    // is too laggy (only updates when the agent emits a heartbeat); this
    // is the authoritative runtime flag flipped by setActiveTask.
    taskStatus: a.task_status || 'idle',
    activeTaskId: a.active_task_id || null,
  }));
}

/**
 * Définir la tâche active d'un agent (première tâche persistante).
 * Passer `taskId = null` pour libérer l'agent (tâche terminée).
 */
export async function setActiveTask(agentId, taskId) {
  const key = KEY(`agent:${agentId}:active_task`);
  await Promise.all([
    query(
      `UPDATE agents
       SET active_task_id = $1,
           task_status    = CASE WHEN $1::varchar IS NULL THEN 'idle' ELSE 'running' END,
           last_activity_at = NOW()
       WHERE id = $2`,
      [taskId, agentId]
    ),
    // redis.set() throws "Invalid argument type" if value is null/undefined —
    // when clearing, delete the key instead of writing a null.
    taskId == null
      ? redis.del(key).catch(() => {})
      : redis.set(key, String(taskId), { EX: 86400 })
  ]);
}

/**
 * Obtenir l'ID de la tâche active d'un agent
 */
export async function getActiveTaskId(agentId) {
  // Check Redis first
  const cached = await redis.get(KEY(`agent:${agentId}:active_task`));
  if (cached) return cached;

  // Fallback to PG
  const result = await query(
    `SELECT active_task_id FROM agents WHERE id = $1`,
    [agentId]
  );
  const taskId = result.rows[0]?.active_task_id;
  if (taskId) {
    await redis.set(KEY(`agent:${agentId}:active_task`), taskId, { EX: 86400 });
  }
  return taskId || null;
}

/**
 * Mettre à jour le statut de tâche d'un agent
 */
export async function updateAgentTaskStatus(agentId, status) {
  await Promise.all([
    query(
      `UPDATE agents
       SET task_status = $1, last_activity_at = NOW()
       WHERE id = $2`,
      [status, agentId]
    ),
    redis.set(KEY(`agent:${agentId}:task_status`), status, { EX: 86400 })
  ]);
}

/**
 * Obtenir le statut de tâche d'un agent
 */
export async function getAgentTaskStatus(agentId) {
  const cached = await redis.get(KEY(`agent:${agentId}:task_status`));
  if (cached) return cached;

  const result = await query(
    `SELECT task_status FROM agents WHERE id = $1`,
    [agentId]
  );
  const status = result.rows[0]?.task_status || 'idle';
  await redis.set(KEY(`agent:${agentId}:task_status`), status, { EX: 86400 });
  return status;
}

export async function listAgents(projectId = null) {
  const r = projectId
    ? await query("SELECT * FROM agents WHERE project_id = $1 AND status != 'archived' ORDER BY created_at DESC", [projectId])
    : await query("SELECT * FROM agents WHERE status != 'archived' ORDER BY created_at DESC");
  return r.rows.map(a => ({
    id: a.id,
    projectId: a.project_id,
    name: a.name,
    role: a.role,
    status: a.status,
    sessionId: a.session_id,
    runnerSessions: normalizeRunnerSessions(a.runner_sessions),
    taskStatus: a.task_status || 'idle',
    activeTaskId: a.active_task_id || null,
  }));
}

/**
 * List only standalone agents (project_id IS NULL)
 */
export async function listStandaloneAgents() {
  const r = await query(
    "SELECT * FROM agents WHERE project_id IS NULL AND status != 'archived' ORDER BY created_at DESC"
  );
  return r.rows.map(formatAgent);
}

/**
 * Check if agent is standalone (no project OR is lead agent)
 * Lead agents use persistent queues like standalone agents
 */
/**
 * Returns true for every agent that owns a persistent Claude session
 * (one long-running task that resumes across queue items). That includes
 * the Yabby super-agent, lead/director agents, standalone agents, sub-agents.
 *
 * Kept under the legacy name `isStandaloneAgent` because it is referenced
 * by many callers; conceptually this now means "has a persistent queue".
 */
export async function isStandaloneAgent(agentId) {
  if (!agentId) return false;
  const agent = await getAgent(agentId);
  if (!agent) return false;
  return true;
}

/**
 * Get workspace path for an agent.
 * Returns { type, path } where type is 'yabby' | 'project' | 'standalone'.
 * Returns null if the agent doesn't exist.
 */
export async function getAgentWorkspaceInfo(agentId) {
  const agent = await getAgent(agentId);
  if (!agent) return null;

  const {
    getSandboxPath,
    getAgentWorkspacePath,
    getYabbyWorkspacePath,
  } = await import("../../lib/sandbox.js");

  // CASE 1: Yabby super agent → dedicated fixed folder
  if (agent.isSuperAgent || agent.id === "yabby-000000") {
    return { type: "yabby", path: await getYabbyWorkspacePath() };
  }

  // CASE 2: Project agent → project sandbox (Group Projects)
  if (agent.projectId) {
    return { type: "project", path: await getSandboxPath(agent.projectId) };
  }

  // CASE 3: Standalone agent → persistent agent workspace (Independent Tasks)
  return { type: "standalone", path: await getAgentWorkspacePath(agent.id, agent.name) };
}

/**
 * List agents grouped by type (standalone vs project)
 */
export async function listAgentsGrouped() {
  const allAgents = await listAgents();
  return {
    standalone: allAgents.filter(a => a.projectId === null),
    project: allAgents.filter(a => a.projectId !== null)
  };
}

export async function updateAgent(id, fields) {
  const sets = [];
  const vals = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    const col = key === "systemPrompt" ? "system_prompt"
      : key === "projectId" ? "project_id"
      : key === "sessionId" ? "session_id"
      : key === "runnerSessions" ? "runner_sessions"
      : key;
    sets.push(`${col} = $${idx}`);
    vals.push((key === "metadata" || key === "runnerSessions") ? JSON.stringify(value) : value);
    idx++;
  }
  sets.push(`updated_at = NOW()`);
  vals.push(id);

  await query(`UPDATE agents SET ${sets.join(", ")} WHERE id = $${idx}`, vals);

  if (fields.status) {
    await redis.set(KEY(`agent:${id}:status`), fields.status, { EX: TTL });
  }
}

export async function updateAgentRunnerSession(agentId, runnerId, sessionKey) {
  if (!agentId || !runnerId) return;
  try {
    if (!sessionKey) {
      await query(
        `UPDATE agents
         SET runner_sessions = COALESCE(runner_sessions, '{}'::jsonb) - $2::text,
             updated_at = NOW()
         WHERE id = $1`,
        [agentId, runnerId]
      );
      return;
    }
    await query(
      `UPDATE agents
       SET runner_sessions = jsonb_set(
         COALESCE(runner_sessions, '{}'::jsonb),
         $2::text[],
         to_jsonb($3::text),
         true
       ),
       updated_at = NOW()
       WHERE id = $1`,
      [agentId, [runnerId], sessionKey]
    );
  } catch (err) {
    // Column not found: migration not applied yet
    if (err?.code !== "42703") throw err;
  }
}

export async function getAgentRunnerSession(agentId, runnerId) {
  if (!agentId || !runnerId) return null;
  try {
    const r = await query(
      `SELECT runner_sessions ->> $2 AS session_key
       FROM agents
       WHERE id = $1`,
      [agentId, runnerId]
    );
    return r.rows[0]?.session_key || null;
  } catch (err) {
    // Column not found: migration not applied yet
    if (err?.code !== "42703") throw err;
    return null;
  }
}

export async function suspendAgent(id) {
  await updateAgent(id, { status: "suspended" });
}

export async function activateAgent(id) {
  await updateAgent(id, { status: "active" });
}

export async function deleteAgent(id) {
  const agent = await getAgent(id);

  // ⚠️ PROTECTION: Cannot delete super agents
  if (agent && agent.isSuperAgent) {
    throw new Error(`Cannot delete super agent: ${agent.name}`);
  }

  await Promise.all([
    query("UPDATE agents SET status = 'archived', updated_at = NOW() WHERE id = $1", [id]),
    redis.del(KEY(`agent:${id}:status`)),
    redis.del(KEY(`agent:${id}:session`)),
  ]);

  // Log differently for standalone vs project agents
  if (agent) {
    if (agent.projectId === null) {
      console.log(`[AGENTS] Archived standalone agent: ${id} (${agent.name})`);
    } else {
      console.log(`[AGENTS] Archived project agent: ${id} (${agent.name}) from project ${agent.projectId}`);
    }
  }
}

/**
 * Find an agent by EXACT name (case-insensitive, no fuzzy matching).
 * Used for duplicate checking during agent creation.
 */
export async function findAgentByExactName(name, projectId = null) {
  let r;
  if (projectId) {
    r = await query("SELECT * FROM agents WHERE LOWER(name) = LOWER($1) AND project_id = $2 AND status != 'archived'", [name, projectId]);
  } else {
    r = await query("SELECT * FROM agents WHERE LOWER(name) = LOWER($1) AND status != 'archived'", [name]);
  }
  return r.rows[0] ? formatAgent(r.rows[0]) : null;
}

/**
 * Find an agent by name (fuzzy ILIKE search).
 * Optionally scoped to a project.
 */
export async function findAgentByName(name, projectId = null) {
  let r;
  const scopeClause = projectId ? " AND project_id = " : "";

  if (projectId) {
    r = await query("SELECT * FROM agents WHERE LOWER(name) = LOWER($1) AND project_id = $2 AND status != 'archived'", [name, projectId]);
    if (r.rows[0]) return formatAgent(r.rows[0]);
    r = await query("SELECT * FROM agents WHERE name ILIKE $1 AND project_id = $2 AND status != 'archived' ORDER BY updated_at DESC LIMIT 1", [`%${name}%`, projectId]);
  } else {
    r = await query("SELECT * FROM agents WHERE LOWER(name) = LOWER($1) AND status != 'archived'", [name]);
    if (r.rows[0]) return formatAgent(r.rows[0]);
    r = await query("SELECT * FROM agents WHERE name ILIKE $1 AND status != 'archived' ORDER BY updated_at DESC LIMIT 1", [`%${name}%`]);
  }
  if (r.rows[0]) return formatAgent(r.rows[0]);

  // Try searching by role as well (e.g., user says "le développeur" or "the developer")
  if (projectId) {
    r = await query("SELECT * FROM agents WHERE role ILIKE $1 AND project_id = $2 AND status != 'archived' ORDER BY updated_at DESC LIMIT 1", [`%${name}%`, projectId]);
  } else {
    r = await query("SELECT * FROM agents WHERE role ILIKE $1 AND status != 'archived' ORDER BY updated_at DESC LIMIT 1", [`%${name}%`]);
  }
  if (r.rows[0]) return formatAgent(r.rows[0]);

  return null;
}

export async function getSubAgents(parentAgentId) {
  const r = await query(
    "SELECT * FROM agents WHERE parent_agent_id = $1 AND status = 'active' ORDER BY created_at ASC",
    [parentAgentId]
  );
  return r.rows.map(formatAgent);
}

export async function getLeadAgent(projectId) {
  const r = await query(
    "SELECT * FROM agents WHERE project_id = $1 AND is_lead = true AND status = 'active' LIMIT 1",
    [projectId]
  );
  return r.rows[0] ? formatAgent(r.rows[0]) : null;
}

function formatAgent(a) {
  return {
    id: a.id,
    projectId: a.project_id,
    name: a.name,
    role: a.role,
    status: a.status,
    sessionId: a.session_id,
    runnerSessions: normalizeRunnerSessions(a.runner_sessions),
    metadata: a.metadata || {},
    parentAgentId: a.parent_agent_id || null,
    isLead: !!a.is_lead,
    taskStatus: a.task_status || 'idle',
    activeTaskId: a.active_task_id || null,
  };
}
