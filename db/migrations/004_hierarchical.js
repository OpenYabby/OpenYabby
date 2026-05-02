import "dotenv/config";
import { query } from "../pg.js";

const MIGRATION = `
-- Agent hierarchy: parent agent and lead flag
ALTER TABLE agents ADD COLUMN IF NOT EXISTS parent_agent_id VARCHAR(12) REFERENCES agents(id);
ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_lead BOOLEAN DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_agents_parent ON agents (parent_agent_id);

-- Heartbeat tracking for progress monitoring
CREATE TABLE IF NOT EXISTS agent_heartbeats (
    id          BIGSERIAL PRIMARY KEY,
    agent_id    VARCHAR(12) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    project_id  VARCHAR(12) REFERENCES projects(id) ON DELETE CASCADE,
    task_id     VARCHAR(8),
    status      VARCHAR(20) NOT NULL DEFAULT 'working',
    progress    INTEGER DEFAULT 0,
    summary     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_heartbeat_agent ON agent_heartbeats (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_heartbeat_project ON agent_heartbeats (project_id, created_at DESC);

-- Extend msg_type to include report, task_complete, heartbeat
ALTER TABLE agent_messages DROP CONSTRAINT IF EXISTS agent_messages_msg_type_check;
ALTER TABLE agent_messages ADD CONSTRAINT agent_messages_msg_type_check
    CHECK (msg_type IN ('message','handoff','review','approval','notification','report','heartbeat','task_complete'));
`;

export async function run() {
  console.log("[MIGRATE-004] Running hierarchical orchestration migration...");
  await query(MIGRATION);
  console.log("[MIGRATE-004] Done.");
}

if (process.argv[1]?.endsWith("004_hierarchical.js")) {
  run()
    .then(() => process.exit(0))
    .catch((err) => { console.error("[MIGRATE-004] Failed:", err.message); process.exit(1); });
}
