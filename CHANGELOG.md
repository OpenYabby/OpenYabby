# Changelog

All notable changes to OpenYabby are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
