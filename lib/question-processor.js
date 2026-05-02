/* ═══════════════════════════════════════════════════════
   YABBY — Project Questions Queue Processor
   ═══════════════════════════════════════════════════════
   Sequential processing of discovery questions.
   Pattern inspired by lib/agent-task-processor.js
*/

import {
  getNextPendingQuestion,
  markQuestionProcessing,
  markQuestionTimeout,
  skipQuestion,
  getQuestion,
  getPendingQuestions
} from "../db/queries/project-questions.js";
import { emitProjectQuestionEvent } from "./logger.js";
import { log } from "./logger.js";

// Concurrency control: prevent multiple processors per project
const activeProcessors = new Set();

/**
 * Process question queue for a project
 * Sends next pending question to voice stream
 * @param {string} projectId - Project ID
 */
export async function processQuestionQueue(projectId) {
  // Concurrency lock - only one processor per project at a time
  if (activeProcessors.has(projectId)) {
    log(`[QUESTION-QUEUE] Already processing project ${projectId}, skipping`);
    return;
  }

  activeProcessors.add(projectId);

  try {
    // Get next question in queue (ordered by sort_order ASC, created_at ASC)
    const nextQuestion = await getNextPendingQuestion(projectId);

    if (!nextQuestion) {
      log(`[QUESTION-QUEUE] No pending questions for project ${projectId}`);
      return;
    }

    log(`[QUESTION-QUEUE] Processing question ${nextQuestion.id} for project ${projectId}: "${nextQuestion.question.slice(0, 60)}..."`);

    // ✅ AJOUT : Enrichir avec project et agent names
    const { getProject } = await import("../db/queries/projects.js");
    const { getAgent } = await import("../db/queries/agents.js");

    const project = await getProject(nextQuestion.projectId);
    const agent = await getAgent(nextQuestion.agentId);

    nextQuestion.projectName = project?.name || nextQuestion.projectId;
    nextQuestion.agentName = agent?.name || 'Agent';

    // Mark as processing
    await markQuestionProcessing(nextQuestion.id);

    // Emit SSE event to inject into voice stream
    // Frontend will receive this and inject into DataChannel
    emitProjectQuestionEvent({
      questionId: nextQuestion.id,
      projectId: nextQuestion.projectId,
      projectName: nextQuestion.projectName,
      agentId: nextQuestion.agentId,
      agentName: nextQuestion.agentName,
      question: nextQuestion.question,
      questionType: nextQuestion.questionType,
      formSchema: nextQuestion.formSchema,
      sortOrder: nextQuestion.sortOrder
    });

    // Wait for user response (polling with timeout)
    await waitForQuestionResponse(nextQuestion.id, projectId);

  } catch (err) {
    log(`[QUESTION-QUEUE] Error processing project ${projectId}:`, err.message);
  } finally {
    activeProcessors.delete(projectId);
  }
}

/**
 * Poll question status until answered/skipped or timeout
 * @param {string} questionId - Question ID
 * @param {string} projectId - Project ID
 */
async function waitForQuestionResponse(questionId, projectId) {
  const MAX_WAIT = 600_000;  // 10 minutes
  const POLL_INTERVAL = 2000;  // 2 seconds
  const start = Date.now();

  while (Date.now() - start < MAX_WAIT) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));

    const question = await getQuestion(questionId);

    // Check if question was answered or skipped
    if (question.status === 'answered' || question.status === 'skipped') {
      log(`[QUESTION-QUEUE] Question ${questionId} ${question.status}`);

      // Check for more questions in queue
      const remaining = await getPendingQuestions(projectId);

      if (remaining.length > 0) {
        log(`[QUESTION-QUEUE] ${remaining.length} question(s) remaining, processing next`);
        setImmediate(() => processQuestionQueue(projectId));
      } else {
        log(`[QUESTION-QUEUE] All questions answered for project ${projectId}`);
      }

      return;
    }
  }

  // Timeout after 10 minutes
  log(`[QUESTION-QUEUE] Question ${questionId} timed out after 10 minutes`);
  await markQuestionTimeout(questionId);

  // Check timeout count - skip after 3 timeouts
  const question = await getQuestion(questionId);

  if (question.timeoutCount >= 3) {
    log(`[QUESTION-QUEUE] Question ${questionId} reached max timeouts (3), skipping`);
    await skipQuestion(questionId);
  } else {
    log(`[QUESTION-QUEUE] Question ${questionId} timeout ${question.timeoutCount}/3, will retry`);
    // Mark back as pending for retry
    await markQuestionProcessing(questionId);
  }

  // Continue to next question (or retry current one if timeout_count < 3)
  setImmediate(() => processQuestionQueue(projectId));
}
