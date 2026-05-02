/* ═══════════════════════════════════════════════════════
   YABBY — Plan Review Queries
   ═══════════════════════════════════════════════════════ */

import { query } from "../pg.js";
import { randomUUID } from "crypto";

const genId = () => randomUUID().slice(0, 12);

function mapRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    agentId: row.agent_id,
    taskId: row.task_id,
    planContent: row.plan_content,
    status: row.status,
    feedback: row.feedback,
    version: row.version,
    shownAsModal: row.shown_as_modal === true,
    pendingEmission: row.pending_emission === true,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
  };
}

/**
 * Mark a plan review as having been auto-displayed as a modal.
 * Used to prevent the modal from reopening on every SSE reconnection
 * or page reload. Manual re-open via the "Voir" notification button
 * bypasses this flag by calling openPlanReviewModal() directly.
 */
export async function markPlanReviewShown(id) {
  await query(
    "UPDATE plan_reviews SET shown_as_modal = TRUE WHERE id = $1",
    [id]
  );
}

export async function createPlanReview({ projectId, agentId, taskId, planContent }) {
  // Determine version by counting previous reviews for this project
  const countRes = await query(
    "SELECT COUNT(*)::int AS cnt FROM plan_reviews WHERE project_id = $1",
    [projectId]
  );
  const version = (countRes.rows[0]?.cnt || 0) + 1;

  const id = genId();
  // pending_emission = TRUE only when we know which CLI task to wait for.
  // Without a task_id we have no "task exit" event to hook on, so we
  // emit immediately at submit time (legacy path).
  const pendingEmission = !!taskId;
  await query(
    `INSERT INTO plan_reviews (id, project_id, agent_id, task_id, plan_content, version, pending_emission)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, projectId, agentId, taskId || null, planContent, version, pendingEmission]
  );
  return { id, projectId, agentId, taskId, planContent, status: "pending", version, pendingEmission };
}

/**
 * Find a plan_review row that is still waiting for its submitting CLI task
 * to exit. Called by the spawner exit handler — if it returns a row, the
 * spawner fires emitPlanReviewEvent + emitSpeakerNotification and then
 * calls markPlanReviewEmitted to flip the flag.
 *
 * Filters on status='pending' so we don't re-emit reviews that the user
 * already approved/revised/cancelled in the gap between submit and task
 * exit (rare but possible if an operator manually resolves via API).
 */
export async function getPendingEmissionByTaskId(taskId) {
  if (!taskId) return null;
  const r = await query(
    `SELECT * FROM plan_reviews
     WHERE task_id = $1 AND pending_emission = TRUE AND status = 'pending'
     ORDER BY created_at DESC
     LIMIT 1`,
    [taskId]
  );
  if (!r.rows[0]) return null;
  return mapRow(r.rows[0]);
}

/**
 * Flip pending_emission to FALSE. Call after the spawner has fired
 * emitPlanReviewEvent + emitSpeakerNotification for this review so a
 * subsequent task exit (resume, retry) doesn't re-trigger the modal.
 */
export async function markPlanReviewEmitted(id) {
  await query(
    "UPDATE plan_reviews SET pending_emission = FALSE WHERE id = $1",
    [id]
  );
}

export async function getPlanReview(id) {
  const r = await query("SELECT * FROM plan_reviews WHERE id = $1", [id]);
  if (!r.rows[0]) return null;
  return mapRow(r.rows[0]);
}

export async function getPendingReviews(projectId = null) {
  const sql = projectId
    ? "SELECT * FROM plan_reviews WHERE status = 'pending' AND project_id = $1 ORDER BY created_at DESC"
    : "SELECT * FROM plan_reviews WHERE status = 'pending' ORDER BY created_at DESC";
  const params = projectId ? [projectId] : [];
  const r = await query(sql, params);
  return r.rows.map(mapRow);
}

export async function resolvePlanReview(id, status, feedback = null) {
  await query(
    "UPDATE plan_reviews SET status = $1, feedback = $2, resolved_at = NOW() WHERE id = $3",
    [status, feedback, id]
  );
}

export async function getLatestReview(projectId) {
  const r = await query(
    "SELECT * FROM plan_reviews WHERE project_id = $1 ORDER BY created_at DESC LIMIT 1",
    [projectId]
  );
  if (!r.rows[0]) return null;
  return mapRow(r.rows[0]);
}
