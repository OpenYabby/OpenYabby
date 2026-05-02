/* ═══════════════════════════════════════════════════════
   WhatsApp Adapter (@whiskeysockets/baileys)
   ═══════════════════════════════════════════════════════
   Uses Baileys library for direct WhatsApp Web protocol.
   Auth via QR code or pairing code. Credentials stored
   in authDir (default: data/whatsapp-auth/).
*/

import { ChannelAdapter } from "./base.js";
import { normalize } from "./normalize.js";
import { log } from "../logger.js";
import { mkdirSync } from "fs";
import { join } from "path";

export class WhatsAppAdapter extends ChannelAdapter {
  constructor(config) {
    super("whatsapp", config);
    this.sock = null;
    this._reconnectTimer = null;
    this.qrCode = null; // Store QR code for UI display
    this._yabbyGroupId = null; // Store Yabby group ID for isolation
  }

  async start() {
    // Close existing connection first (without logging out)
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch {}
      this.sock = null;
    }

    // Clear reconnect timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    const baileys = await import("@whiskeysockets/baileys");
    const makeWASocket = baileys.default;
    const {
      useMultiFileAuthState,
      DisconnectReason,
      fetchLatestBaileysVersion,
      makeCacheableSignalKeyStore,
    } = baileys;

    // Baileys requires a pino-compatible logger
    const pinoMod = await import("pino").catch(() => null);
    const pinoLogger = pinoMod
      ? pinoMod.default({ level: "silent" })
      : { level: "silent", trace() {}, debug() {}, info() {},
          warn(...a) { log("[CHANNEL:whatsapp] WARN:", ...a); },
          error(...a) { log("[CHANNEL:whatsapp] ERROR:", ...a); },
          fatal(...a) { log("[CHANNEL:whatsapp] FATAL:", ...a); },
          child() { return this; } };

