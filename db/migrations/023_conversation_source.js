/**
 * Migration 023: Add source tracking to conversation_turns
 *
 * Adds a 'source' column to track where messages originated from:
 * - 'web' (default)
 * - 'voice'
 * - 'whatsapp'
 * - 'discord'
 * - 'slack'
 * - etc.
 *
 * This prevents duplicate message forwarding between channels.
 */

export const MIGRATION = `
  -- Add source column with default 'web'
  ALTER TABLE conversation_turns ADD COLUMN IF NOT EXISTS source VARCHAR(50) DEFAULT 'web';

  -- Create index for source-based queries
  CREATE INDEX IF NOT EXISTS idx_conv_turns_source ON conversation_turns(source, created_at DESC);

  -- Backfill existing WhatsApp messages
  UPDATE conversation_turns SET source = 'whatsapp' WHERE id IN (
    SELECT DISTINCT ct.id
    FROM conversation_turns ct
    JOIN channel_messages cm ON cm.content = ct.text
    JOIN channel_conversations cc ON cm.conversation_id = cc.id
    WHERE cc.channel_name = 'whatsapp'
      AND ct.source = 'web'
      AND ABS(EXTRACT(EPOCH FROM (ct.created_at - cm.created_at))) < 5
  );
`;

export async function run() {
  const { query } = await import("../pg.js");
  await query(MIGRATION);
}
