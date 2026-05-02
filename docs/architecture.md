# Architecture

This is the user-facing tour of how OpenYabby is put together. For the deep internal map (every key file, every migration, every Redis key convention), read [CLAUDE.md](../CLAUDE.md) — it's the AI-assistant briefing and it covers everything.

---

## The big picture

<p align="center">
  <img src="../assets/architecture.svg" alt="OpenYabby architecture" width="900">
</p>

Three concurrent loops talk to each other:

1. **Voice loop** — Browser ↔ OpenAI Realtime API over WebRTC. Tools dispatched client-side, results sent back via DataChannel.
2. **Agent loop** — CLI runners spawned as child processes. Output parsed into structured activity logs. Inter-agent messaging on Redis pub/sub.
3. **Channel loop** — Discord / Slack / Telegram / WhatsApp / Signal adapters share the same LLM function-calling tools as voice.

Everything writes to Postgres (source of truth) and caches in Redis (24h TTL).

---

## Voice pipeline

```
Browser ──SDP offer──▶ POST /session ──▶ OpenAI Realtime API
   ▲                                              │
   │              SDP answer                      │
   │◀─────────────────────────────────────────────┘
   │
   └─── WebRTC bidirectional audio + DataChannel
              │
              ├── audio frames (24kHz PCM)
              └── tool calls (JSON) ──▶ public/js/voice.js
                                              │
                                              └─▶ HTTP fetch to backend
                                                       │
                                                       └─▶ tool result via DataChannel
```

The backend never proxies audio — only the SDP exchange. All tool dispatch happens **client-side** in [public/js/voice.js](../public/js/voice.js); each tool call becomes an HTTP fetch to the backend, and the result is sent back to OpenAI through the same DataChannel.

Wake word is detected client-side (Silero VAD ONNX model) and validated server-side by Whisper transcription with a regex match on `Yabby` / `Jabby` variants.

---

## Agent hierarchy

Three tiers, distinguished by flags on the `agents` row:

| Flag combination | Role | Prompt builder | Workflow |
|---|---|---|---|
| `is_lead=true` | **Lead** | `buildLeadAgentPrompt()` | 5 phases: discovery → planning → execution → review → QA |
| `is_manager=true` + `parent_agent_id` | **Manager** | `buildManagerAgentPrompt()` | 3 phases: plan + create agents → review → report |
| `parent_agent_id` only | **Sub-agent** | `buildSubAgentPrompt()` | Executes a task, sends `task_complete` to parent |

All three share the same base prompt ([lib/prompts.js](../lib/prompts.js) `getBasePrompt()`) covering Mac autonomy rules, GUI lock conventions, and the web-interaction hierarchy (JS DOM → Playwright → Accessibility API → OCR).

Language is injected dynamically from config via [lib/i18n.js](../lib/i18n.js) — prompts are authored in English with an `agentLang` directive telling the LLM which language to respond in.

---

## Task execution

Each task is a CLI process spawned by [lib/spawner.js](../lib/spawner.js):

```
claude -p --dangerously-skip-permissions \
       --verbose --output-format stream-json \
       --session-id {uuid} \
       --system-prompt {prompt} \
       {task}
```

Output parsing is runner-specific via [lib/runner-profiles.js](../lib/runner-profiles.js). Each profile defines:

- `buildArgs()` — the argv to spawn
- `parseStdoutLine()` — converts a line into `{ type, content, tool, ... }`
- `capabilities` — what the runner supports (resume, stream-json, etc.)

The spawner auto-generates a `.mcp.json` in the task CWD so MCP-backed connectors work transparently.

---

## Multi-agent task cascades

[lib/multi-agent-orchestrator.js](../lib/multi-agent-orchestrator.js) + [lib/agent-task-processor.js](../lib/agent-task-processor.js) implement position-based cascades:

```
Position 0:  [task A] [task B] [task C]   ← run in parallel
Position 1:  [task D]                     ← waits for 0 to finish
Position 2:  [task E] [task F]            ← waits for 1 to finish
```

Tasks at the same `position` run in parallel; the next position waits until **all** tasks at the current position complete.

The completion signal is delivered by an in-memory one-shot bus ([lib/task-completion-bus.js](../lib/task-completion-bus.js)) — the spawner exit handler publishes, the processor subscribes. This replaces an older DB-polling approach that timed out after 10 minutes.

On error, the cascade can `stop` or `continue` per the row's `on_error` policy.

