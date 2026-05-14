# Changelog

All notable changes to OpenYabby are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] — 2026-05-14

### Added

- **Exit-code aware bg task tracking.** New columns `exit_code`, `exit_signal`, `exit_file`, `is_service` (migration 045). The bookkeeper script wraps the user command so its exit code is captured (POSIX-portable). A `[bg:service]` tag in the tool's `description` marks long-lived servers — when they die, the agent gets `[BG_SERVICE_DIED]` instead of `[BG_COMPLETED]`. Non-zero exits routed as `[BG_FAILED]`.
- **5 agent introspection tools.** `list_bg_tasks` (compact list, running first, status counts), `bg_task_detail` (full info for one cli_task_id), `get_bg_task_log` (read output with `tail` / `head` / `grep` modes, 64KB cap), `kill_bg_task` (SIGTERM→SIGKILL escalation), `register_external_bg` (track a process detached by external scripts like `start.sh`).
- **Global `GET /api/bg-tasks`** endpoint joining `agents` for cross-agent visibility.
- **Activity page split.** CLI events and Background Tasks now have their own scrollable section with running-first sort, status badges, elapsed timer, service marker, and 15s auto-refresh. All strings i18n'd (fr + en).
- **`start.sh` convention.** The prompt now asks the lead to print each spawned service as `SERVICE <name> PID=<pid> PORT=<port>` and to register them with `register_external_bg` so the user sees them in the activity panel.

### Fixed

