/* ═══════════════════════════════════════════════════════
   MIGRATION 020 — Yabby Super Agent
   ═══════════════════════════════════════════════════════
   - Add is_super_agent column to agents table
   - Create Yabby system agent with fixed ID
   - Yabby will have persistent task queue and session
   - Cannot be deleted (protected system agent)
*/

import { query } from "../pg.js";

const MIGRATION = `
-- Step 1: Add is_super_agent column to agents table
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_super_agent BOOLEAN DEFAULT FALSE;

COMMENT ON COLUMN agents.is_super_agent IS
  'True pour Yabby et autres agents système non-supprimables';

-- Step 2: Create index for super agents (fast lookups)
CREATE INDEX IF NOT EXISTS idx_agents_super ON agents(is_super_agent) WHERE is_super_agent = TRUE;

-- Step 3: Create Yabby super agent with fixed ID
INSERT INTO agents (
  id,
  name,
  role,
  system_prompt,
  is_super_agent,
  session_id,
  status,
  created_at
) VALUES (
  'yabby-000000',
  'Yabby',
  'Assistant Principal',
  'Tu es Yabby, l''assistant vocal principal. Tu orchestres les projets, les agents et les tâches. Tu peux exécuter des tâches directement ou déléguer à des sous-agents selon la complexité.',
  TRUE,
  gen_random_uuid(),
  'active',
  NOW()
) ON CONFLICT (id) DO NOTHING;

-- Log completion
DO $$
BEGIN
  RAISE NOTICE 'Migration 020 complete: Yabby super agent created with ID yabby-000000';
END $$;
`;

export async function run() {
  await query(MIGRATION);
}
