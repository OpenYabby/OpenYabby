# CLAUDE.md

> **Note for human readers:** this file is an AI-assistant briefing for [Claude Code](https://claude.com/product/claude-code) and other agentic coding tools working on this repository. It's intentionally exhaustive — every key file, every migration, every Redis convention. **For user-facing documentation start with the [README](README.md)** and the guides in [docs/](docs/). For contributor onboarding see [CONTRIBUTING.md](CONTRIBUTING.md). A shorter sibling briefing for non-Claude agents lives at [AGENTS.md](AGENTS.md) — keep both roughly in sync when changing high-level structure.

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Yabby** is a voice-first AI assistant with multi-agent orchestration. It combines OpenAI's Realtime API (WebRTC) for bidirectional voice with Claude CLI spawned as child processes for autonomous task execution. The system supports hierarchical agent teams, persistent memory (Mem0), inter-agent communication via Redis pub/sub, multi-channel integrations (Discord, Slack, Telegram, WhatsApp, Signal), and an extensible plugin/connector system.

Primary language is French — configurable via `lib/i18n.js` (supports fr, en, es, de). All prompts are maintained in English; the LLM is instructed to respond in the user's language via a directive (`agentLang`). Only `SERVER_MESSAGES` (channel UI strings) are localized (fr/en, others fall back to en). Frontend locales: `public/locales/` (fr, en). No linting or formatting tools configured.

## Commands

```bash
# One-command bootstrap (checks prereqs, installs deps, starts PG+Redis, launches server)
./setup.sh                         # auto-detects Docker vs local
./setup.sh docker                  # force Docker Compose for PG+Redis
./setup.sh local                   # assume PG+Redis already running

# Install dependencies (Node 20+ required)
npm install

# Start server (prerequisites: PostgreSQL database "yabby", Redis localhost:6379)
npm start                          # node --max-old-space-size=8192 --expose-gc server.js (port 3000)
npm run dev                        # services pre-flight + Node + Speaker + ImageGen via concurrently
npm run services                   # ensure Postgres/Redis are running (used by dev)
npm run speaker                    # speaker verification microservice only
npm run imagegen                   # local image-generation microservice only

# Maintenance
npm run cleanup                    # bash scripts/cleanup-zombies.sh — kill stale CLI runner processes
npm run reset                      # node scripts/reset-yabby.js — full fresh-start reset (preserves onboarding)

# Kill and restart node (port 3000)
lsof -ti :3000 | xargs kill 2>/dev/null; sleep 1; npm start &

# Run unit tests (Vitest — mocks PG/Redis, no real DB needed)
npx vitest                         # all tests in tests/**/*.test.js
npx vitest run tests/config.test.js  # single test file

# Run E2E tests (Playwright — requires server running on localhost:3000)
npm run test:e2e                   # headless
npm run test:e2e:headed            # headed browser
npm run test:e2e:ui                # Playwright UI mode
npm run test:e2e:debug             # debug mode
```

No build step — frontend is vanilla JS served as static files from `public/`. Migrations run automatically on startup (all idempotent with `IF NOT EXISTS`/`ON CONFLICT`). Note: `npx vitest` is not in package.json scripts — run it directly. `npm start` always passes `--max-old-space-size=8192 --expose-gc` because `lib/heap-monitor.js` needs `global.gc` to free memory under heap pressure — don't invoke `node server.js` directly without those flags.

## Environment Variables

Required in `.env` (see `.env.example`):
- `OPENAI_API_KEY` — Realtime API, Whisper transcription, Mem0
- `PG_HOST`, `PG_PORT`, `PG_DATABASE`, `PG_USER`, `PG_PASSWORD` — PostgreSQL
- `REDIS_URL` — Redis connection string
- `CLAUDE_CMD` — path to Claude CLI binary (default: `claude`)

Optional:
- `SPEAKER_SERVICE_URL` — speaker verification microservice (default: `http://localhost:3001`)
- `YABBY_SECRET` — encryption key for connector credentials (auto-derived from OPENAI_API_KEY if unset)
- `YABBY_AUTH_PASSWORD` / `YABBY_AUTH_ENABLED` — gateway auth from env
- `DISABLE_TUNNEL` — set to `true` to skip relay tunnel to `relay.openyabby.com`
- `SANDBOX_ROOT` — override project sandbox location (default: `~/Desktop/Yabby Projects`)
- `TASKS_FORWARD_URL` — forward task spawns to remote agent (Docker mode)

## Architecture

### Voice Pipeline
Browser → WebRTC SDP offer → `POST /session` → OpenAI Realtime API → SDP answer → bidirectional audio stream. Tools from `lib/plugins/tool-registry.js` (base + plugin + MCP) are sent with the session config. Tool calls arrive via WebRTC DataChannel and are dispatched **client-side** in `public/js/voice.js` — each tool call is an API fetch to the backend, result sent back via DataChannel.

### Speaker Verification Service

**Optional Python microservice** (FastAPI + SpeechBrain) that provides voice biometric filtering for wake word detection.

**Architecture:**
```
Browser → Silero VAD → Speaker Verification → Whisper → Wake Word Match
                              ↓
                    Python Service (port 3001)
                    ECAPA-TDNN embeddings
```

**Technology:**
- **Model**: SpeechBrain ECAPA-TDNN (pretrained on VoxCeleb)
- **Method**: Cosine similarity of speaker embeddings
- **Threshold**: 0.25 (configurable via `SPEAKER_THRESHOLD`)
- **Storage**: NumPy `.npy` file in `speaker/data/enrollment.npy`

**Integration:**
- **Routes**: `/api/speaker/*` proxies to Python service
- **Fail-open**: If service down, voice detection continues (returns `verified: true`)
- **Client check**: `checkSpeakerVerification()` in `voice.js` line 114
- **Enrollment**: 3+ audio samples required, averaged into single profile

**Environment Variables:**
```bash
SPEAKER_SERVICE_URL=http://localhost:3001  # Python service endpoint
SPEAKER_THRESHOLD=0.25                     # Cosine similarity threshold (0.0-1.0)
SPEAKER_DATA_DIR=./data                    # Enrollment storage directory
```

**Endpoints:**
| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/speaker/status` | Check enrollment status |
| POST | `/api/speaker/enroll` | Enroll speaker (3+ samples) |
| POST | `/api/speaker/verify` | Verify audio matches enrollment |
| DELETE | `/api/speaker/enroll` | Clear enrollment |

**Starting the Service:**
```bash
npm run dev            # Starts both Node + Speaker services
npm run speaker        # Starts speaker service only
cd speaker && ./start.sh  # Manual startup script
```

**Deployment:**
- **Development**: Use `npm run dev` for integrated startup
- **Production**: Run as separate systemd service or Docker container
- **Docker**: Not included in docker-compose.yml (Claude CLI incompatibility)

### Task Execution
Each task spawns a CLI child process via `lib/spawner.js`. The runner is configurable (`lib/runner-profiles.js`): Claude Code (default), OpenAI Codex, Aider, Goose, Cline, or Continue CLI. For Claude:
```
claude -p --dangerously-skip-permissions --verbose --output-format stream-json --session-id {uuid} --system-prompt {prompt} {task}
```
Tasks have full Mac access (bash, AppleScript, GUI). Output is parsed via runner profile's `parseStdoutLine()` into structured activity logs (`logs/{taskId}-activity.log`) and raw logs (`logs/{taskId}-raw.log`). The spawner auto-generates `.mcp.json` in the task CWD so the CLI runner can use connected MCP connectors.

### Agent Hierarchy & Prompt Generation
Agents have free-form roles (not enum). Three tiers with distinct system prompts built by `lib/prompts.js`:

- **Lead agent** (`is_lead=true`): `buildLeadAgentPrompt()` — full team management API docs, 5-phase workflow (discovery → planning → execution → review → QA), can submit plans for user approval via `/api/plan-reviews`, can ask discovery questions via `/api/project-questions`
- **Manager agent** (`is_manager=true` + `parent_agent_id`): `buildManagerAgentPrompt()` — same team API as lead but reports to parent agent instead of speaker, 3-phase workflow (plan + create agents → review → report to superior)
- **Sub-agent** (`parent_agent_id` only): `buildSubAgentPrompt()` — executes tasks, sends `task_complete` message to parent with detailed compte-rendu

All prompts share `getBasePrompt()` (Mac autonomy rules, GUI lock instructions, web interaction hierarchy: JS DOM → Playwright → Accessibility API → OCR). Language instruction injected dynamically from config via `lib/i18n.js`.

### Orchestrator Auto-Trigger
`lib/orchestrator.js` listens on `yabby:agent-bus` Redis channel. When a sub-agent completes, it spawns a review task for the parent manager/lead (5s debounce, 10s delayed re-check). Prevents duplicate review tasks — checks if manager already has a running task before spawning.

### Multi-Agent Task Cascades
`lib/multi-agent-orchestrator.js` + `lib/agent-task-processor.js` — A lead agent can submit a multi-step plan where tasks are distributed across agents. Tasks at the same `position` run in parallel; the next position waits until all current-position tasks complete. The `task-completion-bus.js` provides an in-memory one-shot event bus so the processor learns immediately when a spawned task exits (replacing the old DB-polling approach that timed out after 10min). On error, the cascade can `stop` or `continue` per `on_error` policy. Data stored in `multi_agent_task_queue` table (migration 032), with `agent_task_queue` items linked via `multi_agent_task_id` + `multi_agent_position`.

### Plan Review & Discovery Flow
1. Lead agent submits plan → `POST /api/plan-reviews` → SSE `plan_review` event → frontend modal
2. User approves/revises/cancels → `POST /api/plan-reviews/:id/resolve`
3. Approved: spawns task with `[PLAN APPROUVÉ]` prefix (Phase 2 execution)
4. Revised: spawns task with `[PLAN À RÉVISER]` + feedback (re-plan)
5. Cancelled: archives entire project

Discovery questions work similarly: lead posts questions → SSE → modal (voice/modal/connector types) → answers forwarded to lead with `[RÉPONSE]` or `[DÉCOUVERTE TERMINÉE]`.

### Persistent Memory (Mem0)
Facts extracted from conversation every 6 turns using `gpt-5-mini` (CRITICAL: do not change to nano — nano misses French names; pinned in config schema comment). Stored in Qdrant (file-based, `memory.db`) + SQLite. Profile injected into voice session instructions on connect/resume. Retry after 60s if init fails (quota recovery).

### Database Layer
Dual-write pattern: PostgreSQL (source of truth) + Redis (live status cache, 24h TTL). On read, check Redis first, fallback to PG. All queries in `db/queries/` follow this pattern using `Promise.all([query(...), redis.set(KEY(...), ...)])` for writes.

Redis key convention: `yabby:{entity}:{id}:{field}` via `KEY()` helper in `db/redis.js`. Special keys:
- `yabby:gui_lock` — Hash with `task_id` + `since` (5min TTL, auto-expires)
- `yabby:config-change` — pub/sub channel for config hot-reload

### Conversation System
`DEFAULT_CONV_ID = "00000000-0000-0000-0000-000000000001"` — shared main conversation (voice + channels). Windowed: only last 50 turns kept `active=TRUE` in context. `turnsSinceSummary` counter in Redis triggers memory extraction every 6 turns. Each agent gets its own conversation via unique partial index on `agent_id`.

### Configuration System
`lib/config.js` — Zod-validated config backed by PG `config` table + Redis cache. Hot-reloads via `yabby:config-change` pub/sub. Config keys: `general`, `voice`, `memory`, `auth`, `llm`, `channels`, `tts`, `mcp`, `tasks`, `onboarding`, `projects`. API keys from config are seeded into `process.env` on startup (so direct env reads work).

### Scheduler
`lib/scheduler.js` — In-memory scheduler that ticks every 30s. Supports `interval`, `cron`, and `manual` schedule types. Spawns tasks via the normal spawner, monitors completion by polling process handles. Retries on failure (configurable `maxRetries`, `retryDelayMs`). Recovers orphaned runs on startup.

### Relay Tunnel
`lib/tunnel.js` — WebSocket tunnel to `relay.openyabby.com` for mobile app access. Assigns a tunnel code (persisted to `.env`). Proxies HTTP + WebSocket traffic to localhost. Auto-reconnects with exponential backoff (2s → 30s max). Disabled with `DISABLE_TUNNEL=true`.

### Credential Encryption
`lib/crypto.js` — AES-256-GCM encryption for connector credentials. Key derived from `YABBY_SECRET` env var (or falls back to deterministic derivation from `OPENAI_API_KEY`). Each credential field encrypted individually. Stored as `{ iv, data, tag }` in JSONB.

### Tool Registry (`lib/plugins/tool-registry.js`)
Three tool categories combined via `getAllTools()`:
- **BASE_TOOLS** (48): task management, project/agent CRUD, connectors, inter-agent messaging, skills, scheduling, plan review, status monitoring
- **pluginTools**: dynamically registered by plugins via `registerTool(def)` (auto-prefixed with plugin name)
- **mcpTools**: bridged from MCP servers via `registerMcpTool(def)` (prefixed `mcp_{server}_{tool}`)

Connector tools use `conn_{catalogId}_{tool}` prefix. All use OpenAI function-calling format.

### Frontend (SPA)
Single `public/index.html` entry point. Init sequence: auth check → i18n load → onboarding → UI setup → SSE → voice → router → pending modals.

State management: `public/js/state.js` — `EventTarget`-based observable store. Components subscribe via `state.on(key, callback)`. Key state: `voiceStatus`, `currentAgent`, `projects`, `tasks`, `agents`, `activities` (max 200, LIFO), `heartbeats`, `agentChats`.

SSE events consumed in `public/js/sse.js`: `task`, `heartbeat`, `speaker_notify`, `plan_review`, `project_question`, `preview`, `conversation_update`. Notifications injected into DataChannel as system messages for voice announcement.

Activity page (`public/js/components/activity.js`): full-page timeline of all SSE events with type filters and pagination (100 per page). Frontend i18n via `public/js/i18n.js` loading JSON from `public/locales/` (fr, en).

Voice client-side filtering: regex blocks low-value utterances ("ok", "oui", "mmh" — 44 patterns), 10-min inactivity timeout suspends session.

### Integrations
- **Channels** (`lib/channels/`): Discord, Slack, Telegram, WhatsApp, Signal — adapter pattern via `ChannelAdapter` base class. Lazy-loaded via factory map in `index.js`. Handler (`handler.js`) runs LLM function-calling loop (max 5 iterations) using provider from `lib/providers/`. WhatsApp uses isolated auto-created group (only responds there). Notifications routed to channels via `notification-listener.js`.
- **Connectors** (`lib/connectors/`): 37 in static catalog (`catalog.js`). Two backends: built-in (JS class extending `BuiltinConnector`) or MCP (spawns MCP server process). Manager handles connect/disconnect, credential test, project scoping. Tools registered with prefix `conn_` or `mcp_`.
- **Providers** (`lib/providers/`): `LLMProvider` base class with retry (exponential backoff on 429/5xx, max 3). Implementations: Anthropic, Google, Groq, Mistral, Ollama, OpenAI, OpenRouter. Usage logged to `usage_log` table. `initProviders()` re-runs on `llm` config change.
- **MCP** (`lib/mcp/`): `client.js` manages MCP server lifecycle (stdio transport). `bridge.js` converts MCP tool schemas to OpenAI format and registers in tool registry.
- **TTS** (`lib/tts/`): Edge TTS (free, CLI spawn), ElevenLabs, OpenAI (`gpt-4o-mini-tts`), System (OS-level)
- **Plugins** (`lib/plugins/`): Discovery from `plugins/` dir → read `plugin.json` manifest → dynamic import `index.js` → call `init(context)`. Context provides: config read, scoped logger, tool registration, event bus, HTTP route registration at `/api/plugins/{name}`.

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Express app, `/session` endpoint (WebRTC), conversation state, wake word, route mounting, startup/shutdown |
| `lib/spawner.js` | CLI runner process lifecycle, log parsing, parent notification, orchestrator hook, `.mcp.json` generation |
| `lib/prompts.js` | `getBasePrompt()`, `buildVoiceInstructions()`, `buildLeadAgentPrompt()`, `buildManagerAgentPrompt()`, `buildSubAgentPrompt()` |
| `lib/runner-profiles.js` | Runner registry: Claude, Codex, Aider, Goose, Cline, Continue — each defines `buildArgs()`, `parseStdoutLine()`, capabilities |
| `lib/memory.js` | Mem0 singleton: `extractMemories()`, `getMemoryProfile()`, `clearMemories()`, `searchMemories()` |
| `lib/config.js` | Zod-validated config with PG + Redis + pub/sub hot-reload |
| `lib/logger.js` | `log()` (console + SSE + WS broadcast), `emitTaskEvent()`, `emitSpeakerNotification()`, `emitPlanReviewEvent()`, `emitProjectQuestionEvent()` |
| `lib/orchestrator.js` | Auto-trigger manager review on sub-agent completion, debounce (5s) + delayed re-check (10s) |
| `lib/agent-bus.js` | Redis pub/sub (`yabby:agent-bus`) for inter-agent messaging — store in DB + publish notification |
| `lib/scheduler.js` | Cron/interval/manual task scheduling, 30s tick loop, retry logic, orphan recovery |
| `lib/lead-names.js` | Curated multilingual list of human first names for auto-created lead agents |
| `lib/retry-detector.js` | Detects infinite retry loops in task activity logs by normalizing repeated tool calls |
| `lib/tool-suggestions.js` | Static `TOOL_SUGGESTIONS` map (`nextSteps` + `tips`) injected after tool execution |
| `lib/skills/` | Composable prompt-fragment skills attached to agents via `agent_skills` (e.g. `qa-browser-session.js`) |
| `lib/tunnel.js` | WebSocket relay tunnel to `relay.openyabby.com` for mobile access |
| `lib/crypto.js` | AES-256-GCM encryption for connector credentials |
| `lib/i18n.js` | Server-side i18n: English prompt fragments + `agentLang` directive + localized `SERVER_MESSAGES` (fr/en) |
| `lib/sandbox.js` | Project sandbox: `~/Desktop/Yabby Projects/{name}-{id}/` with git init, README, .gitignore |
| `lib/auth.js` | `optionalAuth` middleware — exempt paths: `/session`, `/api/wake-word`, `/api/logs/stream` |
| `lib/question-processor.js` | Sequential processing of project discovery questions (queue with concurrency lock) |
| `lib/memory-advanced.js` | Extends Mem0 with hybrid search (vector + keyword), temporal decay, query expansion |
| `lib/whisper.js` | OpenAI Whisper audio transcription wrapper (auto-detects mime type, defaults to French) |
| `lib/task-forwarder.js` | Remote task forwarding for Docker/remote agent mode (uses `TASKS_FORWARD_URL`) |
| `lib/playwright.js` | Optional headless Chromium automation for browser-based voice tool actions |
| `lib/hallucination-detector.js` | Binary classifier detecting when LLM claims actions without calling tools (warning-only, no auto-retry) |
| `lib/multi-agent-orchestrator.js` | Cascade orchestration: advances `multi_agent_task_queue` position-by-position (parallel within position, sequential across) |
| `lib/agent-task-processor.js` | Processes queued agent tasks — spawns tasks, waits for completion via event bus, advances cascades |
| `lib/task-completion-bus.js` | In-memory one-shot event bus linking spawner exits to queue processor (replaces DB polling) |
| `lib/pricing.js` | Centralized LLM pricing lookup table per provider/model for usage cost calculation |
| `lib/embeddings.js` | Embedding abstraction layer (OpenAI, Ollama, Mistral backends) |
| `lib/session-history.js` | Session persistence layer for conversation history |
| `lib/ws-gateway.js` | WebSocket server on `/ws` — presence tracking, typing indicators, same events as SSE |
| `lib/channels/handler.js` | Central channel message handler — LLM function-calling loop, tool execution, retry + dead letter |
| `lib/channels/normalize.js` | Normalizes platform messages to unified `NormalizedMessage` format |
| `lib/connectors/catalog.js` | Static catalog of 37 connectors with auth config, MCP commands, help text |
| `lib/connectors/manager.js` | Connect/disconnect lifecycle, credential test, tool registration, project scoping |
| `lib/providers/base.js` | `LLMProvider` base class with retry, usage logging |
| `lib/plugins/tool-registry.js` | Central tool registry: base + plugin + MCP tools for voice sessions |
| `lib/mcp/bridge.js` | Converts MCP tool schemas to OpenAI format, registers/unregisters tools |
| `lib/heap-monitor.js` | Watches V8 heap usage; forces `global.gc()` at 80% and warns at 70%/90%. Requires `npm start`'s `--expose-gc` to free memory |
| `lib/media/` | Content-addressed media store: `store.js` (SHA-256 dedup, file persistence), `mime.js`, `pdf.js` (pdfjs extraction), `vision.js` (LLM vision), `extract-paths.js`, `retention.js` (cleanup), `index.js` re-export |
| `lib/imagegen/client.js` | HTTP client for the local image-generation microservice (`npm run imagegen`) |
| `lib/tools/` | Per-tool implementations registered into the tool registry: `generate-image.js`, `search-images.js`, `web-screenshot.js`, `html-screenshot.js`, `send-media.js`, `get-channel-files.js`, `store-file.js` |
| `db/migrate.js` | Base schema (conversations, tasks). Runs standalone: `node db/migrate.js` |
| `db/migrations/` | Numbered migrations (002-041, with two duplicates at 016 and 017), auto-run on startup via explicit list in `server.js` `startup()` |
| `db/pg.js` | PostgreSQL pool (max 10, 30s idle, 5s connect timeout) |
| `db/redis.js` | Redis client, `KEY()` helper for `yabby:` prefixed keys |

## Database Schema

Core tables (see migrations 002-015 for full DDL):

| Table | Key Columns | Purpose |
|-------|-------------|---------|
| `conversations` | `id` (UUID), `summary`, `last_response_id`, `agent_id` (unique partial) | Conversation threads |
| `conversation_turns` | `conversation_id`, `role`, `text`, `active` (BOOLEAN) | Turn history, windowed (max 50 active) |
| `tasks` | `id` (VARCHAR 8), `session_id`, `status`, `result`, `project_id`, `agent_id`, `parent_task_id`, `priority`, `depends_on` (JSONB), `runner_id`, `runner_thread_id` | Task execution state. `runner_id` + `runner_thread_id` (mig 035) hold the native CLI runner session id when it differs from `session_id` (e.g. Codex thread_id) so resume uses the right identifier |
| `projects` | `id` (VARCHAR 12), `name`, `status`, `lead_agent_id`, `context` | Project containers |
| `agents` | `id` (VARCHAR 12), `project_id`, `name`, `role`, `system_prompt`, `parent_agent_id`, `is_lead`, `is_super_agent`, `session_id`, `active_task_id`, `task_status`, `runner_sessions` (JSONB) | Agent definitions and hierarchy. `runner_sessions` (mig 036) maps runner key → native session id, e.g. `{"claude": "...", "codex": "..."}`, so resume can recover even when task-local context is missing |
| `agent_messages` | `from_agent`, `to_agent`, `msg_type`, `content`, `status` (pending/read/processed) | Inter-agent inbox |
| `agent_heartbeats` | `agent_id`, `project_id`, `status`, `progress` (0-100), `summary` | Agent progress tracking |
| `skills` / `agent_skills` | `name`, `prompt_fragment` / `agent_id`, `skill_id` | Composable skill library |
| `event_log` | `project_id`, `agent_id`, `event_type`, `detail` (JSONB) | Append-only audit trail |
| `config` | `key` (PK), `value` (JSONB) | Runtime configuration |
| `users` / `sessions` / `api_tokens` | Standard auth | Optional gateway auth |
| `scheduled_tasks` / `scheduled_task_runs` | `schedule_type` (interval/cron/manual), `task_template`, retry config | Task scheduling |
| `connectors` / `project_connectors` / `connector_requests` | `catalog_id`, `credentials_encrypted`, `is_global` | External API integrations |
| `channel_conversations` / `channel_messages` / `dead_letters` | `channel_name`, `user_id`, `is_group` | Channel message persistence |
| `plan_reviews` | `project_id`, `agent_id`, `plan_content`, `status`, `feedback` | Plan approval workflow |
| `project_questions` | `question`, `question_type` (voice/modal/connector), `form_schema`, `answer` | Discovery Q&A |
| `presentations` | `slides` (JSONB), `demo_steps` (JSONB) | Project presentations |
| `usage_log` | `provider`, `model`, `input_tokens`, `output_tokens`, `cost_usd` | LLM usage tracking |
| `whatsapp_settings` | `yabby_group_id` (UNIQUE) | Persistent WhatsApp group |
| `agent_task_queue` | `agent_id`, `instruction`, `source`, `status`, `priority` | Queued task instructions for agents |
| `channel_thread_bindings` | `channel_name`, `thread_id`, `conversation_id`, `agent_id`, `session_key` | Bind channel threads to agents/conversations |
| `multi_agent_task_queue` | `owner_agent_id`, `status`, `current_position`, `items` (JSONB), `on_error` | Cascade orchestration: position-based parallel/sequential multi-agent task execution |
| `media_assets` / `message_media` / `turn_media` | `sha256` (UNIQUE), `path`, `mime`, `kind` (image/pdf/audio/video/file) | Content-addressed media store; link tables associate assets with channel messages and conversation turns |
| `channel_pairings` | `channel_name` (PK), `owner_user_id`, `owner_chat_id` | One owner per channel — unpaired channels reject all messages except the pairing code |

## Important Patterns

### Agent Name Uniqueness
Standalone agents (no `project_id`) must have globally unique names (enforced by `agents_standalone_name_unique` partial index). Within a project, names must be unique per project (`agents_project_name_unique` index). See migration `025_fix_agent_name_uniqueness.js`. Auto-created lead agents get a random human first name from `lib/lead-names.js`.

### Name Resolution
Tools accept either ID or name. Resolution order: exact ID → exact name (case-insensitive) → ILIKE contains → fuzzy word match (stop-words filtered: "le", "la", "de", "the", "of"...) → ANY word match → role match (agents only). Implemented in each `db/queries/*.js` via `findByName()` / `resolveId()`.

### Soft Delete
Never use actual DELETE. Set `status='archived'`. All queries filter `WHERE status != 'archived'`.

### Dual-Write Cache
Write: `Promise.all([query(...), redis.set(KEY(...), value, { EX: 86400 })])`. Read: check Redis first → fallback to PG → re-cache. TTL varies: 24h default, 7d sessions, 5min GUI lock, 1h API tokens.

### GUI Lock
Redis hash `yabby:gui_lock` with `{ task_id, since }`. Tasks must `POST /api/gui-lock/acquire` before GUI operations. Auto-releases if holding task is no longer running (crash recovery). 5min TTL.

### Real-time Events
SSE (`GET /api/logs/stream`) + WebSocket (`/ws`). Event types: `task`, `heartbeat`, `speaker_notify`, `plan_review`, `project_question`, `preview`, `conversation_update`. Both channels emit identical events from `lib/logger.js`. Speaker notifications also broadcast to WhatsApp via `notification-listener.js`.

### Voice Session Switching
`switch_to_agent`: frontend fetches agent voice config → sends `session.update` via DataChannel to swap instructions (same WebRTC connection persists). `back_to_yabby` fetches `/api/yabby-instructions` and reverses.

### Wake Word
`POST /api/wake-word` receives raw audio (WebM or WAV, also base64) → Whisper transcription (`gpt-4o-mini-transcribe`, French) → regex `/\byab+[iy]e?\b/i` or `/\bjab+[iy]e?\b/i`. Minimum 2KB audio. Client-side VAD via Silero ONNX model.

### Task Status Lifecycle
`running` → `done` | `error` | `paused` | `killed` | `paused_llm_limit`. On startup, `recoverOrphanedTasks()` marks orphaned `running` tasks as `error`. Pause sends SIGTERM, kill sends SIGKILL. Sub-task dependencies via `depends_on` JSONB array — `canTaskStart()` checks all deps are `done`. When the Claude CLI hits its daily quota the spawner marks the task `paused_llm_limit` and persists `task_instruction` + `llm_limit_reset_at` + `paused_at` (migration 024) so the task can be resumed once the quota resets. Tasks also track a `phase` column (migration 026) for phase-aware notifications (discovery vs execution) and a `metadata` JSONB column.

### Retry Loop Detection
`lib/retry-detector.js` — Scans the last 30 tool calls in an activity log looking for repeated normalized commands (strips timestamps and sleep counts). When a pattern repeats beyond threshold, returns `{ isStuck, pattern, count, suggestion }` so the spawner/orchestrator can intervene and unblock a stuck agent.

### Tool Suggestions
`lib/tool-suggestions.js` — Static map (`TOOL_SUGGESTIONS`) from tool name → `{ nextSteps, tips }`. Injected after tool execution to guide the LLM toward natural follow-up actions and improve command discoverability.

### Skills System
`lib/skills/` — Composable prompt fragments that can be attached to agents via the `agent_skills` join table. Each skill exports `{ id, name, category, description, prompt_fragment }`. Example: `qa-browser-session.js` provides Playwright MCP (headless Chrome) instructions for QA agents. Migration `027_qa_browser_session_skill.js` seeds this skill into the DB.

### Lead Agent Auto-Naming
`lib/lead-names.js` — When auto-creating lead agents, picks a random human first name from a curated multilingual list (French, English, etc.) to satisfy the standalone name uniqueness constraint.

### Channel Message Handling
`lib/channels/handler.js` — normalized message → channel pairing check (mig 034: unpaired channels reject all messages except the pairing code, which sets `channel_pairings.owner_user_id`) → DM policy check → group mention gating → slash commands (`/status`, `/new`, `/reset`, `/help`) → LLM function-calling loop (max 5 tool iterations, same tools as voice) → retry with exponential backoff (max 3) → dead letter queue on final failure. Channels share `DEFAULT_CONV_ID` conversation with voice (unified context).

### Hallucination Detection
`lib/hallucination-detector.js` — Binary classifier (via LLM provider) that checks if a response claims an action was performed without actually calling the corresponding tool. Used in voice and channel handlers. Warning-only (no auto-retry) — the deterrent is in the prompt telling the LLM it's being watched.

### Connector Tool Naming
Built-in tools: `conn_{catalogId}_{toolName}`. MCP tools: `mcp_{serverName}_{toolName}`. Plugin tools: auto-prefixed with plugin name. Prevents name collisions in the shared tool registry.

### Route Registration
All route files are Express Routers, mounted in `server.js`. Auth routes mounted before `optionalAuth` (always accessible). SSE endpoint registered before auth middleware. All other routes protected when auth is enabled. Exempt paths: `/session`, `/api/wake-word`, `/api/logs/stream`. Notable routers: `routes/system.js` (`POST /api/system/broadcast-update` — pushes a `system_update` event to all active voice clients via `emitSystemUpdate`).

### Adding Database Migrations
Migrations live in `db/migrations/` with sequential numbering (`002_`, `003_`, etc.; latest on disk is `041_plan_review_pending_emission.js`). Each file exports a `MIGRATION` SQL string and a `run` async function that calls `query(MIGRATION)`. They run automatically on startup (listed explicitly in the hardcoded array inside `startup()` in `server.js` — grep `migrations\\.push` or the migration filenames to find it; line numbers drift) and must be idempotent. **You must add the filename to that array** — the loop does not auto-discover files. Note: some numbers have duplicates on disk (two `016_`, two `017_`) — this is fine since each is idempotent and all are listed explicitly. Caution: `016_performance_indexes.js` exists on disk but is NOT listed in `server.js` startup — verify the array before assuming a migration runs, and before adding new files at the same number. Recent additions: `032_multi_agent_task_queue.js` (cascade orchestration), `033_media_assets.js` (content-addressed media store + `message_media`/`turn_media` link tables), `034_channel_pairings.js` (one-owner-per-channel pairing — unpaired channels reject all messages except the pairing code), `035_runner_session_parity.js` (`tasks.runner_id` + `tasks.runner_thread_id` so resume uses the right native session id per CLI runner), `036_agent_runner_sessions.js` (`agents.runner_sessions` JSONB mapping runner key → native session id, e.g. `{"claude": "...", "codex": "..."}`), `037_presentations_demo.js` (one-active-presentation-per-project unique index + executable demo flow columns: `script_path`, `test_accesses`, `last_run_*`), `038_thread_owner.js` (`channel_thread_bindings.owner_user_id`/`owner_user_name` for per-thread single-owner access gate; backfilled from `channel_pairings`; NULL means no enforcement so legacy threads keep working), `039_channel_containers.js` (new `channel_containers` table — one host group/server/workspace per channel for Telegram/Discord/Slack so `assign_agent` can auto-create dedicated agent threads; WhatsApp excluded — it uses `agent_whatsapp_groups`), `040_tasks_fk_set_null.js` (rebuilds `fk_tasks_agent` and `fk_tasks_project` with `ON DELETE SET NULL` — original migration 002 created them with default `NO ACTION`, which blocked `deleteProject` whenever any task still referenced an archived project's agents; tasks are append-only history so we null out the dangling reference instead of cascading deletes), `041_plan_review_pending_emission.js` (`plan_reviews.pending_emission` column — defers the modal/voice emission until the submitting CLI task actually exits; the spawner exit handler in `lib/spawner.js` watches for `pending_emission=TRUE` rows matching the exiting taskId and fires `emitPlanReviewEvent` + `emitSpeakerNotification` once at task exit instead of at submit time, eliminating the doubled "plan submitted, then task done" notifications).

### Project Sandbox
Projects get isolated working directories at `~/Desktop/Yabby Projects/{sanitized-name}-{id-prefix}/`. Auto-initialized with `src/`, `docs/`, README.md, .gitignore, and `git init`. Location configurable via `projects.sandboxRoot` config.

## Module System

ES modules throughout (`"type": "module"` in package.json). All imports use `.js` extensions. Path aliases defined in `jsconfig.json` (`#lib/*`, `#db/*`, `#routes/*`) but not actively used — all imports use relative paths (e.g. `../db/queries/tasks.js`, `./logger.js`).

## Testing

Two layers:
- **Vitest** (unit) — `tests/**/*.test.js`. Mocks PG pool and Redis to avoid real DB connections. Config in `vitest.config.js` (globals enabled, 10s timeout). Run directly via `npx vitest` (no npm script).
- **Playwright** (E2E) — `tests/e2e/`. Config in `playwright.config.js`: sequential (`fullyParallel: false`), 2min test timeout, Chromium only, base URL `http://localhost:3000`. **The dev server is NOT auto-started** (`webServer` block is commented out) — you must run `npm start` manually before `npm run test:e2e`. Reports saved to `playwright-report/`.

## Docker

`docker-compose.yml` provides Postgres + Redis. Note: Claude CLI cannot run inside Docker — use `TASKS_FORWARD_URL` to forward task spawns to a local agent, or run Docker only for web/channels while keeping local Yabby for task spawning.