    // Auth directory for storing credentials
    const authDir = this.config.authDir || join(process.cwd(), "data", "whatsapp-auth");
    mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);

    // Wrap keys with in-memory cache to reduce disk I/O
    const auth = {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore
        ? makeCacheableSignalKeyStore(state.keys, pinoLogger)
        : state.keys,
    };

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      // Fallback if version fetch fails (network issue)
      log("[CHANNEL:whatsapp] Could not fetch latest version, using default");
    }

    const usePairingCode = !!this.config.phoneNumber;

    this.sock = makeWASocket({
      ...(version ? { version } : {}),
      auth,
      printQRInTerminal: !usePairingCode,
      logger: pinoLogger,
      browser: ["Yabby", "Chrome", "1.0.0"],
    });

    // Pairing code auth (alternative to QR) — if phoneNumber is configured
    if (usePairingCode && !state.creds.registered) {
      const phoneNumber = this.config.phoneNumber.replace(/[^0-9]/g, "");
      try {
        const code = await this.sock.requestPairingCode(phoneNumber);
        log(`[CHANNEL:whatsapp] Pairing code: ${code} — enter this in WhatsApp > Linked Devices`);
      } catch (err) {
        log(`[CHANNEL:whatsapp] Pairing code error:`, err.message);
      }
    }

    // Save credentials on update
    this.sock.ev.on("creds.update", saveCreds);

    // Connection lifecycle
    this.sock.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        this.qrCode = qr;
        log("[CHANNEL:whatsapp] QR code generated — scan with WhatsApp on your phone");
      }

      if (connection === "open") {
        this.running = true;
        this.qrCode = null; // Clear QR code once connected
        log("[CHANNEL:whatsapp] Connected");

        // Auto-initialize: create dedicated Yabby group chat
        this._initializeYabbyGroup().catch(err =>
          log("[CHANNEL:whatsapp] Could not initialize Yabby group:", err.message)
        );
      }

      if (connection === "close") {
        this.running = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        if (shouldReconnect) {
          log(`[CHANNEL:whatsapp] Disconnected (code ${statusCode}), reconnecting in 5s...`);
          this._reconnectTimer = setTimeout(() => this.start(), 5000);
        } else {
          log("[CHANNEL:whatsapp] Logged out — not reconnecting. Re-scan QR to reconnect.");
        }
      }
    });

    // Incoming messages
    this.sock.ev.on("messages.upsert", async ({ messages: msgs, type }) => {
      // Only process new messages (not history sync)
      if (type !== "notify") return;

      for (const m of msgs) {
        // Skip own messages and status broadcasts
        if (m.key.fromMe) continue;
        if (m.key.remoteJid === "status@broadcast") continue;

        // Extract text from various message types
        const text =
          m.message?.conversation ||
          m.message?.extendedTextMessage?.text ||
          m.message?.imageMessage?.caption ||
          m.message?.videoMessage?.caption ||
          "";

        if (!text) continue;

        const isGroup = m.key.remoteJid?.endsWith("@g.us") || false;
        const senderId = isGroup
          ? m.key.participant || m.key.remoteJid
          : m.key.remoteJid;

        // ISOLATION: Only respond to messages in Yabby group
        if (!this._isYabbyGroup(m.key.remoteJid)) {
          continue; // Ignore all other chats
        }

        // Get push name (display name)
        const userName = m.pushName || senderId?.split("@")[0] || "User";

        const msg = normalize({
          channelName: "whatsapp",
          channelId: m.key.remoteJid,
          userId: senderId,
          userName,
          text,
          isGroup,
          platformMsgId: m.key.id,
        });

        await this._handleIncoming(msg);
      }
    });
  }

  async stop() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.sock) {
      this.sock.end(undefined);
      this.sock = null;
    }
    this.running = false;
  }

  async send(channelId, text) {
    if (!this.sock) throw new Error("WhatsApp not connected");

    // WhatsApp has a ~65536 char limit but keep chunks reasonable
    const MAX_LEN = 4096;
    if (text.length <= MAX_LEN) {
      await this.sock.sendMessage(channelId, { text });
    } else {
      const chunks = text.match(/[\s\S]{1,4096}/g) || [text];
      for (const chunk of chunks) {
        await this.sock.sendMessage(channelId, { text: chunk });
      }
    }
  }

  /**
   * Initialize Yabby group - creates a dedicated WhatsApp group for Yabby conversations
   */
  async _initializeYabbyGroup() {
    if (!this.sock) return;

    try {
      // Check if group already exists (stored in config or memory)
      if (this._yabbyGroupId) {
        log(`[CHANNEL:whatsapp] Yabby group already exists: ${this._yabbyGroupId}`);
        return;
      }

      // Create a new group with just yourself
      const groupName = "🤖 Yabby Assistant";
      const me = this.sock.user?.id.split(":")[0] + "@s.whatsapp.net";

      // Create group (empty participants, just you as admin)
      const group = await this.sock.groupCreate(groupName, []);
      const groupId = group.id;

      this._yabbyGroupId = groupId;
      log(`[CHANNEL:whatsapp] Created Yabby group: ${groupId}`);

      // Send welcome message to the group
      await this.sock.sendMessage(groupId, {
        text: "👋 Welcome to your Yabby Assistant chat!\n\nThis is your dedicated space to talk with me. Send me any message here, and I'll respond!\n\n💡 Try: 'Help me with a task' or 'What can you do?'\n\n🔒 Only messages in this group will be answered by Yabby - all your other chats remain private."
      });

      log(`[CHANNEL:whatsapp] Sent welcome message to Yabby group`);
    } catch (err) {
      log("[CHANNEL:whatsapp] Error initializing Yabby group:", err.message);
      // If group creation fails, fall back to responding to all DMs
      log("[CHANNEL:whatsapp] Falling back to DM-only mode");
    }
  }

  /**
   * Check if a message is from the Yabby group
   */
  _isYabbyGroup(remoteJid) {
    if (!this.sock) return false;

    // If we have a dedicated Yabby group, only respond there
    if (this._yabbyGroupId) {
      return remoteJid === this._yabbyGroupId;
    }

    // Fallback: respond to all DMs (not groups) if no Yabby group exists
    return !remoteJid?.endsWith("@g.us");
  }
}
