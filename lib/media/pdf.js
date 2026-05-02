/* ═══════════════════════════════════════════════════════
   PDF helpers — text extract + page render
   ═══════════════════════════════════════════════════════
   Used by lib/media/vision.js to build multimodal message parts.
   - extractText() is always attempted (cheap, always runs)
   - renderPages() is used only when a vision provider needs images
     (e.g. OpenAI, Google) AND the PDF is small enough
*/

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "@napi-rs/canvas";
import { log } from "../logger.js";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

// Disable the pdfjs worker — we run synchronously in the main thread.
// In Node.js, pdfjs-dist automatically disables the worker (isNodeJS check
// in PDFWorker sets #isWorkerDisabled = true) and sets workerSrc to the
// bundled pdf.worker.mjs. No explicit workerSrc override needed here.

const __dirname = dirname(fileURLToPath(import.meta.url));
// Path to the standard fonts bundled with pdfjs-dist. Must end with trailing
// slash; pdfjs concatenates font filenames directly onto this string.
const STANDARD_FONT_DATA_URL =
  resolve(__dirname, "..", "..", "node_modules", "pdfjs-dist", "standard_fonts") + "/";

const TARGET_LONG_EDGE_PX = 1024;

/**
 * Extract concatenated text from all pages of a PDF.
 * @param {Buffer} buffer - raw PDF bytes
 * @returns {Promise<{ text: string, numPages: number }>}
 */
export async function extractText(buffer) {
  const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const doc = await pdfjsLib.getDocument({
    data: uint8,
    disableWorker: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const numPages = doc.numPages;
  const pages = [];
  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    pages.push(pageText);
  }
  await doc.destroy();
  return { text: pages.join("\n\n"), numPages };
}

/**
 * Render the first N pages of a PDF to PNG buffers.
 * Long edge of each page is scaled to TARGET_LONG_EDGE_PX (1024) for
 * a consistent quality/cost tradeoff when feeding vision models.
 * @param {Buffer} buffer - raw PDF bytes
 * @param {number} maxPages - hard cap (typical: 10)
 * @returns {Promise<Array<{ pageNum, pngBuffer, widthPx, heightPx }>>}
 */
export async function renderPages(buffer, maxPages = 10) {
  const uint8 = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const doc = await pdfjsLib.getDocument({
    data: uint8,
    disableWorker: true,
    standardFontDataUrl: STANDARD_FONT_DATA_URL,
  }).promise;
  const count = Math.min(doc.numPages, maxPages);
  const out = [];
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const unscaled = page.getViewport({ scale: 1 });
    const longEdge = Math.max(unscaled.width, unscaled.height);
    const scale = TARGET_LONG_EDGE_PX / longEdge;
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const pngBuffer = canvas.toBuffer("image/png");
    out.push({
      pageNum: i,
      pngBuffer,
      widthPx: canvas.width,
      heightPx: canvas.height,
    });
  }
  await doc.destroy();
  if (doc.numPages > maxPages) {
    log(`[PDF] truncated: rendered ${maxPages} of ${doc.numPages} pages`);
  }
  return out;
}
