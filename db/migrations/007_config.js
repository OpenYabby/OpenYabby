import { query } from "../pg.js";

const MIGRATION = `
CREATE TABLE IF NOT EXISTS config (
  key         VARCHAR(100) PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT '{}',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

const DEFAULTS = {
  voice: { model: "gpt-realtime", voice: "marin", language: "fr" },
  // CRITICAL: memory.model is pinned to gpt-5-mini — see CLAUDE.md (nano misses French names)
  memory: { model: "gpt-5-mini", embedder: "text-embedding-3-small", extractEveryNTurns: 6 },
  auth: { enabled: false, gatewayPassword: null, sessionTtlDays: 7 },
  llm: { defaultProvider: "openai", providers: {} },
  channels: {},
  tts: { defaultProvider: "edge-tts" },
  mcp: { servers: [] },
  tasks: { forwardUrl: null },
};

export async function run() {
  await query(MIGRATION);

  // Seed defaults only if config table is empty (first run)
  const { rows } = await query("SELECT count(*)::int AS cnt FROM config");
  if (rows[0].cnt === 0) {
    for (const [key, value] of Object.entries(DEFAULTS)) {
      await query(
        "INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING",
        [key, JSON.stringify(value)]
      );
    }
  }
}
