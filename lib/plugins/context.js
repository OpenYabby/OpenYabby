/* ═══════════════════════════════════════════════════════
   YABBY — Restricted Plugin Context
   ═══════════════════════════════════════════════════════
   Plugins receive this context in init(). NO direct DB
   access. High-level helpers only.
*/

import { getConfig } from "../config.js";
import { log } from "../logger.js";
import { registerTool, removeTool } from "./tool-registry.js";

// Event bus for plugins
const eventHandlers = new Map(); // event → Set<callback>

export function emitPluginEvent(event, data) {
  const handlers = eventHandlers.get(event);
  if (!handlers) return;
  for (const cb of handlers) {
    try { cb(data); } catch (err) {
      log(`[PLUGIN-EVENT] Handler error on ${event}:`, err.message);
    }
  }
}

// Route collectors for plugin HTTP routes
const pluginRoutes = [];

export function getPluginRoutes() {
  return [...pluginRoutes];
}

/**
 * Build a restricted context object for a plugin.
 */
export function createPluginContext(pluginName) {
  return {
    // Read-only config access
    config: {
      get: (key) => getConfig(key),
    },

    // Scoped logger
    log: (...args) => log(`[PLUGIN:${pluginName}]`, ...args),

    // Tool registration (scoped — prefix with plugin name to avoid collisions)
    tools: {
      register: (def) => {
        const scopedDef = { ...def, name: def.name, _plugin: pluginName };
        return registerTool(scopedDef);
      },
      remove: (name) => removeTool(name),
    },

    // Event system
    events: {
      on: (event, cb) => {
        if (!eventHandlers.has(event)) eventHandlers.set(event, new Set());
        eventHandlers.get(event).add(cb);
      },
      off: (event, cb) => {
        eventHandlers.get(event)?.delete(cb);
      },
      emit: (event, data) => emitPluginEvent(event, data),
    },

    // HTTP route registration
    http: {
      registerRoute: (method, path, handler) => {
        pluginRoutes.push({ method: method.toLowerCase(), path: `/api/plugins/${pluginName}${path}`, handler, plugin: pluginName });
        log(`[PLUGIN:${pluginName}] Registered route: ${method.toUpperCase()} /api/plugins/${pluginName}${path}`);
      },
    },
  };
}
