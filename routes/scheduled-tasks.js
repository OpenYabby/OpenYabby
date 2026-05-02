import { Router } from "express";
import {
  createScheduledTask,
  getScheduledTask,
  listScheduledTasks,
  updateScheduledTask,
  archiveScheduledTask,
  listRuns,
} from "../db/queries/scheduled-tasks.js";
import { calculateNextRun, reload as reloadScheduler, triggerNow } from "../lib/scheduler.js";
import { log } from "../lib/logger.js";
import { isStandaloneAgent, getAgent, findAgentByName } from "../db/queries/agents.js";
import { getProject, findProjectByName } from "../db/queries/projects.js";

const router = Router();

// List all scheduled tasks (optionally filtered by agent_id or project_id)
router.get("/api/scheduled-tasks", async (req, res) => {
  try {
    const filters = {};
    if (req.query.agent_id) filters.agentId = req.query.agent_id;
    if (req.query.project_id) filters.projectId = req.query.project_id;

    const tasks = await listScheduledTasks(filters);
    res.json({ tasks });
  } catch (err) {
    log("[SCHED] List error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get single scheduled task
router.get("/api/scheduled-tasks/:id", async (req, res) => {
  try {
    const task = await getScheduledTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Not found" });
    res.json(task);
  } catch (err) {
    log("[SCHED] Get error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create scheduled task
router.post("/api/scheduled-tasks", async (req, res) => {
  try {
    let { name, description, taskTemplate, scheduleType, scheduleConfig,
            projectId, agentId, maxRetries, retryDelayMs } = req.body;

    if (!name || !taskTemplate || !scheduleType) {
      return res.status(400).json({ error: "name, taskTemplate, and scheduleType are required" });
    }

    // Resolve agentId (name → ID)
    if (agentId) {
      let agent = await getAgent(agentId);
      if (!agent) agent = await findAgentByName(agentId);
      if (!agent) {
        return res.status(404).json({ error: `Agent "${agentId}" not found` });
      }
      agentId = agent.id;
      log(`[SCHED] Resolved agent: ${agent.name} (${agent.id})`);
    }

    // Resolve projectId (name → ID) - OPTIONAL
    if (projectId) {
      let project = await getProject(projectId);
      if (!project) project = await findProjectByName(projectId);
      if (!project) {
        return res.status(404).json({ error: `Project "${projectId}" not found` });
      }
      projectId = project.id;
      log(`[SCHED] Resolved project: ${project.name} (${project.id})`);
    }

    // Auto-enable use_continue for standalone agents
    let useContinue = req.body.use_continue ?? false;
    if (agentId && !useContinue) {
      const isStandalone = await isStandaloneAgent(agentId);
      if (isStandalone) {
        useContinue = true;
        log(`[SCHED] Auto-enabled use_continue for standalone agent ${agentId}`);
      }
    }

    // Calculate initial next_run_at
    const nextRunAt = calculateNextRun(scheduleType, scheduleConfig || {});

    const task = await createScheduledTask({
      name, description, taskTemplate, scheduleType,
      scheduleConfig: scheduleConfig || {},
      projectId, agentId,
      maxRetries: maxRetries ?? 3,
      retryDelayMs: retryDelayMs ?? 60000,
      nextRunAt,
      useContinue,
    });

    await reloadScheduler();
    log("[SCHED] Created:", task.id, task.name);
    res.json(task);
  } catch (err) {
    log("[SCHED] Create error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update scheduled task
router.put("/api/scheduled-tasks/:id", async (req, res) => {
  try {
    const existing = await getScheduledTask(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });

    const fields = {};
    const allowed = ["name", "description", "taskTemplate", "scheduleType",
                     "scheduleConfig", "projectId", "agentId", "maxRetries", "retryDelayMs", "use_continue"];
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }

    // Recalculate next_run_at if schedule changed
    const type = fields.scheduleType || existing.scheduleType;
    const config = fields.scheduleConfig || existing.scheduleConfig;
    fields.nextRunAt = calculateNextRun(type, config);

    const updated = await updateScheduledTask(req.params.id, fields);
    await reloadScheduler();
    log("[SCHED] Updated:", req.params.id);
    res.json(updated);
  } catch (err) {
    log("[SCHED] Update error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Pause
router.post("/api/scheduled-tasks/:id/pause", async (req, res) => {
  try {
    const task = await getScheduledTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Not found" });

    await updateScheduledTask(req.params.id, { status: "paused" });
    await reloadScheduler();
    log("[SCHED] Paused:", req.params.id);
    res.json({ id: req.params.id, status: "paused" });
  } catch (err) {
    log("[SCHED] Pause error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Activate
router.post("/api/scheduled-tasks/:id/activate", async (req, res) => {
  try {
    const task = await getScheduledTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Not found" });

    const nextRunAt = calculateNextRun(task.scheduleType, task.scheduleConfig);
    await updateScheduledTask(req.params.id, { status: "active", nextRunAt });
    await reloadScheduler();
    log("[SCHED] Activated:", req.params.id);
    res.json({ id: req.params.id, status: "active", nextRunAt });
  } catch (err) {
    log("[SCHED] Activate error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Trigger now
router.post("/api/scheduled-tasks/:id/trigger", async (req, res) => {
  try {
    await triggerNow(req.params.id);
    log("[SCHED] Triggered now:", req.params.id);
    res.json({ id: req.params.id, triggered: true });
  } catch (err) {
    log("[SCHED] Trigger error:", err.message);
    res.status(err.message.includes("not found") ? 404 : 409).json({ error: err.message });
  }
});

// Archive (soft delete)
router.delete("/api/scheduled-tasks/:id", async (req, res) => {
  try {
    await archiveScheduledTask(req.params.id);
    await reloadScheduler();
    log("[SCHED] Archived:", req.params.id);
    res.json({ id: req.params.id, status: "archived" });
  } catch (err) {
    log("[SCHED] Archive error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get run history
router.get("/api/scheduled-tasks/:id/runs", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const runs = await listRuns(req.params.id, limit);
    res.json({ runs });
  } catch (err) {
    log("[SCHED] Runs error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
