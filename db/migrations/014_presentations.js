import { query } from "../pg.js";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS presentations (
  id           VARCHAR(12) PRIMARY KEY,
  project_id   VARCHAR(12) NOT NULL REFERENCES projects(id),
  agent_id     VARCHAR(12),
  title        TEXT NOT NULL,
  summary      TEXT,
  content      TEXT NOT NULL,
  slides       JSONB DEFAULT '[]',
  demo_steps   JSONB DEFAULT '[]',
  sandbox_path TEXT,
  status       TEXT DEFAULT 'draft',
  presented_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_presentations_project ON presentations(project_id);
CREATE INDEX IF NOT EXISTS idx_presentations_status ON presentations(status);
`;

export async function run() {
  await query(MIGRATION);
}
