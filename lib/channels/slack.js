/* ═══════════════════════════════════════════════════════
   Slack Adapter (@slack/bolt)
   ═══════════════════════════════════════════════════════
   Supports text and voice/audio messages.
   Inbound voice: downloads audio file → transcribed via Whisper.
   Outbound voice: TTS → uploaded as audio snippet.
*/

import { ChannelAdapter } from "./base.js";
import { normalize } from "./normalize.js";
import { log } from "../logger.js";
import { transcribeAudio } from "../whisper.js";
import { unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export class SlackAdapter extends ChannelAdapter {
  constructor(config) {
    super("slack", config);
    this.app = null;
    // Per-channel thread tracking (avoids race condition with instance-level state)
    this._threadMap = new Map();
  }

  async start() {
    const { App } = await import("@slack/bolt");

    if (!this.config.botToken || !this.config.appToken) {
      throw new Error("Slack botToken and appToken required");
    }

    this.app = new App({
      token: this.config.botToken,
      appToken: this.config.appToken,
      socketMode: true,
    });

    // Handle messages
    this.app.message(async ({ message, client }) => {
      // Ignore bot messages (but allow file_share subtype for voice/audio)
      if (message.bot_id) return;
      if (message.subtype && message.subtype !== "file_share") return;

      // Get user info for display name
      let userName = "User";
      try {
        const userInfo = await client.users.info({ user: message.user });
        userName = userInfo.user?.real_name || userInfo.user?.name || "User";
      } catch {}

      // ── /yabbypair: register the current Slack workspace as the Yabby
      //    container so assign_agent can later auto-create one private
      //    channel per agent via conversations.create.
      if (typeof message.text === "string" && message.text.trim().startsWith("/yabbypair")) {
        try {
          const teamInfo = await client.team.info();
          const teamId = teamInfo?.team?.id;
          const teamName = teamInfo?.team?.name || null;
          if (!teamId) {
            await client.chat.postMessage({ channel: message.channel, text: "❌ Could not resolve workspace ID." });
            return;
          }
          const { setChannelContainer } = await import("../../db/queries/channel-containers.js");
          await setChannelContainer({
            channelName: "slack",
            containerId: teamId,
            ownerUserId: message.user,
            ownerUserName: userName,
            pairedBy: userName,
            metadata: { team_name: teamName },
          });
          await client.chat.postMessage({
            channel: message.channel,
            text: `✅ Slack workspace paired (\`${teamName || teamId}\`). Yabby will create one private channel here per agent. ⚠️ Note: workspace owners/admins can still see private channels via Slack export/compliance.`,
          });
          log(`[CHANNEL:slack] /yabbypair: workspace=${teamId} owner=${message.user} (${userName})`);
        } catch (err) {
          log(`[CHANNEL:slack] /yabbypair failed: ${err.message}`);
          try { await client.chat.postMessage({ channel: message.channel, text: `❌ Pairing failed: ${err.message}` }); } catch {}
        }
        return;
      }

      const isGroup = message.channel_type === "channel" || message.channel_type === "group";
      const threadTs = message.thread_ts || message.ts;

      // Store thread context per channel (concurrency-safe)
      this._threadMap.set(message.channel, threadTs);

      // Check for audio file attachments
      const audioFile = message.files?.find(
        (f) => f.mimetype?.startsWith("audio/") || f.name?.endsWith(".ogg") || f.name?.endsWith(".mp3") || f.name?.endsWith(".wav") || f.name?.endsWith(".m4a")
      );

      if (audioFile) {
        await this._handleVoiceMessage(message, audioFile, client, userName, isGroup, threadTs);
        return;
      }

      // Extract non-audio file attachments
      const attachments = [];
      for (const f of (message.files || [])) {
        if (f.mimetype?.startsWith("audio/")) continue; // already handled above
        const mime = f.mimetype || "application/octet-stream";
        const kind = mime.startsWith("image/") ? "image"
          : mime.startsWith("video/") ? "video"
          : mime === "application/pdf" ? "pdf"
          : "file";
        attachments.push({
          kind, mime,
          platformRef: f.url_private, // Slack private URL (needs auth header)
          filename: f.name || null,
          sizeBytes: f.size || null,
          assetId: null,
        });
      }

      const msg = normalize({
        channelName: "slack",
        channelId: message.channel,
        userId: message.user,
        userName,
        text: message.text || "",
        isGroup,
        // Use message.channel as threadId so messages in a Yabby agent's
        // private channel (created by createAgentSlackChannel) get routed
        // via channel_thread_bindings. The Slack-native thread_ts
        // (sub-thread replies) is preserved separately on this._threadMap
        // for outbound chat.postMessage calls — not used for binding lookup.
        threadId: message.channel,
        platformMsgId: message.ts,
        attachments,
      });

      await this._handleIncoming(msg);
    });

    await this.app.start();
    this.running = true;
    log(`[CHANNEL:slack] Bot started (socket mode, text + voice)`);
  }

  async _handleVoiceMessage(message, audioFile, client, userName, isGroup, threadTs) {
    let tempPath = null;

    try {
      log(`[CHANNEL:slack] Audio file received: ${audioFile.name} (${audioFile.mimetype})`);

      // Download file from Slack (requires bot token for private URLs)
      const downloadUrl = audioFile.url_private_download || audioFile.url_private;
      if (!downloadUrl) {
        log("[CHANNEL:slack] No download URL for audio file");
        return;
      }

      const response = await fetch(downloadUrl, {
        headers: { "Authorization": `Bearer ${this.config.botToken}` },
      });
      if (!response.ok) {
        throw new Error(`Failed to download audio: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Save to temp file
      const ext = audioFile.name?.split(".").pop() || "ogg";
      tempPath = join(tmpdir(), `slack-voice-${Date.now()}.${ext}`);
      writeFileSync(tempPath, buffer);

      // Transcribe via Whisper
      const text = await transcribeAudio(tempPath);
      log(`[CHANNEL:slack] Transcribed voice: "${text}"`);

      if (!text || !text.trim()) {
        log("[CHANNEL:slack] Empty transcription, skipping");
        return;
      }

      const msg = normalize({
        channelName: "slack",
        channelId: message.channel,
        userId: message.user,
        userName,
        text,
        isGroup,
        // Use message.channel as threadId so messages in a Yabby agent's
        // private channel (created by createAgentSlackChannel) get routed
        // via channel_thread_bindings. The Slack-native thread_ts
        // (sub-thread replies) is preserved separately on this._threadMap
        // for outbound chat.postMessage calls — not used for binding lookup.
        threadId: message.channel,
        platformMsgId: message.ts,
        isAudio: true,
      });

      await this._handleIncoming(msg);
    } catch (err) {
      log(`[CHANNEL:slack] Voice message error:`, err.message);
      log(`[CHANNEL:slack] Stack:`, err.stack);
    } finally {
      if (tempPath) {
        try { unlinkSync(tempPath); } catch (_err) { /* ignore */ }
      }
    }
  }

  async stop() {
    if (this.app) {
      await this.app.stop();
      this.app = null;
    }
    this._threadMap.clear();
    this.running = false;
  }

  async send(channelId, text) {
    if (!this.app) throw new Error("Slack app not running");

    await this.app.client.chat.postMessage({
      channel: channelId,
      text,
      thread_ts: this._threadMap.get(channelId) || undefined,
    });
  }

  async sendAudio(channelId, audioInput) {
    if (!this.app) throw new Error("Slack app not running");

    const audioBuffer = audioInput?.audio || audioInput;

    log(`[CHANNEL:slack] Uploading audio file (${audioBuffer.length} bytes)`);

    await this.app.client.filesUploadV2({
      channel_id: channelId,
      file: audioBuffer,
      filename: "voice-reply.mp3",
      title: "Voice Reply",
      thread_ts: this._threadMap.get(channelId) || undefined,
    });

    log("[CHANNEL:slack] Audio file uploaded");
  }

  makeMediaFetcher(ref) {
    const self = this;
    return async () => {
      // Slack requires Bearer token to download private URLs
      const resp = await fetch(ref.platformRef, {
        headers: { Authorization: `Bearer ${self.config.botToken}` },
      });
      if (!resp.ok) throw new Error(`Slack file download failed: ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      return { buffer, mime: ref.mime, filename: ref.filename };
    };
  }

  async sendImage(channelId, opts = {}) {
    if (!this.app) throw new Error("Slack app not running");
    const { buffer: buf, filename } = await this._resolveMedia(opts);
    await this.app.client.filesUploadV2({
      channel_id: channelId,
      file: buf,
      filename: filename || "image.png",
      title: opts.caption || "Image",
      thread_ts: this._threadMap.get(channelId) || undefined,
    });
    log(`[CHANNEL:slack] ✓ Image uploaded (${buf.length} bytes)`);
  }

  async sendDocument(channelId, opts = {}) {
    if (!this.app) throw new Error("Slack app not running");
    const { buffer: buf, filename } = await this._resolveMedia(opts);
    await this.app.client.filesUploadV2({
      channel_id: channelId,
      file: buf,
      filename: filename || "document",
      title: opts.caption || "Document",
      thread_ts: this._threadMap.get(channelId) || undefined,
    });
    log(`[CHANNEL:slack] ✓ Document uploaded (${buf.length} bytes)`);
  }

  async _resolveMedia(opts) {
    let buf = opts.buffer;
    let filename = opts.filename || null;
    if (opts.assetId && !buf) {
      const { read } = await import("../media/store.js");
      const asset = await read(opts.assetId);
      if (!asset) throw new Error(`Media asset ${opts.assetId} not found`);
      buf = asset.buffer;
      filename = filename || `file.${asset.row?.mime?.split("/")[1] || "bin"}`;
    }
    if (!buf) throw new Error("No buffer or assetId provided");
    return { buffer: buf, filename };
  }
}
