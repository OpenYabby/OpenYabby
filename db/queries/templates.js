import { query } from "../pg.js";

export async function createTemplate(id, name, role, basePrompt, defaultSkills, projectType) {
  const r = await query(
    `INSERT INTO agent_templates (id, name, role, base_prompt, default_skills, project_type)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [id, name, role, basePrompt, JSON.stringify(defaultSkills), projectType]
  );
  return r.rows[0];
}

export async function getTemplate(id) {
  const r = await query("SELECT * FROM agent_templates WHERE id = $1", [id]);
  if (!r.rows[0]) return null;
  const t = r.rows[0];
  return {
    id: t.id,
    name: t.name,
    role: t.role,
    basePrompt: t.base_prompt,
    defaultSkills: t.default_skills,
    projectType: t.project_type,
  };
}

export async function listTemplates(projectType = null) {
  const r = projectType
    ? await query("SELECT * FROM agent_templates WHERE project_type = $1 ORDER BY name", [projectType])
    : await query("SELECT * FROM agent_templates ORDER BY project_type, name");
  return r.rows.map(t => ({
    id: t.id,
    name: t.name,
    role: t.role,
    basePrompt: t.base_prompt,
    defaultSkills: t.default_skills,
    projectType: t.project_type,
  }));
}

export async function deleteTemplate(id) {
  await query("DELETE FROM agent_templates WHERE id = $1", [id]);
}
