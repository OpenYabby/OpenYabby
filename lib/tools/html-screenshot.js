/* ═══════════════════════════════════════════════════════
   html_screenshot tool
   ═══════════════════════════════════════════════════════
   Renders a synthesized HTML string in the shared Playwright
   instance and captures a screenshot. Useful for charts, tables,
   styled reports, or any markup the LLM produces inline.
*/

import { setHtmlContent, screenshot } from "../playwright.js";
import { write as storeWrite } from "../media/store.js";
import { log } from "../logger.js";

const MAX_HTML_BYTES = 1_000_000; // 1 MB cap on input HTML

/**
 * @param {{ html: string, widthPx?: number, waitMs?: number, fullPage?: boolean }} args
 * @returns {Promise<{ assetId, widthPx, heightPx }>}
 */
export async function htmlScreenshot(args) {
  const { html, widthPx, waitMs, fullPage = false } = args || {};
  if (!html || typeof html !== "string") {
    throw new Error("html_screenshot: html must be a non-empty string");
  }
  if (html.length > MAX_HTML_BYTES) {
    throw new Error(`html_screenshot: html too large (${html.length} > ${MAX_HTML_BYTES})`);
  }

  log(`[TOOL:html_screenshot] rendering ${html.length}B of HTML (width=${widthPx || 1200})`);
  const rendered = await setHtmlContent(html, { widthPx, waitMs });
  const shot = await screenshot({ fullPage });
  log(`[TOOL:html_screenshot] captured ${shot.buffer.byteLength}B`);

  const asset = await storeWrite(shot.buffer, "image/png", {
    source: "screenshot",
    metadata: {
      sourceUrl: "synthetic:html",
      htmlLength: html.length,
      widthPx: rendered.widthPx,
    },
  });

  return {
    assetId: asset.id,
    widthPx: rendered.widthPx,
    heightPx: rendered.heightPx,
  };
}
