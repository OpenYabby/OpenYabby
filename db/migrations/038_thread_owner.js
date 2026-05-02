/* ═══════════════════════════════════════════════════════
   YABBY — Migration 038: Per-thread owner (single-owner gate)
   ═══════════════════════════════════════════════════════
   Adds owner_user_id + owner_user_name to channel_thread_bindings so the
   message handler can reject any non-owner who finds the thread / topic /
   channel. Defence-in-depth on top of channel_pairings (single owner per
   channel) — a tier of granular access control per agent thread.

   Backfill: existing WhatsApp bindings inherit the channel-level owner from
   channel_pairings. Older rows that predate the pairing system stay NULL —
   the gate treats NULL as "no owner enforcement" so legacy threads keep
   working until the operator pairs them explicitly.
*/

import { query } from "../pg.js";

export const MIGRATION = `
ALTER TABLE channel_thread_bindings
  ADD COLUMN IF NOT EXISTS owner_user_id   TEXT,
  ADD COLUMN IF NOT EXISTS owner_user_name TEXT;

UPDATE channel_thread_bindings b
SET owner_user_id = p.owner_user_id,
    owner_user_name = p.owner_user_name
FROM channel_pairings p
WHERE b.channel_name = p.channel_name
  AND b.owner_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_thread_bindings_owner
  ON channel_thread_bindings (channel_name, owner_user_id);
`;

export async function run() {
  await query(MIGRATION);
}