- **Orphaned `claude` processes from bg-task DB write races.** Fire-and-forget DB writes in `onBgTaskStarted` / `onBgTaskNotification` / close handler are now serialised via `lib/bg-write-tracker.js` (per-task `Set<Promise>`), so the close handler awaits all writes before `markOrphanedBgTasksDead` runs. Includes 5 Vitest cases. (Contributed by @AyonPal in #20.)
- **`pause` and `intervene` left hung children reparented to init.** Both endpoints now escalate SIGTERM → SIGKILL after the grace window if `processHandles` still tracks the task. (Contributed by @AyonPal in #20.)
- **Bookkeeper wrap broke on Python `f'...'` and nested quotes.** Replaced the double `sh -c` wrap (which applied the `'\''` escape twice) with a per-call bookkeeper script written to `/tmp/yabby-bg/<id>.sh`, invoked via `sh -c 'nohup .../bookkeeper.sh ... &'`. Zero shell escaping needed, exit code captured via `wait $C; $?`.
- **Watchdog kill treated as failure in the notification branch.** When the FINAL_OUTPUT watchdog SIGTERMs a CLI cleanly (no bg active), the close handler's success branch now triggers (`code === 0 || killedAfterFinalOutput`) instead of falling into the error branch.
- **Startup sweep blindly orphaned still-alive bg rows.** `server.js` now checks each `running` row's PID with `kill -0` before marking it orphaned, so long-running bg jobs survive a Yabby restart.
- **`markOrphanedBgTasksDead` killed all `running` rows on CLI close.** Now PID-aware: rows whose PID is still alive stay `running` and the bg-watcher continues polling them.

## [0.1.2] — 2026-05-13

### Added

- **OS-level tracking of `Bash run_in_background` jobs.** New `bg_tasks` table, PreToolUse hook that captures the host PID, and a watcher polling `kill -0` every 30s. When a bg job ends after the parent CLI has exited, the agent receives a `[BG_COMPLETED]` follow-up. Exposed via `GET /api/tasks/:id/bg-tasks` and `GET /api/agents/:id/bg-tasks`.

### Fixed

- **Lead looping "project done" after delivery.** The `plan_continuation` auto-poke now skips when an active presentation has `last_run_status='passed'`.
- **Sub-agent completions not reaching the lead past Phase 1.** The orchestrator's `phase='discovery'` skip now also requires no approved plan — `task.phase` is never advanced, so leads were silently dropped after their first plan approval.
- **Review pile-up on cascading sub-completions.** The orchestrator skips a new `orchestrator_review` when one is already `pending` or `processing` — the existing review already reads all pending inbox messages.
- **Watchdog killed live bg jobs (regression from 0.1.1).** Removed the 10s `FINAL_OUTPUT` watchdog and the close-handler `SIGKILL` of the process group. Bg jobs now survive CLI exit; the watcher above detects completion via OS PID.

## [0.1.1] — 2026-05-09

### Added

- **`once` schedule type** — schedule a task to run exactly one time at a specific date and time, then stop. The previous workaround of using a yearly cron expression (e.g. `0 10 20 5 *`) would silently re-fire the next year. Use the new `Once (specific date)` option in the scheduled tasks UI, or POST `scheduleType: "once"` with `scheduleConfig: { runAt: "<ISO timestamp>" }`. After execution the task naturally stops being picked up by the tick loop (no status change required).

### Fixed

- **Lead agent stalls at the end of a project without creating a presentation.** The auto-poke `continue` instruction now nudges the lead toward the presentation flow if everything else is delivered, so the project ends with a runnable demo instead of "nothing to continue."
- **Duplicate presentation creation when the auto-poke beat the project-completed handler.** The completed-handler instruction now asks the lead to call `presentation_status` first and switch to `presentation_update` if a presentation already exists, instead of failing on `create_presentation`.
- **WhatsApp Baileys crash on the new `@lid` participant stub format.** Patched the upstream library to handle the new format gracefully.
- **WhatsApp media upload `ENOENT` on Baileys enc temp files.** Flush the temp file before upload, recover from missing-file errors instead of crashing.
- **`/api/tools/execute` rejected payloads using `tool` / `params` aliases.** Now accepts both the canonical `toolName` / `args` and the shorter `tool` / `params` shape.

### Documentation

- Discord link and badge added to the README.

## [0.1.0] — 2026-04-29

First public release.

### Added

- **Voice pipeline** — WebRTC bidirectional audio with the OpenAI Realtime API. Wake word (`Yabby`) detection via Silero VAD + Whisper transcription. Optional speaker verification via SpeechBrain ECAPA-TDNN microservice (`npm run speaker`).
- **Multi-agent orchestration** — Hierarchical lead / manager / sub-agent system with phase-aware prompts (discovery, planning, execution, review, QA). Auto-trigger of parent reviews on sub-agent completion.
- **Multi-agent task cascades** — Position-based parallel/sequential execution across agents, with one-shot in-memory completion bus replacing DB polling.
- **CLI runner registry** — Five runners supported out of the box: Claude Code (default), OpenAI Codex, Aider, Goose, Cline, Continue. Per-runner native session id persisted for correct resume.
- **Channels** — Discord, Slack, Telegram, WhatsApp, Signal. One-owner-per-channel pairing model. Unified LLM function-calling loop across voice and channels.
- **37 connectors** — Static catalog with built-in and MCP backends. Tools auto-prefixed `conn_*` / `mcp_*` for namespace isolation.
- **Persistent memory** — Mem0 + Qdrant (file-based) for facts extracted every 6 turns. Hybrid search (vector + keyword), temporal decay, query expansion.
- **Plan review and discovery** — Lead agents submit plans for user approval and ask discovery questions through SSE-driven modals (voice, modal, or connector form types).
- **Scheduler** — In-memory tick loop supporting interval, cron, and manual schedules with retry and orphan recovery.
- **Relay tunnel** — Optional WebSocket tunnel to `relay.openyabby.com` for remote access. Auto-reconnect with exponential backoff. Disabled by default.
- **Plugin system** — Drop-in plugin loader with scoped logger, tool registry, event bus, and HTTP route mounting.
- **Auth gateway** — Optional username/password protection with API tokens and session cookies. Exempt paths for the SDP and SSE endpoints.
- **Multi-channel media store** — Content-addressed (SHA-256) media assets with PDF/vision/audio extraction.
- **41 idempotent migrations** — All run on startup, listed explicitly in `server.js` `startup()`.
- **i18n** — French (default), English, Spanish, German via `lib/i18n.js`. Frontend locales in `public/locales/`.

### Known limitations

- macOS-first (Linux/Windows on the roadmap)
- Voice pipeline requires the OpenAI Realtime API (local-voice path planned)
- Claude CLI required for the default runner (other runners available)
- WhatsApp adapter pulls in `@whiskeysockets/baileys` which transitively includes a GPL-3.0 component — see [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md)

[Unreleased]: https://github.com/OpenYabby/OpenYabby/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/OpenYabby/OpenYabby/releases/tag/v0.1.1
[0.1.0]: https://github.com/OpenYabby/OpenYabby/releases/tag/v0.1.0
