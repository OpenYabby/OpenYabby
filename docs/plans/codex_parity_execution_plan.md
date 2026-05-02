# Codex Parity Execution Plan (OpenYabby)

## Objective
As of April 23, 2026, OpenYabby is Codex-capable but not parity-complete with Claude flows. This plan defines the exact updates required so any workflow that works with Claude (`start`, `continue`, `intervene`, queue processing, activity logs, notifications) behaves equivalently with Codex.

## Scope
In scope: task execution, session persistence/resume, event parsing, task APIs, UI activity rendering, operational scripts, docs, and tests.
Out of scope: changing product behavior unrelated to runner parity (channels/connectors feature expansion).

## Non-Regression Requirements (Must Not Break Existing Working Flows)
1. Claude remains first-class during migration: no removal of current Claude paths or behaviors until parity tests are green.
2. All DB changes are additive only (new nullable columns / new indexes). No destructive schema changes, no type narrowing.
3. Maintain compatibility aliases during migration:
   - API: keep `/claude/*` routes active while introducing `/api/tasks/*`.
   - Events: emit both `runner_*` and legacy `claude_text` for one release cycle.
4. Introduce runner parity behind a feature flag (`tasks.enableRunnerParityV2`), default `false` in production.
5. Codex changes must not alter task semantics for existing users:
   - same task lifecycle statuses
   - same queue behavior
   - same notification chain
6. Every phase requires explicit go/no-go checks and rollback readiness before moving forward.

## Baseline Findings
- Codex fresh runs work (`codex exec ...`).
- Codex resume currently fails in app semantics because resume args omit prompt and app-generated UUID session IDs are not guaranteed to match Codex `thread_id`.
- Internal APIs and labels are still Claude-centric (`/claude/*`, `claude_text`, Claude-only wording).

## Impact Analysis
### 1) Data Model (High impact)
- Add runner-physical session tracking to avoid resume drift.
- Proposed schema additions:
  - `tasks.runner_id VARCHAR(32)`
  - `tasks.runner_thread_id TEXT`
  - `agents.runner_sessions JSONB DEFAULT '{}'::jsonb` (map by runner)
- Risk: backward compatibility with existing tasks. Mitigation: nullable columns + fallback to legacy `session_id` when missing.

### 2) Execution Engine (High impact)
- `lib/spawner.js` and `lib/runner-profiles.js` become runner-neutral for session lifecycle.
- Codex adapter must persist `thread.started.thread_id` and resume with prompt.
- Risk: regressions in Claude flow. Mitigation: adapter-level tests + dual-runner CI matrix.

### 3) API Contracts (Medium impact)
- Introduce canonical endpoints: `/api/tasks/start|check|continue|pause|kill|intervene`.
- Keep `/claude/*` aliases for one release cycle.
- Risk: consumer breakage. Mitigation: aliases + gradual caller migration.

### 4) UI/Observability (Medium impact)
- Normalize event types: `runner_text`, `runner_tool_use`, `runner_tool_result`.
- Keep `claude_text` compatibility mapping in UI until cleanup.

### 5) Docs/Ops (Low-Medium impact)
- Update README, `.env.example`, onboarding/settings wording, cleanup scripts, and contributor docs to describe runner-agnostic behavior.

## Implementation Phases
### Phase 0: Guardrails and Baseline
- Add parity acceptance tests (see Test Matrix section).
- Add temporary debug logs around session/thread persistence.
- Snapshot baseline behavior from current working Claude flow (golden logs + SSE timeline + API responses) and lock it as regression reference.
- Add kill-switch config path to instantly revert to legacy behavior if anomalies are detected.

### Phase 1: Session & Resume Correctness (Blocker)
- Update Codex profile in `lib/runner-profiles.js`:
  - `buildResumeArgs(task,{sessionId}) => ["exec","resume",sessionId,"--json",task]` (or equivalent ordering validated by CLI help).
  - Parse `thread.started` and expose `thread_id` event to spawner callbacks.
