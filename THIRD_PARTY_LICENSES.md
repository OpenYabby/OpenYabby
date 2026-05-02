# License Analysis

OpenYabby is licensed under the [MIT License](LICENSE) and ships with one optional GPL-3.0 transitive dependency that only becomes relevant if you redistribute the WhatsApp adapter.

This file enumerates the licenses of every direct production dependency and flags every non-permissive license found anywhere in the resolved transitive tree. Generated with `npx license-checker --production` against the committed `package-lock.json`.

> **TL;DR for redistributors:**
> - All 34 direct production dependencies are MIT, Apache-2.0, or BSD-family permissive licenses.
> - The full transitive tree contains **one GPL-3.0 package** (`@whiskeysockets/libsignal-node`) which is pulled in by `@whiskeysockets/baileys` (the WhatsApp adapter).
> - **If you redistribute OpenYabby with WhatsApp support enabled, you must comply with GPL-3.0 for that one component** (provide source, propagate the GPL on the work that incorporates it). If you do not enable or ship the WhatsApp adapter, GPL-3.0 does not apply.
> - All other non-MIT licenses found in the transitive tree are permissive (BlueOak-1.0.0, 0BSD, WTFPL-as-an-option, Apache-2.0, BSD).

Last reviewed: 2026-04-29.

---

## Summary across the full transitive tree (production)

| License | Count |
|---|---|
| MIT | 355 |
| Apache-2.0 | 29 |
| BSD-3-Clause | 18 |
| ISC | 14 |
| BSD-2-Clause | 12 |
| MIT OR Apache-2.0 | 1 |
| Apache* (treated as Apache-2.0) | 1 |
| **GPL-3.0** | **1** |
| (MIT OR WTFPL) | 1 |
| BlueOak-1.0.0 | 1 |
| (BSD-2-Clause OR MIT OR Apache-2.0) | 1 |
| 0BSD | 1 |

---

## Non-MIT/Apache/BSD/ISC packages (full audit of unusual licenses)

| Package | License | How it enters the tree | Status |
|---|---|---|---|
| `@whiskeysockets/libsignal-node@2.0.1` | **GPL-3.0** | Transitive of `@whiskeysockets/baileys` (WhatsApp adapter only) | **Copyleft. Optional. See below.** |
| `@mistralai/mistralai@1.15.1` | `Apache*` | Direct dep (Mistral provider) | Treated as Apache-2.0; the `*` is a packaging quirk in Mistral's SDK. Permissive. |
| `expand-template@2.0.3` | `(MIT OR WTFPL)` | Transitive build tooling | Dual-licensed; MIT applies. Permissive. |
| `lru-cache@11.2.7` | `BlueOak-1.0.0` | Transitive | Permissive ([Blue Oak Council Model License 1.0.0](https://blueoakcouncil.org/license/1.0.0)). Compatible with MIT redistribution. |
| `tslib@2.8.1` | `0BSD` | Transitive (TypeScript runtime helpers) | Public-domain-equivalent. Permissive. |

---

## Direct production dependencies (34)

| Package | License |
|---|---|
| `@anthropic-ai/sdk` | MIT |
| `@azure/identity` | MIT |
| `@azure/search-documents` | MIT |
| `@cloudflare/workers-types` | MIT OR Apache-2.0 |
| `@google/genai` | Apache-2.0 |
| `@langchain/core` | MIT |
| `@mistralai/mistralai` | Apache* |
| `@modelcontextprotocol/sdk` | MIT |
| `@napi-rs/canvas` | MIT |
| `@qdrant/js-client-rest` | Apache-2.0 |
| `@slack/bolt` | MIT |
| `@supabase/supabase-js` | MIT |
| `@whiskeysockets/baileys` | MIT (but pulls in libsignal-node, GPL-3.0) |
| `better-sqlite3` | MIT |
| `cloudflare` | Apache-2.0 |
| `cors` | MIT |
| `cron-parser` | MIT |
| `discord.js` | Apache-2.0 |
| `dotenv` | BSD-2-Clause |
| `express` | MIT |
| `grammy` | MIT |
| `groq-sdk` | Apache-2.0 |
| `link-preview-js` | MIT |
| `mem0ai` | Apache-2.0 |
| `mime-types` | MIT |
| `multer` | MIT |
| `neo4j-driver` | Apache-2.0 |
| `ollama` | MIT |
| `pdfjs-dist` | Apache-2.0 |
| `pg` | MIT |
| `pino` | MIT |
| `redis` | MIT |
| `ws` | MIT |
| `zod` | MIT |

Dev dependencies (`@playwright/test`, `concurrently`, `vitest`) are not redistributed with the application and are excluded from the production audit. All three are MIT.

---

## The GPL-3.0 case in detail

`@whiskeysockets/libsignal-node` is a Node port of the Signal Protocol. It is **GPL-3.0 by upstream choice** (Open Whisper Systems' historical licensing). It is pulled in by `@whiskeysockets/baileys`, which OpenYabby uses only for the optional WhatsApp adapter (`lib/channels/whatsapp*.js`).

Two scenarios:

### 1. You run OpenYabby for yourself (use, not redistribution)

GPL-3.0 obligations are triggered by **distribution**, not by use. Running OpenYabby on your own machine — even commercially — does not trigger any GPL obligation on the rest of the codebase. No action required.

### 2. You redistribute OpenYabby with the WhatsApp adapter enabled

If you build, fork, or repackage OpenYabby and ship it to others **with the WhatsApp channel included**, the combined work must comply with GPL-3.0:

- Provide the complete corresponding source of `libsignal-node` (already public).
- Make it clear which component is GPL-3.0.
- The aggregate work that links `libsignal-node` is generally considered a "modified version" under GPL-3.0 §5 — the conservative reading is that the redistributed bundle as a whole is GPL-3.0.

**Mitigation:** the WhatsApp adapter is opt-in. If you remove `lib/channels/whatsapp*.js` and drop `@whiskeysockets/baileys` from `package.json` before redistribution, the GPL-3.0 component is not in your tree, and OpenYabby remains pure MIT. The other channel adapters (Discord, Slack, Telegram, Signal) are unaffected.

This is also called out in [LICENSE](LICENSE) itself.

---

## Reproducing this analysis

```bash
# Full transitive tree, production deps only
npx license-checker --production --summary

# Find every non-permissive license
npx license-checker --production --json | \
  jq -r 'to_entries[] | select(.value.licenses | test("GPL|LGPL|MPL|EPL"))'

# Direct deps only
node -e '
  const p = require("./package.json");
  console.log([...Object.keys(p.dependencies||{}), ...Object.keys(p.devDependencies||{})].join("\n"));
'
```

If you add a new dependency, please re-run the checker and update this file in the same PR.
