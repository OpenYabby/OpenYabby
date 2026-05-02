/* ═══════════════════════════════════════════════════════
   YABBY — Connector Queries (PG + Redis dual-write)
   ═══════════════════════════════════════════════════════ */

import { query } from "../pg.js";
import { redis, KEY } from "../redis.js";
import { randomUUID } from "crypto";

const TTL = 86400; // 24h
const genId = () => randomUUID().slice(0, 12);

// ── Connectors ──

export async function createConnector(data) {
  const id = data.id || genId();
  await query(
    `INSERT INTO connectors (id, catalog_id, label, backend, status, auth_type, credentials_encrypted, mcp_config, is_global, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, data.catalogId, data.label, data.backend || "builtin", data.status || "disconnected",
     data.authType || "none", JSON.stringify(data.credentialsEncrypted || {}),
     JSON.stringify(data.mcpConfig || {}), !!data.isGlobal, data.createdBy || "user"]
  );
  await redis.set(KEY(`connector:${id}`), JSON.stringify({ id, ...data, status: data.status || "disconnected" }), { EX: TTL });
  return { id, ...data, status: data.status || "disconnected" };
}

export async function getConnector(id) {
  // Redis first
  const cached = await redis.get(KEY(`connector:${id}`));
  if (cached) return JSON.parse(cached);

  const r = await query("SELECT * FROM connectors WHERE id = $1", [id]);
  if (!r.rows[0]) return null;
  const c = mapRow(r.rows[0]);
  await redis.set(KEY(`connector:${c.id}`), JSON.stringify(c), { EX: TTL });
  return c;
}

export async function listConnectors() {
  const r = await query("SELECT * FROM connectors WHERE status != 'archived' ORDER BY created_at DESC");
  return r.rows.map(mapRow);
}

export async function updateConnector(id, fields) {
  const sets = [];
  const vals = [];
  let idx = 1;

  const fieldMap = {
    status: "status",
    label: "label",
    backend: "backend",
    credentialsEncrypted: "credentials_encrypted",
    mcpConfig: "mcp_config",
    isGlobal: "is_global",
    errorMessage: "error_message",
  };

  for (const [key, col] of Object.entries(fieldMap)) {
    if (fields[key] !== undefined) {
      const val = (key === "credentialsEncrypted" || key === "mcpConfig")
        ? JSON.stringify(fields[key])
        : fields[key];
      sets.push(`${col} = $${idx}`);
      vals.push(val);
      idx++;
    }
  }

  if (sets.length === 0) return;
  sets.push(`updated_at = NOW()`);
  vals.push(id);
  await query(`UPDATE connectors SET ${sets.join(", ")} WHERE id = $${idx}`, vals);

  // Invalidate cache
  await redis.del(KEY(`connector:${id}`));
}

export async function archiveConnector(id) {
  await updateConnector(id, { status: "archived" });
}

// ── Project-Connector Links ──

export async function linkToProject(projectId, connectorId, linkedBy = "user") {
  const id = genId();
  await query(
    `INSERT INTO project_connectors (id, project_id, connector_id, linked_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (project_id, connector_id) DO UPDATE SET enabled = true, linked_by = $4`,
    [id, projectId, connectorId, linkedBy]
  );
  await redis.del(KEY(`project:${projectId}:connectors`));
  return { id, projectId, connectorId, linkedBy };
}

export async function unlinkFromProject(projectId, connectorId) {
  await query(
    "DELETE FROM project_connectors WHERE project_id = $1 AND connector_id = $2",
    [projectId, connectorId]
  );
  await redis.del(KEY(`project:${projectId}:connectors`));
}

export async function getProjectConnectors(projectId) {
  const cached = await redis.get(KEY(`project:${projectId}:connectors`));
  if (cached) return JSON.parse(cached);

  const r = await query(
    `SELECT c.*, pc.enabled, pc.linked_by FROM connectors c
     JOIN project_connectors pc ON pc.connector_id = c.id
     WHERE pc.project_id = $1 AND c.status != 'archived'
     ORDER BY c.created_at`,
    [projectId]
  );
  const result = r.rows.map(row => ({
    ...mapRow(row),
    linked: true,
    enabled: row.enabled,
    linkedBy: row.linked_by,
  }));
  await redis.set(KEY(`project:${projectId}:connectors`), JSON.stringify(result), { EX: TTL });
  return result;
}

export async function getGlobalConnectors() {
  const r = await query(
    "SELECT * FROM connectors WHERE is_global = true AND status != 'archived' ORDER BY created_at"
  );
  return r.rows.map(mapRow);
}

// ── Connector Requests ──

export async function createRequest(data) {
  const id = genId();
  await query(
    `INSERT INTO connector_requests (id, project_id, agent_id, catalog_id, reason)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, data.projectId, data.agentId, data.catalogId, data.reason]
  );
  return { id, ...data, status: "pending" };
}

export async function resolveRequest(id, status) {
  await query(
    "UPDATE connector_requests SET status = $1, resolved_at = NOW() WHERE id = $2",
    [status, id]
  );
}

export async function getPendingRequests(projectId = null) {
  const sql = projectId
    ? "SELECT * FROM connector_requests WHERE status = 'pending' AND project_id = $1 ORDER BY created_at DESC"
    : "SELECT * FROM connector_requests WHERE status = 'pending' ORDER BY created_at DESC";
  const params = projectId ? [projectId] : [];
  const r = await query(sql, params);
  return r.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    catalogId: row.catalog_id,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
  }));
}

export async function getRequest(id) {
  const r = await query("SELECT * FROM connector_requests WHERE id = $1", [id]);
  if (!r.rows[0]) return null;
  const row = r.rows[0];
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    catalogId: row.catalog_id,
    reason: row.reason,
    status: row.status,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

// ── Helpers ──

function mapRow(row) {
  return {
    id: row.id,
    catalogId: row.catalog_id,
    label: row.label,
    backend: row.backend,
    status: row.status,
    authType: row.auth_type,
    credentialsEncrypted: row.credentials_encrypted || {},
    mcpConfig: row.mcp_config || {},
    isGlobal: row.is_global,
    createdBy: row.created_by,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
