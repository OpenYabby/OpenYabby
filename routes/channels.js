import { Router } from "express";
import { listChannels, restartChannel, stopChannel, getChannel } from "../lib/channels/index.js";
import {
  listConversations,
  getMessages,
  listDeadLetters,
  deleteDeadLetter,
  clearDeadLetters,
} from "../db/queries/channels.js";
import {
  generatePairingCode,
  getPairingCode,
  unpair,
  listPairings,
} from "../db/queries/channel-pairings.js";

const PAIRING_CHANNELS = new Set(["telegram", "discord", "slack", "signal"]);

const router = Router();

// GET /api/channels — list all channels with status
router.get("/api/channels", (_req, res) => {
  res.json(listChannels());
});

// POST /api/channels/:name/restart — restart a specific channel
router.post("/api/channels/:name/restart", async (req, res) => {
  try {
    const ok = await restartChannel(req.params.name);
    res.json({ ok, channel: req.params.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/channels/:name/stop — stop (disconnect) a specific channel
// Body: { clearSession: boolean } - if true, clears saved session (forces new QR)
router.post("/api/channels/:name/stop", async (req, res) => {
  try {
    const clearSession = req.body?.clearSession || false;
    const ok = await stopChannel(req.params.name, clearSession);
    res.json({ ok, channel: req.params.name, clearedSession: clearSession });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/channels/:name/reconnect — manual reconnect without touching session
// Useful after the auto-reconnect loop has given up (e.g. after DNS failure).
// Preserves session files and DB state — only resets counters and calls start() again.
router.post("/api/channels/:name/reconnect", async (req, res) => {
  try {
    const adapter = getChannel(req.params.name);
    if (!adapter) {
      return res.status(404).json({ error: `Channel "${req.params.name}" not active` });
    }
    if (typeof adapter.reconnect !== "function") {
      return res.status(501).json({ error: `reconnect() not supported for "${req.params.name}"` });
    }
    await adapter.reconnect();
    res.json({ ok: true, channel: req.params.name, message: "Reconnect triggered" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/channels/:name/qr — get QR code for channel (WhatsApp, Signal)
router.get("/api/channels/:name/qr", async (req, res) => {
  const adapter = getChannel(req.params.name);
  if (!adapter) return res.status(404).json({ error: `Channel "${req.params.name}" not active` });

  // Signal: proxy QR image from signal-cli API
  if (req.params.name === "signal" && adapter.config?.apiUrl) {
    return res.json({ qr: null, qrImageUrl: `/api/channels/signal/qr-image` });
  }

  if (adapter.qrCode) {
    res.json({ qr: adapter.qrCode });
  } else {
    res.json({ qr: null });
  }
});

// POST /api/channels/:name/send — send a message to a channel user
router.post("/api/channels/:name/send", async (req, res) => {
  const adapter = getChannel(req.params.name);
  if (!adapter) return res.status(404).json({ error: `Channel "${req.params.name}" not active` });

  const { channelId, text } = req.body;
  if (!channelId || !text) return res.status(400).json({ error: "channelId and text required" });

  try {
    await adapter.send(channelId, text);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/channels/:name/conversations — list conversations for a channel
router.get("/api/channels/:name/conversations", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const conversations = await listConversations(req.params.name, limit);
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/channels/conversations/:id/messages — get messages for a conversation
router.get("/api/channels/conversations/:id/messages", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const messages = await getMessages(req.params.id, limit);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/channels/dead-letters — list dead letters
router.get("/api/channels/dead-letters", async (req, res) => {
  try {
    const channel = req.query.channel || null;
    const limit = parseInt(req.query.limit) || 50;
    const letters = await listDeadLetters(channel, limit);
    res.json({ deadLetters: letters });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/channels/dead-letters/:id — delete a single dead letter
router.delete("/api/channels/dead-letters/:id", async (req, res) => {
  try {
    await deleteDeadLetter(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/channels/dead-letters — clear all dead letters
router.delete("/api/channels/dead-letters", async (req, res) => {
  try {
    const channel = req.query.channel || null;
    await clearDeadLetters(channel);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/channels/signal/qr-image — proxy QR PNG from signal-cli API
router.get("/api/channels/signal/qr-image", async (req, res) => {
  try {
    const adapter = getChannel("signal");
    if (!adapter?.config?.apiUrl) return res.status(404).json({ error: "Signal not configured" });
    const response = await fetch(`${adapter.config.apiUrl}/v1/qrcodelink?device_name=Yabby`);
    if (!response.ok) return res.status(response.status).send("Failed to get QR");
    res.set("Content-Type", response.headers.get("content-type") || "image/png");
    const buffer = Buffer.from(await response.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/channels/:name/users — list distinct users who have messaged this channel
router.get("/api/channels/:name/users", async (req, res) => {
  try {
    const { query: dbQuery } = await import("../db/pg.js").then(m => ({ query: m.default.query.bind(m.default) }));
    const { rows } = await dbQuery(
      `SELECT DISTINCT user_id, user_name, MAX(last_message_at) as last_seen
       FROM channel_conversations
       WHERE channel_name = $1
       GROUP BY user_id, user_name
       ORDER BY last_seen DESC
       LIMIT 50`,
      [req.params.name]
    );
    res.json({ users: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// Channel Pairing (owner-only security)
// ══════════════════════════════════════════

// GET /api/channels/pairings — list pairing status for all pairable channels
router.get("/api/channels/pairings", async (_req, res) => {
  try {
    const owners = await listPairings();
    const result = {};
    for (const name of PAIRING_CHANNELS) {
      const owner = owners[name] || null;
      const pending = await getPairingCode(name);
      result[name] = {
        paired: !!owner,
        owner: owner ? {
          userId: owner.owner_user_id,
          userName: owner.owner_user_name,
          pairedAt: owner.paired_at,
        } : null,
        pendingCode: pending ? { code: pending.code, ttlSeconds: pending.ttlSeconds } : null,
      };
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/channels/:name/pair — generate a new pairing code
router.post("/api/channels/:name/pair", async (req, res) => {
  const name = req.params.name;
  if (!PAIRING_CHANNELS.has(name)) {
    return res.status(400).json({ error: `Pairing not supported for channel "${name}"` });
  }
  try {
    const { code, expiresAt, ttlSeconds } = await generatePairingCode(name);
    res.json({ ok: true, channel: name, code, expiresAt, ttlSeconds });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/channels/:name/pair — unpair (remove owner)
router.delete("/api/channels/:name/pair", async (req, res) => {
  const name = req.params.name;
  if (!PAIRING_CHANNELS.has(name)) {
    return res.status(400).json({ error: `Pairing not supported for channel "${name}"` });
  }
  try {
    await unpair(name);
    res.json({ ok: true, channel: name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
