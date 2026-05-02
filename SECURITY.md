# Security Policy

## Supported versions

OpenYabby is in early development. Only the latest minor on `main` receives fixes.

| Version | Supported |
|---|---|
| `0.1.x` | Yes |
| `< 0.1` | No |

Once `1.0.0` ships, this table will list the supported branches.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Use GitHub's private advisory form:
**https://github.com/OpenYabby/OpenYabby/security/advisories/new**

Or email `idov.mamane@gmail.com` with the subject line `OpenYabby security report`.

Please include:

- A description of the issue and the impact
- Steps to reproduce (a minimal proof-of-concept is ideal)
- The commit SHA or release tag where you observed it
- Your suggested remediation, if you have one

You can expect:

- An acknowledgement within 72 hours
- An initial assessment and severity rating within 7 days
- Coordinated disclosure: we'll agree on a fix-and-publish timeline before any public discussion
- Credit in the release notes (or anonymity, if you prefer)

## Scope

OpenYabby executes real local commands on the host machine through CLI runners (Claude Code, Codex, Aider, Goose, Cline, Continue). The threat model assumes:

- The operator trusts the runner binary they have installed
- The operator trusts the LLM provider they have configured
- Connector credentials are encrypted at rest with AES-256-GCM (see [lib/crypto.js](lib/crypto.js))
- The relay tunnel (`relay.openyabby.com`) is opt-in and authenticated via `RELAY_SECRET`

In scope:

- Authentication and authorization bypasses
- Credential leakage from the connector store, logs, or process memory
- Remote code execution via crafted channel messages, voice tool calls, or webhooks
- Path traversal or arbitrary file write outside the project sandbox
- SQL injection in any DB query
- Cross-site scripting in the SPA
- WebRTC / Realtime session hijacking
- Tunnel proxy abuse leading to access on unintended hosts

Out of scope:

- Denial-of-service against a self-hosted instance
- Issues that require an already-compromised host
- Vulnerabilities in third-party services (OpenAI, Discord, Slack, etc.) — please report those upstream
- Social engineering of the operator
- Findings against the optional WhatsApp adapter that originate in `@whiskeysockets/baileys` itself (report upstream)

## Known advisories (v0.1.0)

OpenYabby ships with a few transitive vulnerabilities from upstream packages. None are exploitable in the default configuration, but you should be aware of them:

- **`protobufjs` prototype pollution (critical)** — pulled in via `@whiskeysockets/baileys` → `@whiskeysockets/libsignal-node`. Affects only the optional WhatsApp adapter. Tracking upstream fix.
- **`path-to-regexp` ReDoS (high)** — pulled in via Express. Mitigated by the fact that Yabby does not expose route params to untrusted input in any current handler.
- **`picomatch` ReDoS via extglob quantifiers (critical)** — pulled in transitively via several dev/build tooling chains. Not in any request-handling path; cannot be triggered by a remote attacker.
- Several **moderate** advisories in `axios`, `follow-redirects`, `hono`, `langsmith`, `mem0ai`, `uuid`. Reviewed; none currently exploitable in Yabby's usage patterns.

Run `npm audit` for the live picture. We'll bump these as upstream patches land.

## Hardening tips for operators

- Set `YABBY_AUTH_ENABLED=true` and a strong `YABBY_AUTH_PASSWORD` if you expose Yabby beyond `localhost`.
- Set `DISABLE_TUNNEL=true` if you don't need remote access.
- Rotate `OPENAI_API_KEY` and any connector credentials if you suspect exposure.
- Keep your CLI runner up to date — runners can execute arbitrary local commands.
- Run as a non-admin user; never as root.
