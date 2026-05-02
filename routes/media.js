/* ═══════════════════════════════════════════════════════
   Media Routes
   ═══════════════════════════════════════════════════════
   GET  /api/media/:id        — serve raw bytes
   POST /api/media/upload     — multipart ingest (form field: "file")

   Auth: mounted AFTER optionalAuth in server.js — protected
   when gateway auth is on, open otherwise.
*/

import { Router } from "express";
import multer from "multer";
import { write as storeWrite, read as storeRead, head as storeHead } from "../lib/media/store.js";
import { isAllowed } from "../lib/media/mime.js";
import { getConfig } from "../lib/config.js";
import { log } from "../lib/logger.js";
import { getChannel } from "../lib/channels/index.js";
import { readFileSync } from "fs";

const router = Router();

// 50 MB hard cap at multer level; per-kind cap (image vs pdf) enforced below
// from config.media.max*SizeMb.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 10 },
});

// ── GET /api/media/:id ────────────────────────────────────────────
router.get("/api/media/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9]{12}$/i.test(id)) {
    return res.status(400).json({ error: "invalid media id" });
  }
  try {
    const result = await storeRead(id);
    if (!result) return res.status(404).json({ error: "not found" });
    const { row, buffer } = result;
    res.set("Content-Type", row.mime);
    res.set("Content-Length", String(row.size_bytes));
    res.set("Cache-Control", "public, max-age=31536000, immutable"); // content-addressed → safe for shared caches
    res.set("X-Media-Kind", row.kind);
    res.set("X-Media-Sha256", row.sha256);
    return res.status(200).end(buffer);
  } catch (err) {
    log(`[MEDIA] GET ${id} error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── HEAD /api/media/:id (metadata only, no bytes) ─────────────────
router.head("/api/media/:id", async (req, res) => {
  const { id } = req.params;
  if (!/^[a-f0-9]{12}$/i.test(id)) return res.status(400).end();
  try {
    const result = await storeHead(id);
    if (!result) return res.status(404).end();
    res.set("Content-Type", result.row.mime);
    res.set("Content-Length", String(result.row.size_bytes));
    res.set("X-Media-Kind", result.row.kind);
    res.set("X-Media-Sha256", result.row.sha256);
    return res.status(200).end();
  } catch (err) {
    log(`[MEDIA] HEAD ${id} error:`, err.message);
    return res.status(500).end();
  }
});

// ── POST /api/media/upload ────────────────────────────────────────
router.post("/api/media/upload", (req, res, next) => {
  upload.array("file", 10)(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
          return res.status(413).json({ error: "file too large (exceeds 50 MB hard cap)" });
        }
        if (err.code === "LIMIT_FILE_COUNT" || err.code === "LIMIT_UNEXPECTED_FILE") {
          return res.status(413).json({ error: "too many files (max 10)" });
        }
        return res.status(400).json({ error: `upload error: ${err.message}` });
      }
      log(`[MEDIA] upload middleware error:`, err.message);
      return res.status(500).json({ error: err.message });
    }
    next();
  });
}, async (req, res) => {
  const files = req.files || [];
  if (files.length === 0) {
    return res.status(400).json({ error: "no files (expected form field: file)" });
  }

  const mediaCfg = getConfig("media") || {};
  const maxImageBytes = (mediaCfg.maxImageSizeMb ?? 20) * 1024 * 1024;
  const maxPdfBytes = (mediaCfg.maxPdfSizeMb ?? 50) * 1024 * 1024;
  const maxPerMessage = mediaCfg.maxImagesPerMessage ?? 10;

  if (files.length > maxPerMessage) {
    return res.status(413).json({ error: `too many files (max ${maxPerMessage})` });
  }

  const results = [];
  const errors = [];

  for (const f of files) {
    try {
      if (!isAllowed(f.mimetype)) {
        errors.push({ filename: f.originalname, error: `mime not allowed: ${f.mimetype}` });
        continue;
      }
      const cap = f.mimetype === "application/pdf" ? maxPdfBytes : maxImageBytes;
      if (f.size > cap) {
        errors.push({ filename: f.originalname, error: `file too large (> ${cap} bytes)` });
        continue;
      }
      const asset = await storeWrite(f.buffer, f.mimetype, {
        source: "inbound",
        metadata: { originalName: f.originalname || null, uploadedVia: "http" },
      });
      results.push({
        id: asset.id,
        mime: asset.mime,
        size_bytes: asset.size_bytes,
        kind: asset.kind,
        sha256: asset.sha256,
        deduped: asset.deduped,
        url: `/api/media/${asset.id}`,
      });
    } catch (err) {
      log(`[MEDIA] upload error for ${f.originalname}:`, err.message);
      errors.push({ filename: f.originalname, error: err.message });
    }
  }

  const status = results.length > 0 ? 200 : 400;
  return res.status(status).json({ assets: results, errors });
});

// ── POST /api/media/send-document ─────────────────────────────────
router.post("/api/media/send-document", async (req, res) => {
  const { group_id, file_path, asset_id, caption, file_name } = req.body || {};
  if (!group_id) return res.status(400).json({ error: "group_id required" });
  if (!file_path && !asset_id) return res.status(400).json({ error: "file_path or asset_id required" });

  try {
    const wa = getChannel("whatsapp");
    if (!wa) return res.status(503).json({ error: "WhatsApp channel not available" });

    let buffer, mimetype, fileName;

    if (asset_id) {
      const result = await storeRead(asset_id);
      if (!result) return res.status(404).json({ error: "asset not found" });
      buffer = result.buffer;
      mimetype = result.row.mime;
      fileName = file_name || `document.${result.row.kind || "pdf"}`;
    } else {
      buffer = readFileSync(file_path);
      mimetype = "application/pdf";
      fileName = file_name || file_path.split("/").pop();
    }

    await wa.sendDocument(group_id, { buffer, mimetype, fileName, caption });
    return res.json({ success: true, fileName, size: buffer.length });
  } catch (err) {
    log(`[MEDIA] send-document error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

export default router;
