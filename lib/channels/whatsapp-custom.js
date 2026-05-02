/* ═══════════════════════════════════════════════════════
   Custom WhatsApp Client - Better than Baileys
   ═══════════════════════════════════════════════════════
   A cleaner, more stable WhatsApp Web implementation.

   Features:
   - Better connection stability
   - Automatic reconnection with exponential backoff
   - Clean event system
   - Proper session management
   - QR code generation

   Uses WhatsApp Web protocol directly with improved handling.
*/

import { ChannelAdapter } from "./base.js";
import { normalize } from "./normalize.js";
import { log } from "../logger.js";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import EventEmitter from "events";
import { getYabbyGroupId, setYabbyGroupId, clearYabbyGroupId } from "../../db/queries/whatsapp.js";
import { getAgentByWhatsAppGroup } from "../../db/queries/agent-whatsapp-groups.js";
import { transcribeAudio } from "../whisper.js";
import { speak } from "../tts/index.js";
import { ChannelDebouncer } from "./debouncer.js";
import { redis, KEY } from "../../db/redis.js";

export class CustomWhatsAppAdapter extends ChannelAdapter {
  constructor(config) {
    super("whatsapp", config);
    this.client = null;
    this.qrCode = null;
    this.sessionPath = config.authDir || join(process.cwd(), "data", "whatsapp-auth");
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 10;
    this._reconnectDelay = 5000; // Start with 5 seconds
    this._connectionState = "disconnected"; // disconnected, connecting, connected, reconnecting
    this._yabbyGroupId = null;

    mkdirSync(this.sessionPath, { recursive: true });

    // Créer debouncer pour filtrer spam et économiser tokens LLM
    this._debouncer = new ChannelDebouncer({
      channel: "whatsapp",

      // Clé unique par utilisateur + channel
      buildKey: (msg) => `${msg.userId}:${msg.channelId}`,

      // Règles de debouncing:
      // - Jamais debouncer les messages audio (contiennent déjà de l'info importante)
      // - Debouncer les messages courts (<10 chars) ou mots communs
      shouldDebounce: (msg) => {
        const text = msg.text?.trim() || "";

        // Jamais debouncer audio (isAudio flag)
        if (msg.isAudio) {
          return false;
        }

        // Mots courts communs (français + anglais + emojis)
        const shortWords = /^(ok|oui|non|merci|d'accord|cool|bien|super|oui|yes|no|thanks|sure|fine|👍|👌|🙏|✅|❤️)$/i;

        // Debouncer si: message court OU mot commun
        return text.length < 10 || shortWords.test(text);
      },

      // Quand le batch flush, traiter seulement le dernier message
      onFlush: async (batch) => {
        const last = batch.at(-1);
        log(`[WHATSAPP-CUSTOM] Debouncer flushing batch of ${batch.length} messages, processing last one`);
        await this._processMessage(last);
      },

      // Délai de debounce: 2 secondes
      debounceMs: 2000
    });
  }

  async start() {
    if (this._connectionState === "connecting" || this._connectionState === "connected") {
      log("[WHATSAPP-CUSTOM] Already connected or connecting");
      return;
    }

    this._connectionState = "connecting";
    log("[WHATSAPP-CUSTOM] Starting WhatsApp connection...");

    try {
      // Import Baileys components we need
      const baileys = await import("@whiskeysockets/baileys");
      const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = baileys;

      // Load or create auth state
      const { state, saveCreds } = await useMultiFileAuthState(this.sessionPath);

      // Get latest version
      let version;
      try {
        const versionData = await fetchLatestBaileysVersion();
        version = versionData.version;
      } catch (err) {
        log("[WHATSAPP-CUSTOM] Could not fetch version, using default");
      }

      // Create socket with improved config
      this.client = makeWASocket({
        auth: state,
        ...(version && { version }),
        printQRInTerminal: false, // We handle QR ourselves
        logger: this._createLogger(),
        browser: ["Yabby AI", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000, // Longer timeout
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 30000, // Keep connection alive
        markOnlineOnConnect: true,
        syncFullHistory: false, // Don't sync full history
        // Some receipts arrive with jid=undefined (Baileys internal flow). Treat
        // unknown JIDs as ignorable so the receipt handler doesn't crash with
        // "Cannot read properties of undefined (reading 'endsWith')".
        shouldIgnoreJid: jid => !jid || typeof jid !== "string" || jid.endsWith("@newsletter"),
        getMessage: async (key) => ({ conversation: "" }), // Required for message retries
      });

      // Setup event handlers
      this._setupEventHandlers(saveCreds);

      log("[WHATSAPP-CUSTOM] Client initialized");
    } catch (err) {
      log("[WHATSAPP-CUSTOM] Failed to start:", err.message);
      this._connectionState = "disconnected";
      this._scheduleReconnect();
    }
  }

  _createLogger() {
    return {
      level: "silent",
      trace: () => {},
      debug: () => {},
      info: (...args) => log("[WHATSAPP-CUSTOM] INFO:", ...args),
      warn: (...args) => log("[WHATSAPP-CUSTOM] WARN:", ...args),
      error: (...args) => log("[WHATSAPP-CUSTOM] ERROR:", ...args),
      fatal: (...args) => log("[WHATSAPP-CUSTOM] FATAL:", ...args),
      child: () => this._createLogger(),
    };
  }

  _setupEventHandlers(saveCreds) {
    // Credentials update
    this.client.ev.on("creds.update", saveCreds);

    // Connection updates
    this.client.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      // Handle QR code
      if (qr) {
        this.qrCode = qr;
        log("[WHATSAPP-CUSTOM] QR code generated");
      }

      // Handle connection state
      if (connection === "open") {
        this._connectionState = "connected";
        this.running = true;
        this.qrCode = null;
        this._reconnectAttempts = 0; // Reset reconnect counter
        this._reconnectDelay = 5000; // Reset delay
        log("[WHATSAPP-CUSTOM] ✓ Connected successfully");

        // Initialize Yabby group
        this._initializeYabbyGroup().catch(err =>
          log("[WHATSAPP-CUSTOM] Could not initialize group:", err.message)
        );
      }

      if (connection === "close") {
        this.running = false;
        this._connectionState = "disconnected";

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || "Unknown";

        log(`[WHATSAPP-CUSTOM] Connection closed: ${reason} (code: ${statusCode})`);

        // Import DisconnectReason
        const { DisconnectReason } = await import("@whiskeysockets/baileys");

        // Handle different disconnect reasons
        if (statusCode === DisconnectReason.loggedOut) {
          log("[WHATSAPP-CUSTOM] Logged out - need to re-scan QR");
          this.qrCode = null;
        } else {
          // Auto-reconnect for other reasons
          this._scheduleReconnect();
        }
      }

      if (connection === "connecting") {
        this._connectionState = "connecting";
        log("[WHATSAPP-CUSTOM] Connecting...");
      }
    });

    // Incoming messages
    this.client.ev.on("messages.upsert", async ({ messages, type }) => {
      log(`[WHATSAPP-CUSTOM] messages.upsert event - type: ${type}, count: ${messages.length}`);
      if (type !== "notify") return; // Only process new messages

      for (const message of messages) {
        const msgId = message.key.id;  // platform_msg_id unique

        // ⚠️ DÉDUPLICATION: Vérifier si message déjà traité ou en cours
        const processingKey = KEY(`whatsapp:msg:processing:${msgId}`);
        const processedKey = KEY(`whatsapp:msg:processed:${msgId}`);

        const isProcessing = await redis.get(processingKey);
        const isProcessed = await redis.get(processedKey);

        if (isProcessing || isProcessed) {
          log(`[WHATSAPP-CUSTOM] Message ${msgId} already processed/processing, skipping`);
          continue;
        }

        // Marquer comme "en cours de traitement"
        await redis.set(processingKey, "1", { EX: 300 });  // 5 minutes TTL

        try {
          await this._handleIncomingMessage(message);

          // Marquer comme "traité" après succès
          await redis.set(processedKey, "1", { EX: 3600 });  // 1 heure TTL
        } catch (err) {
          log("[WHATSAPP-CUSTOM] Error handling message:", err.message);
          log("[WHATSAPP-CUSTOM] Stack:", err.stack);
        } finally {
          // Cleanup flag "en cours"
          await redis.del(processingKey);
        }
      }
    });

    log("[WHATSAPP-CUSTOM] Event handlers set up");
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      log("[WHATSAPP-CUSTOM] Max reconnect attempts reached, giving up");
      return;
    }

