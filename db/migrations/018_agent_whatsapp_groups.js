import { query } from "../pg.js";

const MIGRATION = `
-- Table pour stocker les groupes WhatsApp dédiés aux agents
CREATE TABLE IF NOT EXISTS agent_whatsapp_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Agent lié
  agent_id VARCHAR(12) NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,

  -- Groupe WhatsApp
  group_id VARCHAR(255) NOT NULL UNIQUE,
  group_name VARCHAR(255) NOT NULL,

  -- Métadonnées
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pour lookup par agent_id
CREATE INDEX IF NOT EXISTS idx_agent_whatsapp_groups_agent
  ON agent_whatsapp_groups(agent_id);

-- Index pour lookup par group_id
CREATE INDEX IF NOT EXISTS idx_agent_whatsapp_groups_group
  ON agent_whatsapp_groups(group_id);
`;

export async function run() {
  await query(MIGRATION);
}
