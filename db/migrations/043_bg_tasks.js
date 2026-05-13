/* ═══════════════════════════════════════════════════════
   YABBY — Migration 043: bg_tasks
   ═══════════════════════════════════════════════════════
   Tracks Claude CLI Bash(run_in_background=true) jobs that the agent has
   spawned. Each row mirrors a CLI-side bg task and lives independently of
   the parent Yabby task — the parent can exit while bg jobs keep running.

   Lifecycle:
   - Row created on CLI stdout event {type:"system", subtype:"task_started"}.
   - Updated on {subtype:"task_notification", status:"completed"|"stopped"|"failed"}.
   - Marked 'orphaned' if the parent CLI exits while still 'running'.
   - Swept to 'orphaned' on server startup (process group is gone).
*/

import { query } from "../pg.js";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS bg_tasks (
  cli_task_id     TEXT PRIMARY KEY,
  yabby_task_id   VARCHAR(8) NOT NULL,
  agent_id        VARCHAR(12),
  session_id      UUID NOT NULL,
  tool_use_id     TEXT,
  description     TEXT,
  task_type       TEXT,
  status          TEXT NOT NULL DEFAULT 'running',
  output_file     TEXT,
  summary         TEXT,
  usage_json      JSONB,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,
  CONSTRAINT fk_bg_tasks_yabby_task
    FOREIGN KEY (yabby_task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_bg_tasks_yabby ON bg_tasks(yabby_task_id);
CREATE INDEX IF NOT EXISTS idx_bg_tasks_status_running ON bg_tasks(status) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_bg_tasks_agent ON bg_tasks(agent_id);
`;

export async function run() {
  await query(MIGRATION);
}
