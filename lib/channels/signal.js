/* ═══════════════════════════════════════════════════════
   Signal Adapter (signal-cli-rest-api)
   ═══════════════════════════════════════════════════════
   Connects to a signal-cli-rest-api instance (Docker).
   Receives via WebSocket (json-rpc mode) or polling.
   Sends via POST /v2/send.
   Supports voice messages (inbound transcription + outbound audio).

   Config:
     apiUrl:       "http://localhost:8080"
     phoneNumber:  "+33612345678"  (E.164 format)
     mode:         "websocket" | "polling"  (default: websocket)
     pollInterval: 5000  (ms, only for polling mode)
*/

import { ChannelAdapter } from "./base.js";
import { normalize } from "./normalize.js";
import { log } from "../logger.js";
import { transcribeAudio } from "../whisper.js";
import { unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execSync } from "child_process";

export class SignalAdapter extends ChannelAdapter {
  constructor(config) {
    super("signal", config);
    this._ws = null;
    this._pollTimer = null;
    this._reconnectTimer = null;
  }

  async start() {
    if (!this.config.apiUrl) throw new Error("Signal apiUrl required");
    if (!this.config.phoneNumber) throw new Error("Signal phoneNumber required");

    // Verify the API is reachable
    try {
      const res = await fetch(`${this.config.apiUrl}/v1/about`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const about = await res.json();
      log(`[CHANNEL:signal] API connected — version: ${about.versions?.["signal-cli"] || "unknown"}`);
    } catch (err) {
      throw new Error(`Signal API not reachable at ${this.config.apiUrl}: ${err.message}`);
    }

    // Verify the phone number is registered
    try {
      const res = await fetch(`${this.config.apiUrl}/v1/accounts`);
      if (res.ok) {
        const accounts = await res.json();
        const registered = Array.isArray(accounts)
          ? accounts.some(a => a === this.config.phoneNumber || a.number === this.config.phoneNumber)
          : false;
        if (!registered) {
          log(`[CHANNEL:signal] WARNING: ${this.config.phoneNumber} not found in registered accounts. You may need to register or link this number.`);
        }
      }
    } catch {}

    const mode = this.config.mode || "websocket";
    if (mode === "websocket") {
      await this._startWebSocket();
    } else {
      this._startPolling();
    }

    this.running = true;
    log(`[CHANNEL:signal] Started (${mode} mode, text + voice)`);
  }

  async _startWebSocket() {
    const { default: WebSocket } = await import("ws");
    const wsUrl = this.config.apiUrl.replace(/^http/, "ws");
    const endpoint = `${wsUrl}/v1/receive/${encodeURIComponent(this.config.phoneNumber)}`;

    this._ws = new WebSocket(endpoint);

    this._ws.on("open", () => {
      log("[CHANNEL:signal] WebSocket connected");
    });

    this._ws.on("message", async (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        await this._processEnvelope(parsed);
      } catch (err) {
        log(`[CHANNEL:signal] WebSocket message parse error:`, err.message);
      }
    });

    this._ws.on("close", () => {
      log("[CHANNEL:signal] WebSocket closed, reconnecting in 5s...");
      this._reconnectTimer = setTimeout(() => {
        if (this.running) this._startWebSocket().catch(err => {
          log(`[CHANNEL:signal] Reconnect failed:`, err.message);
        });
      }, 5000);
    });

    this._ws.on("error", (err) => {
      log(`[CHANNEL:signal] WebSocket error:`, err.message);
    });
  }

  _startPolling() {
    const interval = this.config.pollInterval || 5000;
    this._pollTimer = setInterval(async () => {
      try {
        const res = await fetch(
          `${this.config.apiUrl}/v1/receive/${encodeURIComponent(this.config.phoneNumber)}`
        );
        if (!res.ok) return;
        const messages = await res.json();
        if (!Array.isArray(messages)) return;

        for (const msg of messages) {
          await this._processEnvelope(msg);
        }
      } catch (err) {
        log(`[CHANNEL:signal] Poll error:`, err.message);
      }
    }, interval);
  }

