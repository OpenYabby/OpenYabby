# Repository Guidelines

## Project Structure & Module Organization
- `server.js`: Express entrypoint, startup lifecycle, WebRTC/session wiring.
- `lib/`: Core runtime logic (spawner, orchestrators, providers, channels, plugins, MCP bridge).
- `routes/`: HTTP API surface (`/api/*`, task control, config, tools, channels).
- `db/`: PostgreSQL/Redis layer (`queries/`, `migrations/`, `migrate.js`).
- `public/`: Vanilla JS SPA (`public/js/components/*`, locales, CSS tokens/layout/components).
- `tests/`: Vitest unit tests (`*.test.js`) plus E2E and helper scripts.
- `speaker/` and `imagegen/`: Python sidecars started by npm scripts.

## Build, Test, and Development Commands
- `npm start`: run Node server (`server.js`) on port `3000`.
- `npm run dev`: start services + Node + speaker + imagegen concurrently.
- `npm run services`: ensure PostgreSQL/Redis are up locally.
- `npx vitest`: run unit tests in `tests/**/*.test.js`.
- `npm run test:e2e`: Playwright E2E suite.
- `npm run test:e2e:ui` / `:headed` / `:debug`: interactive E2E modes.
- `npm run cleanup`: kill orphan MCP/browser/CLI zombie processes.

## Coding Style & Naming Conventions
- JavaScript is ESM (`"type": "module"`), with semicolons and double quotes.
- Match existing formatting: 2-space indentation, small focused functions, explicit imports.
- File names are usually kebab-case (e.g. `task-completion-bus.js`); tests use `*.test.js`.
- DB migrations use numeric prefixes (`db/migrations/032_multi_agent_task_queue.js`).
- No lint/formatter is enforced; keep diffs minimal and consistent with nearby code.

## Testing Guidelines
- Prefer Vitest for unit/regression coverage around `lib/`, `routes/`, and `db/queries/` changes.
- Add/update Playwright tests for user-facing/API workflow changes.
- Name tests by behavior, not implementation details.
- Before opening a PR: run `npx vitest` and relevant `npm run test:e2e*` scope.

## Commit & Pull Request Guidelines
- Follow the observed Conventional Commit style: `feat(scope): ...`, `fix(scope): ...`, `chore(scope): ...`.
- Keep commits atomic (one change theme per commit).
- PRs should include: concise problem/solution summary, affected paths, migration/config changes, and test evidence.
- Include screenshots or short recordings for UI changes (`public/` components, onboarding/settings flows).

## Security & Configuration Tips
- Never commit secrets (`.env`, API keys, tokens, auth sessions).
- Validate `.env` changes against `.env.example` and document new variables in `README.md`.
- Treat task execution as high-trust: runners can execute local commands and access files.