- Update `lib/spawner.js`:
  - Persist `runner_id` and `runner_thread_id` into task + agent records.
  - On resume/intervention, prefer `runner_thread_id`; fallback to legacy `session_id`.
  - Add Codex-specific "thread not found" recovery path.
- DB updates:
  - Add `db/migrations/035_runner_session_parity.js` for new columns.
  - Register migration in `server.js` migration list.

### Phase 2: Event Normalization
- Emit normalized events from spawner; keep legacy aliases:
  - `runner_text` (+ legacy `claude_text` alias)
  - `runner_tool_use`, `runner_tool_result`, `runner_result`
- Update consumers:
  - `public/js/sse.js`
  - `public/js/components/activity.js`
  - `public/js/components/agent-detail.js`
  - `public/js/voice.js`

### Phase 3: API Neutralization
- Add canonical task control routes in `routes/tasks.js`.
- Migrate callers from `/claude/*` to `/api/tasks/*`:
  - `public/js/api.js`
  - `routes/tools.js`
  - `lib/task-forwarder.js`
  - prompt examples in `lib/prompts.js`, `routes/agents.js`, docs/tests references.
- Keep `/claude/*` aliases untouched until:
  - full test matrix passes in Claude+Codex mode
  - manual smoke tests pass in UI + voice + agent chat
  - one release cycle completes without regressions

### Phase 4: Runner-Behavior Parity
- Apply Claude-only safeguards conditionally:
  - `.claude-settings.json` and PreToolUse hook only for Claude.
- Add equivalent workspace safety guidance into Codex instruction path (`CODEX_INSTRUCTIONS.md` generation) so `change-workspace` behavior remains consistent.
- Rename LLM limit copy from “Claude quota” to runner-neutral wording where generic.

### Phase 5: Docs, Onboarding, and Settings
- Update runner defaults/labels and hints:
  - `public/js/components/onboarding.js`
  - `public/js/components/settings.js`
  - `public/js/components/runner-selector.js`
  - `public/locales/*.json`
- Update docs:
  - `README.md`, `.env.example`, `tests/e2e/README.md`, `docs/plans/*` references.

## Planned File-Level Updates
- `db/migrations/035_runner_session_parity.js` (new)
- `server.js` (register migration)
- `db/queries/tasks.js` (persist/read runner fields)
- `db/queries/agents.js` (persist/read `runner_sessions`)
- `lib/runner-profiles.js` (Codex resume/event parsing fixes)
- `lib/spawner.js` (session/thread persistence, normalized events, recovery)
- `routes/tasks.js` (canonical endpoints + aliases)
- `routes/tools.js`, `public/js/api.js`, `lib/task-forwarder.js` (caller migration)
- `public/js/sse.js`, `public/js/components/activity.js`, `public/js/components/agent-detail.js`, `public/js/voice.js` (event consumption)
- `README.md`, `.env.example`, `tests/e2e/README.md`, `scripts/cleanup-zombies.sh` (docs/ops parity)

## Test Matrix (Definition of Done)
1. Start task with Claude and Codex: both complete successfully.
2. Continue same task: both preserve context.
3. Intervention on running task: both pause+resume same logical task.
4. Resume after restart: both recover with persisted runner session/thread.
5. SSE/activity UI: same timeline semantics for both runners.
6. Queue/agent cascade: same orchestration outcomes for both runners.

## Rollout & Risk Control
- Release in 2 steps:
  1. Ship data model + session fixes + dual event emission behind `tasks.enableRunnerParityV2`.
  2. Switch callers to canonical APIs, then remove legacy paths in next release.
- Rollback: disable parity flag, continue using legacy fields/endpoints; DB additions are additive and safe.

