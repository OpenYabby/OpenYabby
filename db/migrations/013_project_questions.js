import { query } from "../pg.js";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS project_questions (
  id           VARCHAR(12) PRIMARY KEY,
  project_id   VARCHAR(12) NOT NULL,
  agent_id     VARCHAR(12) NOT NULL,
  question     TEXT NOT NULL,
  question_type TEXT DEFAULT 'voice',
  form_schema  JSONB DEFAULT '{}',
  answer       TEXT,
  answer_data  JSONB DEFAULT '{}',
  status       TEXT DEFAULT 'pending',
  sort_order   INTEGER DEFAULT 0,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_pq_status ON project_questions(status);
CREATE INDEX IF NOT EXISTS idx_pq_project ON project_questions(project_id);
`;

export async function run() {
  await query(MIGRATION);
}
