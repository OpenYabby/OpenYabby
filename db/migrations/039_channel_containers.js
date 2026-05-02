/* ═══════════════════════════════════════════════════════
   YABBY — Migration 039: Channel containers
   ═══════════════════════════════════════════════════════
   Single-row-per-channel registry of the "host" group / server / workspace
   that Yabby uses to auto-create dedicated agent threads when assign_agent
   runs on Telegram / Discord / Slack.

   - Telegram: container_id = forum group chat_id (must have topics enabled).
                 Yabby creates a new forum topic per agent there.
   - Discord:   container_id = guild_id (server). Yabby creates a private
                 text channel per agent there with permissionOverwrites that
                 hide the channel from @everyone.
   - Slack:     container_id = team_id (workspace). Yabby creates a private
                 conversations.create channel per agent and invites the owner.

   The owner_user_id is the platform user who paired the container — used as
   the default owner for every newly-created channel_thread_binding so the
   per-thread access gate (migration 038) rejects any non-owner who finds
   the topic / channel.

   WhatsApp is NOT in this table — it has its own bespoke flow
   (agent_whatsapp_groups + Yabby-creates-the-group-on-the-fly).
*/

import { query } from "../pg.js";

export const MIGRATION = `
CREATE TABLE IF NOT EXISTS channel_containers (
  channel_name      TEXT PRIMARY KEY,
  container_id      TEXT NOT NULL,
  owner_user_id     TEXT NOT NULL,
  owner_user_name   TEXT,
  paired_by         TEXT,
  paired_at         TIMESTAMPTZ DEFAULT NOW(),
  metadata          JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_channel_containers_owner
  ON channel_containers (owner_user_id);
`;

export async function run() {
  await query(MIGRATION);
}
