import { query } from "../pg.js";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id              VARCHAR(12) PRIMARY KEY DEFAULT substr(gen_random_uuid()::text, 1, 12),
  name            VARCHAR(255) NOT NULL,
  description     TEXT,
  task_template   TEXT NOT NULL,
  schedule_type   VARCHAR(20) NOT NULL CHECK (schedule_type IN ('interval', 'cron', 'manual')),
  schedule_config JSONB NOT NULL DEFAULT '{}',
  status          VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  project_id      VARCHAR(12),
  agent_id        VARCHAR(12),
  max_retries     INTEGER DEFAULT 3,
  retry_delay_ms  INTEGER DEFAULT 60000,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  run_count       INTEGER DEFAULT 0,
  error_count     INTEGER DEFAULT 0,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_task_runs (
  id                  SERIAL PRIMARY KEY,
  scheduled_task_id   VARCHAR(12) NOT NULL,
  task_id             VARCHAR(8),
  status              VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'error', 'skipped')),
  started_at          TIMESTAMPTZ,
  completed_at        TIMESTAMPTZ,
  result              TEXT,
  error               TEXT,
  retry_number        INTEGER DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$ BEGIN
  ALTER TABLE scheduled_tasks ADD CONSTRAINT fk_scheduled_project FOREIGN KEY (project_id) REFERENCES projects(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE scheduled_tasks ADD CONSTRAINT fk_scheduled_agent FOREIGN KEY (agent_id) REFERENCES agents(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE scheduled_task_runs ADD CONSTRAINT fk_runs_scheduled FOREIGN KEY (scheduled_task_id) REFERENCES scheduled_tasks(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE scheduled_task_runs ADD CONSTRAINT fk_runs_task FOREIGN KEY (task_id) REFERENCES tasks(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_status ON scheduled_tasks (status);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_next_run ON scheduled_tasks (next_run_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_scheduled_runs_task ON scheduled_task_runs (scheduled_task_id);
`;

export async function run() {
  await query(MIGRATION);
}
