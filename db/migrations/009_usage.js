import { query } from "../pg.js";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS usage_log (
  id            SERIAL PRIMARY KEY,
  provider      VARCHAR(50) NOT NULL,
  model         VARCHAR(100) NOT NULL,
  input_tokens  INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd      NUMERIC(10, 6) DEFAULT 0,
  context       VARCHAR(50) DEFAULT 'chat',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_log_provider ON usage_log (provider);
CREATE INDEX IF NOT EXISTS idx_usage_log_created ON usage_log (created_at);
`;

export async function run() {
  await query(MIGRATION);
}
