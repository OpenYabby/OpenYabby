/* ═══════════════════════════════════════════════════════
   YABBY — Migration 042: schedule_type 'once'
   ═══════════════════════════════════════════════════════
   Extends the scheduled_tasks.schedule_type CHECK constraint to accept
   'once' alongside 'interval', 'cron', 'manual'.

   Behavior of 'once' (implemented in lib/scheduler.js calculateNextRun):
   - schedule_config stores { runAt: ISO timestamp }
   - At creation: next_run_at = runAt (if in the future)
   - At tick: scheduler runs the task once, then calculates next_run_at
     against now, finds runAt is in the past, returns null. Task naturally
     stops being picked up by the tick loop. No status change required.
*/

import { query } from "../pg.js";

const MIGRATION = `
ALTER TABLE scheduled_tasks
  DROP CONSTRAINT IF EXISTS scheduled_tasks_schedule_type_check;

ALTER TABLE scheduled_tasks
  ADD CONSTRAINT scheduled_tasks_schedule_type_check
  CHECK (schedule_type IN ('interval', 'cron', 'manual', 'once'));
`;

export async function run() {
  await query(MIGRATION);
}
