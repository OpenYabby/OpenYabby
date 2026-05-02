/* ═══════════════════════════════════════════════════════
   YABBY — Plugin Loader
   ═══════════════════════════════════════════════════════
   Reads each plugin directory for plugin.json manifest,
   validates, imports entry, calls init(ctx) in try-catch.
*/

import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { log } from "../logger.js";
import { createPluginContext } from "./context.js";

const PLUGINS_DIR = join(process.cwd(), "plugins");

/**
 * Discover and load all plugins from the plugins/ directory.
 * Returns a Map<name, pluginInfo>.
 */
export async function discoverPlugins() {
  const plugins = new Map();

  let dirs;
  try {
    dirs = await readdir(PLUGINS_DIR, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      log("[PLUGINS] No plugins directory found — skipping");
      return plugins;
    }
    throw err;
  }

  for (const dirent of dirs) {
    if (!dirent.isDirectory()) continue;
    const pluginDir = join(PLUGINS_DIR, dirent.name);
    const manifestPath = join(pluginDir, "plugin.json");

    try {
      const raw = await readFile(manifestPath, "utf-8");
      const manifest = JSON.parse(raw);

      if (!manifest.name) manifest.name = dirent.name;

      plugins.set(manifest.name, {
        name: manifest.name,
        version: manifest.version || "0.0.0",
        description: manifest.description || "",
        permissions: manifest.permissions || [],
        autoEnable: manifest.autoEnable ?? false,
        dir: pluginDir,
        manifest,
        status: "discovered",
        error: null,
        module: null,
      });
    } catch (err) {
      log(`[PLUGINS] Invalid manifest in ${dirent.name}:`, err.message);
      plugins.set(dirent.name, {
        name: dirent.name,
        version: "?",
        description: "",
        permissions: [],
        autoEnable: false,
        dir: pluginDir,
        manifest: null,
        status: "error",
        error: `Invalid manifest: ${err.message}`,
        module: null,
      });
    }
  }

  return plugins;
}

/**
 * Load and initialize a single plugin.
 */
export async function initPlugin(pluginInfo) {
  if (pluginInfo.status === "error") return pluginInfo;

  try {
    const entryPath = join(pluginInfo.dir, "index.js");
    const mod = await import(entryPath);
    pluginInfo.module = mod;

    if (typeof mod.init === "function") {
      const ctx = createPluginContext(pluginInfo.name);
      await mod.init(ctx);
    }

    pluginInfo.status = "active";
    log(`[PLUGINS] Loaded ${pluginInfo.name} v${pluginInfo.version}`);
  } catch (err) {
    pluginInfo.status = "error";
    pluginInfo.error = err.message;
    log(`[PLUGINS] Error loading ${pluginInfo.name}:`, err.message);
  }

  return pluginInfo;
}
