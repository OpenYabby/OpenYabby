import { query } from "../pg.js";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS users (
  id          VARCHAR(12) PRIMARY KEY DEFAULT substr(gen_random_uuid()::text, 1, 12),
  username    VARCHAR(100) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role        VARCHAR(20) NOT NULL DEFAULT 'admin' CHECK (role IN ('admin', 'user')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sessions (
  token       VARCHAR(64) PRIMARY KEY,
  user_id     VARCHAR(12) NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_tokens (
  id          VARCHAR(12) PRIMARY KEY DEFAULT substr(gen_random_uuid()::text, 1, 12),
  name        VARCHAR(100) NOT NULL,
  token_hash  VARCHAR(128) NOT NULL UNIQUE,
  token_prefix VARCHAR(8) NOT NULL,
  scopes      JSONB NOT NULL DEFAULT '["*"]',
  last_used_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE sessions ADD CONSTRAINT fk_session_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
CREATE INDEX IF NOT EXISTS idx_api_tokens_hash ON api_tokens (token_hash);
`;

export async function run() {
  await query(MIGRATION);
}
