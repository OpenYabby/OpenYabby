import { Router } from "express";
import { getInbox, getProjectMessages, markRead, markProcessed, getPendingCount } from "../db/queries/agent-messages.js";
import { agentSend } from "../lib/agent-bus.js";
import { log } from "../lib/logger.js";

const router = Router();

// Send message between agents
router.post("/api/agents/:id/messages", async (req, res) => {
  const { to_agent, content, msg_type } = req.body;
  if (!to_agent || !content) return res.status(400).json({ error: "Missing to_agent or content" });
  try {
    const msg = await agentSend(req.params.id, to_agent, req.body.project_id || null, content, msg_type || "message");
    res.json(msg);
  } catch (err) {
    log("[MESSAGES] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get agent inbox
router.get("/api/agents/:id/inbox", async (req, res) => {
  try {
    const messages = await getInbox(req.params.id, req.query.status || null);
    const pending = await getPendingCount(req.params.id);
    res.json({ messages, pendingCount: pending });
  } catch (err) {
    log("[MESSAGES] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Mark message as read
router.post("/api/messages/:id/read", async (req, res) => {
  try {
    await markRead(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    log("[MESSAGES] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Mark message as processed
router.post("/api/messages/:id/processed", async (req, res) => {
  try {
    await markProcessed(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    log("[MESSAGES] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Get project message history
router.get("/api/projects/:id/messages", async (req, res) => {
  try {
    const messages = await getProjectMessages(req.params.id, parseInt(req.query.limit) || 50);
    res.json({ messages });
  } catch (err) {
    log("[MESSAGES] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
