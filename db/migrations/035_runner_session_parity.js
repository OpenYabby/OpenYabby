/* ═══════════════════════════════════════════════════════
   YABBY — Migration 035: Runner Session Parity
   ═══════════════════════════════════════════════════════
   Tracks runner-specific session metadata on tasks so resume
   can use the correct identifier for each CLI runner.

   - runner_id: logical runner key (claude, codex, ...)
   - runner_thread_id: native runner thread/session id when it
     differs from tasks.session_id (for Codex thread_id parity)
*/

import { query } from "../pg.js";

export const MIGRATION = `
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS runner_id VARCHAR(32),
  ADD COLUMN IF NOT EXISTS runner_thread_id TEXT;

CREATE INDEX IF NOT EXISTS idx_tasks_runner_id
  ON tasks(runner_id);

CREATE INDEX IF NOT EXISTS idx_tasks_runner_thread_id
  ON tasks(runner_thread_id)
  WHERE runner_thread_id IS NOT NULL;
`;

export async function run() {
  await query(MIGRATION);
}
