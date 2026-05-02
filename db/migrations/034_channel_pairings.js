import { query } from "../pg.js";

const MIGRATION = `
-- Channel pairings: owner identity per channel (Telegram, Discord, Slack, Signal, WhatsApp)
-- One owner per channel. Unpaired channels reject all messages except the pairing code.
CREATE TABLE IF NOT EXISTS channel_pairings (
    channel_name       VARCHAR(32) PRIMARY KEY,
    owner_user_id      TEXT NOT NULL,
    owner_user_name    TEXT,
    owner_chat_id      TEXT NOT NULL,
    paired_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_pairings_owner
    ON channel_pairings(channel_name, owner_user_id);
`;

export async function run() {
  await query(MIGRATION);
}
