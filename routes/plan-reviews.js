/* ═══════════════════════════════════════════════════════
   YABBY — Plan Review Routes
   ═══════════════════════════════════════════════════════
   Lead agent submits plan for user approval before execution.
   Follows the connector-request pattern.
*/

import { Router } from "express";
import { createPlanReview, getPlanReview, getPendingReviews, resolvePlanReview, markPlanReviewShown, getLatestReview } from "../db/queries/plan-reviews.js";
import { getAgent, getActiveTaskId } from "../db/queries/agents.js";
import { getProject, deleteProject } from "../db/queries/projects.js";
import { log, emitPlanReviewEvent, emitSpeakerNotification } from "../lib/logger.js";
import { serverMsg } from "../lib/i18n.js";
import { processHandles } from "../lib/spawner.js";
import { query } from "../db/pg.js";
import { updateTaskStatus } from "../db/queries/tasks.js";
import { enqueueTask } from "../db/queries/agent-task-queue.js";
import { processAgentQueue } from "../lib/agent-task-processor.js";

const router = Router();

// ── Submit plan for review (called by lead agent via curl) ──

router.post("/api/plan-reviews", async (req, res) => {
  const { project_id, agent_id, task_id: bodyTaskId, plan_content, plan_summary } = req.body;

  if (!project_id || !agent_id || !plan_content) {
    return res.status(400).json({ error: "project_id, agent_id, and plan_content required" });
  }

  try {
    // Auto-resolve previous pending plans for same project (superseded by new version)
    await query(
      `UPDATE plan_reviews
       SET status = 'superseded', resolved_at = NOW()
       WHERE project_id = $1 AND status = 'pending'`,
      [project_id]
    );
    log(`[PLAN-REVIEW] Auto-resolved previous pending plans for project ${project_id}`);

    // Auto-resolve task_id from the agent's currently-running task when the
    // caller didn't provide one. Without this, the prompt would have to ask
    // every lead agent to thread its task_id through the curl body — but
    // task_id is an internal identifier the agent doesn't know naturally.
    // With auto-resolve, pending_emission=TRUE kicks in correctly so the
    // modal + voice announcement only fire after the CLI task exits.
    let task_id = bodyTaskId;
    if (!task_id) {
      try {
        task_id = await getActiveTaskId(agent_id);
        if (task_id) {
          log(`[PLAN-REVIEW] Auto-resolved task_id=${task_id} from agent ${agent_id}'s active task`);
        } else {
          log(`[PLAN-REVIEW] No active task for agent ${agent_id} — emission will fire immediately (legacy path)`);
        }
      } catch (resolveErr) {
        log(`[PLAN-REVIEW] task_id auto-resolve failed (proceeding without): ${resolveErr.message}`);
      }
    }

    const review = await createPlanReview({ projectId: project_id, agentId: agent_id, taskId: task_id, planContent: plan_content });

    // Resolve names for display
    const project = await getProject(project_id);
    const agent = await getAgent(agent_id);
    const projectName = project?.name || project_id;
    const agentName = agent?.name || agent_id;

    // ─── DEFERRED EMISSION ────────────────────────────────────────────
    // When the lead provided its task_id, we DON'T emit modal + voice
    // notifications now — the lead is still wrapping up its CLI task and
    // emitting now would produce two notifications for what the user
    // perceives as one event ("plan submitted, then task completed, then
    // a third 'task done' summary"). The spawner's exit handler watches
    // for plan_reviews with pending_emission=TRUE matching the exiting
    // taskId and fires the consolidated emission once at task exit
    // (lib/spawner.js around the "AUTO-NOTIFICATION CHAIN" block).
    //
    // When task_id is missing (legacy callers, manual API use), we keep
    // the original synchronous emit so the modal still appears.
    if (review.pendingEmission) {
      log(`[PLAN-DEFER] Plan submitted v${review.version} for project "${projectName}" (taskId=${task_id}) — modal + voice notification deferred to task-exit hook`);
    } else {
      log(`[PLAN-DEFER] Plan submitted v${review.version} for project "${projectName}" (no task_id) — emitting immediately (legacy path)`);
      const notifMessage = plan_summary
        ? `${agentName} has submitted a plan for "${projectName}" (v${review.version}).\n\n${plan_summary}\n\nThe full detailed plan is available on the web dashboard for review.`
        : `${agentName} has submitted a plan for "${projectName}" (v${review.version}). Open the web dashboard to review the full plan and approve, revise, or cancel.`;
      // skipChannelBroadcast: avoid pushing the long EN paste to Telegram (📋 prefix)
      // and WhatsApp (via handleTaskNotification → reformulateResult). Channels still
      // receive the clean short FR reply via the conversation-update forwarder once
      // Realtime persists its reply.
      emitSpeakerNotification(agent, project_id, "milestone", notifMessage, {
        skipVoiceAnnouncement: true,
        skipChannelBroadcast: true,
      });
      // Use the lead's own plan_summary if provided; otherwise generate a
      // short voice-friendly summary from plan_content for the speaker.
      let voiceSummary = plan_summary || null;
      if (!voiceSummary) {
        try {
          const { summarizePlanForVoice } = await import("../lib/channels/notification-listener.js");
          voiceSummary = await summarizePlanForVoice(plan_content, agentName, projectName);
        } catch (sumErr) {
          log(`[PLAN-REVIEW] Voice summary generation failed (proceeding without): ${sumErr.message}`);
        }
      }
      emitPlanReviewEvent({
        reviewId: review.id,
        planContent: plan_content,
        planSummary: voiceSummary,
        projectId: project_id,
        projectName,
        agentId: agent_id,
        agentName,
        version: review.version,
      });
      try {
        await markPlanReviewShown(review.id);
      } catch (markErr) {
        log("[PLAN-REVIEW] markPlanReviewShown failed (non-fatal):", markErr.message);
      }
    }

    log(`[PLAN-REVIEW] Plan submitted for project ${projectName} (v${review.version})`);
    res.json({ id: review.id, status: "pending", version: review.version, deferred: review.pendingEmission });
  } catch (err) {
    log("[PLAN-REVIEW] Error creating review:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── List pending reviews ──

router.get("/api/plan-reviews", async (req, res) => {
  try {
    const reviews = await getPendingReviews(req.query.projectId || null);

    // By default, filter out plans already auto-displayed as a modal — prevents
    // the modal from re-popping on every page reload. Pass ?all=true to get
    // every pending plan (used by the notification dropdown "Voir" flow).
    const includeShown = req.query.all === 'true';
    const filtered = includeShown ? reviews : reviews.filter(r => !r.shownAsModal);

    // Enrich with project/agent names
    const enriched = await Promise.all(filtered.map(async (r) => {
      const project = await getProject(r.projectId);
      const agent = await getAgent(r.agentId);
      return {
        ...r,
        projectName: project?.name || r.projectId,
        agentName: agent?.name || r.agentId,
      };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Latest review for a project (any status) ──
//
// Used by the project-detail "Voir le plan" button to show the most
// recent plan in read-only mode, even after it has been approved /
// revised / cancelled. Distinct from GET / which only returns pending.

router.get("/api/plan-reviews/latest", async (req, res) => {
  try {
    const projectId = req.query.projectId;
    if (!projectId) return res.status(400).json({ error: "projectId required" });
    const review = await getLatestReview(projectId);
    // Return 200 with `review: null` when nothing exists yet — "no plan
    // submitted yet" is a valid state, not an error. A 404 was generating
    // red console noise on every project detail open just because the
    // "Voir le plan" button was probing whether to show itself.
    if (!review) return res.json({ review: null });
    const project = await getProject(review.projectId);
    const agent = await getAgent(review.agentId);
    res.json({
      ...review,
      projectName: project?.name || review.projectId,
      agentName: agent?.name || review.agentId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Get single plan review by ID ──

router.get("/api/plan-reviews/:id", async (req, res) => {
  try {
    const review = await getPlanReview(req.params.id);
    if (!review) {
      return res.status(404).json({ error: "Plan review not found" });
    }

    // Enrich with project/agent names
    const project = await getProject(review.projectId);
    const agent = await getAgent(review.agentId);

    res.json({
      ...review,
      projectName: project?.name || review.projectId,
      agentName: agent?.name || review.agentId,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Resolve a plan review (approve / revise / cancel) ──

router.post("/api/plan-reviews/:id/resolve", async (req, res) => {
  const { status, feedback } = req.body;

  if (!["approved", "revised", "cancelled"].includes(status)) {
    return res.status(400).json({
      error: `Invalid status: "${status}". Must be "approved", "revised", or "cancelled".`,
      received: req.body,
      instruction: "Use status field (not action) with one of: approved, revised, cancelled"
    });
  }

  try {
    const review = await getPlanReview(req.params.id);
    if (!review) return res.status(404).json({ error: "Review not found" });

    // Resolve names BEFORE any destructive action (cancelled deletes project + agents)
    const reviewProject = await getProject(review.projectId);
    const reviewAgent = await getAgent(review.agentId);
    const projectName = reviewProject?.name || review.projectId;
    const agentName = reviewAgent?.name || review.agentId;

    await resolvePlanReview(req.params.id, status, feedback || null);

    if (status === "approved") {
      const instruction = `[PLAN APPROVED] The user approved your plan. Now run Phase 2 as the PROJECT DIRECTOR — you DELEGATE, you do NOT code yourself.

Mandatory steps:
1. Read PLAN.md to recall the team you proposed (agent names, roles, task split, milestones, AND who reports to whom).

2. Create the entire team — managers FIRST, then their sub-agents. For each agent, POST http://localhost:3000/api/tools/execute with toolName="assign_agent" and args matching the hierarchy from your plan:
   • Managers and agents reporting DIRECTLY to YOU: pass parent_agent_id = your own agent id, set is_manager=true if they will themselves manage sub-agents.
   • Sub-agents reporting to a manager: pass parent_name = "<manager's exact name from your plan>". The server resolves the name within the project. Create each manager BEFORE its sub-agents so the lookup succeeds.

3. Delegation rule — STRICT: you delegate the first batch of work ONLY to YOUR DIRECT REPORTS (the managers you just created, plus any direct-report agents like QA). You do NOT bypass managers and assign tasks to sub-sub-agents directly — that's the manager's job, not yours.
   • For EACH of your direct reports, POST http://localhost:3000/api/tools/execute with toolName="talk_to_agent" and args { agent_id: "<their id>", instruction: "<the milestone-level mission from your plan, verbatim>" }. The instruction should be the slice of work that whole team owns — the manager will then decompose it and hand pieces to its own sub-agents.
   • If you try to send a task to an agent that is NOT your direct report, the server returns 400 with a hierarchy violation error. Read the error message — it tells you exactly who the target's actual parent is, and you should redirect the task to that parent instead.
   • Send tasks in the milestone order from your plan so dependencies are respected.

4. End YOUR task here — return a short status message. Your direct reports work in parallel and cascade tasks to their own sub-agents autonomously. The orchestrator notifies you when they finish so you can review and proceed to the next milestone.

DO NOT write HTML/CSS/JS yourself. DO NOT run Write/Edit on the project files. DO NOT delegate to sub-sub-agents directly (only to your direct reports). Your ONLY job in this task is to create the team with the right hierarchy and hand the first milestone-level work to your direct reports. Anything else is a violation of the director role.`;

      // All non-Yabby agents (leads, standalones, sub-agents) now run on the
      // persistent queue — single code path, session preserved across phases.
      await enqueueTask(review.agentId, instruction, 'api', null, 90, 'Phase 2 — Delegate & kick off team');
      setImmediate(() => processAgentQueue(review.agentId));
      log(`[PLAN-REVIEW] Plan approved, Phase 2 kickoff enqueued for ${review.agentId}`);

    } else if (status === "revised") {
      const instruction = `[PLAN À RÉVISER] L'utilisateur demande des modifications. Voici son feedback :\n\n${feedback}\n\nModifie PLAN.md selon ce feedback et resoumets via POST /api/plan-reviews.`;
      await enqueueTask(review.agentId, instruction, 'api', null, 90, 'Plan revision requested');
      setImmediate(() => processAgentQueue(review.agentId));
      log(`[PLAN-REVIEW] Plan revision enqueued for ${review.agentId}`);

    } else if (status === "cancelled") {
      // 1. Get all running tasks for this project and kill them
      const runningTasks = await query(
        "SELECT id FROM tasks WHERE project_id = $1 AND status IN ('running', 'paused')",
        [review.projectId]
      );

      // Mark each task killed in DB BEFORE sending SIGKILL so the spawner's
      // close handler returns early instead of overwriting with status="error".
      for (const task of runningTasks.rows) {
        await updateTaskStatus(task.id, "killed", "Project cancelled by user");
        const child = processHandles.get(task.id);
        if (child) {
          try {
            child.kill("SIGKILL");
            log(`[PLAN-REVIEW] Killed task process ${task.id}`);
          } catch (err) {
            log(`[PLAN-REVIEW] Error killing task ${task.id}:`, err.message);
          }
        }
      }

      // 2. Delete ALL tasks for this project (to avoid FK constraint violations)
      await query(
        "UPDATE tasks SET status = 'killed' WHERE project_id = $1 AND status != 'killed'",
        [review.projectId]
      );
      await query("DELETE FROM tasks WHERE project_id = $1", [review.projectId]);
      log(`[PLAN-REVIEW] Deleted all tasks for project ${review.projectId}`);

      // 3. Delete project (also deletes agents via CASCADE)
      await deleteProject(review.projectId);
      log(`[PLAN-REVIEW] Project ${review.projectId} cancelled: ${runningTasks.rows.length} tasks killed, all data deleted`);
    }

    // Notify voice / webchat / WhatsApp / all channels
    // Uses reviewProject/reviewAgent resolved BEFORE the destructive cancelled path
    try {
      if (status === "approved") {
        emitSpeakerNotification(reviewAgent, review.projectId, "milestone",
          serverMsg().planApproved(projectName, agentName));
      } else if (status === "revised") {
        emitSpeakerNotification(reviewAgent, review.projectId, "progress",
          serverMsg().planRevised(projectName, agentName));
      } else if (status === "cancelled") {
        emitSpeakerNotification(null, review.projectId, "error",
          serverMsg().projectCancelled(projectName));
      }
    } catch (notifyErr) {
      log("[PLAN-REVIEW] Notification error (non-fatal):", notifyErr.message);
    }

    // Emit SSE event for frontend
    emitPlanReviewEvent({
      event: "resolved",
      reviewId: req.params.id,
      status,
      projectId: review.projectId,
    });

    res.json({ ok: true, status });
  } catch (err) {
    log("[PLAN-REVIEW] Error resolving:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
