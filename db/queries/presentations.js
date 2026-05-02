/* ═══════════════════════════════════════════════════════
   YABBY — Presentation Queries
   ═══════════════════════════════════════════════════════ */

import { query } from "../pg.js";
import { randomUUID } from "crypto";

const genId = () => randomUUID().slice(0, 12);

export async function createPresentation(data) {
  const id = data.id || genId();
  await query(
    `INSERT INTO presentations
      (id, project_id, agent_id, title, summary, content, slides, demo_steps,
       sandbox_path, script_path, test_accesses, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, data.projectId, data.agentId || null, data.title, data.summary || null,
     data.content, JSON.stringify(data.slides || []), JSON.stringify(data.demoSteps || []),
     data.sandboxPath || null, data.scriptPath || null,
     JSON.stringify(data.testAccesses || []), data.status || "draft"]
  );
  return { id, ...data, status: data.status || "draft" };
}

export async function getPresentation(id) {
  const r = await query("SELECT * FROM presentations WHERE id = $1", [id]);
  if (!r.rows[0]) return null;
  return mapRow(r.rows[0]);
}

export async function listPresentations(status = null) {
  const sql = status
    ? "SELECT p.*, pr.name as project_name FROM presentations p LEFT JOIN projects pr ON pr.id = p.project_id WHERE p.status = $1 ORDER BY p.created_at DESC"
    : "SELECT p.*, pr.name as project_name FROM presentations p LEFT JOIN projects pr ON pr.id = p.project_id ORDER BY p.created_at DESC";
  const params = status ? [status] : [];
  const r = await query(sql, params);
  return r.rows.map(row => ({ ...mapRow(row), projectName: row.project_name }));
}

export async function getProjectPresentations(projectId) {
  const r = await query(
    "SELECT * FROM presentations WHERE project_id = $1 ORDER BY created_at DESC",
    [projectId]
  );
  return r.rows.map(mapRow);
}

/**
 * Returns the single non-archived presentation for a project, or null.
 * Backed by the partial unique index from migration 037.
 */
export async function getActivePresentationByProject(projectId) {
  const r = await query(
    `SELECT * FROM presentations
     WHERE project_id = $1 AND status != 'archived'
     LIMIT 1`,
    [projectId]
  );
  return r.rows[0] ? mapRow(r.rows[0]) : null;
}

export async function updatePresentation(id, fields) {
  const sets = [];
  const vals = [];
  let idx = 1;

  const fieldMap = {
    title: "title", summary: "summary", content: "content",
    slides: "slides", demoSteps: "demo_steps", status: "status",
    sandboxPath: "sandbox_path", scriptPath: "script_path",
    testAccesses: "test_accesses",
    presentedAt: "presented_at",
    lastRunAt: "last_run_at", lastRunStatus: "last_run_status", lastRunLog: "last_run_log",
  };

  const jsonFields = new Set(["slides", "demoSteps", "testAccesses"]);

  for (const [key, col] of Object.entries(fieldMap)) {
    if (fields[key] !== undefined) {
      const val = jsonFields.has(key) ? JSON.stringify(fields[key]) : fields[key];
      sets.push(`${col} = $${idx}`);
      vals.push(val);
      idx++;
    }
  }

  if (sets.length === 0) return;
  vals.push(id);
  await query(`UPDATE presentations SET ${sets.join(", ")} WHERE id = $${idx}`, vals);
}

export async function markPresented(id) {
  await query(
    "UPDATE presentations SET status = 'presented', presented_at = NOW() WHERE id = $1",
    [id]
  );
}

function mapRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    title: row.title,
    summary: row.summary,
    content: row.content,
    slides: row.slides || [],
    demoSteps: row.demo_steps || [],
    sandboxPath: row.sandbox_path,
    scriptPath: row.script_path || null,
    testAccesses: row.test_accesses || [],
    status: row.status,
    presentedAt: row.presented_at,
    lastRunAt: row.last_run_at || null,
    lastRunStatus: row.last_run_status || null,
    lastRunLog: row.last_run_log || null,
    createdAt: row.created_at,
  };
}
