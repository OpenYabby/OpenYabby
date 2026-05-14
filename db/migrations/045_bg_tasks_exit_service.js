/* Migration 045: exit code + service intent for bg_tasks. */

import { query } from "../pg.js";

const MIGRATION = `
ALTER TABLE bg_tasks ADD COLUMN IF NOT EXISTS exit_code   INTEGER;
ALTER TABLE bg_tasks ADD COLUMN IF NOT EXISTS exit_signal TEXT;
ALTER TABLE bg_tasks ADD COLUMN IF NOT EXISTS exit_file   TEXT;
ALTER TABLE bg_tasks ADD COLUMN IF NOT EXISTS is_service  BOOLEAN NOT NULL DEFAULT FALSE;
`;

export async function run() {
  await query(MIGRATION);
}
