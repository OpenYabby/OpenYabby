/**
 * Migration 024: LLM rate limit task tracking
 *
 * Adds support for tasks that get paused due to LLM (Claude CLI) hitting
 * its daily quota. Such tasks were previously marked as 'error' and lost.
 *
 * Changes:
 * - Update tasks.status CHECK constraint to allow 'paused_llm_limit'
 * - Add task_instruction TEXT column (preserves the original instruction
 *   so the task can be resumed even if Claude session expired)
 * - Add llm_limit_reset_at TEXT column (parsed reset time, e.g. "2am (Europe/Paris)")
 * - Add paused_at TIMESTAMPTZ column (when the task was paused)
 * - Partial index on status='paused_llm_limit' for fast lookup
 */

export const MIGRATION = `
  ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
  ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
    CHECK (status IN ('running', 'done', 'error', 'paused', 'killed', 'paused_llm_limit'));

  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS task_instruction TEXT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS llm_limit_reset_at TEXT;
  ALTER TABLE tasks ADD COLUMN IF NOT EXISTS paused_at TIMESTAMPTZ;

  CREATE INDEX IF NOT EXISTS idx_tasks_status_paused_llm_limit
    ON tasks(status) WHERE status = 'paused_llm_limit';
`;

export async function run() {
  const { query } = await import("../pg.js");
  await query(MIGRATION);
  console.log("[MIGRATION 024] ✓ LLM limit task tracking ready");
}
