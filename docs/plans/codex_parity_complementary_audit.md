# Codex Parity Complementary Audit (Gap Addendum)

Date: 2026-04-23  
Scope: second-pass audit to catch omissions from `codex_parity_execution_plan.md`.

## Executive Summary
The original plan is directionally correct, but this addendum identifies extra parity-critical surfaces that must be included to reach true Claude↔Codex execution equivalence. The biggest missed areas are UI event consumers, agent chat streaming assumptions, tooling metadata text, and operational scripts.

## Non-Regression Constraint
All addendum items are subject to strict compatibility mode:
- no removal of existing Claude behavior during rollout,
- additive-only schema/API/event changes first,
- legacy aliases and event formats kept until full dual-runner validation is complete.

## Newly Identified Gaps
### 1) Event-to-UI Coupling (High)
- UI still treats runner output as `claude_text`/`claude` only.
- Impact: Codex tasks may execute but appear silent/incomplete in activity/agent chat views.
- Files:
  - `public/js/sse.js`
  - `public/js/voice.js`
  - `public/js/components/activity.js`
  - `public/js/components/agent-chat.js`
  - `public/js/components/agent-detail.js`
  - `public/js/components/dashboard.js`
  - `public/js/components/project-detail.js`
  - `public/css/components.css` (class names tied to `.claude`)

### 2) Codex Event Parsing Coverage (High)
- Codex emits `thread.started`, `turn.*`, `item.completed`; current parser mainly handles `message/output_text/text`.
- Impact: missing streamed text, weaker completion extraction, inconsistent result propagation.
- Files:
  - `lib/runner-profiles.js`
  - `lib/spawner.js`

### 3) Tool Contract Language Drift (Medium)
- Tool descriptions still encode “Claude session/quota” semantics.
- Impact: model behavior bias and inaccurate user-facing guidance.
- Files:
  - `lib/plugins/tool-registry.js`
  - `lib/tool-suggestions.js`
  - `db/queries/tasks.js` comments
  - `db/migrations/024_llm_limit_tasks.js` comments

### 4) Ops/Dev Script Parity (Medium)
- Zombie cleanup script handles `claude` processes but not `codex`.
- Impact: resource leaks in Codex-first operation.
- Files:
  - `scripts/cleanup-zombies.sh`

### 5) Docs/Test Surface Completeness (Medium)
- Multiple docs/tests still hardcode `/claude/*` endpoint examples and Claude-only prerequisites.
- Impact: drift between implementation and verification/docs.
- Files:
  - `tests/e2e/*.spec.js`
  - `tests/e2e/README.md`
  - `tests/MESSAGE_FLOW_COMPLETE.md`
  - `README.md`, `.env.example`, `setup.sh` output text

### 6) Runner Health Preflight (Medium)
- Runner detection validates binary/version but not Codex auth/session readiness.
- Impact: false “ready” state with runtime failure.
- Recommended checks:
  - `codex login status`
  - write-access check for `~/.codex/sessions`
- Files:
  - `routes/tasks.js` (`/api/tasks/runners` detection)

## Plan Updates Required
1. Extend Phase 2 (event normalization) to explicitly include agent-chat streaming and CSS/type migration.
2. Add a new phase for “Runner Health Preflight” before rollout.
3. Expand Phase 5 docs migration to include tests and operational scripts.
4. Keep temporary compatibility layer:
   - emit both `runner_text` and legacy `claude_text` for one release.
   - accept both `/api/tasks/*` and `/claude/*` until test suite migration completes.

## Additional Definition-of-Done Checks
1. Codex task emits visible incremental text in Activity and Agent Chat.
2. Dashboard/project filters show runner output regardless of source runner.
3. `cleanup-zombies.sh` clears orphaned Codex processes.
4. `GET /api/tasks/runners` reports Codex “installed but not authenticated” distinctly.
5. E2E suite passes after switching tests to canonical `/api/tasks/*` routes.