---

## Plan review and discovery flow

The lead agent submits structured plans for human approval:

```
Lead agent ──POST /api/plan-reviews──▶ Postgres
     │
     └── on task exit ──▶ SSE plan_review event
                                │
                                └─▶ Frontend modal
                                       │
                                       ├── Approve   ──▶ spawn task with [PLAN APPROUVÉ]
                                       ├── Revise    ──▶ spawn task with [PLAN À RÉVISER] + feedback
                                       └── Cancel    ──▶ archive entire project
```

The submission and emission are decoupled: the row is created with `pending_emission=TRUE` ([migration 041](../db/migrations/041_plan_review_pending_emission.js)) and the modal/voice notification fires only when the submitting CLI task actually exits — eliminating a doubled "plan submitted, then task done" notification.

Discovery questions work the same way: lead posts questions → SSE → modal (voice / modal / connector form types) → answers forwarded with `[RÉPONSE]` or `[DÉCOUVERTE TERMINÉE]`.

---

## Persistent memory

Mem0 extracts facts every 6 turns using `gpt-5-mini` (pinned — see [Troubleshooting](troubleshooting.md#dont-change-the-mem0-model-to-nano)). Stored in Qdrant (file-based, `memory.db`) plus SQLite. Profile injected into the voice session instructions on connect/resume.

Hybrid search ([lib/memory-advanced.js](../lib/memory-advanced.js)) combines vector + keyword retrieval with temporal decay and query expansion.

---

## Database layer

**Dual-write pattern**: Postgres is the source of truth, Redis is the live status cache (24h TTL).

```js
// Write
await Promise.all([
  query("UPDATE tasks SET status=$1 WHERE id=$2", [status, id]),
  redis.set(KEY("task", id, "status"), status, { EX: 86400 }),
]);

// Read
let status = await redis.get(KEY("task", id, "status"));
if (!status) {
  const r = await query("SELECT status FROM tasks WHERE id=$1", [id]);
  status = r.rows[0]?.status;
  if (status) await redis.set(KEY("task", id, "status"), status, { EX: 86400 });
}
```

Redis key convention: `yabby:{entity}:{id}:{field}` via the `KEY()` helper in [db/redis.js](../db/redis.js).

Special keys:

- `yabby:gui_lock` — Hash with `task_id` + `since`, 5-minute TTL, auto-expires on crash
- `yabby:config-change` — pub/sub channel for config hot-reload
- `yabby:agent-bus` — pub/sub channel for inter-agent messaging

---

## Real-time events

Two transports emit identical events from [lib/logger.js](../lib/logger.js):

- **SSE** — `GET /api/logs/stream` (used by the SPA)
- **WebSocket** — `/ws` (used for presence + typing indicators)

Event types: `task`, `heartbeat`, `speaker_notify`, `plan_review`, `project_question`, `preview`, `conversation_update`, `system_update`.

Notifications are also injected into the WebRTC DataChannel as system messages so the voice agent announces them.

---

## Channels

Adapter pattern — every channel subclasses `ChannelAdapter` ([lib/channels/](../lib/channels/)). The handler ([lib/channels/handler.js](../lib/channels/handler.js)) runs the same LLM function-calling loop as voice (max 5 iterations) using a provider from [lib/providers/](../lib/providers/).

One owner per channel ([migration 034](../db/migrations/034_channel_pairings.js)) — unpaired channels reject all messages except the pairing code.

WhatsApp is the exception: it operates in an isolated auto-created group and pulls in a GPL-3.0 transitive — see [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md).

---

## Connectors

37 in the static catalog ([lib/connectors/catalog.js](../lib/connectors/catalog.js)). Two backends:

- **Built-in** — JS class extending `BuiltinConnector`. Tools prefixed `conn_{catalogId}_{tool}`.
- **MCP** — spawns an MCP server process via stdio. Tools bridged to OpenAI function-calling format and prefixed `mcp_{server}_{tool}`.

Credentials are encrypted at rest via AES-256-GCM ([lib/crypto.js](../lib/crypto.js)).

---

## Where to dig deeper

- [docs/runners.md](runners.md) — the six CLI runners and how to choose
- [docs/connectors.md](connectors.md) — the 37 connectors organized by category
- [docs/plugins.md](plugins.md) — plugin manifest and context API
- [CLAUDE.md](../CLAUDE.md) — every file, every migration, every pattern (long but exhaustive)
