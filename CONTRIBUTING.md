# Contributing to OpenYabby

Thanks for your interest in making OpenYabby better. This guide covers everything you need to set up the project locally, run tests, and ship a clean PR — including recipes for the most common extension points (migrations, connectors, runners, channels, plugins).

If anything here is unclear or out of date, that itself is a great first PR.

---

## Code of conduct

By participating in this project you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).

For security issues, **do not open a public issue** — see [SECURITY.md](SECURITY.md) for private disclosure.

---

## Prerequisites

| Requirement | Version | Notes |
|---|---|---|
| Node.js | 20+ | Yabby uses ESM (`"type": "module"`) and modern V8 features |
| PostgreSQL | 14+ | Database name: `yabby` |
| Redis | 6+ | Default `redis://localhost:6379` |
| Claude CLI | latest | `npm i -g @anthropic-ai/claude-code` (or use a different runner — see [Adding a CLI runner](#adding-a-cli-runner)) |
| OpenAI API key | — | Realtime API access required for voice |
| macOS | 13+ | Linux/Windows support is on the [roadmap](README.md#roadmap) |

---

## Local setup

```bash
git clone https://github.com/OpenYabby/OpenYabby.git
cd OpenYabby
./setup.sh                # one-shot: prereqs check, npm install, PG+Redis, server
```

Or, if you already have Postgres + Redis running:

```bash
npm install
cp .env.example .env      # then fill in your OpenAI key
npm run dev               # Node + Speaker + ImageGen via concurrently
```

The setup script will prompt for your `OPENAI_API_KEY`. Other variables are documented in [.env.example](.env.example).

Migrations run automatically on startup — they're idempotent and listed explicitly in `server.js` `startup()`.

---

## Running tests

### Unit tests (Vitest)

```bash
npx vitest                          # watch mode
npx vitest run                      # single run, suitable for CI
npx vitest run tests/config.test.js # one file
```

Vitest mocks the PG pool and Redis client, so unit tests run with no real database. Config: [vitest.config.js](vitest.config.js).

### End-to-end tests (Playwright)

E2E tests require the dev server running on `:3000` (the `webServer` block in [playwright.config.js](playwright.config.js) is intentionally commented out).

```bash
npm start                           # in one terminal
npm run test:e2e                    # in another (headless)
npm run test:e2e:headed             # see the browser
npm run test:e2e:ui                 # Playwright UI mode
npm run test:e2e:debug              # step through
```

---

## Branch and commit style

- Base off `main`. Use a descriptive branch name: `feat/scheduler-cron-validation`, `fix/spawner-zombie-on-sigterm`.
- **Conventional commits** — match the existing `git log`:
  - `feat(scope): ...` — new user-facing capability
  - `fix(scope): ...` — bug fix
  - `docs: ...` — docs only
  - `chore(scope): ...` — tooling, deps, CI
  - `refactor(scope): ...` — no behavior change
  - `test(scope): ...` — test-only changes
- One logical change per commit. Squash-merge is the default on PRs.
- Don't bypass hooks (`--no-verify`) — fix the underlying issue.

---

## Adding a database migration

Migrations live in [db/migrations/](db/migrations/), numbered sequentially.

1. Pick the next number (latest at time of writing is `041_plan_review_pending_emission.js`).
2. Create `db/migrations/NNN_descriptive_name.js` exporting:
   - `MIGRATION` — the SQL string, **idempotent** (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, `ON CONFLICT DO NOTHING`, etc.)
   - `run` — `async function run() { await query(MIGRATION); }`
3. **Add the filename to the explicit array in `server.js` `startup()`** (search for the existing list around line 880). The loop does **not** auto-discover files — forgetting this is the #1 migration mistake. **Also add it to the same list in [db/migrate.js](db/migrate.js)** so CI and standalone runs stay in sync. (A future cleanup should extract this list to a shared module — PRs welcome.)
4. Verify locally: stop the server, drop the relevant tables/columns, restart, watch the migration log line.

Migrations should never destroy user data; prefer additive changes (new columns nullable, then backfill, then enforce).

---

## Adding a connector

Connectors live in [lib/connectors/](lib/connectors/) and are registered in [lib/connectors/catalog.js](lib/connectors/catalog.js).

Two backends:

- **Built-in** — JS class extending `BuiltinConnector`. Implement `connect()`, `disconnect()`, `testCredentials()`, and one method per tool. Tools auto-prefixed `conn_{catalogId}_{tool}`.
- **MCP** — declare an MCP server `command` + `args` + `env` in the catalog entry. The MCP bridge ([lib/mcp/bridge.js](lib/mcp/bridge.js)) discovers the server's tools and registers them as `mcp_{server}_{tool}`.

Steps:

1. Add a catalog entry with `id`, `name`, `description`, `auth` schema (Zod), `helpText`, and either a `Connector` class reference or an `mcp` block.
2. Built-in: implement the class in `lib/connectors/builtins/{id}.js`.
3. Run the connector lifecycle locally and confirm tools show up in the registry — `console.log` from `getAllTools()` in [lib/plugins/tool-registry.js](lib/plugins/tool-registry.js).

Credentials are encrypted at rest via [lib/crypto.js](lib/crypto.js) — never log them.

---

## Adding a CLI runner

Runners live in [lib/runner-profiles.js](lib/runner-profiles.js).

Each profile declares:

- `id`, `name`, `cmd` (binary), `installHint`
- `buildArgs({ taskId, sessionId, systemPrompt, instruction, runnerThreadId })` — produces the `argv` array
- `parseStdoutLine(line)` — converts a runner-emitted line into the structured activity-log shape Yabby expects (`{ type, content, tool, ... }`)
- `capabilities` — `{ supportsResume, supportsStreamJson, ... }`

Some runners (e.g. Codex) emit a different session/thread id than the one Yabby asks for. Persist that in `tasks.runner_id` + `tasks.runner_thread_id` ([migration 035](db/migrations/035_runner_session_parity.js)) and `agents.runner_sessions` ([migration 036](db/migrations/036_agent_runner_sessions.js)) so resume works correctly.

---

## Adding a channel

Channels live in [lib/channels/](lib/channels/). Each adapter subclasses `ChannelAdapter` and implements `connect()`, `disconnect()`, `sendMessage()`, and the platform-specific event loop that calls back into [lib/channels/handler.js](lib/channels/handler.js) with a `NormalizedMessage`.

1. Implement `lib/channels/{name}.js`.
2. Register a lazy factory in [lib/channels/index.js](lib/channels/index.js).
3. Add normalization for the platform's message shape in [lib/channels/normalize.js](lib/channels/normalize.js).
4. Channel pairing — unpaired channels reject all messages except a one-time pairing code (see [migration 034](db/migrations/034_channel_pairings.js)).

The handler runs the same LLM function-calling loop that voice uses, with all tools available.

---

## Adding a plugin

Plugins live in `plugins/` (one folder per plugin).

- `plugin.json` — manifest (`name`, `version`, `description`)
- `index.js` — exports `init(context)` where `context` provides:
  - `context.config.get(key)` — read config
  - `context.logger` — scoped logger
  - `context.registerTool(def)` — auto-prefixed with the plugin name
  - `context.events` — pub/sub event bus
  - `context.registerRoute(method, path, handler)` — mounts under `/api/plugins/{name}`

See existing plugins for examples of the manifest + init shape.

---

## Coding conventions

- ES modules with `.js` extensions in imports
- Soft-delete: never `DELETE` rows — set `status = 'archived'`. All queries filter on it.
- Dual-write cache pattern: `Promise.all([query(...), redis.set(KEY(...), value, { EX: 86400 })])`. Read: Redis first, fallback to PG, re-cache.
- Redis keys: `yabby:{entity}:{id}:{field}` via the `KEY()` helper in [db/redis.js](db/redis.js).
- Locale: prompts are authored in English and the LLM is instructed to respond in the user's language via the `agentLang` directive ([lib/i18n.js](lib/i18n.js)). Only `SERVER_MESSAGES` (channel UI strings) are localized.
- No build step for the frontend — vanilla JS in [public/](public/), no bundler.

---

## Submitting a PR

1. Fork the repo and push your branch.
2. Open a PR against `main`. The [PR template](.github/pull_request_template.md) will guide you through the checklist.
3. CI runs `npx vitest run` on Node 20 + 22. Make sure it's green.
4. A maintainer will review. Expect comments — most PRs go through one round.
5. We squash-merge with the PR title as the commit subject; keep it Conventional-Commits-shaped.

---

## Things to avoid

- Committing `.env`, `memory.db`, anything in `logs/`, or `data/`. The [.gitignore](.gitignore) covers these — don't `git add -f` past it.
- Adding new top-level files at the repo root unless they're standard (LICENSE, README, etc.). Prefer [docs/](docs/) for guides.
- Bypassing the test suite. If a test is wrong, fix or delete it in the same PR.
- Hard-coding personal paths or hostnames. Read from config or env.

---

## Asking questions

- **Discussions**: https://github.com/OpenYabby/OpenYabby/discussions — the right place for "how do I…" and "would you accept a PR for…"
- **Issues**: bugs and concrete feature requests, using the templates.
- **Security**: privately via the [Security Advisory form](https://github.com/OpenYabby/OpenYabby/security/advisories/new).

Thanks for contributing.
