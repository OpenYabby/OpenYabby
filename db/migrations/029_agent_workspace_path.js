/* ═══════════════════════════════════════════════════════
   YABBY — Migration 029: Agent custom workspace path
   ═══════════════════════════════════════════════════════
   Adds `workspace_path` TEXT column to `agents` table.

   - NULL = use default workspace resolved by resolveAgentWorkspace()
   - Non-NULL = override, agent's CWD is set to this absolute path on every task spawn

   Used by POST /api/agents/:id/change-workspace endpoint so that agents can
   "move" their working directory to an existing project on the Mac (e.g.
   /Users/username/Projects/OpenYabby). The change persists across
   restarts and across all future task spawns for that agent.

   The audit trail of workspace changes is stored in `agents.metadata.workspace_history`
   (existing JSONB column, no schema change needed for that).
*/

export const MIGRATION = `
ALTER TABLE agents ADD COLUMN IF NOT EXISTS workspace_path TEXT;
`;

export async function run() {
  const { query } = await import("../pg.js");
  await query(MIGRATION);
  console.log('[MIGRATION 029] ✅ Added workspace_path column to agents');
}
