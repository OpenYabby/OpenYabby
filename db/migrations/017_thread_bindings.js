import { query } from "../pg.js";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS channel_thread_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Identification
  channel_name VARCHAR(50) NOT NULL,
  account_id VARCHAR(100) NOT NULL,
  thread_id VARCHAR(255) NOT NULL,
  conversation_id VARCHAR(255) NOT NULL,

  -- Cible du binding
  target_kind VARCHAR(20) NOT NULL,
  agent_id VARCHAR(12),
  session_key VARCHAR(255) NOT NULL,

  -- Lifecycle
  bound_at TIMESTAMPTZ DEFAULT NOW(),
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),

  -- Timeouts
  idle_timeout_ms INT DEFAULT 86400000,
  max_age_ms INT DEFAULT 604800000,

  -- Métadonnées
  metadata JSONB DEFAULT '{}',

  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index unique: 1 seul binding par thread
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_binding_unique
  ON channel_thread_bindings(channel_name, account_id, thread_id);

-- Index pour lookup par agent
CREATE INDEX IF NOT EXISTS idx_thread_binding_agent
  ON channel_thread_bindings(agent_id) WHERE agent_id IS NOT NULL;

-- Index pour sweep (cleanup)
CREATE INDEX IF NOT EXISTS idx_thread_binding_activity
  ON channel_thread_bindings(last_activity_at);
`;

export async function run() {
  await query(MIGRATION);
}
