import "dotenv/config";
import { query } from "./pg.js";

const SCHEMA = `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS conversations (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    summary          TEXT NOT NULL DEFAULT '',
    last_response_id TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_turns (
    id               BIGSERIAL PRIMARY KEY,
    conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant')),
    text             TEXT NOT NULL,
    ts               BIGINT NOT NULL,
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_turns_conv_active ON conversation_turns (conversation_id, active) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_turns_conv_created ON conversation_turns (conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS tasks (
    id                  VARCHAR(8) PRIMARY KEY,
    session_id          UUID NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'running'
                        CHECK (status IN ('running', 'done', 'error', 'paused', 'killed', 'paused_llm_limit')),
    result              TEXT,
    error               TEXT,
    task_instruction    TEXT,
    llm_limit_reset_at  TEXT,
    paused_at           TIMESTAMPTZ,
    start_time          BIGINT NOT NULL,
    elapsed             INTEGER,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_paused_llm_limit ON tasks(status) WHERE status = 'paused_llm_limit';
`;

const SEED = `
INSERT INTO conversations (id)
VALUES ('00000000-0000-0000-0000-000000000001')
ON CONFLICT (id) DO NOTHING;
`;

// Numbered migrations to run in order. Mirrors the explicit list in
// server.js startup() so CI and standalone migration paths stay in sync.
const NUMBERED_MIGRATIONS = [
  "002_projects_agents.js",
  "003_skills_deps.js",
  "004_hierarchical.js",
  "005_chat_persistence.js",
  "006_scheduled_tasks.js",
  "007_config.js",
  "008_auth.js",
  "009_usage.js",
  "010_channels.js",
  "011_connectors.js",
  "012_plan_reviews.js",
  "013_project_questions.js",
  "014_presentations.js",
  "015_whatsapp_settings.js",
  "016_unique_agent_names.js",
  "017_agent_task_queue.js",
  "017_thread_bindings.js",
  "018_agent_whatsapp_groups.js",
  "019_deduplicate_whatsapp.js",
  "020_yabby_super_agent.js",
  "021_project_questions_queue.js",
  "022_task_speaker_context.js",
  "023_conversation_source.js",
  "024_llm_limit_tasks.js",
  "025_fix_agent_name_uniqueness.js",
  "026_task_phase.js",
  "027_qa_browser_session_skill.js",
  "028_cli_system_prompt.js",
  "029_agent_workspace_path.js",
  "030_plan_review_shown.js",
  "031_queue_task_title.js",
  "032_multi_agent_task_queue.js",
  "033_media_assets.js",
  "034_channel_pairings.js",
  "035_runner_session_parity.js",
  "036_agent_runner_sessions.js",
  "037_presentations_demo.js",
  "038_thread_owner.js",
  "039_channel_containers.js",
  "040_tasks_fk_set_null.js",
  "041_plan_review_pending_emission.js",
];

async function migrate() {
  console.log("[MIGRATE] Running base schema...");
  await query(SCHEMA);

  console.log("[MIGRATE] Seeding default conversation...");
  await query(SEED);

  console.log(`[MIGRATE] Running ${NUMBERED_MIGRATIONS.length} numbered migrations...`);
  for (const migFile of NUMBERED_MIGRATIONS) {
    try {
      const { run } = await import(`./migrations/${migFile}`);
      await run();
    } catch (err) {
      if (!err.message.includes("already exists") && !err.message.includes("duplicate")) {
        console.log(`[MIGRATE] ${migFile} note:`, err.message);
      }
    }
  }

  console.log("[MIGRATE] Done.");
  process.exit(0);
}

migrate().catch((err) => {
  console.error("[MIGRATE] Failed:", err.message);
  process.exit(1);
});
