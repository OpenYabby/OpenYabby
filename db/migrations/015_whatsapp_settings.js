import { query } from "../pg.js";

const MIGRATION = `
-- WhatsApp settings for persistent group management
CREATE TABLE IF NOT EXISTS whatsapp_settings (
    id                SERIAL PRIMARY KEY,
    yabby_group_id    TEXT UNIQUE,
    yabby_group_name  TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export async function run() {
  await query(MIGRATION);
}
