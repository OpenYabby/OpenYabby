import { query } from "../pg.js";

export async function createSkill(id, name, description, promptFragment, category) {
  const r = await query(
    `INSERT INTO skills (id, name, description, prompt_fragment, category)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [id, name, description, promptFragment, category]
  );
  return r.rows[0];
}

export async function getSkill(id) {
  const r = await query("SELECT * FROM skills WHERE id = $1", [id]);
  return r.rows[0] || null;
}

export async function listSkills(category = null) {
  const r = category
    ? await query("SELECT * FROM skills WHERE category = $1 ORDER BY name", [category])
    : await query("SELECT * FROM skills ORDER BY category, name");
  return r.rows;
}

export async function assignSkillToAgent(agentId, skillId) {
  await query(
    `INSERT INTO agent_skills (agent_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [agentId, skillId]
  );
}

export async function removeSkillFromAgent(agentId, skillId) {
  await query(
    `DELETE FROM agent_skills WHERE agent_id = $1 AND skill_id = $2`,
    [agentId, skillId]
  );
}

export async function getAgentSkills(agentId) {
  const r = await query(
    `SELECT s.* FROM skills s
     JOIN agent_skills a ON a.skill_id = s.id
     WHERE a.agent_id = $1
     ORDER BY s.name`,
    [agentId]
  );
  return r.rows;
}

/**
 * Build a combined prompt fragment from all of an agent's skills.
 */
export async function buildSkillsPrompt(agentId) {
  const skills = await getAgentSkills(agentId);
  if (skills.length === 0) return "";
  const fragments = skills.map(s => `[SKILL: ${s.name}]\n${s.prompt_fragment}`);
  return "\nTES COMPÉTENCES:\n" + fragments.join("\n\n");
}
