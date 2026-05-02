/* ═══════════════════════════════════════════════════════
   Channel Manager
   ═══════════════════════════════════════════════════════
   Reads config.channels, starts only enabled adapters.
   Provides getChannel(), listActive(), closeChannels().
*/

import { log } from "../logger.js";
import { getConfig } from "../config.js";
import { handleChannelMessage } from "./handler.js";
import { startConversationListener, registerChannelAdapter } from "./notification-listener.js";

const adapters = new Map();

// Lazy-loaded adapter constructors
const ADAPTER_FACTORIES = {
  telegram: () => import("./telegram.js").then(m => m.TelegramAdapter),
  slack: () => import("./slack.js").then(m => m.SlackAdapter),
  discord: () => import("./discord.js").then(m => m.DiscordAdapter),
  whatsapp: () => import("./whatsapp-custom.js").then(m => m.CustomWhatsAppAdapter), // Using custom implementation
  signal: () => import("./signal.js").then(m => m.SignalAdapter),
  web: () => import("./web.js").then(m => m.WebAdapter), // Web app agent chat
};

/**
 * Initialize all enabled channels from config.
 */
export async function initChannels() {
  const channelsConfig = getConfig("channels") || {};

  // Always initialize web adapter (for web app agent chat)
  try {
    const WebAdapter = await ADAPTER_FACTORIES.web();
    const webAdapter = new WebAdapter({ enabled: true });
    webAdapter.onMessage(handleChannelMessage);
    await webAdapter.start();
    adapters.set("web", webAdapter);
    log(`[CHANNEL] web started (internal)`);
  } catch (err) {
    log(`[CHANNEL] Failed to start web adapter:`, err.message);
  }

  for (const [name, cfg] of Object.entries(channelsConfig)) {
    if (!cfg || !cfg.enabled) continue;
    if (!ADAPTER_FACTORIES[name]) {
      log(`[CHANNEL] Unknown channel adapter: ${name}`);
      continue;
    }

    try {
      const AdapterClass = await ADAPTER_FACTORIES[name]();
      const adapter = new AdapterClass(cfg);
      adapter.onMessage(handleChannelMessage);
      await adapter.start();
      adapters.set(name, adapter);
      log(`[CHANNEL] ${name} started`);
    } catch (err) {
      log(`[CHANNEL] Failed to start ${name}:`, err.message);
    }
  }

  if (adapters.size > 0) {
    log(`[CHANNEL] ${adapters.size} channel(s) active`);

    // Register adapters for notification forwarding
    for (const [name, adapter] of adapters) {
      registerChannelAdapter(name, adapter);
    }

    // Start conversation listener for bidirectional sync
    await startConversationListener();
  } else {
    log(`[CHANNEL] No channels enabled`);
  }
}

/**
 * Get a running adapter by name.
 */
export function getChannel(name) {
  return adapters.get(name) || null;
}

/**
 * List all active channels with status.
 */
export function listChannels() {
  const channelsConfig = getConfig("channels") || {};
  const result = {};

  for (const name of Object.keys(ADAPTER_FACTORIES)) {
    const cfg = channelsConfig[name] || {};
    const adapter = adapters.get(name);
    result[name] = {
      enabled: cfg.enabled || false,
      running: adapter ? adapter.running : false,
      connectionState: adapter?._connectionState || 'disconnected',
      config: {
        dmPolicy: cfg.dmPolicy || "open",
        groupMentionGating: cfg.groupMentionGating ?? true,
        // Don't expose tokens
        hasToken: !!(cfg.botToken || cfg.token || cfg.appToken || cfg.phoneNumber || cfg.apiUrl),
      },
    };
  }

  return result;
}

/**
 * Stop all active channels.
 */
export async function closeChannels() {
  for (const [name, adapter] of adapters) {
    try {
      await adapter.stop();
      log(`[CHANNEL] ${name} stopped`);
    } catch (err) {
      log(`[CHANNEL] Error stopping ${name}:`, err.message);
    }
  }
  adapters.clear();
}

/**
 * Stop a specific channel (disconnect).
 * @param {string} name - Channel name
 * @param {boolean} clearSession - If true, clears saved session data (forces new QR)
 */
export async function stopChannel(name, clearSession = false) {
  const existing = adapters.get(name);
  if (existing) {
    try {
      await existing.stop(clearSession);
      adapters.delete(name);
      log(`[CHANNEL] ${name} stopped (clearSession: ${clearSession})`);
      return true;
    } catch (err) {
      log(`[CHANNEL] Error stopping ${name}:`, err.message);
      return false;
    }
  }
  log(`[CHANNEL] ${name} not found to stop`);
  return false;
}

/**
 * Restart a specific channel (after config change).
 */
export async function restartChannel(name) {
  // Stop existing
  const existing = adapters.get(name);
  if (existing) {
    try { await existing.stop(); } catch {}
    adapters.delete(name);
  }

  // Re-read config
  const channelsConfig = getConfig("channels") || {};
  const cfg = channelsConfig[name];
  if (!cfg || !cfg.enabled) {
    log(`[CHANNEL] ${name} disabled or not configured`);
    return false;
  }

  if (!ADAPTER_FACTORIES[name]) {
    log(`[CHANNEL] Unknown channel: ${name}`);
    return false;
  }

  try {
    const AdapterClass = await ADAPTER_FACTORIES[name]();
    const adapter = new AdapterClass(cfg);
    adapter.onMessage(handleChannelMessage);
    await adapter.start();
    adapters.set(name, adapter);
    log(`[CHANNEL] ${name} restarted`);
    return true;
  } catch (err) {
    log(`[CHANNEL] Failed to restart ${name}:`, err.message);
    return false;
  }
}