  async _processEnvelope(data) {
    const envelope = data.envelope || data;
    if (!envelope) return;

    // Prefer phone number, fall back to UUID for routing
    const sourceNumber = envelope.sourceNumber || null;
    const sourceUuid = envelope.sourceUuid || envelope.source || null;
    const sourceId = sourceNumber || sourceUuid;
    const sourceName = envelope.sourceName || sourceId;
    log(`[CHANNEL:signal] Envelope: number=${sourceNumber}, uuid=${sourceUuid}, name=${envelope.sourceName}`);
    if (!sourceId) return;

    // Determine if group message
    const groupId = envelope.dataMessage?.groupInfo?.groupId || null;
    const isGroup = !!groupId;
    const channelId = isGroup ? `group.${groupId}` : sourceId;

    // Check for voice/audio attachments
    const attachments = envelope.dataMessage?.attachments || [];
    const audioAttachment = attachments.find(
      (a) => a.contentType?.startsWith("audio/")
    );

    if (audioAttachment) {
      await this._handleVoiceMessage(envelope, audioAttachment, channelId, sourceId, sourceName, isGroup);
      return;
    }

    // Extract non-audio attachments (images, documents, etc.)
    const mediaAttachments = [];
    for (const a of attachments) {
      if (a.contentType?.startsWith("audio/")) continue; // already handled
      const mime = a.contentType || "application/octet-stream";
      const kind = mime.startsWith("image/") ? "image"
        : mime.startsWith("video/") ? "video"
        : mime === "application/pdf" ? "pdf"
        : "file";
      mediaAttachments.push({
        kind, mime,
        platformRef: a.id, // signal-cli attachment ID for download
        filename: a.filename || null,
        sizeBytes: a.size || null,
        assetId: null,
      });
    }

    // Extract text message
    const text = envelope.dataMessage?.message;
    if (!text && mediaAttachments.length === 0) return;

    const msg = normalize({
      channelName: "signal",
      channelId,
      userId: sourceId,
      userName: sourceName,
      text: text || "",
      isGroup,
      platformMsgId: String(envelope.timestamp || Date.now()),
      attachments: mediaAttachments,
    });

    await this._handleIncoming(msg);
  }

