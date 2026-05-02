/* ═══════════════════════════════════════════════════════
   web_screenshot tool
   ═══════════════════════════════════════════════════════
   Navigates to a URL via the shared Playwright instance and
   captures a screenshot. Stores the PNG in the media store
   and returns the asset id for the handler to dispatch via
   adapter.sendImage().
*/

import { navigateTo, screenshot } from "../playwright.js";
import { write as storeWrite } from "../media/store.js";
import { log } from "../logger.js";

/**
 * @param {{ url: string, fullPage?: boolean, viewportWidth?: number }} args
 * @returns {Promise<{ assetId, finalUrl, title, fullPage }>}
 */
export async function webScreenshot(args) {
  const { url, fullPage = false } = args || {};
  if (!url || typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error("web_screenshot: url must start with http:// or https://");
  }

  log(`[TOOL:web_screenshot] navigating: ${url} (fullPage=${fullPage})`);
  const nav = await navigateTo(url);
  const shot = await screenshot({ fullPage });
  log(`[TOOL:web_screenshot] captured ${shot.buffer.byteLength}B from ${nav.url}`);

  const asset = await storeWrite(shot.buffer, "image/png", {
    source: "screenshot",
    metadata: {
      sourceUrl: nav.url,
      requestedUrl: url,
      title: nav.title,
      fullPage,
    },
  });

  return {
    assetId: asset.id,
    finalUrl: nav.url,
    title: nav.title,
    fullPage,
  };
}
