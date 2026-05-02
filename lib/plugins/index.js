/* ═══════════════════════════════════════════════════════
   YABBY — Plugin Manager
   ═══════════════════════════════════════════════════════
   loadPlugins, getPlugin, listPlugins, enable/disable.
*/

import { log } from "../logger.js";
import { discoverPlugins, initPlugin } from "./loader.js";
import { createPluginContext } from "./context.js";

// All discovered plugins
let plugins = new Map();

export async function loadPlugins() {
  plugins = await discoverPlugins();

  // Auto-enable plugins with autoEnable: true
  for (const [name, info] of plugins) {
    if (info.autoEnable && info.status !== "error") {
      await initPlugin(info);
    }
  }

  const total = plugins.size;
  const active = [...plugins.values()].filter(p => p.status === "active").length;
  const errors = [...plugins.values()].filter(p => p.status === "error").length;
  log(`[PLUGINS] ${total} discovered, ${active} active, ${errors} errors`);
}

export function getPlugin(name) {
  return plugins.get(name) || null;
}

export function listPlugins() {
  return [...plugins.values()].map(p => ({
    name: p.name,
    version: p.version,
    description: p.description,
    permissions: p.permissions,
    autoEnable: p.autoEnable,
    status: p.status,
    error: p.error,
  }));
}

export async function enablePlugin(name) {
  const info = plugins.get(name);
  if (!info) throw new Error(`Plugin "${name}" not found`);
  if (info.status === "active") return info;

  // Re-init
  info.status = "discovered";
  info.error = null;
  await initPlugin(info);
  return info;
}

export async function disablePlugin(name) {
  const info = plugins.get(name);
  if (!info) throw new Error(`Plugin "${name}" not found`);

  // Call destroy if available
  if (info.module && typeof info.module.destroy === "function") {
    try {
      await info.module.destroy();
    } catch (err) {
      log(`[PLUGINS] Error destroying ${name}:`, err.message);
    }
  }

  info.status = "disabled";
  info.error = null;
  log(`[PLUGINS] Disabled ${name}`);
  return info;
}