  async _handleVoiceMessage(envelope, attachment, channelId, sourceId, sourceName, isGroup) {
    let tempPath = null;

    try {
      log(`[CHANNEL:signal] Voice/audio attachment received: ${attachment.contentType} (${attachment.size || '?'} bytes)`);

      // signal-cli-rest-api stores attachments and provides an ID
      const attachmentId = attachment.id;
      if (!attachmentId) {
        log("[CHANNEL:signal] No attachment ID, cannot download");
        return;
      }

      // Download attachment from signal-cli-rest-api
      const downloadUrl = `${this.config.apiUrl}/v1/attachments/${attachmentId}`;
      const response = await fetch(downloadUrl);
      if (!response.ok) {
        throw new Error(`Failed to download attachment: ${response.status}`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      // Save to temp file
      const ext = attachment.contentType?.includes("ogg") ? "ogg"
        : attachment.contentType?.includes("aac") ? "m4a"
        : attachment.contentType?.includes("mp4") ? "m4a"
        : attachment.contentType?.includes("mpeg") ? "mp3"
        : "ogg";
      const rawPath = join(tmpdir(), `signal-voice-raw-${Date.now()}.${ext}`);
      writeFileSync(rawPath, buffer);

      // Convert to mp3 via ffmpeg for reliable Whisper compatibility
      tempPath = join(tmpdir(), `signal-voice-${Date.now()}.mp3`);
      try {
        execSync(`ffmpeg -y -i "${rawPath}" -ar 16000 -ac 1 "${tempPath}"`, { stdio: "ignore" });
      } catch (convErr) {
        log(`[CHANNEL:signal] ffmpeg conversion failed, using raw file`);
        tempPath = rawPath;
      }
      try { unlinkSync(rawPath); } catch {}

      // Transcribe via Whisper
      const text = await transcribeAudio(tempPath);
      log(`[CHANNEL:signal] Transcribed voice: "${text}"`);

      if (!text || !text.trim()) {
        log("[CHANNEL:signal] Empty transcription, skipping");
        return;
      }

      const msg = normalize({
        channelName: "signal",
        channelId,
        userId: sourceId,
        userName: sourceName,
        text,
        isGroup,
        platformMsgId: String(envelope.timestamp || Date.now()),
        isAudio: true,
      });

      await this._handleIncoming(msg);
    } catch (err) {
      log(`[CHANNEL:signal] Voice message error:`, err.message);
      log(`[CHANNEL:signal] Stack:`, err.stack);
    } finally {
      if (tempPath) {
        try { unlinkSync(tempPath); } catch (_err) { /* ignore */ }
      }
    }
  }

  async stop() {
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.running = false;
  }

  async getQrLink() {
    try {
      const res = await fetch(`${this.config.apiUrl}/v1/qrcodelink?device_name=Yabby`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // The endpoint returns a PNG image, but we need the URI for client-side QR rendering
      // Try the JSON endpoint first
      const textRes = await fetch(`${this.config.apiUrl}/v1/qrcodelink?device_name=Yabby`, {
        headers: { "Accept": "application/json" }
      });
      if (textRes.ok) {
        const contentType = textRes.headers.get("content-type") || "";
        if (contentType.includes("json")) {
          const data = await textRes.json();
          return data.uri || data.link || null;
        }
      }
      // Fallback: return the image URL for direct embedding
      return `${this.config.apiUrl}/v1/qrcodelink?device_name=Yabby`;
    } catch (err) {
      log(`[CHANNEL:signal] QR link error: ${err.message}`);
      return null;
    }
  }

  async send(channelId, text) {
    const recipients = [];
    if (channelId.startsWith("group.")) {
      recipients.push(channelId.replace("group.", ""));
    } else {
      recipients.push(channelId);
    }

    const body = {
      message: text,
      number: this.config.phoneNumber,
      recipients,
    };

    const res = await fetch(`${this.config.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Signal send failed (${res.status}): ${errText}`);
    }
  }

  async sendAudio(channelId, audioInput) {
    const audioBuffer = audioInput?.audio || audioInput;

    log(`[CHANNEL:signal] Sending voice message (${audioBuffer.length} bytes)`);

    // signal-cli-rest-api supports base64 attachments in /v2/send
    const base64Audio = audioBuffer.toString("base64");

    const recipients = [];
    if (channelId.startsWith("group.")) {
      recipients.push(channelId.replace("group.", ""));
    } else {
      recipients.push(channelId);
    }

    const body = {
      number: this.config.phoneNumber,
      recipients,
      message: "",
      base64_attachments: [`data:audio/mpeg;filename=voice-reply.mp3;base64,${base64Audio}`],
    };

    const res = await fetch(`${this.config.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Signal sendAudio failed (${res.status}): ${errText}`);
    }

    log("[CHANNEL:signal] Voice message sent");
  }

  makeMediaFetcher(ref) {
    const self = this;
    return async () => {
      const resp = await fetch(`${self.config.apiUrl}/v1/attachments/${ref.platformRef}`);
      if (!resp.ok) throw new Error(`Signal attachment download failed: ${resp.status}`);
      const buffer = Buffer.from(await resp.arrayBuffer());
      return { buffer, mime: ref.mime, filename: ref.filename };
    };
  }

  async sendImage(channelId, opts = {}) {
    const { buffer: buf, mime, filename } = await this._resolveMedia(opts);
    const base64 = buf.toString("base64");
    const mimeType = mime || "image/png";

    const recipients = [];
    if (channelId.startsWith("group.")) {
      recipients.push(channelId.replace("group.", ""));
    } else {
      recipients.push(channelId);
    }

    const body = {
      number: this.config.phoneNumber,
      recipients,
      message: opts.caption || "",
      base64_attachments: [`data:${mimeType};filename=${filename || "image.png"};base64,${base64}`],
    };

    const res = await fetch(`${this.config.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Signal sendImage failed (${res.status}): ${errText}`);
    }
    log(`[CHANNEL:signal] ✓ Image sent (${buf.length} bytes)`);
  }

  async sendDocument(channelId, opts = {}) {
    const { buffer: buf, mime, filename } = await this._resolveMedia(opts);
    const base64 = buf.toString("base64");
    const mimeType = mime || "application/octet-stream";

    const recipients = [];
    if (channelId.startsWith("group.")) {
      recipients.push(channelId.replace("group.", ""));
    } else {
      recipients.push(channelId);
    }

    const body = {
      number: this.config.phoneNumber,
      recipients,
      message: opts.caption || "",
      base64_attachments: [`data:${mimeType};filename=${filename || "document"};base64,${base64}`],
    };

    const res = await fetch(`${this.config.apiUrl}/v2/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Signal sendDocument failed (${res.status}): ${errText}`);
    }
    log(`[CHANNEL:signal] ✓ Document sent (${buf.length} bytes)`);
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
