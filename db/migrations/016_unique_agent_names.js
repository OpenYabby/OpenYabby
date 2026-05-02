/* ═══════════════════════════════════════════════════════
   MIGRATION 016 — Unique Agent Names
   ═══════════════════════════════════════════════════════
   - Make agent names globally unique across all agents
   - Handle existing duplicates by renaming (keep most recent)
   - Make project_id explicitly nullable for standalone agents
*/

import { query } from "../pg.js";

const MIGRATION = `
-- Step 1: Rename duplicate agent names (keeping most recent with original name)
-- Uses unique ID suffix to avoid creating new duplicates
DO $$
DECLARE
  agent_rec RECORD;
BEGIN
  FOR agent_rec IN
    SELECT a1.id, a1.name
    FROM agents a1
    WHERE EXISTS (
      SELECT 1 FROM agents a2
      WHERE a2.name = a1.name AND a2.id < a1.id
    )
    ORDER BY a1.name, a1.created_at
  LOOP
    UPDATE agents
    SET name = agent_rec.name || '_' || substring(agent_rec.id from 1 for 6),
        updated_at = NOW()
    WHERE id = agent_rec.id;
    RAISE NOTICE 'Renamed duplicate agent: % to %_%', agent_rec.name, agent_rec.name, substring(agent_rec.id from 1 for 6);
  END LOOP;
END $$;

-- Step 2: Add unique constraint on agent names
ALTER TABLE agents ADD CONSTRAINT agents_name_unique UNIQUE (name);

-- Step 3: Make project_id explicitly nullable (documentation - already nullable in schema)
-- No action needed, but documented here that project_id can be NULL for standalone agents
-- ALTER TABLE agents ALTER COLUMN project_id DROP NOT NULL; -- Already nullable

-- Log completion
DO $$
BEGIN
  RAISE NOTICE 'Migration 016 complete: Agent names are now globally unique';
END $$;
`;

export async function run() {
  await query(MIGRATION);
}
