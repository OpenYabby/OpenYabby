/* ═══════════════════════════════════════════════════════
   Vision parts builder — per-provider multimodal shape
   ═══════════════════════════════════════════════════════
   Callers: lib/channels/handler.js builds the user turn content
   for the LLM call. This module converts a NormalizedMessage's
   attachments into the correct content shape for each provider
   (or degrades to a text-only note for non-vision providers).
*/

import { read as storeRead } from "./store.js";
import { extractText, renderPages } from "./pdf.js";
import { log } from "../logger.js";

const PDF_PAGE_LIMIT = 10;
// Providers that currently accept image/document multimodal content.
const VISION_PROVIDERS = new Set(["openai", "anthropic", "google"]);

/**
 * Build a content array for the user turn.
 * @param {Array} attachments - from NormalizedMessage.attachments, each with assetId populated
 * @param {string} userText - user's typed text (may be empty — e.g. photo-only message)
 * @param {string} providerName - "openai" | "anthropic" | "google" | other (text-only)
 * @returns {Promise<string | Array>} — string for text-only providers; content-array for vision providers
 */
export async function buildVisionParts(attachments, userText, providerName) {
  const text = (userText || "").trim();
  const list = Array.isArray(attachments) ? attachments : [];

  // Non-vision providers OR no attachments: degrade to text + synthetic summary
  if (!VISION_PROVIDERS.has(providerName) || list.length === 0) {
    if (list.length === 0) return text || "";
    const counts = list.reduce((acc, a) => ((acc[a.kind] = (acc[a.kind] || 0) + 1), acc), {});
    const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}${n > 1 ? "s" : ""}`).join(", ");
    return `${text}${text ? "\n\n" : ""}[user sent ${summary} — this provider cannot see them]`;
  }

  // Vision path: fetch bytes for each attachment, dispatch to provider-specific shape
  const resolved = [];
  for (const att of list) {
    if (!att.assetId) {
      log(`[VISION] skipping attachment with no assetId (kind=${att.kind})`);
      continue;
    }
    const asset = await storeRead(att.assetId);
    if (!asset) {
      log(`[VISION] skipping missing asset ${att.assetId}`);
      continue;
    }
    resolved.push({ ref: att, buffer: asset.buffer, row: asset.row });
  }

  if (resolved.length === 0) return text || "";

  switch (providerName) {
    case "openai":    return await buildOpenAI(text, resolved);
    case "anthropic": return await buildAnthropic(text, resolved);
    case "google":    return await buildGoogle(text, resolved);
  }
  return text || ""; // unreachable
}

// ── OpenAI: image_url data URLs; PDFs rendered to image parts ──
async function buildOpenAI(text, resolved) {
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const { buffer, row } of resolved) {
    if (row.kind === "image") {
      const b64 = buffer.toString("base64");
      parts.push({
        type: "image_url",
        image_url: { url: `data:${row.mime};base64,${b64}` },
      });
    } else if (row.kind === "pdf") {
      try {
        const { text: pdfText } = await extractText(buffer);
        const pages = await renderPages(buffer, PDF_PAGE_LIMIT);
        for (const pg of pages) {
          parts.push({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${pg.pngBuffer.toString("base64")}` },
          });
        }
        if (pdfText) {
          parts.push({ type: "text", text: `[PDF text, ${pages.length} page(s) rendered above]\n${pdfText.slice(0, 8000)}` });
        }
      } catch (err) {
        log(`[VISION] OpenAI PDF processing failed: ${err.message}`);
        parts.push({ type: "text", text: `[PDF could not be processed: ${err.message}]` });
      }
    }
  }
  return parts;
}

// ── Anthropic: image/document source blocks; native PDF under 30 MB ──
async function buildAnthropic(text, resolved) {
  const parts = [];
  if (text) parts.push({ type: "text", text });
  for (const { buffer, row } of resolved) {
    if (row.kind === "image") {
      parts.push({
        type: "image",
        source: {
          type: "base64",
          media_type: row.mime,
          data: buffer.toString("base64"),
        },
      });
    } else if (row.kind === "pdf") {
      // Anthropic's document limit is on the base64-encoded payload (~32 MB).
      // Base64 inflates by 4/3, so we cap raw bytes at ~22.5 MB (32 × 3/4)
      // with a small safety margin baked in (30 × 3/4 = 22.5 MB).
      const ANTHROPIC_MAX_PDF_RAW = Math.floor(30 * 1024 * 1024 * 3 / 4);
      if (buffer.byteLength <= ANTHROPIC_MAX_PDF_RAW) {
        parts.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: buffer.toString("base64"),
          },
        });
      } else {
        try {
          const { text: pdfText } = await extractText(buffer);
          parts.push({ type: "text", text: `[PDF too large for native ingest — extracted text below]\n${pdfText.slice(0, 8000)}` });
        } catch (err) {
          log(`[VISION] Anthropic PDF fallback failed: ${err.message}`);
          parts.push({ type: "text", text: `[PDF could not be processed: ${err.message}]` });
        }
      }
    }
  }
  return parts;
}

// ── Google: parts[] with text + inlineData; PDFs rendered to image parts ──
async function buildGoogle(text, resolved) {
  const parts = [];
  if (text) parts.push({ text });
  for (const { buffer, row } of resolved) {
    if (row.kind === "image") {
      parts.push({
        inlineData: {
          mimeType: row.mime,
          data: buffer.toString("base64"),
        },
      });
    } else if (row.kind === "pdf") {
      try {
        const { text: pdfText } = await extractText(buffer);
        const pages = await renderPages(buffer, PDF_PAGE_LIMIT);
        for (const pg of pages) {
          parts.push({
            inlineData: {
              mimeType: "image/png",
              data: pg.pngBuffer.toString("base64"),
            },
          });
        }
        if (pdfText) parts.push({ text: `[PDF text]\n${pdfText.slice(0, 8000)}` });
      } catch (err) {
        log(`[VISION] Google PDF processing failed: ${err.message}`);
        parts.push({ text: `[PDF could not be processed: ${err.message}]` });
      }
    }
  }
  return parts;
}
