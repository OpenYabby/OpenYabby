/* ═══════════════════════════════════════════════════════
   YABBY — Presentation Routes
   ═══════════════════════════════════════════════════════ */

import { Router } from "express";
import * as db from "../db/queries/presentations.js";
import { getProject } from "../db/queries/projects.js";
import { enqueueTask } from "../db/queries/agent-task-queue.js";
import { processAgentQueue } from "../lib/agent-task-processor.js";
import { log, emitPresentationEvent } from "../lib/logger.js";

const router = Router();

// List all presentations
router.get("/api/presentations", async (req, res) => {
  try {
    const presentations = await db.listPresentations(req.query.status || null);
    res.json(presentations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get single presentation by id
router.get("/api/presentations/:id", async (req, res) => {
  try {
    const p = await db.getPresentation(req.params.id);
    if (!p) return res.status(404).json({ error: "Not found" });
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create presentation (used by agents via the create_presentation tool)
router.post("/api/presentations", async (req, res) => {
  const {
    projectId, agentId, title, summary, content,
    slides, demoSteps, sandboxPath, scriptPath, testAccesses,
  } = req.body;

  if (!projectId || !title || !content) {
    return res.status(400).json({ error: "projectId, title, and content required" });
  }

  // scriptPath is required by the new contract (one-presentation-per-project +
  // executable demo flow). Enforce it here too so direct curl calls can't bypass
  // the tool handler's check.
  if (!scriptPath) {
    return res.status(400).json({
      error: "scriptPath is required. Create a start.sh at the project sandbox root that brings the whole project up end-to-end (idempotent: kills stale processes, starts services, waits for them, exits 0 only when ready). Then include its absolute path in scriptPath.",
    });
  }

  try {
    // Validate script exists on disk and lives inside the project sandbox.
    try {
      const { accessSync, constants: fsConstants } = await import("node:fs");
      accessSync(scriptPath, fsConstants.R_OK);
    } catch {
      return res.status(400).json({
        error: `scriptPath does not exist or isn't readable: ${scriptPath}`,
      });
    }
    if (sandboxPath && !scriptPath.startsWith(sandboxPath)) {
      log(`[PRESENTATION] ⚠ scriptPath ${scriptPath} is outside sandbox ${sandboxPath}`);
      return res.status(400).json({
        error: `scriptPath must live inside the project sandbox (${sandboxPath}). Got: ${scriptPath}`,
      });
    }

    // Defense in depth: the partial unique index from migration 037 already
    // prevents this, but we surface a friendly error before the constraint fires.
    const existing = await db.getActivePresentationByProject(projectId);
    if (existing) {
      return res.status(409).json({
        error: `A presentation already exists for project ${projectId} (id=${existing.id}).`,
        existing: {
          presentationId: existing.id,
          title: existing.title,
          status: existing.status,
          scriptPath: existing.scriptPath,
          createdAt: existing.createdAt,
          agentId: existing.agentId,
        },
        suggestion: "Use presentation_detail to read it, presentation_update to modify it, or presentation_status to check its state. Do NOT call create_presentation again.",
      });
    }

    const presentation = await db.createPresentation({
      projectId, agentId, title, summary, content,
      slides: slides || [], demoSteps: demoSteps || [],
      sandboxPath, scriptPath: scriptPath || null,
      testAccesses: testAccesses || [],
      status: "ready",
    });

    emitPresentationEvent("presentation_ready", {
      presentationId: presentation.id,
      projectId,
      title,
      agentId,
      scriptPath: presentation.scriptPath,
    });

    log(`[PRESENTATION] Created: ${title} for project ${projectId}`);
    res.json(presentation);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Partial update — used by presentation_update tool and by the run-demo flow.
router.patch("/api/presentations/:id", async (req, res) => {
  try {
    const existing = await db.getPresentation(req.params.id);
    if (!existing) return res.status(404).json({ error: "Not found" });

    const allowed = [
      "title", "summary", "content", "slides", "demoSteps",
      "sandboxPath", "scriptPath", "testAccesses",
      "status", "lastRunStatus", "lastRunLog", "lastRunAt",
    ];
    const fields = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) fields[key] = req.body[key];
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: "No updatable fields provided" });
    }

    await db.updatePresentation(req.params.id, fields);
    const updated = await db.getPresentation(req.params.id);

    // Choose the right SSE channel: run-result vs generic update.
    if (fields.lastRunStatus === "passed") {
      emitPresentationEvent("presentation_run_completed", {
        presentationId: updated.id,
        projectId: updated.projectId,
        title: updated.title,
        lastRunLog: updated.lastRunLog,
      });
    } else if (fields.lastRunStatus === "failed") {
      emitPresentationEvent("presentation_run_failed", {
        presentationId: updated.id,
        projectId: updated.projectId,
        title: updated.title,
        lastRunLog: updated.lastRunLog,
      });
    } else {
      emitPresentationEvent("presentation_updated", {
        presentationId: updated.id,
        projectId: updated.projectId,
        title: updated.title,
        changedFields: Object.keys(fields),
      });
    }

    log(`[PRESENTATION] Updated ${req.params.id} (fields: ${Object.keys(fields).join(", ")})`);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark as presented (legacy — kept for backwards compat)
router.post("/api/presentations/:id/presented", async (req, res) => {
  try {
    await db.markPresented(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Trigger the demo run — enqueue a high-priority task on the project's lead
 * agent so it runs the start.sh, smoke-checks the services, and reports back
 * via presentation_update.
 */
router.post("/api/presentations/:id/run", async (req, res) => {
  try {
    const presentation = await db.getPresentation(req.params.id);
    if (!presentation) return res.status(404).json({ error: "Not found" });
    if (!presentation.scriptPath) {
      return res.status(400).json({
        error: "This presentation has no script_path — the agent didn't ship a start.sh. Ask the lead to update the presentation with a script_path.",
      });
    }

    const project = await getProject(presentation.projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });
    if (!project.leadAgentId) {
      return res.status(400).json({
        error: "Project has no lead agent — cannot dispatch the run task.",
      });
    }

    const projectName = project.name || presentation.projectId;
    const instruction = `[RUN PRESENTATION DEMO — ${projectName}]
The user just clicked "Lancer la présentation" in the web UI for project "${projectName}".
Your job:

1. Bash: bash "${presentation.scriptPath}" 2>&1 | tee /tmp/preso-${presentation.id}.log
2. Wait for the script to exit. Cap at 5 minutes.
3. Smoke-check the services with curl on the URLs you exposed in test_accesses (curl --max-time 10).
4. If everything is up, call presentation_update with:
     presentation_id="${presentation.id}",
     last_run_status="passed",
     last_run_log="<last 30 lines of /tmp/preso-${presentation.id}.log>"
5. If anything failed, call presentation_update with last_run_status="failed" and the failing
   command + error in last_run_log. DO NOT silently retry — surface the failure so the user can act.`;

    await enqueueTask(
      project.leadAgentId,
      instruction,
      "presentation_run",
      presentation.id,  // sourceId so the listener can correlate
      95,               // high priority
      `Run presentation: ${projectName}`,
    );
    setImmediate(() => processAgentQueue(project.leadAgentId));

    // Mark the presentation so the modal knows a run is in progress.
    await db.updatePresentation(presentation.id, {
      lastRunAt: new Date().toISOString(),
      lastRunStatus: "requested",
    });

    emitPresentationEvent("presentation_run_requested", {
      presentationId: presentation.id,
      projectId: presentation.projectId,
      title: presentation.title,
      leadAgentId: project.leadAgentId,
    });

    log(`[PRESENTATION] Run requested for ${presentation.id} (project ${projectName}) — dispatched to lead ${project.leadAgentId}`);
    res.json({ ok: true, presentationId: presentation.id, leadAgentId: project.leadAgentId });
  } catch (err) {
    log(`[PRESENTATION] Run dispatch error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// All presentations for a project (history, including archived)
router.get("/api/projects/:pid/presentations", async (req, res) => {
  try {
    const presentations = await db.getProjectPresentations(req.params.pid);
    res.json(presentations);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The single active presentation for a project (404 if none).
router.get("/api/projects/:pid/presentation", async (req, res) => {
  try {
    const p = await db.getActivePresentationByProject(req.params.pid);
    if (!p) return res.status(404).json({ error: "No active presentation for this project" });
    res.json(p);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
