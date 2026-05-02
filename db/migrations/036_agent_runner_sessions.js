/* ═══════════════════════════════════════════════════════
   YABBY — Migration 036: Agent Runner Sessions
   ═══════════════════════════════════════════════════════
   Stores runner-native session keys per agent so resume can
   recover even if task-local context is missing.

   Example:
   {
     "claude": "<session_id>",
     "codex": "<thread_id>"
   }
*/

import { query } from "../pg.js";

export const MIGRATION = `
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS runner_sessions JSONB NOT NULL DEFAULT '{}'::jsonb;
`;

export async function run() {
  await query(MIGRATION);
}
