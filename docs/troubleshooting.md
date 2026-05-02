# Troubleshooting

When OpenYabby misbehaves, this is the place to start. The README has a [shorter version](../README.md#troubleshooting) of the most common cases.

If your issue isn't covered here, open a [bug report](https://github.com/OpenYabby/OpenYabby/issues/new?template=bug_report.yml) with the relevant logs (redact secrets first).

---

## Startup and infrastructure

### `EADDRINUSE: port 3000 already in use`

A previous Node process is still bound to port 3000.

```bash
lsof -ti :3000 | xargs kill 2>/dev/null
sleep 1
npm start
```

### `ECONNREFUSED 127.0.0.1:5432` (Postgres)

Postgres isn't running, or your `.env` points to the wrong host/port.

```bash
./setup.sh docker            # start PG+Redis via Docker Compose
# or
brew services start postgresql@14
psql -h localhost -U postgres -l   # confirm the 'yabby' database exists
```

If the `yabby` database is missing:

```bash
createdb -h localhost -U postgres yabby
```

### `ECONNREFUSED 127.0.0.1:6379` (Redis)

```bash
./setup.sh docker            # or
brew services start redis
redis-cli ping               # should print PONG
```

### Migrations fail at startup

Migrations are idempotent and listed explicitly in `server.js` `startup()`. If one fails:

1. Read the actual error — usually a missing column reference or a unique-constraint violation from earlier dirty state.
2. Check that the failing migration is in the explicit list (latest is `041_plan_review_pending_emission.js`).
3. If state is corrupt and you don't mind losing data: `npm run reset` (full fresh-start, preserves onboarding).

### Server crashes with V8 heap warnings or `FATAL ERROR: Reached heap limit`

[lib/heap-monitor.js](../lib/heap-monitor.js) requires `--expose-gc` to free memory under pressure. **Always launch via `npm start`** (which passes `--max-old-space-size=8192 --expose-gc`). Never run `node server.js` directly.

---

## Voice and wake-word

### Wake word never triggers

1. **Mic permission** — open browser site permissions, confirm microphone is allowed.
2. **Speaker service** — if you enrolled a voice but the service is off, every wake-word check fails closed in the UI even though the backend fail-opens. Either start it (`npm run speaker`) or clear enrollment via the API:
   ```bash
   curl -X DELETE http://localhost:3000/api/speaker/enroll
   ```
3. **Audio chunk too small** — the wake-word endpoint requires ≥2KB of audio. If your VAD is cutting too aggressively, you'll see `audio too small` in server logs.
4. **Language** — Whisper is configured for French by default with regex fallback `/\byab+[iy]e?\b/i` (also `jab+iy`). Mispronunciations like "Yabbie" / "Jabbi" are fine; "Yappy" or "Yummy" are not.

### Voice cuts out or feels laggy

- Test in Chrome on the same network as the server.
- Check `chrome://webrtc-internals` for ICE failures — if you see `disconnected`, you have a NAT/firewall issue.
- The 10-minute inactivity timeout suspends the session; that's by design.
- If you see frequent SDP renegotiation, your network is dropping UDP packets.

### Voice client filters too many of my words

[public/js/voice.js](../public/js/voice.js) ships 44 regex patterns that block low-value utterances ("ok", "oui", "mmh", etc.). These are deliberately tuned for French + English ambient noise. Tune the array if your use case differs.

---

## Tasks and runners

### `Claude CLI not found` in spawner logs

```bash
npm i -g @anthropic-ai/claude-code
which claude                 # should print a path
```

If you installed it under a different name (or want a specific version):

```bash
echo "CLAUDE_CMD=/full/path/to/claude" >> .env
```

### Tasks pause with status `paused_llm_limit`

The Claude CLI hit its daily quota. Yabby auto-resumes after the reset window — see [migration 024](../db/migrations/024_llm_limit_tasks.js) for the persisted resume metadata (`task_instruction`, `llm_limit_reset_at`, `paused_at`).

If you need to resume manually before the reset:

```bash
# Find the paused task
psql -h localhost -U postgres yabby -c \
  "SELECT id, status, paused_at, llm_limit_reset_at FROM tasks WHERE status='paused_llm_limit';"

# Or switch to a different runner that isn't quota-limited
# Edit your config: tasks.runnerId = 'codex' (or aider/goose/cline/continue)
```

### Task is stuck in a retry loop

[lib/retry-detector.js](../lib/retry-detector.js) scans the last 30 tool calls and detects repeated normalized commands. When triggered, the orchestrator intervenes. If you suspect a stuck loop that the detector missed, send the agent a corrective message via the agent inbox.

### Sub-agent finishes but the manager never reviews

[lib/orchestrator.js](../lib/orchestrator.js) listens on Redis `yabby:agent-bus` with a 5s debounce + 10s delayed re-check. Common causes:

1. The manager already has a running task — orchestrator skips to avoid duplicates.
2. Redis pub/sub lost a message (rare). The 10s delayed re-check usually catches it.
3. The sub-agent's `task_complete` message wasn't published. Check `agent_messages` table.

---

## Channels

### Channel rejects all my messages with "channel not paired"

[Migration 034](../db/migrations/034_channel_pairings.js) requires a one-time pairing code before any channel will respond. Look at the SPA Settings → Channels for the code, paste it into the channel as your first message, and you're paired.

### Discord/Slack bot is online but doesn't respond in groups

In groups the bot only replies when mentioned. DMs work without mention. Slash commands (`/status`, `/new`, `/reset`, `/help`) work in both.

### WhatsApp gives "GPL-3.0" warnings

That's intentional. The WhatsApp adapter pulls `@whiskeysockets/libsignal-node` which is GPL-3.0. See [THIRD_PARTY_LICENSES.md](../THIRD_PARTY_LICENSES.md) for redistribution implications.

---

## Memory and Mem0

### Memory profile is empty even after long sessions

Mem0 extracts facts every **6 turns** using `gpt-5-mini`. If your conversation is shorter, nothing has been extracted yet.

If init failed at startup (look for `Mem0 init failed` in server logs), Yabby retries after 60 seconds — usually a quota recovery issue.

### Memory has wrong information

```bash
curl -X DELETE http://localhost:3000/api/memory     # clears everything
# or use the UI: Settings → Memory → Clear
```

Then have Yabby re-learn during a fresh conversation.

### Don't change the Mem0 model to nano

The config schema has a comment pinning the extraction model to `gpt-5-mini` — `gpt-5-nano` consistently misses French names and short proper nouns. This is a real regression you'll hit if you "optimize" it.

---

## Tunnel

### Tunnel won't connect to `relay.openyabby.com`

The relay requires a `RELAY_SECRET`. Either request one from the maintainer or run your own relay. To silence the reconnect attempts:

```bash
echo "DISABLE_TUNNEL=true" >> .env
```

The app runs fine locally without it.

---

## Auth gateway

### I enabled auth and now the SPA shows a blank screen

The auth middleware exempts `/session`, `/api/wake-word`, and `/api/logs/stream` so voice keeps working, but the SPA's first load hits `/api/config` which is gated. Make sure you're sending the password header — re-login via `/login` if needed.

### I lost my password

```bash
# Reset auth from the env (overrides the password stored in the DB on next start)
echo "YABBY_AUTH_PASSWORD=newpassword" >> .env
echo "YABBY_AUTH_ENABLED=true" >> .env
npm start
```

---

## Filing a bug

Include:

- Output of `git rev-parse --short HEAD`
- The relevant lines from `logs/{taskId}-activity.log` and `logs/{taskId}-raw.log` (for task issues)
- Browser console + network tab (for voice/SPA issues)
- Server console output around the failure
- OS, Node version, and which runner you're using

**Always redact API keys, tokens, and personal info before pasting.**
