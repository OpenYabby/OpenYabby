/* ═══════════════════════════════════════════════════════
   YABBY — Migration 037: presentation idempotency + demo flow
   ═══════════════════════════════════════════════════════
   1. Archive duplicate presentations (keep most recent per project)
      so the partial unique index can be created.
   2. Add columns supporting the executable demo flow:
      - script_path (path to start.sh inside the sandbox)
      - test_accesses (JSONB array of {label, url, username, password, notes})
      - last_run_at, last_run_status, last_run_log
   3. Create partial unique index on (project_id) WHERE status != 'archived'.
*/

import { query } from "../pg.js";

const MIGRATION = `
-- Step 1: archive duplicates (keep only the most recent non-archived per project)
WITH ranked AS (
  SELECT id, project_id,
         ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY created_at DESC) AS rn
  FROM presentations
  WHERE status != 'archived'
)
UPDATE presentations
SET status = 'archived'
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

-- Step 2: new columns for the demo flow
ALTER TABLE presentations
  ADD COLUMN IF NOT EXISTS script_path     TEXT,
  ADD COLUMN IF NOT EXISTS test_accesses   JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS last_run_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_run_status TEXT,
  ADD COLUMN IF NOT EXISTS last_run_log    TEXT;

-- Step 3: partial unique index — at most ONE active presentation per project
CREATE UNIQUE INDEX IF NOT EXISTS presentations_project_active_unique
  ON presentations (project_id)
  WHERE status != 'archived';
`;

export async function run() {
  await query(MIGRATION);
}
