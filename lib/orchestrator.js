/**
 * Orchestrator — auto-triggers manager/lead review when sub-agents complete tasks.
 *
 * Two triggers:
 * 1. Redis agent-bus: when a task_complete message arrives for any manager
 * 2. Spawner hook: when a manager's own task finishes, check for pending inbox messages
 *
 * Any manager (lead or mid-level with children) is relaunched when they have pending messages.
 */
import { createClient } from "redis";
import { getAgent, getLeadAgent, getSubAgents } from "../db/queries/agents.js";
import { log } from "./logger.js";
import { registerManagerTaskCallback } from "./spawner.js";
import { enqueueTask } from "../db/queries/agent-task-queue.js";
import { processAgentQueue } from "./agent-task-processor.js";
import { query } from "../db/pg.js";

const CHANNEL = "yabby:agent-bus";
let subscriber = null;

// Debounce per manager: don't spawn if one was spawned recently
// Uses a short window (5s) to batch near-simultaneous completions,
// then schedules a delayed check to catch any that arrived during the window
const recentReviews = new Map(); // managerId -> timestamp
const DEBOUNCE_MS = 60000; // 60s — batch near-simultaneous completions (15s was too aggressive, caused 33 reviews in 6h)
const DELAYED_CHECK_MS = 60000; // re-check after debounce to catch any stragglers
const pendingChecks = new Map(); // managerId -> timeout handle

export async function initOrchestrator() {
  // Register callback with spawner (avoids circular import)
  registerManagerTaskCallback(onManagerTaskComplete);

  const url = process.env.REDIS_URL || "redis://localhost:6379";
  subscriber = createClient({ url });
  subscriber.on("error", (err) => log("[ORCHESTRATOR] Redis error:", err.message));
  await subscriber.connect();

  await subscriber.subscribe(CHANNEL, async (message) => {
    try {
      const data = JSON.parse(message);

      // Only handle task_complete messages
      if (data.msgType !== "task_complete") return;

      const targetAgent = await getAgent(data.toAgent);
      if (!targetAgent) return;

      // Trigger for ANY agent that has sub-agents (manager) or isLead
      const children = await getSubAgents(targetAgent.id);
      if (children.length === 0 && !targetAgent.isLead) return;

      await triggerManagerReview(targetAgent, "agent-bus task_complete");
    } catch (err) {
      log("[ORCHESTRATOR] Error:", err.message);
    }
  });

  log("[ORCHESTRATOR] Initialized — listening for task_complete messages");
}

/**
 * Called from spawner.js when a manager/lead agent's own task finishes.
 *
 * Historically this was required because the orchestrator used to SKIP
 * enqueueing when the manager had a running task, expecting to be called
 * back here to trigger the review. Now that reviews are always enqueued
 * (queue + --resume keeps context intact), this callback is a safety net:
 * if inbox messages are still pending with no queued review, re-trigger.
 */
export async function onManagerTaskComplete(agentId, projectId) {
  setTimeout(async () => {
    try {
      const [pendingCount, agent] = await Promise.all([
        countPendingInbox(agentId),
        getAgent(agentId),
      ]);
      if (!agent || pendingCount === 0) return;

      // Skip if a review is already queued — no point stacking duplicates.
      const queuedReview = await query(
        `SELECT id FROM agent_task_queue
         WHERE agent_id = $1 AND source = 'orchestrator_review' AND status IN ('pending','processing')
         LIMIT 1`,
        [agentId]
      );
      if (queuedReview.rows.length > 0) return;

      log(`[ORCHESTRATOR] Safety-net: ${agent.name} finished with ${pendingCount} pending messages — enqueueing review`);
      await triggerManagerReview(agent, `${pendingCount} pending inbox messages after task completion`);
    } catch (err) {
      log("[ORCHESTRATOR] onManagerTaskComplete error:", err.message);
    }
  }, 3000); // 3s delay to let DB settle
}

/**
 * Core logic: decide whether to spawn a review task for a manager/lead.
 */
