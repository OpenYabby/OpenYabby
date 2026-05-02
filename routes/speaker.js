import { Router } from "express";
import { log } from "../lib/logger.js";

const router = Router();

const SPEAKER_URL = process.env.SPEAKER_SERVICE_URL || "http://localhost:3001";

// Proxy helper — forwards request to Python speaker microservice
async function proxy(req, res, path, options = {}) {
  const url = `${SPEAKER_URL}${path}`;
  try {
    const fetchOpts = { method: options.method || "GET", headers: {} };

    if (options.body) {
      fetchOpts.body = options.body;
      // Forward content-type for multipart
      if (req.headers["content-type"]) {
        fetchOpts.headers["content-type"] = req.headers["content-type"];
      }
    }

    log(`[Speaker] Proxying ${fetchOpts.method} ${url} with Content-Type: ${fetchOpts.headers["content-type"] || 'none'}`);

    const upstream = await fetch(url, fetchOpts);

    log(`[Speaker] Response status: ${upstream.status}`);

    // Check if response is OK before parsing JSON
    if (!upstream.ok) {
      const errorText = await upstream.text();
      log(`[Speaker] Error response: ${errorText}`);
      return res.status(upstream.status).json({ error: errorText });
    }

    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    log(`[Speaker] Service error (${url}): ${err.message}`);
    log(`[Speaker] Full error: ${err.stack}`);
    // Fail open — if service is down, don't block wake word
    if (path === "/verify") {
      res.json({ verified: true, fallback: true });
    } else if (path === "/status") {
      res.json({ enrolled: false, fallback: true });
    } else {
      res.status(503).json({ error: "Speaker service unavailable", details: err.message });
    }
  }
}

// GET /api/speaker/status
router.get("/api/speaker/status", (req, res) => proxy(req, res, "/status"));

// POST /api/speaker/enroll — forward multipart form data
router.post("/api/speaker/enroll", (req, res) => {
  // Collect raw body to forward as-is to Python service
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    proxy(req, res, "/enroll", { method: "POST", body });
  });
});

// POST /api/speaker/verify — forward raw audio bytes
router.post("/api/speaker/verify", (req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    // Use /verify-raw endpoint for raw audio bytes (not multipart)
    proxy(req, res, "/verify-raw", { method: "POST", body });
  });
});

// DELETE /api/speaker/enroll — clear enrollment
router.delete("/api/speaker/enroll", (req, res) => proxy(req, res, "/enroll", { method: "DELETE" }));

export default router;
