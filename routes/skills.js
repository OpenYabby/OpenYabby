import { Router } from "express";
import { randomUUID } from "crypto";
import { createSkill, getSkill, listSkills, assignSkillToAgent, removeSkillFromAgent, getAgentSkills } from "../db/queries/skills.js";
import { listTemplates, getTemplate, createTemplate } from "../db/queries/templates.js";
import { log } from "../lib/logger.js";

const router = Router();

function genId() {
  return "sk-" + randomUUID().slice(0, 8);
}

// List skills
router.get("/api/skills", async (req, res) => {
  try {
    const skills = await listSkills(req.query.category || null);
    res.json({ skills });
  } catch (err) {
    log("[SKILLS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create skill
router.post("/api/skills", async (req, res) => {
  const { name, description, prompt_fragment, category } = req.body;
  if (!name || !prompt_fragment) return res.status(400).json({ error: "Missing name or prompt_fragment" });
  try {
    const skill = await createSkill(genId(), name, description, prompt_fragment, category);
    res.json(skill);
  } catch (err) {
    log("[SKILLS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get agent skills
router.get("/api/agents/:id/skills", async (req, res) => {
  try {
    const skills = await getAgentSkills(req.params.id);
    res.json({ skills });
  } catch (err) {
    log("[SKILLS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Assign skill to agent
router.post("/api/agents/:id/skills", async (req, res) => {
  const { skill_id } = req.body;
  if (!skill_id) return res.status(400).json({ error: "Missing skill_id" });
  try {
    await assignSkillToAgent(req.params.id, skill_id);
    const skills = await getAgentSkills(req.params.id);
    res.json({ skills });
  } catch (err) {
    log("[SKILLS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Remove skill from agent
router.delete("/api/agents/:agentId/skills/:skillId", async (req, res) => {
  try {
    await removeSkillFromAgent(req.params.agentId, req.params.skillId);
    res.json({ ok: true });
  } catch (err) {
    log("[SKILLS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// List templates
router.get("/api/templates", async (req, res) => {
  try {
    const templates = await listTemplates(req.query.project_type || null);
    res.json({ templates });
  } catch (err) {
    log("[TEMPLATES] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create template
router.post("/api/templates", async (req, res) => {
  const { name, role, base_prompt, default_skills, project_type } = req.body;
  if (!name || !role || !base_prompt) return res.status(400).json({ error: "Missing name, role, or base_prompt" });
  try {
    const id = "tpl-" + randomUUID().slice(0, 8);
    const template = await createTemplate(id, name, role, base_prompt, default_skills || [], project_type);
    res.json(template);
  } catch (err) {
    log("[TEMPLATES] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