async function triggerManagerReview(managerAgent, reason) {
  const managerId = managerAgent.id;

  // Skip auto-review only if the agent is in TRUE discovery — meaning:
  // - phase=='discovery' (never advanced — see agent-task-processor.js)
  // - AND no plan_review has been approved yet for this project
  // The second condition is the real signal: once any plan is approved, the
  // project is in execution and the lead must process sub-agent completions
  // even if its task row still has the legacy phase='discovery' value.
  const activeTaskId = managerAgent.activeTaskId;
  if (activeTaskId) {
    const { getTask } = await import("../db/queries/tasks.js");
    const activeTask = await getTask(activeTaskId);
    const taskPhase = activeTask?.phase;

    if (taskPhase === 'discovery' && managerAgent.projectId) {
      const approvedPlan = await query(
        `SELECT 1 FROM plan_reviews
         WHERE project_id = $1 AND status = 'approved' LIMIT 1`,
        [managerAgent.projectId]
      );
      if (approvedPlan.rows.length === 0) {
        log(`[ORCHESTRATOR] Agent ${managerAgent.name} in true discovery (no approved plan yet) — skipping auto-review`);
        return;
      }
      log(`[ORCHESTRATOR] Agent ${managerAgent.name} task.phase='discovery' but plan approved — proceeding with auto-review`);
    }
  }

  // Debounce to batch near-simultaneous completions. Enqueue is idempotent
  // enough that we still coalesce rapid-fire events into a single review.
  const lastReview = recentReviews.get(managerId);
  if (lastReview && Date.now() - lastReview < DEBOUNCE_MS) {
    log(`[ORCHESTRATOR] Debounce: batching for ${managerAgent.name} — scheduling delayed check`);
    scheduleDelayedCheck(managerAgent);
    return;
  }

  const pendingCount = await countPendingInbox(managerId);
  recentReviews.set(managerId, Date.now());

  const isTopLevel = managerAgent.isLead && !managerAgent.parentAgentId;
  const base = `http://localhost:${process.env.PORT || 3000}`;

  // Reporting / completion steps depend on hierarchy position
  const reportStep = isTopLevel
    ? `STEP 4 — Notify the speaker with a CONCRETE SUMMARY of what was done:
curl -s -X POST ${base}/api/notify-speaker -H "Content-Type: application/json" -d '{"agent_id":"${managerId}","project_id":"${managerAgent.projectId}","type":"progress","message":"[CONCRETE SUMMARY HERE]"}'`
    : `STEP 4 — Report to your superior if your department is done:
curl -s -X POST ${base}/api/agents/${managerId}/messages -H "Content-Type: application/json" -d '{"to_agent":"${managerAgent.parentAgentId}","project_id":"${managerAgent.projectId}","content":"[DEPARTMENT REPORT]","msg_type":"task_complete"}'`;

  const completionStep = isTopLevel
    ? `STEP 6 — If ALL agents are done AND the project is complete:
curl -s -X POST ${base}/api/notify-speaker -H "Content-Type: application/json" -d '{"agent_id":"${managerId}","project_id":"${managerAgent.projectId}","type":"complete","message":"Project completed. [FINAL REPORT]"}'`
    : `STEP 6 — If ALL your agents are done and the work is validated, send a final report to your superior:
curl -s -X POST ${base}/api/agents/${managerId}/messages -H "Content-Type: application/json" -d '{"to_agent":"${managerAgent.parentAgentId}","project_id":"${managerAgent.projectId}","content":"[FINAL DEPARTMENT REPORT — everything is completed and validated]","msg_type":"task_complete"}'`;

  const reviewInstruction = `AUTOMATIC REVIEW — ${reason}

You have ${pendingCount} pending message(s) in your inbox.

STEP 1 — Read your inbox:
curl -s ${base}/api/agents/${managerId}/inbox?status=pending

STEP 2 — Check the status of ALL project tasks:
curl -s ${base}/api/projects/${managerAgent.projectId}/tasks

STEP 3 — For each agent that has completed, you MUST:
a) Read their report in detail
b) INSPECT their work: go to the working directory, read the created files, verify quality
c) If it's a visual deliverable (website, design): take a screenshot to verify (screencapture /tmp/review-AGENT.png)
d) If the work is insufficient → relaunch with PRECISE corrections
e) If the work is good → assign a NEW task (if work remains) or mark as validated

${reportStep}

STEP 5 — Send a heartbeat with progress:
curl -s -X POST ${base}/api/heartbeat -H "Content-Type: application/json" -d '{"agent_id":"${managerId}","project_id":"${managerAgent.projectId}","status":"working","progress":[PERCENTAGE],"summary":"[SUMMARY]"}'

${completionStep}

IMPORTANT:
- You MUST process EVERY pending message. Do not ignore them.
- INSPECT each agent's work before validating it.
- If an agent failed, relaunch their task with corrected instructions.
- If an agent succeeded but the work is not perfect, give them corrections.
- Every idle agent MUST receive a new task if work remains.
- Do NOT just say "everything is fine". ACT concretely.`;

  // Skip if a review is already queued or processing for this manager.
  // The review prompt does `GET /api/agents/:id/inbox?status=pending` in
  // STEP 1, which fetches ALL pending messages in one go. Enqueueing N
  // reviews for N near-simultaneous sub-agent completions is redundant
  // — the first review already covers every message that will be pending.
  // Without this guard, a cascade of sub-completions creates a flood of
  // identical reviews (Comedy Club incident 2026-05-13: 6 reviews in 11min
  // for 4 actual completions, plus self-loop via Yabby super-agent reacting
  // to the lead's own notify-speaker).
  const existingReview = await query(
    `SELECT id FROM agent_task_queue
     WHERE agent_id = $1 AND source = 'orchestrator_review' AND status IN ('pending','processing')
     LIMIT 1`,
    [managerId]
  );
  if (existingReview.rows.length > 0) {
    log(`[ORCHESTRATOR] Review already queued/processing for ${managerAgent.name} (queue_id=${existingReview.rows[0].id}) — skipping duplicate`);
    return;
  }

  // Enqueue the review on the manager's persistent queue. This preserves
  // the "one persistent task per manager" invariant: if the manager is
  // already running something, the processor will pick this up as the next
  // item (session resumed). If idle, the processor spawns it immediately.
  // No parallel tasks, no context loss.
  const reviewTitle = `Review — ${reason.slice(0, 60)}`;
  await enqueueTask(managerId, reviewInstruction, 'orchestrator_review', null, 80, reviewTitle);
  setImmediate(() => {
    processAgentQueue(managerId).catch(err => {
      log(`[ORCHESTRATOR] processAgentQueue failed for ${managerId}: ${err.message}`);
    });
  });
  log(`[ORCHESTRATOR] Review enqueued for ${managerAgent.name} (reason: ${reason}, ${pendingCount} pending)`);
}