## Go/No-Go Gates Per Phase
1. Unit + integration tests pass for both runners.
2. Manual smoke suite passes on currently working Claude flows (must be unchanged).
3. No increase in task failure rate or stuck-task rate after enabling parity flag.
4. UI parity verified: activity timeline, agent chat streaming, dashboard status, and notifications.
5. If any regression appears, immediate rollback to flag `false` and keep legacy paths.

## Complementary Audit
For additional missed-surface checks discovered in a second pass (UI event coupling, agent chat streaming assumptions, tool metadata language drift, ops script parity, and runner preflight readiness), see:

- `docs/plans/codex_parity_complementary_audit.md`

## Execution Status (2026-04-23)
- Completed: Phase 1 core wiring (non-breaking, additive only).
- Completed: `db/migrations/035_runner_session_parity.js` created and registered.
- Completed: `lib/runner-profiles.js` Codex resume args fixed to include prompt + `--json`.
- Completed: Codex parser now handles `thread.started` and `item.completed` `agent_message`.
- Completed: `db/queries/tasks.js` runner-context read/write helpers added with safe fallback when columns are missing.
- Completed: `lib/spawner.js` now persists `runner_id`, stores Codex `thread_id`, and prefers stored `runner_thread_id` on resume.
- Completed: stale-session detection expanded for Codex `"no rollout found for thread id"` path.
- Completed: Phase 2 event normalization:
  - `lib/spawner.js` emits `runner_tool_use`, `runner_tool_result`, `runner_text`, `runner_result` plus legacy aliases.
  - `public/js/sse.js` normalizes/deduplicates dual events so UI behavior stays stable.
  - `public/js/voice.js` and `public/js/components/agent-chat.js` accept normalized event names.
- Completed: Phase 3 API neutralization (initial rollout):
  - Added canonical aliases `/api/tasks/start|check|continue|pause|kill|intervene` in `routes/tasks.js`.
  - Updated core callers (`public/js/api.js`, `routes/tools.js`, `lib/task-forwarder.js`) to canonical routes.
  - Kept all `/claude/*` routes active for compatibility.
- Completed (partial): Phase 4 runner-specific safeguards:
  - `.claude-settings.json` hook injection now runs only when `runnerId === "claude"`.
- Completed (partial): runner-neutral UX/docs wording:
  - Task/activity labels switched from provider-specific text to runner-neutral wording in locale bundles (`en`, `fr`, `es`, `de`) while preserving existing translation keys.
  - Agent detail log badge label now displays `Runner` instead of `Claude`.
  - Task/tool metadata copy updated from "Claude quota/session" to runner-neutral "LLM limit/runner session" where applicable.
- Completed (ops): `scripts/cleanup-zombies.sh` now also handles orphan `codex` CLI processes in the same safe pattern as `claude`.
- Completed (tests): added endpoint parity regression coverage in `tests/e2e/api-basic.spec.js` validating canonical `/api/tasks/*` and legacy `/claude/*` task control paths.
- Completed: feature-flag kill switch added to config as `tasks.enableRunnerParityV2` (default `true` to preserve current behavior, can be set `false` for rollback).
- Completed: `db/migrations/036_agent_runner_sessions.js` added and registered in startup migrations.
- Completed: `db/queries/agents.js` now supports runner session map persistence via:
  - `updateAgentRunnerSession(agentId, runnerId, sessionKey)`
  - `getAgentRunnerSession(agentId, runnerId)`
- Completed: `lib/spawner.js` resume parity now falls back from task runner thread to agent-level runner session when needed.
- Completed: `lib/spawner.js` now persists agent-level runner sessions for both Claude and Codex (Codex on `thread.started`).
- Completed: parity behavior in `lib/spawner.js` now respects `tasks.enableRunnerParityV2`.
- Completed: Codex preflight readiness in `/api/tasks/runners` now includes auth status (`codex login status`) and `~/.codex/sessions` writeability checks.
- Pending next: run full regression test matrix (unit + e2e) and record pass/fail evidence.
