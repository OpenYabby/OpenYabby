import "dotenv/config";
import { query } from "../pg.js";

const MIGRATION = `
-- Add agent_id to conversations for per-agent chat persistence
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS agent_id VARCHAR(12);

-- Unique partial index: one conversation per agent
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_agent
  ON conversations (agent_id) WHERE agent_id IS NOT NULL;

-- FK to agents (idempotent)
DO $$ BEGIN
    ALTER TABLE conversations ADD CONSTRAINT fk_conversations_agent
        FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`;

export async function run() {
  console.log("[MIGRATE-005] Running chat persistence migration...");
  await query(MIGRATION);
  console.log("[MIGRATE-005] Done.");
}

if (process.argv[1]?.endsWith("005_chat_persistence.js")) {
  run()
    .then(() => process.exit(0))
    .catch((err) => { console.error("[MIGRATE-005] Failed:", err.message); process.exit(1); });
}
