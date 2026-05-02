/* ═══════════════════════════════════════════════════════
   YABBY — Preview API
   ═══════════════════════════════════════════════════════
   Rich content blocks (HTML, Code, Markdown) pushed to
   browser activity feed and agent chats via SSE + WS.
   Blocks are scoped to projects via optional projectId.
*/

import { Router } from "express";
import { broadcastWs } from "../lib/ws-gateway.js";
import { sseClients } from "../lib/logger.js";

const router = Router();

// In-memory block store
let blocks = [];
let idCounter = 0;
const MAX_BLOCKS = 200;
const VALID_TYPES = new Set(["html", "code", "markdown"]);

// Broadcast to both SSE and WS
function broadcast(event, data) {
  const payload = JSON.stringify({ event, timestamp: new Date().toISOString(), ...data });
  for (const client of sseClients) {
    client.write(`event: preview\ndata: ${payload}\n\n`);
  }
  broadcastWs({ type: "preview", event, ...data });
}

// POST /api/preview/push — create a preview block
router.post("/api/preview/push", (req, res) => {
  const { type, content, title, language, taskId, agentId, projectId } = req.body;

  if (!type || !VALID_TYPES.has(type)) {
    return res.status(400).json({ error: "type must be html, code, or markdown" });
  }
  if (!content || typeof content !== "string") {
    return res.status(400).json({ error: "content required" });
  }

  const block = {
    id: `pv_${++idCounter}`,
    type,
    content,
    title: title || null,
    language: type === "code" ? (language || null) : null,
    taskId: taskId || null,
    agentId: agentId || null,
    projectId: projectId || null,
    timestamp: new Date().toISOString(),
  };

  blocks.unshift(block);
  if (blocks.length > MAX_BLOCKS) {
    blocks = blocks.slice(0, MAX_BLOCKS);
  }

  broadcast("push", { block });
  res.json({ ok: true, block });
});

// GET /api/preview/blocks — list blocks, optionally filtered by projectId
router.get("/api/preview/blocks", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 200, MAX_BLOCKS);
  const offset = parseInt(req.query.offset) || 0;
  const projectId = req.query.projectId || null;

  let filtered = blocks;
  if (projectId) {
    filtered = blocks.filter((b) => b.projectId === projectId);
  }

  const slice = filtered.slice(offset, offset + limit);
  res.json({ blocks: slice, count: filtered.length });
});

// GET /api/preview/blocks/:id — get a single block
router.get("/api/preview/blocks/:id", (req, res) => {
  const block = blocks.find((b) => b.id === req.params.id);
  if (!block) return res.status(404).json({ error: "Block not found" });
  res.json({ block });
});

// DELETE /api/preview/blocks/:id — remove a single block
router.delete("/api/preview/blocks/:id", (req, res) => {
  const idx = blocks.findIndex((b) => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Block not found" });
  blocks.splice(idx, 1);
  broadcast("remove", { blockId: req.params.id });
  res.json({ ok: true });
});

// POST /api/preview/reset — clear all blocks (optionally by projectId)
router.post("/api/preview/reset", (req, res) => {
  const projectId = req.body?.projectId || null;
  if (projectId) {
    blocks = blocks.filter((b) => b.projectId !== projectId);
  } else {
    blocks = [];
    idCounter = 0;
  }
  broadcast("reset", { projectId });
  res.json({ ok: true });
});

// POST /api/preview/eval — evaluate JS in a rendered HTML block
router.post("/api/preview/eval", (req, res) => {
  const { blockId, js } = req.body;
  if (!js) return res.status(400).json({ error: "js required" });
  broadcast("eval", { blockId, js });
  res.json({ ok: true });
});

export default router;
