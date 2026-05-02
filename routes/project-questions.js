/* ═══════════════════════════════════════════════════════
   YABBY — Project Questions Routes
   ═══════════════════════════════════════════════════════
   Lead agent asks discovery questions before building the plan.
   Follows the same connector-request pattern as plan-reviews.
*/

import { Router } from "express";
import { createQuestion, getQuestion, getPendingQuestions, resolveQuestion, skipQuestion } from "../db/queries/project-questions.js";
import { getAgent } from "../db/queries/agents.js";
import { getProject } from "../db/queries/projects.js";
import { log, emitProjectQuestionEvent, emitSpeakerNotification } from "../lib/logger.js";
import { processQuestionQueue } from "../lib/question-processor.js";
import { enqueueTask } from "../db/queries/agent-task-queue.js";
import { processAgentQueue } from "../lib/agent-task-processor.js";

const router = Router();

// ── Submit a question (called by lead agent via curl) ──

router.post("/api/project-questions", async (req, res) => {
  const { project_id, agent_id, question, question_type, form_schema, sort_order } = req.body;

  if (!project_id || !agent_id || !question) {
    return res.status(400).json({ error: "project_id, agent_id, and question required" });
  }

  try {
    const q = await createQuestion({
      projectId: project_id,
      agentId: agent_id,
      question,
      questionType: question_type,
      formSchema: form_schema,
      sortOrder: sort_order,
    });

    // Resolve names for display
    const project = await getProject(project_id);
    const agent = await getAgent(agent_id);

    // ⚠️ NEW QUEUE SYSTEM: Trigger queue processor instead of emitting event immediately
    // The processor will emit SSE events sequentially as questions are processed
    setImmediate(() => processQuestionQueue(project_id));

    log(`[PROJECT-Q] Question queued for project ${project?.name || project_id}: ${question.slice(0, 80)}`);
    res.json({ id: q.id, status: "pending" });
  } catch (err) {
    log("[PROJECT-Q] Error creating question:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── List pending questions ──

router.get("/api/project-questions", async (req, res) => {
  try {
    const questions = await getPendingQuestions(req.query.projectId || null);

    // Enrich with project/agent names
    const enriched = await Promise.all(questions.map(async (q) => {
      const project = await getProject(q.projectId);
      const agent = await getAgent(q.agentId);
      return {
        ...q,
        projectName: project?.name || q.projectId,
        agentName: agent?.name || q.agentId,
      };
    }));

    res.json(enriched);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Resolve a question (user answers) ──

router.post("/api/project-questions/:id/resolve", async (req, res) => {
  const { answer, answer_data } = req.body;

  if (!answer) {
    return res.status(400).json({ error: "answer required" });
  }

  try {
    const q = await getQuestion(req.params.id);
    if (!q) return res.status(404).json({ error: "Question not found" });

    await resolveQuestion(req.params.id, answer, answer_data || {});

    // Check if all questions for this project are answered
    const remaining = await getPendingQuestions(q.projectId);

    // Every non-Yabby agent runs on a single persistent task — route every
    // answer through the queue so the lead keeps context across Q&A rounds
    // and never ends up with parallel tasks.
    let instruction;
    let title;
    if (remaining.length === 0) {
      instruction = `[DÉCOUVERTE TERMINÉE] Toutes les questions ont reçu réponse. Procède à la Phase 1 (planification).\n\nDernière réponse — Question: "${q.question}"\nRéponse: ${answer}`;
      title = 'Discovery complete → plan';
    } else {
      instruction = `[RÉPONSE] L'utilisateur a répondu à ta question.\n\nQuestion: "${q.question}"\nRéponse: ${answer}\n\nIl reste ${remaining.length} question(s) en attente. Continue la découverte ou soumets de nouvelles questions si nécessaire.`;
      title = `Answer — "${q.question.slice(0, 50)}"`;
    }
    await enqueueTask(q.agentId, instruction, 'discovery', null, 90, title);
    setImmediate(() => processAgentQueue(q.agentId));
    log(`[PROJECT-Q] Answer enqueued for ${q.agentId} (remaining: ${remaining.length})`);

    // Emit SSE event
    emitProjectQuestionEvent({
      event: "resolved",
      questionId: req.params.id,
      projectId: q.projectId,
      remainingCount: remaining.length,
    });

    res.json({ ok: true, remainingCount: remaining.length });
  } catch (err) {
    log("[PROJECT-Q] Error resolving:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Skip a question ──

router.post("/api/project-questions/:id/skip", async (req, res) => {
  try {
    const q = await getQuestion(req.params.id);
    if (!q) return res.status(404).json({ error: "Question not found" });

    await skipQuestion(req.params.id);

    const remaining = await getPendingQuestions(q.projectId);

    let instruction;
    let title;
    if (remaining.length === 0) {
      instruction = `[DÉCOUVERTE TERMINÉE] Toutes les questions ont reçu réponse ou ont été ignorées. Procède à la Phase 1 (planification).`;
      title = 'Discovery complete → plan';
    } else {
      instruction = `[QUESTION IGNORÉE] L'utilisateur a ignoré la question: "${q.question}"\n\nIl reste ${remaining.length} question(s) en attente.`;
      title = `Question skipped — "${q.question.slice(0, 50)}"`;
    }
    await enqueueTask(q.agentId, instruction, 'discovery', null, 90, title);
    setImmediate(() => processAgentQueue(q.agentId));
    log(`[PROJECT-Q] Skip enqueued for ${q.agentId} (remaining: ${remaining.length})`);

    emitProjectQuestionEvent({
      event: "resolved",
      questionId: req.params.id,
      projectId: q.projectId,
      remainingCount: remaining.length,
    });

    res.json({ ok: true, skipped: true, remainingCount: remaining.length });
  } catch (err) {
    log("[PROJECT-Q] Error skipping:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
