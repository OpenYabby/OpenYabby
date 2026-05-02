/* ═══════════════════════════════════════════════════════
   YABBY — Migration 025: Task Phase Tracking
   ═══════════════════════════════════════════════════════

   Adds phase column and metadata JSONB to tasks table
   for phase-aware notifications (discovery vs execution).
*/

export const MIGRATION = `
-- Add phase column to tasks table for phase-aware notifications
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS phase VARCHAR(50);
CREATE INDEX IF NOT EXISTS idx_tasks_phase ON tasks(phase) WHERE phase IS NOT NULL;

-- Add metadata JSONB column to tasks if not exists (may already exist)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_tasks_metadata ON tasks USING GIN (metadata);
`;

export async function run() {
  const { query } = await import("../pg.js");
  await query(MIGRATION);
  console.log('[MIGRATION 026] ✅ Added phase tracking to tasks');
}
