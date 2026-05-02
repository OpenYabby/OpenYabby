import { Router } from "express";
import { randomUUID } from "crypto";
import { createProject, getProject, listProjects, updateProject, setProjectLead, findProjectByName, deleteProject, renameProject } from "../db/queries/projects.js";
import { createAgent, getAgent, getProjectAgents, findAgentByName, findAgentByExactName } from "../db/queries/agents.js";
import { getProjectEvents } from "../db/queries/events.js";
import { logEvent } from "../db/queries/events.js";
import { buildAgentPrompt, buildLeadAgentPrompt, buildSubAgentPrompt, buildManagerAgentPrompt } from "../lib/prompts.js";
import { log, emitHeartbeatEvent, emitSpeakerNotification } from "../lib/logger.js";
import { serverMsg } from "../lib/i18n.js";
import { recordHeartbeat, getLatestHeartbeats } from "../db/queries/heartbeats.js";
import { query } from "../db/pg.js";
import { enqueueTask } from "../db/queries/agent-task-queue.js";
import { processAgentQueue } from "../lib/agent-task-processor.js";

const router = Router();

function genId() {
  return randomUUID().slice(0, 12);
}

// Create a project
router.post("/api/projects", async (req, res) => {
  const { name, description, project_type, context, lead_name, lead_role } = req.body;
  log("[PROJECT] Creating:", name);

  if (!name) return res.status(400).json({ error: "Missing project name" });

  try {
    // Resolve lead name. Two accepted inputs:
    //   - A valid human first name → use as-is
    //   - Nothing (or an invalid name like "CEO", "Directeur", a role title) →
    //     silently fall back to a randomly generated real first name.
    //
    // Previously an invalid lead_name returned 400, which was a dead-end: the
    // caller (voice LLM or Yabby CLI) had no way to recover mid-tool-call.
    // Auto-falling back keeps the project creation flowing; the substitution
    // is surfaced in the response so the caller can mention it.
    const { generateLeadName, isValidLeadName } = await import("../lib/lead-names.js");

    let leadName;
    let leadNameSubstituted = false;
    if (lead_name && await isValidLeadName(lead_name)) {
      leadName = lead_name;
    } else {
      leadName = generateLeadName();
      if (lead_name) {
        leadNameSubstituted = true;
        log(`[PROJECT] lead_name "${lead_name}" rejected by validator, substituted with "${leadName}"`);
      }
    }

    // Truncate lead_role to fit the agents.role column (VARCHAR 100)
    const safeLeadRole = (lead_role || "General Director").slice(0, 100);

    // Now create the project
    const id = genId();
    const project = await createProject(id, name, description, project_type, context);

    await logEvent("project_created", {
      projectId: id,
      detail: { name, projectType: project_type },
    });

    // ✅ Auto-create lead agent with validated name
    let leadAgent = null;

    const agentId = genId();
    const projectContext = context || description || "";
    const { getSandboxPath } = await import("../lib/sandbox.js");
    const sandboxPath = await getSandboxPath(id, name);

    // Build lead agent system prompt
    const systemPrompt = buildLeadAgentPrompt(
      leadName,
      safeLeadRole,
      "", // role_instructions (empty by default)
      projectContext,
      id, // projectId
      agentId,
      sandboxPath
    );

    // Create lead agent
    leadAgent = await createAgent(agentId, id, leadName, safeLeadRole, systemPrompt, {
      parentAgentId: null,
      isLead: true,
    });

    // Set as project lead
    await setProjectLead(id, agentId);

    await logEvent("agent_created", {
      projectId: id,
      agentId,
      detail: { name: leadName, role: safeLeadRole, isLead: true },
    });

    log(`[PROJECT] Lead agent created: ${agentId} ${leadName} (role: ${safeLeadRole})`);

    log("[PROJECT] Created:", id, name);

    // 🔔 WS broadcast only — voice + channels are covered by other paths.
    //
    // skipVoiceAnnouncement: the user just spoke the create_project tool
    // call themselves and Realtime will reply contextually with the tool
    // result. Injecting a parallel speaker_notify item would force Realtime
    // to produce a second redundant spoken announcement.
    //
    // skipChannelBroadcast: without it, broadcastToChannels routes this
    // notification through handleTaskNotification → sendYabbyTaskResult,
    // which calls reformulateResult (gpt-4.1-nano) and persists a
    // reformulated `notification` turn into DEFAULT_CONV_ID — that turn
    // shows up in the Yabby web panel as a redundant duplicate of the
    // raw kickoff output (task_result_raw) and Realtime's own reply.
    // Channels still receive a clean signal because the notification-
    // listener forwards Realtime's reply (source='web') to every other
    // surface as soon as Realtime persists it.
    try {
      emitSpeakerNotification(
        leadAgent,
        id,
        "complete",
        serverMsg().projectLaunched(name, leadName),
        { skipVoiceAnnouncement: true, skipChannelBroadcast: true }
      );
    } catch (notifyErr) {
      log("[PROJECT] Notification error (non-fatal):", notifyErr.message);
    }

    res.json({
      ...project,
      lead_agent_id: leadAgent?.id || null,
      lead_name: leadName,
      lead_name_substituted: leadNameSubstituted,
      kickoff_enqueued: true,
      ...(leadNameSubstituted && {
        note: `lead_name "${lead_name}" was invalid — substituted with "${leadName}". Mention this to the user.`
      }),
    });

    // Auto-kickoff Phase 1 (discovery) for the lead agent via the persistent
    // task queue. The caller (voice, channels, or Yabby CLI super-agent) only
    // needs to call create_project — the server takes care of:
    //   create_project → create lead agent → enqueue persistent task →
    //   lead starts working (discovery questions or plan submission).
    //
    // Fire-and-forget via setImmediate so the HTTP response returns fast;
    // processAgentQueue is async and runs in the background.
    setImmediate(async () => {
      try {
        const kickoffInstruction = `Welcome to the project "${name}". You are ${leadName}, ${lead_role || "Lead / Director"}.

PROJECT CONTEXT:
${projectContext || "(no context provided — ask the user discovery questions first)"}

PHASE 1 — DISCOVERY:
If the context above is vague or incomplete, post discovery questions via POST http://localhost:3000/api/project-questions to clarify (exact scope, constraints, references, target audience). Speak to the user in their conversation language — your system prompt defines which one.

If the context is already clear enough to plan, skip to Phase 2 (planning) and submit a plan via POST http://localhost:3000/api/plan-reviews.

Read your system prompt for the full 5-phase workflow and team management API.`;

        await enqueueTask(leadAgent.id, kickoffInstruction, 'project_kickoff', null, 90, 'Phase 1 — Discovery & plan');
        log(`[PROJECT] Kickoff task enqueued for lead ${leadName} (${leadAgent.id})`);
        processAgentQueue(leadAgent.id).catch(err => {
          log(`[PROJECT] processAgentQueue failed for lead ${leadAgent.id}: ${err.message}`);
        });
      } catch (err) {
        log(`[PROJECT] ❌ Failed to enqueue kickoff task for lead ${leadAgent?.id}: ${err.message}`);
      }
    });
  } catch (err) {
    log("[PROJECT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// List projects
router.get("/api/projects", async (req, res) => {
  try {
    const status = req.query.status || null;
    const projects = await listProjects(status);

    // Enrich with agent and task counts
    for (const p of projects) {
      const agents = await getProjectAgents(p.id);
      p.agentCount = agents.length;

      const taskResult = await query(
        "SELECT COUNT(*) as total, COUNT(*) FILTER (WHERE status = 'running') as active, COUNT(*) FILTER (WHERE status = 'done') as done FROM tasks WHERE project_id = $1",
        [p.id]
      );
      p.taskCount = parseInt(taskResult.rows[0].total);
      p.activeTaskCount = parseInt(taskResult.rows[0].active);
      const doneCount = parseInt(taskResult.rows[0].done);
      p.overallProgress = p.status === 'completed' ? 100
        : p.taskCount > 0 ? Math.round((doneCount / p.taskCount) * 100) : 0;
    }

    res.json({ projects });
  } catch (err) {
    log("[PROJECTS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get project detail
router.get("/api/projects/:id", async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const agents = await getProjectAgents(req.params.id);

    const taskResult = await query(
      "SELECT id, title, status, priority, agent_id, elapsed, result, error FROM tasks WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20",
      [req.params.id]
    );
    const tasks = taskResult.rows.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      agentId: t.agent_id,
      elapsed: t.elapsed,
      result: t.status === "done" ? (t.result || "").slice(0, 2000) : undefined,
      error: t.status === "error" ? (t.error || "").slice(0, 500) : undefined,
    }));

    res.json({ ...project, agents, tasks });
  } catch (err) {
    log("[PROJECT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update project
router.put("/api/projects/:id", async (req, res) => {
  try {
    const before = await getProject(req.params.id);
    await updateProject(req.params.id, req.body);
    const project = await getProject(req.params.id);

    // When a project transitions to "completed", auto-enqueue a presentation
    // task on the lead agent. If a presentation already exists for the project
    // we ask the lead to refine it (presentation_update) rather than create a
    // duplicate — the partial unique index from migration 037 also enforces
    // this at the DB level.
    if (req.body.status === "completed" && before?.status !== "completed" && project?.leadAgentId) {
      try {
        const projectName = project.name || req.params.id;
        const { getActivePresentationByProject } = await import("../db/queries/presentations.js");
        const existing = await getActivePresentationByProject(project.id);

        let instruction, source, title;
        if (existing) {
          source = "project_complete_update";
          title = "Refine final presentation";
          instruction = `[PROJECT RE-COMPLETED] The project "${projectName}" already has an active presentation (id=${existing.id}, "${existing.title}"${existing.scriptPath ? `, script=${existing.scriptPath}` : ''}). DO NOT call create_presentation — it will error out.

Your task:
1. Call presentation_detail (project_name_or_id="${req.params.id}") to load the current content.
2. Decide what changed since the last delivery. If the start.sh still works and nothing material changed, simply end the task.
3. Otherwise call presentation_update with the fields you want to change (partial patch — only pass what's new).

If the start.sh needs updating, edit it on disk first, run it once to verify, then call presentation_update with the new script_path / test_accesses / content.`;
        } else {
          source = "project_complete";
          title = "Final presentation report";
          instruction = `[PROJECT COMPLETED] The project "${projectName}" has been marked complete.

Your FINAL task — three steps:

1. Create a start.sh at the sandbox root that brings the whole project up end-to-end. Requirements:
   - idempotent (kill stale processes on its ports first, recreate Docker volumes if needed)
   - starts every service the project needs (docker-compose up, npm run dev, uvicorn, etc.)
   - waits for them to actually respond (loop curl --max-time 30 against /health endpoints)
   - prints the URLs and test credentials at the end
   - exits 0 on success, non-zero with a clear last line on failure
   Run it once yourself to verify it works.

2. Call create_presentation with:
     project_name_or_id: "${req.params.id}"
     title: "${projectName} — Final Delivery Report"
     summary: <2-3 sentence executive summary: goal, what was built, current state>
     content: <full markdown report: 1) goal, 2) features delivered, 3) progress per agent, 4) QA results, 5) demo instructions, 6) known issues / next steps, 7) success criteria checklist>
     script_path: "<absolute path to the start.sh you just created>"
     test_accesses: [{label, url, username, password, notes}, ...]   // any test users / URLs the operator can try; [] if none
     demo_steps: ["1. ...", "2. ..."]

3. End your task.`;
        }

        await enqueueTask(project.leadAgentId, instruction, source, null, 95, title);
        setImmediate(() => processAgentQueue(project.leadAgentId));
        log(`[PROJECT] Project "${projectName}" marked complete → ${existing ? 'update' : 'create'} presentation task enqueued for lead ${project.leadAgentId}`);
      } catch (err) {
        log(`[PROJECT] Failed to enqueue presentation task (non-fatal): ${err.message}`);
      }
    }

    res.json(project);
  } catch (err) {
    log("[PROJECT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Helper: resolve project by ID or name
async function resolveProject(idOrName) {
  let project = await getProject(idOrName);
  if (!project) project = await findProjectByName(idOrName);
  return project;
}

// Delete (archive) project
router.delete("/api/projects/:id", async (req, res) => {
  try {
    const project = await resolveProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    await deleteProject(project.id);

    // Optionally clean sandbox files
    const { getConfig } = await import("../lib/config.js");
    const projectsConfig = getConfig("projects");
    if (projectsConfig?.cleanOnArchive || req.query.clean === "true") {
      const { getSandboxRoot } = await import("../lib/sandbox.js");
      const { rm } = await import("fs/promises");
      try {
        await rm(`${getSandboxRoot()}/${project.id}`, { recursive: true, force: true });
        log(`[SANDBOX] Cleaned: ${project.id}`);
      } catch {}
    }

    await logEvent("project_deleted", { projectId: project.id, detail: { name: project.name } });
    log("[PROJECT] Deleted:", project.id, project.name);
    res.json({ deleted: true, id: project.id, name: project.name });
  } catch (err) {
    log("[PROJECT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Rename project
router.patch("/api/projects/:id/rename", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: "Missing name" });
    const project = await resolveProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const oldName = project.name;
    await renameProject(project.id, name);
    await logEvent("project_renamed", { projectId: project.id, detail: { oldName, newName: name } });
    log("[PROJECT] Renamed:", project.id, oldName, "→", name);
    res.json({ renamed: true, id: project.id, oldName, newName: name });
  } catch (err) {
    log("[PROJECT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Add agent to project
router.post("/api/projects/:id/agents", async (req, res) => {
  const { name, role, role_instructions, is_lead, is_manager, parent_agent_id } = req.body;
  const projectId = req.params.id;
  log("[AGENT] Creating for project", projectId, ":", name, role, is_lead ? "(LEAD)" : is_manager ? "(MANAGER)" : parent_agent_id ? `(sub of ${parent_agent_id})` : "");

  if (!name || !role) return res.status(400).json({ error: "Missing name or role" });

  try {
    // Check for duplicate name globally (enforced by DB constraint, but provide better error)
    const existingAgent = await findAgentByExactName(name);
    if (existingAgent) {
      return res.status(409).json({
        error: `Agent name "${name}" already exists. Agent names must be globally unique.`,
        existingAgent: {
          id: existingAgent.id,
          name: existingAgent.name,
          role: existingAgent.role,
          projectId: existingAgent.projectId,
          projectName: existingAgent.projectId ? '(project agent)' : '(standalone agent)'
        }
      });
    }

    const project = await getProject(projectId);
    if (!project) return res.status(404).json({ error: "Project not found" });

    // ─── Resolve parent_agent_id from parent_name when needed ────────────
    // LLM leads naturally know the names they wrote in PLAN.md but rarely
    // have the freshly-created manager ids on hand at the moment they
    // create that manager's reports. parent_name lets them say "Aiden
    // reports to Tobias" instead of having to capture Tobias's id from
    // the previous curl response. Project-scoped lookup so name collisions
    // across projects can't accidentally re-parent.
    //
    // Priority: explicit parent_agent_id (wins) > parent_name resolution.
    let resolvedParentAgentId = parent_agent_id || null;
    const parentName = req.body.parent_name || req.body.parentName || null;
    let parentNameLookupFailed = false;
    if (!resolvedParentAgentId && parentName) {
      try {
        const parent = await findAgentByExactName(parentName, projectId);
        if (parent && parent.projectId === projectId) {
          resolvedParentAgentId = parent.id;
          log(`[AGENT] parent_name="${parentName}" resolved to id=${parent.id} in project ${projectId}`);
        } else {
          parentNameLookupFailed = true;
          log(`[AGENT] parent_name="${parentName}" not found in project ${projectId}`);
        }
      } catch (lookupErr) {
        parentNameLookupFailed = true;
        log(`[AGENT] parent_name lookup failed: ${lookupErr.message}`);
      }
    }

    // ─── Reject when no parent could be resolved for a non-lead agent ────
    // A project sub-agent without a parent is a flat hierarchy, which is
    // never what the user wanted (the plan always defines who reports to
    // whom). Returning a clear 400 forces the caller — LLM or human — to
    // be explicit instead of silently creating an orphan sub-agent.
    //
    // Bypass: is_lead=true (the project lead has no parent by design).
    if (!is_lead && !resolvedParentAgentId) {
      const reason = parentNameLookupFailed
        ? `parent_name="${parentName}" did not match any agent in project ${projectId}`
        : `neither parent_agent_id nor parent_name was provided`;
      log(`[AGENT] ❌ Rejected creation of "${name}" — ${reason}`);
      return res.status(400).json({
        error: `Cannot create non-lead agent without a parent. ${reason}.`,
        hint: `Pass one of:\n` +
          `  • "parent_agent_id": "<id>" — the id of the agent this one reports to (yours if it's a direct report, or a manager's id for sub-sub-agents)\n` +
          `  • "parent_name": "<name>" — the literal name of the parent agent in this project (server resolves it)\n` +
          `  • "is_lead": true — only when creating the project lead itself (no parent)\n\n` +
          `If this agent reports directly to YOU, pass your own agent id as parent_agent_id. If it reports to a manager you already created, use that manager's name as parent_name. ORDER MATTERS: create managers before their sub-agents.`,
        canonicalFields: {
          parent_agent_id: "string|null — id of the parent agent",
          parent_name: "string|null — name of the parent agent (project-scoped lookup)",
          is_lead: "boolean — true ONLY for the project lead",
        },
      });
    }

    const agentId = genId();
    const projectContext = project.context || project.description || "";
    const { getSandboxPath } = await import("../lib/sandbox.js");
    const sandboxPath = await getSandboxPath(projectId, project.name);

    let systemPrompt;
    if (is_lead) {
      systemPrompt = buildLeadAgentPrompt(name, role, role_instructions || "", projectContext, projectId, agentId, sandboxPath);
    } else if (resolvedParentAgentId && is_manager) {
      // Intermediate manager: has a parent but manages sub-agents
      systemPrompt = buildManagerAgentPrompt(name, role, role_instructions || "", projectContext, projectId, agentId, resolvedParentAgentId, sandboxPath);
    } else if (resolvedParentAgentId) {
      systemPrompt = buildSubAgentPrompt(name, role, role_instructions || "", projectContext, projectId, agentId, resolvedParentAgentId, sandboxPath);
    } else {
      systemPrompt = buildAgentPrompt(name, role, role_instructions || "", projectContext);
    }

    const agent = await createAgent(agentId, projectId, name, role, systemPrompt, {
      parentAgentId: resolvedParentAgentId,
      isLead: !!is_lead,
    });

    // Auto-assign qa_browser_session skill for QA roles
    if (role && (role.toLowerCase().includes('qa') || role.toLowerCase().includes('test'))) {
      try {
        await query(
          'INSERT INTO agent_skills (agent_id, skill_id) SELECT $1, id FROM skills WHERE name = $2 ON CONFLICT DO NOTHING',
          [agentId, 'qa_browser_session']
        );
        log(`[AGENTS] ✅ Auto-assigned qa_browser_session skill to ${name} (${role})`);
      } catch (err) {
        log(`[AGENTS] ⚠️  Failed to auto-assign qa_browser_session:`, err.message);
      }
    }

    if (is_lead) {
      await setProjectLead(projectId, agentId);
    }

    await logEvent("agent_created", {
      projectId, agentId,
      detail: { name, role, isLead: !!is_lead, parentAgentId: resolvedParentAgentId },
    });

    log("[AGENT] Created:", agentId, name, "as", role);
    res.json(agent);
  } catch (err) {
    log("[AGENT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// List project agents
router.get("/api/projects/:id/agents", async (req, res) => {
  try {
    const agents = await getProjectAgents(req.params.id);
    res.json({ agents });
  } catch (err) {
    log("[AGENTS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Project tasks
router.get("/api/projects/:id/tasks", async (req, res) => {
  try {
    const r = await query(
      "SELECT id, title, status, priority, agent_id, elapsed FROM tasks WHERE project_id = $1 ORDER BY created_at DESC",
      [req.params.id]
    );
    res.json({ tasks: r.rows });
  } catch (err) {
    log("[TASKS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Project events
router.get("/api/projects/:id/events", async (req, res) => {
  try {
    const events = await getProjectEvents(req.params.id, parseInt(req.query.limit) || 50);
    res.json({ events });
  } catch (err) {
    log("[EVENTS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resolve project or agent by name (for voice tools that pass names instead of IDs)
router.get("/api/resolve", async (req, res) => {
  const { type, name, project_id } = req.query;
  if (!name) return res.status(400).json({ error: "Missing name" });

  try {
    if (type === "agent") {
      const agent = await findAgentByName(name, project_id || null);
      if (!agent) return res.json({ found: false });
      return res.json({ found: true, ...agent });
    }

    // Default: resolve project
    // First try as ID
    let project = await getProject(name);
    if (!project) project = await findProjectByName(name);
    if (!project) return res.json({ found: false });
    return res.json({ found: true, ...project });
  } catch (err) {
    log("[RESOLVE] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get project by ID or name (smart lookup)
router.get("/api/projects/lookup/:idOrName", async (req, res) => {
  try {
    const idOrName = req.params.idOrName;
    // Try as ID first
    let project = await getProject(idOrName);
    // If not found, try by name
    if (!project) project = await findProjectByName(idOrName);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const agents = await getProjectAgents(project.id);
    const taskResult = await query(
      "SELECT id, title, status, priority, agent_id, elapsed, result, error FROM tasks WHERE project_id = $1 ORDER BY created_at DESC LIMIT 20",
      [project.id]
    );
    const tasks = taskResult.rows.map(t => ({
      id: t.id,
      title: t.title,
      status: t.status,
      priority: t.priority,
      agentId: t.agent_id,
      elapsed: t.elapsed,
      // Include result summary for completed tasks (truncated for voice)
      result: t.status === "done" ? (t.result || "").slice(0, 2000) : undefined,
      error: t.status === "error" ? (t.error || "").slice(0, 500) : undefined,
    }));

    res.json({ ...project, agents, tasks });
  } catch (err) {
    log("[PROJECT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// === HEARTBEAT & NOTIFICATIONS ===

// Agent reports heartbeat
router.post("/api/heartbeat", async (req, res) => {
  const { agent_id, project_id, task_id, status, progress, summary } = req.body;
  if (!agent_id) return res.status(400).json({ error: "Missing agent_id" });

  try {
    await recordHeartbeat(agent_id, project_id || null, task_id || null, status, progress, summary);
    emitHeartbeatEvent(agent_id, project_id, status, progress, summary);
    res.json({ ok: true });
  } catch (err) {
    log("[HEARTBEAT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Aggregated project heartbeat
router.get("/api/projects/:id/heartbeat", async (req, res) => {
  try {
    const project = await getProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });

    const agents = await getProjectAgents(req.params.id);
    const heartbeats = await getLatestHeartbeats(req.params.id);

    const taskResult = await query(
      `SELECT id, title, status, agent_id, elapsed, result
       FROM tasks WHERE project_id = $1
       ORDER BY created_at DESC LIMIT 30`,
      [req.params.id]
    );

    const agentStatuses = agents.map(agent => {
      const hb = heartbeats.find(h => h.agentId === agent.id);
      const agentTasks = taskResult.rows.filter(t => t.agent_id === agent.id);
      return {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        status: agent.status,
        isLead: agent.isLead || agent.id === project.leadAgentId,
        parentAgentId: agent.parentAgentId,
        taskStatus: agent.taskStatus || 'idle',
        activeTaskId: agent.activeTaskId || null,
        lastHeartbeat: hb || null,
        tasks: agentTasks.map(t => ({
          id: t.id,
          status: t.status,
          elapsed: t.elapsed,
          title: t.title,
        })),
      };
    });

    // Task-based progress (primary — always accurate, especially for completed projects)
    const totalTasks = taskResult.rows.length;
    const completedTasks = taskResult.rows.filter(t => t.status === "done").length;
    const taskProgress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

    // Heartbeat-based progress (secondary — finer granularity during execution)
    const heartbeatProgress = heartbeats.length > 0
      ? Math.round(heartbeats.reduce((sum, h) => sum + (h.progress || 0), 0) / heartbeats.length)
      : 0;

    // Use the higher value: heartbeats may reflect mid-task progress beyond the task ratio
    const overallProgress = Math.max(taskProgress, heartbeatProgress);

    res.json({
      projectId: req.params.id,
      projectName: project.name,
      overallProgress,
      agentStatuses,
      totalTasks,
      runningTasks: taskResult.rows.filter(t => t.status === "running").length,
      completedTasks,
      errorTasks: taskResult.rows.filter(t => t.status === "error").length,
    });
  } catch (err) {
    log("[HEARTBEAT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Agent (typically lead) notifies speaker/Yabby
router.post("/api/notify-speaker", async (req, res) => {
  const { agent_id, project_id, type, message } = req.body;
  if (!message) return res.status(400).json({ error: "Missing message" });

  try {
    const agent = agent_id ? await getAgent(agent_id) : null;

    await logEvent("speaker_notification", {
      projectId: project_id,
      agentId: agent_id,
      detail: { type, message: message.slice(0, 500) },
    });

    // ─── DEDUP GUARD ──────────────────────────────────────────────────
    // Lead agents often call notify-speaker right after submitting a plan
    // or posting discovery questions, even though those endpoints already
    // emit dedicated SSE events (plan_review, project_question) that drive
    // their own voice announcement AND a clean short-summary forwarded to
    // every channel via the notification-listener (when Realtime persists
    // its reply). Without this guard the user hears/sees the same
    // milestone twice — once via the dedicated event, once via this
    // generic notification. We suppress BOTH:
    //   - skipVoiceAnnouncement → no SSE speaker_notify → no Realtime
    //     DataChannel inject (no duplicate spoken summary)
    //   - skipChannelBroadcast  → no broadcastToChannels → no long EN paste
    //     pushed to Telegram (`📋 ...`) and WhatsApp (`reformulateResult`).
    //     The clean short FR reply from Realtime still reaches those
    //     channels via the conversation-update forwarder.
    let suppressBoth = false;
    let skipReason = '';
    if (agent_id) {
      try {
        const planRow = await query(
          `SELECT 1 FROM plan_reviews
           WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '2 minutes'
           LIMIT 1`,
          [agent_id]
        );
        const questionRow = await query(
          `SELECT 1 FROM project_questions
           WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '2 minutes'
           LIMIT 1`,
          [agent_id]
        );
        if (planRow.rows.length > 0) {
          suppressBoth = true;
          skipReason = 'plan_review SSE already announces it';
        } else if (questionRow.rows.length > 0) {
          suppressBoth = true;
          skipReason = 'project_question SSE already announces it';
        }
      } catch (dedupErr) {
        log(`[NOTIFY-SPEAKER] dedup check failed (proceeding): ${dedupErr.message}`);
      }
    }
    if (suppressBoth) {
      log(`[NOTIFY-SPEAKER] 🔕 voice + channels suppressed for ${agent?.name || agent_id} — ${skipReason}`);
    }

    emitSpeakerNotification(agent, project_id, type, message, {
      skipVoiceAnnouncement: suppressBoth,
      skipChannelBroadcast: suppressBoth,
    });

    log(`[NOTIFY-SPEAKER] ${agent?.name || agent_id}: ${type} — ${message.slice(0, 100)}`);
    res.json({ ok: true, notified: true, suppressed: suppressBoth });
  } catch (err) {
    log("[NOTIFY-SPEAKER] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Sandbox endpoints ──

router.get("/api/projects/:id/sandbox", async (req, res) => {
  try {
    const project = await resolveProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const { getSandboxInfo } = await import("../lib/sandbox.js");
    const info = await getSandboxInfo(project.id, project.name);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/projects/:id/sandbox/open", async (req, res) => {
  try {
    const project = await resolveProject(req.params.id);
    if (!project) return res.status(404).json({ error: "Project not found" });
    const { getSandboxPath, openInFileManager } = await import("../lib/sandbox.js");
    const path = await getSandboxPath(project.id, project.name);
    const opened = openInFileManager(path);
    res.json({ ok: opened, path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Browse directories — returns subdirectories for a given path
router.get("/api/workspace/browse", async (req, res) => {
  try {
    const { homedir } = await import("os");
    const { join, resolve } = await import("path");
    const { readdir, stat } = await import("fs/promises");

    let targetPath = req.query.path || homedir();
    // Expand ~ to home directory
    if (targetPath.startsWith("~")) targetPath = join(homedir(), targetPath.slice(1));
    targetPath = resolve(targetPath);

    // Walk up to nearest existing parent if path doesn't exist
    const { access } = await import("fs/promises");
    const { dirname } = await import("path");
    while (targetPath !== '/') {
      try { await access(targetPath); break; } catch { targetPath = dirname(targetPath); }
    }

    const entries = await readdir(targetPath, { withFileTypes: true });
    const dirs = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) continue; // hide dotfiles
      try {
        // Verify we can actually read the directory
        await readdir(join(targetPath, entry.name));
        dirs.push(entry.name);
      } catch {
        // Permission denied — skip
      }
    }
    dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
    res.json({ path: targetPath, dirs });
  } catch (err) {
    res.status(400).json({ error: err.message, path: req.query.path });
  }
});

// Open the Yabby Workspace root folder in the OS file manager
router.post("/api/workspace/open", async (_req, res) => {
  try {
    const { getSandboxRoot, openInFileManager } = await import("../lib/sandbox.js");
    const path = getSandboxRoot();
    const opened = openInFileManager(path);
    res.json({ ok: opened, path });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
