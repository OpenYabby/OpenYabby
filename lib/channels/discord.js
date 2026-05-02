/* ═══════════════════════════════════════════════════════
   Discord Adapter (discord.js)
   ═══════════════════════════════════════════════════════
   Supports text and voice messages.
   Inbound voice: downloads audio attachment → transcribed via Whisper.
   Outbound voice: TTS → sent as voice attachment (MP3).
*/

import { ChannelAdapter } from "./base.js";
import { normalize } from "./normalize.js";
import { log } from "../logger.js";
import { transcribeAudio } from "../whisper.js";
import { unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

export class DiscordAdapter extends ChannelAdapter {
  constructor(config) {
    super("discord", config);
    this.client = null;
  }

  async start() {
    const { Client, GatewayIntentBits } = await import("discord.js");

    if (!this.config.botToken) {
      throw new Error("Discord botToken required");
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.on("messageCreate", async (message) => {
      // Ignore bot messages
      if (message.author.bot) return;

      const isDM = !message.guild;

      // ── /pairserver: register the current Discord guild as the Yabby
      //    container so assign_agent can later auto-create one private text
      //    channel per agent. Bot must have MANAGE_CHANNELS permission.
      if (!isDM && typeof message.content === "string" && message.content.trim().startsWith("/pairserver")) {
        try {
          const { PermissionsBitField } = await import("discord.js");
          const me = await message.guild.members.fetchMe();
          const canManageChannels = me?.permissions?.has(PermissionsBitField.Flags.ManageChannels);
          if (!canManageChannels) {
            await message.reply("❌ I don't have the 'Manage Channels' permission. Promote me first, then run /pairserver again.");
            return;
          }
          const { setChannelContainer } = await import("../../db/queries/channel-containers.js");
          await setChannelContainer({
            channelName: "discord",
            containerId: message.guild.id,
            ownerUserId: message.author.id,
            ownerUserName: message.author.displayName || message.author.username || "User",
            pairedBy: message.author.username || null,
            metadata: { guild_name: message.guild.name || null },
          });
          await message.reply(`✅ Discord server paired (\`${message.guild.name}\`). Yabby will create one private channel here for every new agent.`);
          log(`[CHANNEL:discord] /pairserver: guild=${message.guild.id} owner=${message.author.id} (${message.author.username})`);
        } catch (err) {
          log(`[CHANNEL:discord] /pairserver failed: ${err.message}`);
          try { await message.reply(`❌ Pairing failed: ${err.message}`); } catch {}
        }
        return;
      }

      // Check for voice message attachments (Discord voice messages are .ogg attachments with a special flag)
      const voiceAttachment = message.attachments.find(
        (a) => a.contentType?.startsWith("audio/") || a.name?.endsWith(".ogg") || a.name?.endsWith(".mp3") || a.name?.endsWith(".wav")
      );

      if (voiceAttachment) {
        await this._handleVoiceMessage(message, voiceAttachment, isDM);
        return;
      }

      // Extract non-audio attachments (images, documents, videos, etc.)
      const attachments = [];
      for (const [, a] of message.attachments) {
        if (a.contentType?.startsWith("audio/")) continue; // already handled above
        const mime = a.contentType || "application/octet-stream";
        const kind = mime.startsWith("image/") ? "image"
          : mime.startsWith("video/") ? "video"
          : mime === "application/pdf" ? "pdf"
          : "file";
        attachments.push({
          kind, mime,
          platformRef: a.url, // Discord gives direct download URLs
          filename: a.name || null,
          sizeBytes: a.size || null,
          assetId: null,
        });
      }

      const msg = normalize({
        channelName: "discord",
        channelId: message.channel.id,
        userId: message.author.id,
        userName: message.author.displayName || message.author.username || "User",
        text: message.content || "",
        isGroup: !isDM,
        // Use the channel.id as threadId so messages posted in a Yabby
        // agent's private channel (created by createAgentDiscordChannel,
        // which is a GuildText channel — NOT a Discord native thread) get
        // routed to that agent via channel_thread_bindings. Native Discord
        // threads also surface their channel.id here, so the binding lookup
        // covers both cases. Non-bound channels resolve to no binding and
        // fall through to the normal Yabby super-agent flow.
        threadId: message.channel.id,
        platformMsgId: message.id,
        attachments,
      });

      await this._handleIncoming(msg);
    });

    this.client.on("error", (err) => {
      log(`[CHANNEL:discord] Client error:`, err.message);
    });

    this.client.once("ready", () => {
      this.running = true;
      log(`[CHANNEL:discord] Bot ready as ${this.client.user?.tag} (text + voice)`);
    });

    await this.client.login(this.config.botToken);
  }

  async _handleVoiceMessage(message, attachment, isDM) {
    let tempPath = null;

    try {
      log(`[CHANNEL:discord] Voice/audio attachment received: ${attachment.name} (${attachment.contentType})`);

      // Download the audio file
      const response = await fetch(attachment.url);
      if (!response.ok) {
        throw new Error(`Failed to download audio: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Save to temp file
      const ext = attachment.name?.split(".").pop() || "ogg";
      tempPath = join(tmpdir(), `discord-voice-${Date.now()}.${ext}`);
      writeFileSync(tempPath, buffer);

      // Transcribe via Whisper
      const text = await transcribeAudio(tempPath);
      log(`[CHANNEL:discord] Transcribed voice: "${text}"`);

      if (!text || !text.trim()) {
        log("[CHANNEL:discord] Empty transcription, skipping");
        return;
      }

      const msg = normalize({
        channelName: "discord",
        channelId: message.channel.id,
        userId: message.author.id,
        userName: message.author.displayName || message.author.username || "User",
        text,
        isGroup: !isDM,
        // Use the channel.id as threadId so messages posted in a Yabby
        // agent's private channel (created by createAgentDiscordChannel,
        // which is a GuildText channel — NOT a Discord native thread) get
        // routed to that agent via channel_thread_bindings. Native Discord
        // threads also surface their channel.id here, so the binding lookup
        // covers both cases. Non-bound channels resolve to no binding and
        // fall through to the normal Yabby super-agent flow.
        threadId: message.channel.id,
        platformMsgId: message.id,
        isAudio: true,
      });

      await this._handleIncoming(msg);
    } catch (err) {
      log(`[CHANNEL:discord] Voice message error:`, err.message);
      log(`[CHANNEL:discord] Stack:`, err.stack);
    } finally {
      if (tempPath) {
        try { unlinkSync(tempPath); } catch (_err) { /* ignore */ }
      }
    }
  }

  async stop() {
    if (this.client) {
      await this.client.destroy();
      this.client = null;
    }
    this.running = false;
  }

  async send(channelId, text) {
    if (!this.client) throw new Error("Discord client not running");

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Discord channel ${channelId} not found`);

    // Discord has a 2000 char limit per message
    if (text.length <= 2000) {
      await channel.send(text);
    } else {
      const chunks = text.match(/[\s\S]{1,2000}/g) || [text];
      for (const chunk of chunks) {
        await channel.send(chunk);
      }
    }
  }

  async sendAudio(channelId, audioInput) {
    if (!this.client) throw new Error("Discord client not running");

    const audioBuffer = audioInput?.audio || audioInput;
    const { AttachmentBuilder } = await import("discord.js");

    log(`[CHANNEL:discord] Sending audio attachment (${audioBuffer.length} bytes)`);

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Discord channel ${channelId} not found`);

    const attachment = new AttachmentBuilder(audioBuffer, { name: "voice-reply.mp3" });
    await channel.send({ files: [attachment] });

    log("[CHANNEL:discord] Audio attachment sent");
  }

  makeMediaFetcher(ref) {
    return async () => {
      const resp = await fetch(ref.platformRef); // platformRef = direct URL
      if (!resp.ok) throw new Error(`Discord file download failed: ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      return { buffer, mime: ref.mime, filename: ref.filename };
    };
  }

  async sendImage(channelId, opts = {}) {
    if (!this.client) throw new Error("Discord client not running");
    const { buffer: buf, filename } = await this._resolveMedia(opts);
    const { AttachmentBuilder } = await import("discord.js");
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Discord channel ${channelId} not found`);
    const attachment = new AttachmentBuilder(buf, { name: filename || "image.png" });
    await channel.send({
      files: [attachment],
      ...(opts.caption ? { content: opts.caption } : {}),
    });
    log(`[CHANNEL:discord] ✓ Image sent (${buf.length} bytes)`);
  }

  async sendDocument(channelId, opts = {}) {
    if (!this.client) throw new Error("Discord client not running");
    const { buffer: buf, filename } = await this._resolveMedia(opts);
    const { AttachmentBuilder } = await import("discord.js");
    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`Discord channel ${channelId} not found`);
    const attachment = new AttachmentBuilder(buf, { name: filename || "document" });
    await channel.send({
      files: [attachment],
      ...(opts.caption ? { content: opts.caption } : {}),
    });
    log(`[CHANNEL:discord] ✓ Document sent (${buf.length} bytes)`);
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
