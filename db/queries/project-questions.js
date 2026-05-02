/* ═══════════════════════════════════════════════════════
   YABBY — Project Questions Queries
   ═══════════════════════════════════════════════════════ */

import { query } from "../pg.js";
import { randomUUID } from "crypto";

const genId = () => randomUUID().slice(0, 12);

function mapRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    question: row.question,
    questionType: row.question_type,
    formSchema: row.form_schema,
    answer: row.answer,
    answerData: row.answer_data,
    status: row.status,
    sortOrder: row.sort_order,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    processingStartedAt: row.processing_started_at,
    timeoutCount: row.timeout_count || 0,
  };
}

export async function createQuestion({ projectId, agentId, question, questionType, formSchema, sortOrder }) {
  const id = genId();
  await query(
    `INSERT INTO project_questions (id, project_id, agent_id, question, question_type, form_schema, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, projectId, agentId, question, questionType || "voice", formSchema ? JSON.stringify(formSchema) : "{}", sortOrder || 0]
  );
  return { id, projectId, agentId, question, questionType: questionType || "voice", formSchema, status: "pending", sortOrder: sortOrder || 0 };
}

export async function getQuestion(id) {
  const r = await query("SELECT * FROM project_questions WHERE id = $1", [id]);
  if (!r.rows[0]) return null;
  return mapRow(r.rows[0]);
}

export async function getPendingQuestions(projectId = null) {
  const sql = projectId
    ? "SELECT * FROM project_questions WHERE status = 'pending' AND project_id = $1 ORDER BY sort_order ASC, created_at ASC"
    : "SELECT * FROM project_questions WHERE status = 'pending' ORDER BY sort_order ASC, created_at ASC";
  const params = projectId ? [projectId] : [];
  const r = await query(sql, params);
  return r.rows.map(mapRow);
}

export async function resolveQuestion(id, answer, answerData) {
  await query(
    "UPDATE project_questions SET answer = $1, answer_data = $2, status = 'answered', resolved_at = NOW() WHERE id = $3",
    [answer, answerData ? JSON.stringify(answerData) : "{}", id]
  );
}

export async function skipQuestion(id) {
  await query(
    "UPDATE project_questions SET status = 'skipped', resolved_at = NOW() WHERE id = $1",
    [id]
  );
}

export async function getProjectQuestions(projectId) {
  const r = await query(
    "SELECT * FROM project_questions WHERE project_id = $1 ORDER BY sort_order ASC, created_at ASC",
    [projectId]
  );
  return r.rows.map(mapRow);
}

/**
 * Get next pending question (for queue processing)
 * Ordered by sort_order ASC, created_at ASC (FIFO within priority)
 */
export async function getNextPendingQuestion(projectId) {
  const { rows } = await query(
    `SELECT * FROM project_questions
     WHERE project_id = $1 AND status = 'pending'
     ORDER BY sort_order ASC, created_at ASC
     LIMIT 1`,
    [projectId]
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

/**
 * Mark question as processing (sent to voice stream)
 */
export async function markQuestionProcessing(questionId) {
  await query(
    `UPDATE project_questions
     SET status = 'processing', processing_started_at = NOW()
     WHERE id = $1`,
    [questionId]
  );
}

/**
 * Mark question as timed out (increment timeout_count)
 */
export async function markQuestionTimeout(questionId) {
  await query(
    `UPDATE project_questions
     SET timeout_count = timeout_count + 1
     WHERE id = $1`,
    [questionId]
  );
}

/**
 * Get question queue length for a project
 */
export async function getQuestionQueueLength(projectId) {
  const { rows } = await query(
    `SELECT COUNT(*) as count FROM project_questions
     WHERE project_id = $1 AND status IN ('pending', 'processing')`,
    [projectId]
  );
  return parseInt(rows[0].count);
}
