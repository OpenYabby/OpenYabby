/* ═══════════════════════════════════════════════════════
   Telegram Adapter (grammy)
   ═══════════════════════════════════════════════════════
   Supports text and voice messages.
   Inbound voice: downloaded → transcribed via Whisper.
   Outbound voice: TTS → sent as voice message (OGG/Opus).
*/

import { ChannelAdapter } from "./base.js";
import { normalize } from "./normalize.js";
import { log } from "../logger.js";
import { transcribeAudio } from "../whisper.js";
import { speak } from "../tts/index.js";
import { serverMsg } from "../i18n.js";
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Markdown → Telegram HTML converter ─────────────────────────────────
// Telegram's HTML parse_mode supports: <b>, <i>, <u>, <s>, <code>, <pre>,
// <pre><code class="lang-..."></code></pre>, <a href="">, <blockquote>.
// We convert common markdown/WhatsApp patterns (**bold**, *bold*, _italic_,
// `code`, ```pre```, [txt](url)) and HTML-escape the rest.

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markdownToTelegramHtml(text) {
  if (!text) return "";
  const tokens = [];
  let out = text;

  // Extract triple-backtick code blocks first (preserve verbatim).
  out = out.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_m, lang, code) => {
    const idx = tokens.length;
    const body = escapeHtml(code.replace(/\n$/, ""));
    tokens.push(lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>`
      : `<pre>${body}</pre>`);
    return `\x00TOK${idx}\x00`;
  });

  // Extract inline code.
  out = out.replace(/`([^`\n]+?)`/g, (_m, code) => {
    const idx = tokens.length;
    tokens.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00TOK${idx}\x00`;
  });

  // Escape everything else.
  out = escapeHtml(out);

  // Markdown links [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, label, url) =>
    `<a href="${url.replace(/"/g, "&quot;")}">${label}</a>`);

  // Bold: **text** (markdown) or __text__ — convert first to protect inner content
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, "\x01B\x01$1\x01/B\x01");
  out = out.replace(/__([^_\n]+?)__/g, "\x01B\x01$1\x01/B\x01");

  // WhatsApp/Telegram native: *text* = bold, _text_ = italic, ~text~ = strikethrough
  out = out.replace(/(^|[\s(>])\*([^*\n]+?)\*(?=[\s).,!?:;<]|$)/g, "$1\x01B\x01$2\x01/B\x01");
  out = out.replace(/(^|[\s(>])_([^_\n]+?)_(?=[\s).,!?:;<]|$)/g, "$1<i>$2</i>");

  // Strikethrough: ~~text~~ (markdown) and ~text~ (WhatsApp)
  out = out.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
  out = out.replace(/(^|[\s(>])~([^~\n]+?)~(?=[\s).,!?:;<]|$)/g, "$1<s>$2</s>");

  // Finalize bold markers
  out = out.replace(/\x01B\x01/g, "<b>").replace(/\x01\/B\x01/g, "</b>");

  // Restore extracted tokens.
  out = out.replace(/\x00TOK(\d+)\x00/g, (_m, i) => tokens[Number(i)]);

  return out;
}

export class TelegramAdapter extends ChannelAdapter {
  constructor(config) {
    super("telegram", config);
    this.bot = null;
  }

  async start() {
    const { Bot, InputFile } = await import("grammy");

    if (!this.config.botToken) {
      throw new Error("Telegram botToken required");
    }

    this.bot = new Bot(this.config.botToken);

    // Slash commands handled inline so they short-circuit the regular handler
    // ── /pairforum: register the current group as the Yabby forum container
    //    so assign_agent can later auto-create one topic per agent in here.
    //    The group MUST have topics enabled and the bot MUST be admin.
    this.bot.command("pairforum", async (ctx) => {
      const userLang = (ctx.from?.language_code || "").split("-")[0].toLowerCase() || null;
      const m = serverMsg(userLang);
      try {
        const chatId = String(ctx.chat.id);
        const userId = String(ctx.from.id);
        const userName = ctx.from.first_name || ctx.from.username || "User";

        if (ctx.chat.type === "private") {
          await ctx.reply(m.pairforumDmError);
          return;
        }
        if (!ctx.chat.is_forum) {
          await ctx.reply(m.pairforumNotForumError);
          return;
        }

        // Verify the bot has the canManageTopics permission
        try {
          const me = await ctx.api.getChatMember(chatId, ctx.me.id);
          const canManageTopics = me?.can_manage_topics || me?.status === "creator" || me?.status === "administrator";
          if (!canManageTopics) {
            await ctx.reply(m.pairforumNoPermError);
            return;
          }
        } catch (err) {
          log(`[CHANNEL:telegram] /pairforum permission check failed: ${err.message}`);
        }

        const { setChannelContainer } = await import("../../db/queries/channel-containers.js");
        await setChannelContainer({
          channelName: "telegram",
          containerId: chatId,
          ownerUserId: userId,
          ownerUserName: userName,
          pairedBy: userName,
          metadata: { chat_title: ctx.chat.title || null },
        });
        await ctx.reply(m.pairforumSuccess);
        log(`[CHANNEL:telegram] /pairforum: container=${chatId} owner=${userId} (${userName})`);
      } catch (err) {
        log(`[CHANNEL:telegram] /pairforum failed: ${err.message}`);
        try { await ctx.reply(m.pairforumFailed(err.message)); } catch {}
      }
    });

    // Handle text messages
    this.bot.on("message:text", async (ctx) => {
      // Skip slash commands — handled by bot.command() above. Without this
      // skip, /pairforum would run twice (once as command, once as plain text
      // routed to the LLM handler).
      if (typeof ctx.message.text === "string" && ctx.message.text.startsWith("/")) return;

      // Forum topic awareness: when the user posts inside a forum topic, the
      // platform supplies message_thread_id. We compose it into the channel
      // threadId so the binding lookup (channel_thread_bindings.thread_id =
      // "<chat>:<topic>") finds the right agent.
      const topicId = ctx.message.message_thread_id ?? null;
      const composedThreadId = topicId !== null ? `${ctx.chat.id}:${topicId}` : null;

      const msg = normalize({
        channelName: "telegram",
        channelId: String(ctx.chat.id),
        userId: String(ctx.from.id),
        userName: ctx.from.first_name || ctx.from.username || "User",
        text: ctx.message.text,
        isGroup: ctx.chat.type !== "private",
        threadId: composedThreadId,
        platformMsgId: String(ctx.message.message_id),
        userLang: ctx.from.language_code || null,
      });

      await this._handleIncoming(msg);
    });

    // Handle voice messages
    this.bot.on("message:voice", async (ctx) => {
      await this._handleVoiceMessage(ctx);
    });

    // Handle audio files (sent as audio attachment, not voice note)
    this.bot.on("message:audio", async (ctx) => {
      await this._handleVoiceMessage(ctx);
    });

    // Forum topic awareness for media handlers — when the user posts inside
    // an agent's forum topic, message_thread_id must be composed into the
    // channel threadId so the binding lookup routes to the right agent.
    // Without this, photos/documents/videos sent in an agent topic fall
    // back to Yabby super-agent (same bug that hit voice/audio).
    const composeThreadId = (ctx) => {
      const topicId = ctx.message.message_thread_id ?? null;
      return topicId !== null ? `${ctx.chat.id}:${topicId}` : null;
    };

    // Handle photos
    this.bot.on("message:photo", async (ctx) => {
      const photo = ctx.message.photo;
      const best = photo[photo.length - 1]; // highest resolution
      const attachments = [{
        kind: "image", mime: "image/jpeg",
        platformRef: best.file_id,
        filename: null, sizeBytes: best.file_size || null, assetId: null,
      }];
      const msg = normalize({
        channelName: "telegram", channelId: String(ctx.chat.id),
        userId: String(ctx.from.id), userName: ctx.from.first_name || ctx.from.username || "User",
        text: ctx.message.caption || "", isGroup: ctx.chat.type !== "private",
        threadId: composeThreadId(ctx),
        platformMsgId: String(ctx.message.message_id), attachments,
      });
      await this._handleIncoming(msg);
    });

    // Handle documents (PDF, files, etc.)
    this.bot.on("message:document", async (ctx) => {
      const doc = ctx.message.document;
      const mime = doc.mime_type || "application/octet-stream";
      const kind = mime.startsWith("image/") ? "image" : mime === "application/pdf" ? "pdf" : "file";
      const attachments = [{
        kind, mime,
        platformRef: doc.file_id,
        filename: doc.file_name || null, sizeBytes: doc.file_size || null, assetId: null,
      }];
      const msg = normalize({
        channelName: "telegram", channelId: String(ctx.chat.id),
        userId: String(ctx.from.id), userName: ctx.from.first_name || ctx.from.username || "User",
        text: ctx.message.caption || "", isGroup: ctx.chat.type !== "private",
        threadId: composeThreadId(ctx),
        platformMsgId: String(ctx.message.message_id), attachments,
      });
      await this._handleIncoming(msg);
    });

    // Handle videos
    this.bot.on("message:video", async (ctx) => {
      const vid = ctx.message.video;
      const attachments = [{
        kind: "video", mime: vid.mime_type || "video/mp4",
        platformRef: vid.file_id,
        filename: vid.file_name || null, sizeBytes: vid.file_size || null, assetId: null,
      }];
      const msg = normalize({
        channelName: "telegram", channelId: String(ctx.chat.id),
        userId: String(ctx.from.id), userName: ctx.from.first_name || ctx.from.username || "User",
        text: ctx.message.caption || "", isGroup: ctx.chat.type !== "private",
        threadId: composeThreadId(ctx),
        platformMsgId: String(ctx.message.message_id), attachments,
      });
      await this._handleIncoming(msg);
    });

    // Error handler
    this.bot.catch((err) => {
      log(`[CHANNEL:telegram] Bot error:`, err.message);
    });

    // Start polling (non-blocking)
    this.bot.start({
      onStart: () => {
        this.running = true;
        log(`[CHANNEL:telegram] Bot polling started (text + voice)`);
      },
    });
  }

  async _handleVoiceMessage(ctx) {
    try {
      log("[CHANNEL:telegram] Voice/audio message received, downloading...");

      // Get file info — voice messages use ctx.message.voice, audio uses ctx.message.audio
      const fileObj = ctx.message.voice || ctx.message.audio;
      if (!fileObj) {
        log("[CHANNEL:telegram] No voice/audio object found");
        return;
      }

      // Download file via grammy
      const file = await ctx.getFile();
      const filePath = file.file_path;
      if (!filePath) {
        log("[CHANNEL:telegram] No file_path in Telegram response");
        return;
      }

      // Download the file bytes
      const fileUrl = `https://api.telegram.org/file/bot${this.config.botToken}/${filePath}`;
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download voice file: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Save to temp file
      const ext = filePath.endsWith(".oga") ? "ogg" : filePath.split(".").pop() || "ogg";
      const tempPath = join(tmpdir(), `telegram-voice-${Date.now()}.${ext}`);
      writeFileSync(tempPath, buffer);

      // Transcribe via Whisper
      const text = await transcribeAudio(tempPath);
      log(`[CHANNEL:telegram] Transcribed voice: "${text}"`);

      if (!text || !text.trim()) {
        log("[CHANNEL:telegram] Empty transcription, skipping");
        return;
      }

      // Forum topic awareness — same as text handler. Without this, a voice
      // message sent inside an agent's topic loses the topic id and falls
      // back to Yabby super-agent instead of routing to the agent.
      const topicId = ctx.message.message_thread_id ?? null;
      const composedThreadId = topicId !== null ? `${ctx.chat.id}:${topicId}` : null;

      const msg = normalize({
        channelName: "telegram",
        channelId: String(ctx.chat.id),
        userId: String(ctx.from.id),
        userName: ctx.from.first_name || ctx.from.username || "User",
        text,
        isGroup: ctx.chat.type !== "private",
        threadId: composedThreadId,
        platformMsgId: String(ctx.message.message_id),
        isAudio: true,
      });

      await this._handleIncoming(msg);
    } catch (err) {
      log(`[CHANNEL:telegram] Voice message error:`, err.message);
      log(`[CHANNEL:telegram] Stack:`, err.stack);
    }
  }

  async stop() {
    if (this.bot) {
      await this.bot.stop();
      this.bot = null;
    }
    this.running = false;
  }

  /**
   * Parse a "chatId" or composite "chatId:topicId" into the chat + optional
   * message_thread_id. Used by every send method so that any helper called
   * with a forum-topic-aware identifier delivers inside the right topic.
   * Bare chat IDs return { chatId, messageThreadId: null } and behave as
   * before.
   */
  _parseChannelId(channelId) {
    const s = String(channelId);
    const sep = s.indexOf(":");
    if (sep > 0) {
      const left = s.slice(0, sep);
      const right = s.slice(sep + 1);
      const topicNum = parseInt(right, 10);
      if (!Number.isNaN(topicNum)) {
        return { chatId: left, messageThreadId: topicNum };
      }
    }
    return { chatId: s, messageThreadId: null };
  }

  async send(channelId, text) {
    if (!this.bot) throw new Error("Telegram bot not running");
    if (!text) return;

    const { chatId: targetChatId, messageThreadId } = this._parseChannelId(channelId);

    const sendChunk = async (chunk) => {
      const html = markdownToTelegramHtml(chunk);
      const baseOpts = {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      };
      if (messageThreadId !== null) baseOpts.message_thread_id = messageThreadId;
      try {
        await this.bot.api.sendMessage(targetChatId, html, baseOpts);
      } catch (err) {
        log(`[CHANNEL:telegram] HTML send failed (${err.message}), falling back to plain text`);
        try {
          const plainOpts = messageThreadId !== null ? { message_thread_id: messageThreadId } : undefined;
          await this.bot.api.sendMessage(targetChatId, chunk, plainOpts);
        } catch (err2) {
          log(`[CHANNEL:telegram] Plain send also failed: ${err2.message}`);
          throw err2;
        }
      }
    };

    // Telegram has a 4096 char limit per message
    if (text.length <= 4096) {
      await sendChunk(text);
    } else {
      const chunks = text.match(/[\s\S]{1,4096}/g) || [text];
      for (const chunk of chunks) await sendChunk(chunk);
    }
  }

  async sendAudio(channelId, audioBuffer) {
    if (!this.bot) throw new Error("Telegram bot not running");

    log(`[CHANNEL:telegram] Sending voice message (${audioBuffer.length} bytes)`);

    const { InputFile } = await import("grammy");
    const { chatId, messageThreadId } = this._parseChannelId(channelId);

    // Telegram expects OGG/Opus for voice messages
    await this.bot.api.sendVoice(chatId, new InputFile(audioBuffer, "voice.ogg"), {
      ...(messageThreadId !== null ? { message_thread_id: messageThreadId } : {}),
    });

    log("[CHANNEL:telegram] Voice message sent");
  }

  makeMediaFetcher(ref) {
    const self = this;
    return async () => {
      const file = await self.bot.api.getFile(ref.platformRef); // platformRef = file_id
      const fileUrl = `https://api.telegram.org/file/bot${self.config.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) throw new Error(`Telegram file download failed: ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      return { buffer, mime: ref.mime, filename: ref.filename };
    };
  }

  async sendImage(channelId, opts = {}) {
    if (!this.bot) throw new Error("Telegram bot not running");
    const { chatId, messageThreadId } = this._parseChannelId(channelId);
    const { buffer: buf, mime, filename } = await this._resolveMedia(opts);
    const { InputFile } = await import("grammy");
    const sendOpts = {
      ...(opts.caption ? { caption: markdownToTelegramHtml(opts.caption), parse_mode: "HTML" } : {}),
      ...(messageThreadId !== null ? { message_thread_id: messageThreadId } : {}),
    };
    await this.bot.api.sendPhoto(chatId, new InputFile(buf, filename || "image.png"), sendOpts);
    log(`[CHANNEL:telegram] ✓ Image sent (${buf.length} bytes)`);
  }

  async sendDocument(channelId, opts = {}) {
    if (!this.bot) throw new Error("Telegram bot not running");
    const { chatId, messageThreadId } = this._parseChannelId(channelId);
    const { buffer: buf, mime, filename } = await this._resolveMedia(opts);
    const { InputFile } = await import("grammy");

    // Defensive routing: if a caller passes a video/audio MIME to sendDocument
    // (instead of going via the handler-level routing), delegate internally to
    // the dedicated send methods so we don't lose inline preview/playback.
    if (mime?.startsWith("video/")) {
      return this.sendVideo(channelId, opts);
    }

    const sendOpts = {
      ...(opts.caption ? { caption: markdownToTelegramHtml(opts.caption), parse_mode: "HTML" } : {}),
      ...(messageThreadId !== null ? { message_thread_id: messageThreadId } : {}),
    };

    if (mime?.startsWith("audio/")) {
      await this.bot.api.sendAudio(chatId, new InputFile(buf, filename || "audio.mp3"), sendOpts);
      log(`[CHANNEL:telegram] ✓ Audio sent (${buf.length} bytes)`);
      return;
    }

    await this.bot.api.sendDocument(chatId, new InputFile(buf, filename || "document"), sendOpts);
    log(`[CHANNEL:telegram] ✓ Document sent (${buf.length} bytes)`);
  }

  async sendVideo(channelId, opts = {}) {
    if (!this.bot) throw new Error("Telegram bot not running");
    const { chatId, messageThreadId } = this._parseChannelId(channelId);
    const { buffer: buf, mime, filename } = await this._resolveMedia(opts);
    const { InputFile } = await import("grammy");
    const baseOpts = {
      ...(opts.caption ? { caption: markdownToTelegramHtml(opts.caption), parse_mode: "HTML" } : {}),
      ...(messageThreadId !== null ? { message_thread_id: messageThreadId } : {}),
    };
    // Telegram's sendVideo accepts mp4 natively; other containers (mov/webm)
    // are better off going through sendDocument so Telegram doesn't silently
    // drop them. The handler already routes on kind, but double-guard here.
    if (mime && mime !== "video/mp4" && mime !== "video/quicktime") {
      await this.bot.api.sendDocument(chatId, new InputFile(buf, filename || "video"), baseOpts);
      log(`[CHANNEL:telegram] ✓ Video sent as document (${mime}, ${buf.length} bytes)`);
      return;
    }
    await this.bot.api.sendVideo(chatId, new InputFile(buf, filename || "video.mp4"), {
      ...baseOpts,
      supports_streaming: true,
    });
    log(`[CHANNEL:telegram] ✓ Video sent (${buf.length} bytes)`);
  }

  /**
   * Send an animated GIF. Telegram plays these natively as inline animations.
   * Accepts .gif, .mp4 (short silent video), and image/gif mime.
   */
  async sendAnimation(channelId, opts = {}) {
    if (!this.bot) throw new Error("Telegram bot not running");
    const { chatId, messageThreadId } = this._parseChannelId(channelId);
    const { buffer: buf, mime, filename } = await this._resolveMedia(opts);
    const { InputFile } = await import("grammy");
    await this.bot.api.sendAnimation(chatId, new InputFile(buf, filename || "animation.gif"), {
      ...(opts.caption ? { caption: markdownToTelegramHtml(opts.caption), parse_mode: "HTML" } : {}),
      ...(messageThreadId !== null ? { message_thread_id: messageThreadId } : {}),
    });
    log(`[CHANNEL:telegram] ✓ Animation sent (${buf.length} bytes, mime=${mime || 'unknown'})`);
  }

  async _resolveMedia(opts) {
    let buf = opts.buffer;
    let mime = opts.mime || null;
    let filename = opts.filename || null;
    if (opts.assetId && !buf) {
      const { read } = await import("../media/store.js");
      const asset = await read(opts.assetId);
      if (!asset) throw new Error(`Media asset ${opts.assetId} not found`);
      buf = asset.buffer;
      mime = asset.row?.mime || mime;
      filename = filename || `file.${asset.row?.mime?.split("/")[1] || "bin"}`;
    }
    if (!buf) throw new Error("No buffer or assetId provided");
    return { buffer: buf, mime, filename };
  }
}
