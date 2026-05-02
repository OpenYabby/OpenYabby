# Plugins

Plugins are the easiest way to extend OpenYabby without forking. Drop a folder in `plugins/`, declare what you provide, and Yabby loads it on the next startup.

Compared to connectors:

| | Plugin | Connector |
|---|---|---|
| Lives in | `plugins/{name}/` | `lib/connectors/catalog.js` + `lib/connectors/builtins/` |
| Use case | Custom logic, internal integrations, glue code | Talking to a well-known external service |
| Auth UI | You build it (or skip) | Auto-generated from a Zod schema |
| Process model | In-process with the Node server | In-process (built-in) or separate process (MCP) |
| HTTP routes | Yes (mounted under `/api/plugins/{name}`) | No |
| Hot reload | Restart server | Yes (credential change reloads automatically) |

If you're integrating with an external SaaS that has an SDK and credentials, write a connector. If you're building app-specific behavior, write a plugin.

---

## Anatomy of a plugin

```
plugins/
  my-plugin/
    plugin.json       # manifest
    index.js          # entry point — exports init(context)
    package.json      # optional — for plugin-local deps
    README.md         # optional
```

### `plugin.json`

```json
{
  "name": "my-plugin",
  "version": "0.1.0",
  "description": "What this plugin does, in one sentence.",
  "author": "Your name",
  "license": "MIT"
}
```

### `index.js`

```js
export async function init(context) {
  const { config, logger, registerTool, events, registerRoute } = context;

  // 1. Read config (your plugin can have its own keys under config.plugins.my-plugin)
  const apiKey = await config.get("plugins.my-plugin.apiKey");

  // 2. Register a tool — auto-prefixed with the plugin name
  registerTool({
    name: "do_thing",   // becomes "my-plugin_do_thing" in the registry
    description: "Does the thing.",
    parameters: {
      type: "object",
      properties: {
        input: { type: "string" }
      },
      required: ["input"]
    },
    async execute({ input }) {
      logger.info({ input }, "doing the thing");
      return { ok: true, echo: input };
    }
  });

  // 3. Subscribe to events
  events.on("task:complete", (event) => {
    logger.info({ taskId: event.taskId }, "saw a task complete");
  });

  // 4. Register an HTTP route (mounted at /api/plugins/my-plugin/...)
  registerRoute("get", "/health", (req, res) => {
    res.json({ ok: true });
  });

  logger.info("my-plugin loaded");
}
```

That's the entire surface area.

---

## The plugin context

What `init(context)` receives:

| Field | Type | Purpose |
|---|---|---|
| `config.get(key)` | function | Read a config key (fully namespaced — e.g., `plugins.my-plugin.foo`) |
| `logger` | pino logger | Scoped logger with the plugin name pre-set |
| `registerTool(def)` | function | Add a tool to the voice + channel + agent registry |
| `registerMcpTool(def)` | function | Same, but for MCP-bridged tools (rare in plugins) |
| `events.on(name, fn)` | function | Subscribe to internal events |
| `events.emit(name, payload)` | function | Publish an internal event |
| `registerRoute(method, path, handler)` | function | Mount an Express route under `/api/plugins/{name}` |

---

## Discovery and loading

On startup, [lib/plugins/](../lib/plugins/) scans `plugins/`:

1. For each subdirectory, read `plugin.json`.
2. Skip if the manifest is missing or invalid.
3. Dynamically `import()` `index.js`.
4. Call `init(context)` with the scoped context.
5. Log success or failure (failures are isolated — one bad plugin doesn't crash the others).

To temporarily disable a plugin without deleting it, rename `plugin.json` to `plugin.json.disabled`.

---

## Tool naming

Tools registered by a plugin are auto-prefixed with the plugin name, so:

```js
registerTool({ name: "do_thing", ... })
```

becomes `my-plugin_do_thing` in the shared registry. This prevents collisions with the 48 base tools, the 37 connector tools, and any MCP-bridged tools.

---

## When to use HTTP routes

Plugin routes are great for:

- Webhooks from external services (Stripe, GitHub, etc.) — point the upstream at `https://your-yabby/api/plugins/my-plugin/webhook`.
- Custom UI panels in the SPA that need a backend endpoint.
- One-off admin actions you don't want to add to core.

They're **not** the right tool for things voice or channels would naturally trigger — for those, register a tool instead so all the surfaces benefit.

---

## Distributing plugins

Today, plugins are filesystem-local. There's no plugin registry yet. If you want to share a plugin:

1. Push it to its own GitHub repo.
2. Document install as `git clone … plugins/my-plugin && npm install` (if it has deps).
3. Optionally pin to a Yabby version in your README.

A real plugin registry is on the roadmap — open an issue if you'd like to push it forward.

---

## Examples in the codebase

The simplest reference is to grep for `registerTool(` in `lib/plugins/` and look at how the core tool registry uses the same APIs that plugins do. The contract is identical.

For more details on the underlying tool registry, see [lib/plugins/tool-registry.js](../lib/plugins/tool-registry.js).
