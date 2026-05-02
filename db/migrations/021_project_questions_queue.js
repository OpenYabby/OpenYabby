/* ═══════════════════════════════════════════════════════
   MIGRATION 021 — Project Questions Queue
   ═══════════════════════════════════════════════════════
   - Add queue-specific columns (processing_started_at, timeout_count)
   - Add index for efficient queue processing
   - Transform project_questions into a sequential queue system
*/

import { query } from "../pg.js";

const MIGRATION = `
-- Step 1: Add queue-specific columns
ALTER TABLE project_questions
  ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS timeout_count INTEGER DEFAULT 0;

-- Step 2: Add index for efficient queue processing
-- Filters pending/processing questions and orders by sort_order, created_at
CREATE INDEX IF NOT EXISTS idx_pq_queue_processing
  ON project_questions(project_id, status, sort_order, created_at)
  WHERE status IN ('pending', 'processing');

-- Step 3: Add comments
COMMENT ON COLUMN project_questions.processing_started_at IS
  'Timestamp when question was sent to voice stream for processing';

COMMENT ON COLUMN project_questions.timeout_count IS
  'Number of times this question timed out (max 3 before automatic skip)';

COMMENT ON INDEX idx_pq_queue_processing IS
  'Optimizes queue processing queries: get next pending question ordered by priority';

-- Log completion
DO $$
BEGIN
  RAISE NOTICE 'Migration 021 complete: Project questions queue system enabled';
END $$;
`;

export async function run() {
  await query(MIGRATION);
}
