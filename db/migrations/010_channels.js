import { query } from "../pg.js";

const MIGRATION = `
-- Channel conversations: one per (channel, user)
CREATE TABLE IF NOT EXISTS channel_conversations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_name    VARCHAR(50) NOT NULL,
  channel_id      VARCHAR(255) NOT NULL,
  user_id         VARCHAR(255) NOT NULL,
  user_name       VARCHAR(255),
  is_group        BOOLEAN DEFAULT FALSE,
  metadata        JSONB DEFAULT '{}',
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cc_channel_user ON channel_conversations(channel_name, user_id);
CREATE INDEX IF NOT EXISTS idx_cc_last_msg ON channel_conversations(last_message_at DESC);

-- Channel messages
CREATE TABLE IF NOT EXISTS channel_messages (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES channel_conversations(id) ON DELETE CASCADE,
  role            VARCHAR(20) NOT NULL,
  content         TEXT NOT NULL,
  platform_msg_id VARCHAR(255),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cm_conv ON channel_messages(conversation_id, created_at DESC);

-- Dead letter queue for failed channel messages
CREATE TABLE IF NOT EXISTS dead_letters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_name    VARCHAR(50) NOT NULL,
  user_id         VARCHAR(255),
  content         TEXT,
  error           TEXT,
  attempts        INT DEFAULT 0,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dl_channel ON dead_letters(channel_name, created_at DESC);
`;

export async function run() {
  await query(MIGRATION);
}
