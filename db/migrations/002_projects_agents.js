import "dotenv/config";
import { query } from "../pg.js";

const MIGRATION = `
-- Projects
CREATE TABLE IF NOT EXISTS projects (
    id              VARCHAR(12) PRIMARY KEY,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    project_type    VARCHAR(50),
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'completed', 'archived')),
    context         TEXT,
    lead_agent_id   VARCHAR(12),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agents (free-form role, not an enum)
CREATE TABLE IF NOT EXISTS agents (
    id              VARCHAR(12) PRIMARY KEY,
    project_id      VARCHAR(12) REFERENCES projects(id) ON DELETE CASCADE,
    name            VARCHAR(100) NOT NULL,
    role            VARCHAR(100) NOT NULL,
    system_prompt   TEXT NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'suspended', 'archived')),
    session_id      UUID,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agents_project ON agents (project_id);

-- Enrich existing tasks table
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS project_id VARCHAR(12);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS agent_id VARCHAR(12);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority VARCHAR(2) DEFAULT 'P2';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS title VARCHAR(255);

-- Add FKs (safe even if columns already exist)
DO $$ BEGIN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_project FOREIGN KEY (project_id) REFERENCES projects(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_agent FOREIGN KEY (agent_id) REFERENCES agents(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks (project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks (agent_id);

-- Event log
CREATE TABLE IF NOT EXISTS event_log (
    id              BIGSERIAL PRIMARY KEY,
    project_id      VARCHAR(12),
    agent_id        VARCHAR(12),
    task_id         VARCHAR(8),
    event_type      VARCHAR(50) NOT NULL,
    detail          JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_project ON event_log (project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type ON event_log (event_type);

-- Circular FK: projects.lead_agent_id -> agents.id
DO $$ BEGIN
    ALTER TABLE projects ADD CONSTRAINT fk_lead_agent
        FOREIGN KEY (lead_agent_id) REFERENCES agents(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Default project for backward compatibility
INSERT INTO projects (id, name, description, status)
VALUES ('default', 'Tâches simples', 'Tâches ponctuelles sans projet', 'active')
ON CONFLICT (id) DO NOTHING;
`;

export async function run() {
  console.log("[MIGRATE-002] Running projects & agents migration...");
  await query(MIGRATION);
  console.log("[MIGRATE-002] Done.");
}

// Allow direct execution: node db/migrations/002_projects_agents.js
if (process.argv[1]?.endsWith("002_projects_agents.js")) {
  run()
    .then(() => process.exit(0))
    .catch((err) => { console.error("[MIGRATE-002] Failed:", err.message); process.exit(1); });
}
