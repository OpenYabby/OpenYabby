import { query } from "../pg.js";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS plan_reviews (
  id           VARCHAR(12) PRIMARY KEY,
  project_id   VARCHAR(12) NOT NULL,
  agent_id     VARCHAR(12) NOT NULL,
  task_id      VARCHAR(8),
  plan_content TEXT NOT NULL,
  status       TEXT DEFAULT 'pending',
  feedback     TEXT,
  version      INTEGER DEFAULT 1,
  resolved_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_plan_reviews_status ON plan_reviews(status);
CREATE INDEX IF NOT EXISTS idx_plan_reviews_project ON plan_reviews(project_id);
`;

export async function run() {
  await query(MIGRATION);
}
