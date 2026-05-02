/* ═══════════════════════════════════════════════════════
   MIGRATION 019 — WhatsApp Message Deduplication
   ═══════════════════════════════════════════════════════
   - Add UNIQUE constraint on platform_msg_id to prevent duplicate messages
   - Partial index: only enforced when platform_msg_id IS NOT NULL
*/

import { query } from "../pg.js";

const MIGRATION = `
-- Step 1: Clean up existing duplicates (keep oldest message, delete newer ones)
DELETE FROM channel_messages
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY conversation_id, platform_msg_id ORDER BY created_at ASC) AS rn
    FROM channel_messages
    WHERE platform_msg_id IS NOT NULL
  ) t
  WHERE rn > 1
);

-- Step 2: Create UNIQUE partial index on (conversation_id, platform_msg_id)
-- Only enforced when platform_msg_id is NOT NULL (allows voice messages without platform ID)
CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_messages_platform_msg_unique
  ON channel_messages(conversation_id, platform_msg_id)
  WHERE platform_msg_id IS NOT NULL;

COMMENT ON INDEX idx_channel_messages_platform_msg_unique IS
  'Prevents duplicate messages based on platform_msg_id. Partial index only applies when platform_msg_id IS NOT NULL.';

-- Log completion
DO $$
BEGIN
  RAISE NOTICE 'Migration 019 complete: WhatsApp message deduplication index created';
END $$;
`;

export async function run() {
  await query(MIGRATION);
}
