/* ═══════════════════════════════════════════════════════
   YABBY — Migration 033: Media Assets
   ═══════════════════════════════════════════════════════
   Content-addressed media store. `media_assets` is the index;
   `message_media` / `turn_media` link assets to channel_messages
   / conversation_turns respectively.

   Idempotent: uses IF NOT EXISTS. Can re-run safely.
*/

export const MIGRATION = `
CREATE TABLE IF NOT EXISTS media_assets (
  id            VARCHAR(12) PRIMARY KEY,
  sha256        CHAR(64) UNIQUE NOT NULL,
  path          TEXT NOT NULL,
  mime          VARCHAR(64) NOT NULL,
  size_bytes    BIGINT NOT NULL,
  kind          VARCHAR(16) NOT NULL,
  source        VARCHAR(32) NOT NULL,
  metadata      JSONB DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  deleted_at    TIMESTAMPTZ,
  CONSTRAINT media_assets_kind_check CHECK (kind IN ('image','pdf','audio','video','file'))
);

CREATE INDEX IF NOT EXISTS idx_media_assets_sha256 ON media_assets(sha256);
CREATE INDEX IF NOT EXISTS idx_media_assets_created_at ON media_assets(created_at);
CREATE INDEX IF NOT EXISTS idx_media_assets_deleted_at ON media_assets(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS message_media (
  message_id    UUID NOT NULL REFERENCES channel_messages(id) ON DELETE CASCADE,
  asset_id      VARCHAR(12) NOT NULL REFERENCES media_assets(id),
  position      SMALLINT DEFAULT 0,
  PRIMARY KEY (message_id, asset_id)
);

CREATE TABLE IF NOT EXISTS turn_media (
  turn_id       BIGINT NOT NULL REFERENCES conversation_turns(id) ON DELETE CASCADE,
  asset_id      VARCHAR(12) NOT NULL REFERENCES media_assets(id),
  position      SMALLINT DEFAULT 0,
  PRIMARY KEY (turn_id, asset_id)
);
`;

export async function run() {
  const { query } = await import("../pg.js");
  await query(MIGRATION);
  console.log('[MIGRATION 030] ✅ media_assets + message_media + turn_media tables ready');
}
