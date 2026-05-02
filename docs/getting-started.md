# Getting Started with OpenYabby

This guide walks you through your first 30 minutes with OpenYabby — from a fresh clone to a working multi-agent project.

If you already followed the [README quick-start](../README.md#quick-start), skip to [First voice session](#first-voice-session).

---

## 1. Prerequisites

| Requirement | Why |
|---|---|
| Node 20+ | ESM, modern V8 |
| PostgreSQL 14+ (database `yabby`) | Source of truth for all state |
| Redis 6+ (`localhost:6379`) | Live status cache + pub/sub |
| Claude CLI (`npm i -g @anthropic-ai/claude-code`) | Default task runner |
| OpenAI API key | Voice (Realtime API) + Whisper + Mem0 |
| Modern Chromium browser | WebRTC voice |
| macOS 13+ | Runners use AppleScript / GUI automation |

A working microphone is required for voice. Web chat alone works without one.

---

## 2. One-shot setup

```bash
git clone https://github.com/OpenYabby/OpenYabby.git
cd OpenYabby
./setup.sh                # auto-detects Docker vs. local Postgres+Redis
```

`setup.sh` will:

1. Verify Node, npm, and the Claude CLI are present.
2. Run `npm install`.
3. Bring up Postgres + Redis (Docker by default; pass `local` to skip).
4. Prompt for your `OPENAI_API_KEY` and write a `.env`.
5. Run all migrations (idempotent).
6. Launch the server on `:3000`.

Open `http://localhost:3000` and you should see the Yabby SPA.

---

## 3. First voice session

1. Click the microphone permission prompt and allow it.
2. Say **"Yabby"** clearly. The wake-word detector listens via Silero VAD locally and validates with OpenAI Whisper. You'll hear an acknowledgement tone.
3. Try one of these:
   - *"Introduce yourself and explain how you work."*
   - *"Create a project plan for a startup landing page."*
   - *"Build a simple HTML landing page for a bakery."*
   - *"Remember that I prefer TypeScript and short commit messages."*

Yabby will respond in real time over WebRTC. While it's "thinking", watch the activity panel — you'll see tool calls stream in (function-calling decisions, memory writes, agent spawns).

If wake-word detection feels flaky in a noisy room, enable the optional speaker-verification microservice — see [§7](#7-optional-speaker-verification).

---

## 4. Creating your first project

Say something like:

> *"Create a new project called Acme Landing. Plan it out, then build it."*

Behind the scenes:

1. Yabby creates a `projects` row + a sandbox at `~/Desktop/Yabby Projects/acme-landing-{id}/` (initialized with `git init`, `src/`, `docs/`, `README.md`).
2. It auto-creates a **lead agent** (random human first name from [lib/lead-names.js](../lib/lead-names.js)) with the lead prompt.
3. The lead enters the **discovery** phase — it may ask you discovery questions via voice, modal, or a connector form ([lib/question-processor.js](../lib/question-processor.js)).
4. Once discovery completes, the lead submits a **plan for your approval**. A modal appears in the SPA.
5. You **Approve / Revise / Cancel**.
6. Approved plans trigger the **execution** phase — sub-agents are spawned, tasks run in the sandbox, the lead reviews, and the work is reported back.

Each phase emits SSE events you can watch in the Activity tab.

---

## 5. The five phases

| Phase | Who | What |
|---|---|---|
| Discovery | Lead | Asks clarifying questions until enough context exists to plan |
| Planning | Lead | Drafts a plan, submits for human approval |
| Execution | Sub-agents | Run tasks via the configured CLI runner (Claude Code by default) |
| Review | Manager / Lead | Auto-triggered after sub-agent completion (5s debounce) |
| QA | Lead | Final pass before declaring the project done |

See [docs/architecture.md](architecture.md) for the prompt structure and SSE event flow.

---

## 6. Watching what's happening

Three windows you'll keep open:

- **The SPA** (`http://localhost:3000`) — Activity tab shows every tool call, every agent spawn, every plan review.
- **Server logs** — the `npm start` terminal. Every spawn, completion, and orchestrator decision is logged here.
- **`logs/`** — per-task structured logs. `logs/{taskId}-activity.log` is the human-readable timeline; `logs/{taskId}-raw.log` is the runner's raw stdout.

---

## 7. Optional: speaker verification

Reduces wake-word false positives by ~90% in multi-person rooms via a Python microservice (SpeechBrain ECAPA-TDNN).

```bash
npm run speaker          # starts the service on :3001
# Then enroll your voice via the SPA settings panel (3+ samples)
```

If the service is offline, voice still works — wake-word validation is fail-open.

---

## 8. Optional: connect a channel

Channels let you talk to Yabby (and individual agents) from Discord, Slack, Telegram, WhatsApp, or Signal.

1. Open Settings → Channels.
2. Pick a platform. Yabby gives you setup instructions ([docs/channels-setup.md](channels-setup.md)).
3. Paste your bot token (encrypted at rest with AES-256-GCM via [lib/crypto.js](../lib/crypto.js)).
4. **Pair the channel** — first time only, you must paste the pairing code from the SPA into the channel. Until paired, the channel rejects all messages except the pairing code (see [migration 034](../db/migrations/034_channel_pairings.js)).

---

## 9. Where to go next

- [docs/architecture.md](architecture.md) — how the voice pipeline, agent hierarchy, and orchestrator fit together
- [docs/runners.md](runners.md) — pick a different CLI runner (Codex, Aider, Goose, Cline, Continue)
- [docs/connectors.md](connectors.md) — the 37 connectors and how to wire them up
- [docs/plugins.md](plugins.md) — extend Yabby with your own plugins
- [docs/troubleshooting.md](troubleshooting.md) — when things go wrong
- [CONTRIBUTING.md](../CONTRIBUTING.md) — adding a migration, connector, runner, or channel
