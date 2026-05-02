/* ═══════════════════════════════════════════════════════
   Channel Adapter — Base Class
   ═══════════════════════════════════════════════════════
   All channel adapters extend this. Provides lifecycle
   (start/stop) and message routing interface.
*/

import { log } from "../logger.js";

export class ChannelAdapter {
  constructor(name, config) {
    this.name = name;
    this.config = config;
    this.running = false;
    this._messageHandler = null;
  }

  /** Start the adapter (connect to platform) */
  async start() {
    throw new Error(`${this.name}: start() not implemented`);
  }

  /** Stop the adapter (disconnect) */
  async stop() {
    this.running = false;
  }

  /** Send a text message to a channel/user */
  async send(channelId, text) {
    throw new Error(`${this.name}: send() not implemented`);
  }

  /**
   * Send an image. Default = not implemented; adapters override.
   * @param {string} channelId
   * @param {{ assetId?: string, path?: string, buffer?: Buffer, caption?: string, filename?: string }} opts
   */
  async sendImage(channelId, opts) {
    throw new Error(`${this.name}: sendImage() not implemented`);
  }

  /**
   * Send a document / arbitrary file. Default = not implemented.
   * @param {string} channelId
   * @param {{ assetId?: string, path?: string, buffer?: Buffer, caption?: string, filename?: string, mime?: string }} opts
   */
  async sendDocument(channelId, opts) {
    throw new Error(`${this.name}: sendDocument() not implemented`);
  }

  /**
   * Send a video. Default = not implemented.
   * @param {string} channelId
   * @param {{ assetId?: string, path?: string, buffer?: Buffer, caption?: string, filename?: string, mime?: string }} opts
   */
  async sendVideo(channelId, opts) {
    throw new Error(`${this.name}: sendVideo() not implemented`);
  }

  /**
   * Return a thunk that downloads bytes for an inbound media attachment.
   * Each adapter overrides this with platform-specific download logic.
   * @param {import('./normalize.js').MediaRef} ref
   * @returns {() => Promise<{ buffer: Buffer, mime?: string, filename?: string }>}
   */
  makeMediaFetcher(ref) {
    return async () => { throw new Error(`${this.name}: makeMediaFetcher() not implemented`); };
  }

  /** Register the central message handler */
  onMessage(handler) {
    this._messageHandler = handler;
  }

  /** Called by subclasses when a message arrives from the platform */
  async _handleIncoming(normalizedMsg) {
    if (!this._messageHandler) {
      log(`[CHANNEL:${this.name}] No message handler registered`);
      return;
    }
    try {
      await this._messageHandler(normalizedMsg, this);
    } catch (err) {
      log(`[CHANNEL:${this.name}] Handler error:`, err.message);
      log(`[CHANNEL:${this.name}] Stack:`, err.stack);
    }
  }

  /** Check if a user is allowed (DM policy) */
  isUserAllowed(userId) {
    const policy = this.config.dmPolicy || "open";
    if (policy === "open") return true;
    if (policy === "closed") {
      const allowed = this.config.allowedUsers || [];
      return allowed.includes(userId);
    }
    return true;
  }
}