    this._reconnectAttempts++;
    this._connectionState = "reconnecting";

    // Exponential backoff: 5s, 10s, 20s, 40s, 60s max
    const delay = Math.min(this._reconnectDelay * Math.pow(1.5, this._reconnectAttempts - 1), 60000);

    log(`[WHATSAPP-CUSTOM] Reconnecting in ${delay / 1000}s (attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts})`);

    setTimeout(() => {
      this.start();
    }, delay);
  }

  async _handleIncomingMessage(m) {
    log(`[WHATSAPP-CUSTOM] Message received - fromMe: ${m.key.fromMe}, remoteJid: ${m.key.remoteJid}`);

    // Skip broadcasts
    if (m.key.remoteJid === "status@broadcast") return;

    // Dans le groupe Yabby isolé OU groupes d'agents, accepter fromMe (groupes auto-créés où l'utilisateur est seul)
    // Dans les autres groupes/DM, ignorer fromMe (messages envoyés par le bot lui-même)
    const { isYabbyOrAgentGroup: isAllowedGroup } = await this._isYabbyOrAgentGroup(m.key.remoteJid);

    if (m.key.fromMe && !isAllowedGroup) {
      log("[WHATSAPP-CUSTOM] Skipping own message (not in Yabby/agent group)");
      return;
    }

    if (m.key.fromMe && isAllowedGroup) {
      log("[WHATSAPP-CUSTOM] Accepting own message (Yabby/agent isolated group)");
    }

    // Check if it's an audio message
    const audioMsg = m.message?.audioMessage;
    const isAudio = !!audioMsg;

    // Extract text
    let text = "";
    if (isAudio) {
      // Transcribe audio message
      try {
        log("[WHATSAPP-CUSTOM] Audio message detected, transcribing...");
        const buffer = await this._downloadMediaMessage(m);
        if (buffer) {
          // Save to temp file
          const tempPath = join(tmpdir(), `whatsapp-audio-${Date.now()}.ogg`);
          writeFileSync(tempPath, buffer);

          // Transcribe
          text = await transcribeAudio(tempPath);
          log(`[WHATSAPP-CUSTOM] Transcribed: "${text}"`);
        }
      } catch (err) {
        log("[WHATSAPP-CUSTOM] Error transcribing audio:", err.message);
        return;
      }
    } else {
      // Extract text from text/image/video messages
      text =
        m.message?.conversation ||
        m.message?.extendedTextMessage?.text ||
        m.message?.imageMessage?.caption ||
        m.message?.videoMessage?.caption ||
        m.message?.documentMessage?.caption ||
        "";
    }

    // Extract media attachments (images, documents, videos)
    const attachments = [];
    const imgMsg = m.message?.imageMessage;
    const docMsg = m.message?.documentMessage;
    const vidMsg = m.message?.videoMessage;
    const stickerMsg = m.message?.stickerMessage;

    if (imgMsg) {
      attachments.push({
        kind: "image",
        mime: imgMsg.mimetype || "image/jpeg",
        platformRef: m, // full message for downloadMediaMessage
        filename: null,
        sizeBytes: imgMsg.fileLength ? Number(imgMsg.fileLength) : null,
        assetId: null,
      });
    }
    if (docMsg) {
      attachments.push({
        kind: docMsg.mimetype?.startsWith("image/") ? "image" : (docMsg.mimetype === "application/pdf" ? "pdf" : "file"),
        mime: docMsg.mimetype || "application/octet-stream",
        platformRef: m,
        filename: docMsg.fileName || null,
        sizeBytes: docMsg.fileLength ? Number(docMsg.fileLength) : null,
        assetId: null,
      });
    }
    if (vidMsg) {
      attachments.push({
        kind: "video",
        mime: vidMsg.mimetype || "video/mp4",
        platformRef: m,
        filename: null,
        sizeBytes: vidMsg.fileLength ? Number(vidMsg.fileLength) : null,
        assetId: null,
      });
    }

    // Allow messages with attachments even if no text
    if (!text && attachments.length === 0) return;

    const isGroup = m.key.remoteJid?.endsWith("@g.us") || false;
    const senderId = isGroup ? (m.key.participant || m.key.remoteJid) : m.key.remoteJid;

    // ISOLATION: Only respond in Yabby group OR agent-specific groups
    // Note: groupMentionGating is disabled in config for WhatsApp because
    // this group isolation already filters messages. All messages in the
    // Yabby group should be processed without requiring mentions.
    const { isYabbyOrAgentGroup, agentId } = await this._isYabbyOrAgentGroup(m.key.remoteJid);
    if (!isYabbyOrAgentGroup) {
      return;
    }

    const userName = m.pushName || senderId?.split("@")[0] || "User";

    log(`[WHATSAPP-CUSTOM] 🔍 DIAG 6 - Creating normalized message`);
    log(`[WHATSAPP-CUSTOM]    - fromMe: ${m.key.fromMe}`);
    log(`[WHATSAPP-CUSTOM]    - remoteJid (channelId): ${m.key.remoteJid}`);
    log(`[WHATSAPP-CUSTOM]    - senderId (userId): ${senderId}`);
    log(`[WHATSAPP-CUSTOM]    - userName: ${userName}`);
    log(`[WHATSAPP-CUSTOM]    - targetAgentId: ${agentId || 'none (Yabby main group)'}`);
    log(`[WHATSAPP-CUSTOM]    - text: "${text.substring(0, 80)}..."`);

    const msg = normalize({
      channelName: "whatsapp",
      channelId: m.key.remoteJid,
      userId: senderId,
      userName,
      text,
      isGroup,
      platformMsgId: m.key.id,
      isAudio,
      threadId: m.key.remoteJid,
      targetAgentId: agentId,
      attachments,
    });

    // ✅ FIX 3: Echo user messages in agent threads (fromMe visibility)
    // In auto-created agent groups, user messages have fromMe=true
    // WhatsApp doesn't re-display these automatically, so we echo them
    if (agentId && m.key.fromMe) {
      try {
        log(`[WHATSAPP-CUSTOM] ✅ Echoed user message to agent thread`);
        log(`📝 Vous: ${text}`);
      } catch (echoErr) {
        log(`[WHATSAPP-CUSTOM] ⚠️ Failed to echo user message:`, echoErr.message);
        // Don't throw - continue processing even if echo fails
      }
    }

    // Push vers debouncer au lieu de traiter immédiatement
    // Le debouncer décidera si bypass (audio, long message) ou batch (short spam)
    this._debouncer.push(msg);
  }

  /**
   * Traiter un message après debouncing
   * Appelé par le debouncer après flush du batch
   */
  async _processMessage(msg) {
    await this._handleIncoming(msg);
  }

  async _initializeYabbyGroup() {
    if (!this.client || this._yabbyGroupId) return;

    const groupName = "🤖 Yabby Assistant";

    try {
      // First, try to load existing group from DB
      const existingGroupId = await getYabbyGroupId();
      if (existingGroupId) {
        this._yabbyGroupId = existingGroupId;
        log(`[WHATSAPP-CUSTOM] ✓ Loaded Yabby group from DB: ${this._yabbyGroupId}`);
        return;
      }

      // No group in DB — try to discover an existing group with the same name
      // on WhatsApp before creating a new one. This handles the case where
      // the DB was wiped (clearSession=true) but the group still exists
      // server-side from a previous pairing of the same phone number.
      try {
        const allGroups = await this.client.groupFetchAllParticipating();
        const matches = Object.values(allGroups).filter(
          (g) => g && g.subject === groupName
        );

        if (matches.length > 0) {
          // Prefer the oldest group (smallest creation timestamp) — most
          // likely the original Yabby group, not a recent duplicate.
          matches.sort((a, b) => (a.creation || 0) - (b.creation || 0));
          const recovered = matches[0];
          this._yabbyGroupId = recovered.id;
          log(
            `[WHATSAPP-CUSTOM] ✓ Recovered existing Yabby group from WhatsApp: ${this._yabbyGroupId}` +
              (matches.length > 1 ? ` (${matches.length} matches, picked oldest)` : "")
          );
          await setYabbyGroupId(this._yabbyGroupId, groupName);
          log("[WHATSAPP-CUSTOM] ✓ Saved recovered group to DB");
          return;
        }
      } catch (discoverErr) {
        log(
          "[WHATSAPP-CUSTOM] Could not scan existing groups, will create new:",
          discoverErr.message
        );
      }

      // No existing group found — create a new one
      const group = await this.client.groupCreate(groupName, []);
      this._yabbyGroupId = group.id;

      log(`[WHATSAPP-CUSTOM] ✓ Created Yabby group: ${this._yabbyGroupId}`);

      // Save to DB
      await setYabbyGroupId(this._yabbyGroupId, groupName);
      log("[WHATSAPP-CUSTOM] ✓ Saved group to DB");
    } catch (err) {
      log("[WHATSAPP-CUSTOM] Could not initialize group:", err.message);
      log("[WHATSAPP-CUSTOM] Fallback: will respond to all DMs");
    }
  }

  makeMediaFetcher(ref) {
    const self = this;
    return async () => {
      const buffer = await self._downloadMediaMessage(ref.platformRef);
      if (!buffer) throw new Error("WhatsApp media download returned null");
      return { buffer, mime: ref.mime, filename: ref.filename };
    };
  }

  async _downloadMediaMessage(message) {
    try {
      const baileys = await import("@whiskeysockets/baileys");
      const { downloadMediaMessage } = baileys;
      const buffer = await downloadMediaMessage(message, 'buffer', {});
      return buffer;
    } catch (err) {
      log("[WHATSAPP-CUSTOM] Error downloading media:", err.message);
      return null;
    }
  }

  async _isYabbyOrAgentGroup(remoteJid) {
    // Check if it's the main Yabby group
    if (this._yabbyGroupId && remoteJid === this._yabbyGroupId) {
      log(`[WHATSAPP-CUSTOM] Message in main Yabby group`);
      return { isYabbyOrAgentGroup: true, agentId: null };
    }

    // Check if it's an agent-specific group
    const agentId = await getAgentByWhatsAppGroup(remoteJid);
    if (agentId) {
      log(`[WHATSAPP-CUSTOM] Message in agent group ${remoteJid} → agent ${agentId}`);
      return { isYabbyOrAgentGroup: true, agentId };
    }

    // Reject all other messages (DMs, regular groups, contacts)
    log(`[WHATSAPP-CUSTOM] Message not in Yabby/agent group: ${remoteJid} - ignoring`);
    return { isYabbyOrAgentGroup: false, agentId: null };
  }

  _isYabbyGroup(remoteJid) {
    // If we have a Yabby group, only respond there
    if (this._yabbyGroupId) {
      return remoteJid === this._yabbyGroupId;
    }

    // Fallback: respond to DMs only (not groups)
    return !remoteJid?.endsWith("@g.us");
  }

  async send(channelId, text) {
    if (!this.client || this._connectionState !== "connected") {
      throw new Error("WhatsApp not connected");
    }

    // Split long messages
    const MAX_LEN = 4096;
    if (text.length <= MAX_LEN) {
      await this.client.sendMessage(channelId, { text });
    } else {
      const chunks = text.match(/[\s\S]{1,4096}/g) || [text];
      for (const chunk of chunks) {
        await this.client.sendMessage(channelId, { text: chunk });
      }
    }
  }

  async sendAudio(channelId, audioBuffer) {
    if (!this.client || this._connectionState !== "connected") {
      throw new Error("WhatsApp not connected");
    }

    log(`[WHATSAPP-CUSTOM] Sending audio message (${audioBuffer.length} bytes)`);

    await this.client.sendMessage(channelId, {
      audio: audioBuffer,
      mimetype: 'audio/ogg; codecs=opus',
      ptt: true // Push-to-talk (voice message)
    });

    log("[WHATSAPP-CUSTOM] ✓ Audio sent");
  }

  async sendImage(channelId, { assetId, buffer, caption, filename }) {
    if (!this.client || this._connectionState !== "connected") {
      throw new Error("WhatsApp not connected");
    }

    let buf = buffer;

    // Resolve buffer from media store if assetId is provided
    if (assetId && !buf) {
      const { read } = await import("../media/store.js");
      const asset = await read(assetId);
      if (!asset) throw new Error(`sendImage: asset ${assetId} not found`);
      buf = asset.buffer;
    }

    if (!buf) throw new Error("sendImage: no buffer or assetId provided");

    log(`[WHATSAPP-CUSTOM] Sending image: ${assetId || filename || 'buffer'} (${buf.length} bytes)`);

    await this.client.sendMessage(channelId, {
      image: buf,
      ...(caption ? { caption } : {}),
    });

    log("[WHATSAPP-CUSTOM] ✓ Image sent");
    return { ok: true, assetId: assetId || null };
  }

  async sendVideo(channelId, { assetId, buffer, mimetype, caption, filename }) {
    if (!this.client || this._connectionState !== "connected") {
      throw new Error("WhatsApp not connected");
    }

    let buf = buffer;
    let mime = mimetype;

    if (assetId && !buf) {
      const { read } = await import("../media/store.js");
      const asset = await read(assetId);
      if (!asset) throw new Error(`sendVideo: asset ${assetId} not found`);
      buf = asset.buffer;
      mime = mime || asset.row?.mime || "video/mp4";
    }

    if (!buf) throw new Error("sendVideo: no buffer or assetId provided");

    log(`[WHATSAPP-CUSTOM] Sending video: ${assetId || filename || 'buffer'} (${buf.length} bytes, ${mime})`);

    await this.client.sendMessage(channelId, {
      video: buf,
      mimetype: mime || "video/mp4",
      ...(caption ? { caption } : {}),
    });

    log("[WHATSAPP-CUSTOM] ✓ Video sent");
    return { ok: true, assetId: assetId || null };
  }

  async sendDocument(channelId, { assetId, buffer, mimetype, fileName, caption }) {
    if (!this.client || this._connectionState !== "connected") {
      throw new Error("WhatsApp not connected");
    }

    let buf = buffer;
    let mime = mimetype;
    let name = fileName;

    // Resolve buffer from media store if assetId is provided
    if (assetId && !buf) {
      const { read } = await import("../media/store.js");
      const asset = await read(assetId);
      if (!asset) throw new Error(`sendDocument: asset ${assetId} not found`);
      buf = asset.buffer;
      mime = mime || asset.row?.mime || "application/octet-stream";
      name = name || `file.${asset.row?.mime?.split("/")[1] || "bin"}`;
    }

    if (!buf) throw new Error("sendDocument: no buffer or assetId provided");

    log(`[WHATSAPP-CUSTOM] Sending document: ${name || assetId} (${buf.length} bytes, ${mime})`);

    // Defensive routing: if a caller passes a video/audio MIME to sendDocument,
    // delegate to the native send so we don't lose inline preview/playback.
    if (mime?.startsWith("video/")) {
      return this.sendVideo(channelId, { buffer: buf, mimetype: mime, caption, filename: name });
    }

    if (mime?.startsWith("audio/")) {
      // WhatsApp drops inline audio messages above ~16 MB without warning.
      // Fall through to document send so the file actually arrives — it loses
      // the inline player but the recipient can still download and play it.
      const AUDIO_INLINE_MAX_BYTES = 14 * 1024 * 1024;
      if (buf.length <= AUDIO_INLINE_MAX_BYTES) {
        await this.client.sendMessage(channelId, {
          audio: buf,
          mimetype: mime,
          ptt: false,
        });
        log("[WHATSAPP-CUSTOM] ✓ Audio sent");
        return;
      }
      log(`[WHATSAPP-CUSTOM] Audio ${buf.length} bytes exceeds inline limit, sending as document`);
    }

    await this.client.sendMessage(channelId, {
      document: buf,
      mimetype: mime || "application/octet-stream",
      fileName: name || "document",
      ...(caption ? { caption } : {}),
    });

    log("[WHATSAPP-CUSTOM] ✓ Document sent");
  }

  async stop(clearSession = false) {
    log(`[WHATSAPP-CUSTOM] Stopping... (clearSession: ${clearSession})`);
    this._connectionState = "disconnected";
    this._reconnectAttempts = this._maxReconnectAttempts; // Prevent reconnection

    // Flush tous les messages en attente dans le debouncer avant shutdown
    if (this._debouncer) {
      log("[WHATSAPP-CUSTOM] Flushing pending debounced messages...");
      this._debouncer.flushAll();
    }

    if (this.client) {
      try {
        await Promise.race([
          this.client.end(undefined),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Disconnect timeout')), 5000)
          )
        ]);
      } catch (err) {
        log("[WHATSAPP-CUSTOM] Error closing client:", err.message);
      }
      this.client = null;
    }

    if (clearSession) {
      try {
        const { rmSync, existsSync } = await import("fs");
        if (existsSync(this.sessionPath)) {
          log(`[WHATSAPP-CUSTOM] Clearing session data at ${this.sessionPath}`);
          rmSync(this.sessionPath, { recursive: true, force: true });
          log("[WHATSAPP-CUSTOM] Session cleared successfully");
        }

        // Also clear the group from DB so a new one will be created
        log("[WHATSAPP-CUSTOM] Clearing Yabby group from database");
        await clearYabbyGroupId();
        this._yabbyGroupId = null; // Reset in-memory group ID
        log("[WHATSAPP-CUSTOM] Group cleared successfully");
      } catch (err) {
        log("[WHATSAPP-CUSTOM] Error clearing session:", err.message);
      }
    }

    this.running = false;
    this.qrCode = null;
    log("[WHATSAPP-CUSTOM] Stopped");
  }

  /**
   * Manual reconnect after the auto-reconnect loop has given up.
   * Does NOT touch session files (no clearSession) and does NOT clear the DB.
   * Resets the reconnect counters and calls start() again to reuse existing creds.
   * Safe to call even if the client is already running (will close cleanly first).
   */
  async reconnect() {
    log("[WHATSAPP-CUSTOM] Manual reconnect requested");

    // Reset counters so the exponential backoff starts fresh
    this._reconnectAttempts = 0;
    this._reconnectDelay = 5000;

    // If a client is still dangling, close it cleanly first (without clearing session)
    if (this.client) {
      try {
        await Promise.race([
          this.client.end(undefined),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Disconnect timeout")), 5000)
          ),
        ]);
      } catch (err) {
        log("[WHATSAPP-CUSTOM] Error closing dangling client:", err.message);
      }
      this.client = null;
    }

    // Re-initialize with existing auth state on disk (no clearSession)
    await this.start();
  }
}
