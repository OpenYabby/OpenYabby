/* ═══════════════════════════════════════════════════════
   ImageGen Proxy Routes
   ═══════════════════════════════════════════════════════
   Proxies /api/imagegen/* to the Python sidecar on port 3002.
   Used by the admin UI for status, model management, etc.
   Mirrors the pattern in routes/speaker.js.
*/

import { Router } from "express";
import { getConfig } from "../lib/config.js";
import { log } from "../lib/logger.js";

const router = Router();

async function proxy(req, res, path, opts = {}) {
  const cfg = getConfig("imagegen") || {};
  if (!cfg.enabled) {
    return res.status(503).json({ error: "image generation is disabled on this platform" });
  }
  const baseUrl = cfg.serviceUrl || "http://localhost:3002";
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    const upstream = await fetch(`${baseUrl}${path}`, {
      method: opts.method || req.method,
      headers: { "Content-Type": "application/json" },
      body: ["POST", "PUT"].includes(req.method) ? JSON.stringify(req.body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    log(`[IMAGEGEN-PROXY] ${path} failed: ${err.message}`);
    res.status(503).json({ error: "image generation service unavailable" });
  }
}

router.get("/api/imagegen/status", (req, res) => proxy(req, res, "/status"));
router.get("/api/imagegen/models", (req, res) => proxy(req, res, "/models"));
router.post("/api/imagegen/load", (req, res) => proxy(req, res, "/load"));
router.post("/api/imagegen/unload", (req, res) => proxy(req, res, "/unload"));

export default router;
