/* ═══════════════════════════════════════════════════════
   Migration 025: Fix Agent Name Uniqueness Constraint
   ═══════════════════════════════════════════════════════

   Problem: agents_name_unique constraint was global, preventing
   different projects from having lead agents with the same name
   (e.g., multiple "Directeur Général").

   Solution:
   - Standalone agents (project_id IS NULL) must have unique names globally
   - Project agents can have duplicate names across different projects
   - Within same project, names must be unique

   Date: 2026-04-09
*/

import { query } from "../pg.js";

const MIGRATION = `
-- Drop the global unique constraint that was causing the issue
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_name_unique;

-- Standalone agents must have unique names globally
-- (prevents creating multiple standalone "Alice", "Bob", etc.)
CREATE UNIQUE INDEX IF NOT EXISTS agents_standalone_name_unique
  ON agents(name)
  WHERE project_id IS NULL;

-- Within each project, agent names must be unique
-- (prevents duplicate "Clara" in same project)
-- But "Clara" can exist in multiple different projects
CREATE UNIQUE INDEX IF NOT EXISTS agents_project_name_unique
  ON agents(name, project_id)
  WHERE project_id IS NOT NULL;
`;

export async function run() {
  console.log("[MIGRATION 025] Fixing agent name uniqueness constraints...");
  await query(MIGRATION);
  console.log("[MIGRATION 025] ✓ Agent name uniqueness fixed");
}
