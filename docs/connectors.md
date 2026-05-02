# Connectors

OpenYabby ships with 37 connectors out of the box, organized in [lib/connectors/catalog.js](../lib/connectors/catalog.js). They give Yabby (and every spawned agent) tools to talk to external systems — search the web, file a Linear ticket, create a GitHub PR, query Postgres, render a Figma frame, etc.

Two backends are supported transparently:

| Backend | When to use | Tool prefix |
|---|---|---|
| **Built-in** (JS class) | When you need fine control or the official SDK is small enough to embed | `conn_{catalogId}_{tool}` |
| **MCP** (separate process) | When the upstream already publishes a Model Context Protocol server | `mcp_{server}_{tool}` |

Built-in vs. MCP is a maintainer choice per connector — users don't see the difference; the tools just appear in the registry.

---

## The catalog

### Code, issues, PRs

| Connector | Auth | Notes |
|---|---|---|
| `github` | Personal access token | Issues, PRs, repos, files |
| `linear` | API key | Issue tracker |
| `sentry` | DSN + token | Error monitoring lookups |
| `git` | None (local) | Operates on the project sandbox |
| `jira` | Email + API token | Atlassian Cloud |
| `confluence` | Email + API token | Atlassian Cloud |
| `trello` | API key + token | Boards, cards |
| `todoist` | API token | Tasks |

### Communication

| Connector | Auth | Notes |
|---|---|---|
| `slack` | Bot token | First-party Slack API |
| `slack-mcp` | OAuth | MCP-based Slack |
| `gmail` | OAuth | Read/send/search via Google API |
| `google-calendar` | OAuth | Events, free/busy |
| `outlook-mail` | OAuth (Azure) | Microsoft 365 |
| `discord` | Bot token | Channels, DMs |
| `telegram` | Bot token | Chats |

### Knowledge / docs

| Connector | Auth | Notes |
|---|---|---|
| `notion` | Integration token | Pages, databases |
| `figma` | Personal access token | Frames, comments |
| `google-drive` | OAuth | Files, folders |

### Databases

| Connector | Auth | Notes |
|---|---|---|
| `postgres` | Connection string | Query execution, schema introspection |
| `mongodb` | URI | Collections, aggregations |
| `mysql` | Connection string | — |
| `supabase` | Project URL + service role key | Tables + auth admin |

### Browser / web

| Connector | Auth | Notes |
|---|---|---|
| `filesystem` | None | Whitelisted directories only |
| `brave-search` | API key | Web search |
| `web-fetch` | None | URL → markdown |
| `puppeteer` | None | Local Chromium |
| `playwright` | None | Local Chromium (headless or headed) |
| `chrome-devtools` | None | DevTools Protocol |
| `youtube-transcript` | None | Caption extraction |

### Maps / multimedia

| Connector | Auth | Notes |
|---|---|---|
| `google-maps` | API key | Geocoding, directions |
| `everart` | API key | Image generation |

### Reasoning helpers

| Connector | Auth | Notes |
|---|---|---|
| `memory` | None | Local key/value scratchpad for the agent |
| `sequential-thinking` | None | Step-by-step reasoning scaffold |

### Business tools

| Connector | Auth | Notes |
|---|---|---|
| `stripe` | Secret key | Customers, charges, subscriptions |
| `hubspot` | Private app token | CRM |
| `salesforce` | OAuth | CRM |
| `datadog` | API key + app key | Metrics, logs, monitors |

---

## Connecting a connector

1. Open the SPA → Settings → Connectors.
2. Pick a connector. Yabby renders a credential form generated from the connector's Zod auth schema.
3. Paste your credentials. Yabby tests them via the connector's `testCredentials()` method before saving.
4. Credentials are encrypted at rest (AES-256-GCM via [lib/crypto.js](../lib/crypto.js)) and stored in `connectors.credentials_encrypted` JSONB.
5. Choose **global** vs. **project-scoped**:
   - **Global** connectors are available to every agent.
   - **Project-scoped** connectors only appear in tasks for that project.

Once connected, the connector's tools immediately show up in the voice tool registry and in every newly-spawned task's `.mcp.json` (for MCP connectors).

---

## Tool naming

Three prefixes prevent collision in the shared registry:

- `conn_{catalogId}_{toolName}` — built-in connector tool
- `mcp_{serverName}_{toolName}` — MCP connector tool
- `{pluginName}_{toolName}` — plugin tool

Example: GitHub's `create_issue` becomes either `conn_github_create_issue` (built-in) or `mcp_github_create_issue` (if you swap to the MCP backend).

---

## Requesting a new connector

Open a [feature request](https://github.com/OpenYabby/OpenYabby/issues/new?template=feature_request.yml) and tell us:

- Which service / API
- Which auth flow (OAuth, API key, basic auth, ...)
- Whether you'd contribute the implementation

If the upstream already publishes an MCP server, the easiest path is to **add it as an MCP connector** (no code in `lib/connectors/builtins/` needed — just a catalog entry).

For a built-in implementation, see [CONTRIBUTING.md → Adding a connector](../CONTRIBUTING.md#adding-a-connector).
