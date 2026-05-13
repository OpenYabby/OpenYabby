/* ═══════════════════════════════════════════════════════
   YABBY — Migration 044: bg_tasks.pid + pid_file
   ═══════════════════════════════════════════════════════
   Captures the host-OS PID of each Bash(run_in_background) child so the
   bg-watcher can `kill -0 <pid>` to detect completion independently of the
   parent CLI process. PID is captured by a PreToolUse hook
   (lib/bg-pid-wrapper.js) that wraps the command with
     `sh -c 'echo $$ > <pid_file>; exec <original>'`
   so $$ becomes the bg PID via exec replacement.
*/

import { query } from "../pg.js";

const MIGRATION = `
ALTER TABLE bg_tasks ADD COLUMN IF NOT EXISTS pid INTEGER;
ALTER TABLE bg_tasks ADD COLUMN IF NOT EXISTS pid_file TEXT;
CREATE INDEX IF NOT EXISTS idx_bg_tasks_pid ON bg_tasks(pid) WHERE pid IS NOT NULL;
`;

export async function run() {
  await query(MIGRATION);
}