/**
 * Schedule a delayed check for pending inbox messages.
 * If multiple events trigger this, only the latest scheduled check runs.
 */
function scheduleDelayedCheck(managerAgent) {
  const managerId = managerAgent.id;
  if (pendingChecks.has(managerId)) {
    clearTimeout(pendingChecks.get(managerId));
  }
  const handle = setTimeout(async () => {
    pendingChecks.delete(managerId);
    try {
      const pendingCount = await countPendingInbox(managerId);
      if (pendingCount > 0) {
        log(`[ORCHESTRATOR] Delayed check: ${managerAgent.name} has ${pendingCount} pending messages — enqueueing review`);
        await triggerManagerReview(managerAgent, `${pendingCount} pending inbox messages (delayed check)`);
      }
    } catch (err) {
      log("[ORCHESTRATOR] Delayed check error:", err.message);
    }
  }, DELAYED_CHECK_MS);
  pendingChecks.set(managerId, handle);
}

async function countPendingInbox(agentId) {
  const r = await query(
    "SELECT COUNT(*) as cnt FROM agent_messages WHERE to_agent = $1 AND status = 'pending'",
    [agentId]
  );
  return parseInt(r.rows[0].cnt) || 0;
}

export async function closeOrchestrator() {
  // Clear all pending checks
  for (const handle of pendingChecks.values()) {
    clearTimeout(handle);
  }
  pendingChecks.clear();
  if (subscriber) {
    await subscriber.unsubscribe(CHANNEL).catch(() => {});
    await subscriber.quit().catch(() => {});
  }
}
