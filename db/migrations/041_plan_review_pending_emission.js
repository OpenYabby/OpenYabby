/* ═══════════════════════════════════════════════════════
   YABBY — Migration 041: plan_reviews.pending_emission
   ═══════════════════════════════════════════════════════
   Defers the plan_review SSE / speaker / modal emission until the
   submitting CLI task actually exits. Without this, the lead agent's
   `POST /api/plan-reviews` fires the modal + voice notification while
   the agent is still wrapping up its task — producing two notifications
   for what the user perceives as one event ("plan submitted, then task
   completed").

   New behavior: at submit time we just persist the row with
   pending_emission = TRUE. The spawner exit handler watches for this
   flag and, when the task with the matching task_id terminates, fires
   the emission once and flips pending_emission = FALSE.

   Existing rows are backfilled to FALSE — they have already been emitted
   under the old flow and must not re-fire on restart.
*/

import { query } from "../pg.js";

export const MIGRATION = `
ALTER TABLE plan_reviews
  ADD COLUMN IF NOT EXISTS pending_emission BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS idx_plan_reviews_pending_emission_task
  ON plan_reviews (task_id)
  WHERE pending_emission = TRUE;
`;

export async function run() {
  await query(MIGRATION);
}
