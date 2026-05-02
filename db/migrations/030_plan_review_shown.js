/* ═══════════════════════════════════════════════════════
   Migration 030 — plan_reviews.shown_as_modal
   ═══════════════════════════════════════════════════════
   Tracks whether a plan review has been auto-displayed as a
   modal at least once. Prevents the modal from reopening on
   every SSE reconnection or page reload. The user can still
   manually reopen a plan via the "Voir" button in the
   notification dropdown — that path bypasses the flag.
*/

import { query } from "../pg.js";

export const MIGRATION = `
  ALTER TABLE plan_reviews
    ADD COLUMN IF NOT EXISTS shown_as_modal BOOLEAN NOT NULL DEFAULT FALSE;

  CREATE INDEX IF NOT EXISTS idx_plan_reviews_pending_unshown
    ON plan_reviews (status, shown_as_modal)
    WHERE status = 'pending' AND shown_as_modal = FALSE;
`;

export async function run() {
  await query(MIGRATION);
}
