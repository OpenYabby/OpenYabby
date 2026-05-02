/**
 * Web Channel Adapter
 * Minimal adapter for web app agent chat
 * Allows web chat to use the same channel handler as WhatsApp (with tools)
 */

import { ChannelAdapter } from "./base.js";

export class WebAdapter extends ChannelAdapter {
  constructor(config = {}) {
    super({
      dmPolicy: "open",  // Web chat always allowed
      groupMentionGating: false,  // No groups in web
      enabled: true,
      ...config
    });
    this.running = true;
    this.config = {
      dmPolicy: "open",
      groupMentionGating: false,
      ...config
    };
  }

  async start() {
    // No connection needed - web is always "running"
    this.running = true;
  }

  async stop() {
    this.running = false;
  }

  async send(channelId, text) {
    // Web chat responses are sent via HTTP response, not pushed
    // This method exists for compatibility but does nothing
    return;
  }

  // Web uploads are already in the media store — no download needed
  makeMediaFetcher(ref) {
    return async () => {
      if (ref.assetId) {
        const { read } = await import("../media/store.js");
        const asset = await read(ref.assetId);
        if (!asset) throw new Error(`Web media asset ${ref.assetId} not found`);
        return { buffer: asset.buffer, mime: ref.mime, filename: ref.filename };
      }
      throw new Error("Web makeMediaFetcher: no assetId");
    };
  }

  isUserAllowed(userId) {
    // Web chat always allowed (authenticated via session)
    return true;
  }
}
