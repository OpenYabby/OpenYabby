/* ═══════════════════════════════════════════════════════
   Migration 031 — agent_task_queue.title
   ═══════════════════════════════════════════════════════
   Persist a short human-readable title for each queued task.
   Required so leads can reference sub-agent work cleanly
   ("continue the Homepage task", "intervene on the Navbar task")
   and so the UI (dashboard, activity) shows something meaningful
   instead of just a task id.
*/

import { query } from "../pg.js";

export const MIGRATION = `
  ALTER TABLE agent_task_queue
    ADD COLUMN IF NOT EXISTS title VARCHAR(120);
`;

export async function run() {
  await query(MIGRATION);
}
