/* ═══════════════════════════════════════════════════════
   search_images tool
   ═══════════════════════════════════════════════════════
   Uses the shared Playwright instance to scrape DuckDuckGo
   Image search (no API key needed). Downloads up to N
   thumbnails into the media store. Bing fallback if DDG fails.
*/

import { navigateTo, evaluate, waitForSelector } from "../playwright.js";
import { write as storeWrite } from "../media/store.js";
import { isAllowed } from "../media/mime.js";
import { log } from "../logger.js";

const DEFAULT_COUNT = 4;
const MAX_COUNT = 8;

/**
 * @param {{ query: string, count?: number, safe?: boolean }} args
 * @returns {Promise<{ assets: Array<{ assetId, sourceUrl, title, domain }>, source: "duckduckgo"|"bing" }>}
 */
export async function searchImages(args) {
  const query = (args?.query || "").trim();
  if (!query) throw new Error("search_images: query is required");
  const count = Math.min(MAX_COUNT, Math.max(1, args?.count || DEFAULT_COUNT));
  const safe = args?.safe !== false; // default true

  log(`[TOOL:search_images] query="${query}" count=${count} safe=${safe}`);

  let candidates = [];
  let source = "duckduckgo";
  try {
    candidates = await scrapeDuckDuckGo(query, count, safe);
  } catch (err) {
    log(`[TOOL:search_images] DDG failed: ${err.message} — trying Bing`);
  }
  if (candidates.length === 0) {
    try {
      candidates = await scrapeBing(query, count, safe);
      source = "bing";
    } catch (err) {
      log(`[TOOL:search_images] Bing also failed: ${err.message}`);
      throw new Error(`search_images: both DDG and Bing failed`);
    }
  }

  const downloads = await Promise.all(
    candidates.slice(0, count).map(async (c) => {
      try {
        const res = await fetch(c.thumbnailUrl, { redirect: "follow" });
        if (!res.ok) return null;
        const arrayBuffer = await res.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/jpeg";
        if (!isAllowed(mime)) return null;
        const asset = await storeWrite(buffer, mime, {
          source: "search",
          metadata: {
            query,
            engine: source,
            sourceUrl: c.sourceUrl,
            domain: c.domain,
            title: c.title,
            thumbnailUrl: c.thumbnailUrl,
          },
        });
        return {
          assetId: asset.id,
          sourceUrl: c.sourceUrl,
          title: c.title,
          domain: c.domain,
        };
      } catch (err) {
        log(`[TOOL:search_images] thumbnail download failed: ${err.message}`);
        return null;
      }
    })
  );

  const assets = downloads.filter((d) => d !== null);
  log(`[TOOL:search_images] returning ${assets.length} of ${candidates.length} candidates`);
  return { assets, source };
}

async function scrapeDuckDuckGo(query, count, safe) {
  const url = `https://duckduckgo.com/?iax=images&ia=images&q=${encodeURIComponent(query)}${safe ? "" : "&kp=-2"}`;
  await navigateTo(url);
  await waitForSelector("[data-id^='img_'], div.tile.tile--img, img.tile--img__img", { timeout: 10000 }).catch(() => {});
  return await evaluate((maxCount) => {
    const out = [];
    const tiles = document.querySelectorAll("[data-id^='img_'], div.tile.tile--img");
    for (const tile of tiles) {
      if (out.length >= maxCount) break;
      const img = tile.querySelector("img");
      const link = tile.querySelector("a[href]");
      const titleEl = tile.querySelector(".tile--img__title, .img-tile__title, .tile__title");
      const thumb = img?.getAttribute("data-src") || img?.src;
      const sourceUrl = link?.href || "";
      let domain = "";
      try { domain = new URL(sourceUrl).hostname; } catch {}
      const title = (titleEl?.textContent || img?.alt || "").trim();
      if (thumb) out.push({ thumbnailUrl: thumb, sourceUrl, title, domain });
    }
    return out;
  }, count);
}

async function scrapeBing(query, count, safe) {
  const url = `https://www.bing.com/images/search?q=${encodeURIComponent(query)}${safe ? "&safesearch=strict" : ""}`;
  await navigateTo(url);
  await waitForSelector("a.iusc", { timeout: 10000 }).catch(() => {});
  return await evaluate((maxCount) => {
    const out = [];
    const anchors = document.querySelectorAll("a.iusc");
    for (const a of anchors) {
      if (out.length >= maxCount) break;
      const m = a.getAttribute("m");
      if (!m) continue;
      try {
        const meta = JSON.parse(m);
        const thumb = meta.murl || meta.turl;
        const sourceUrl = meta.purl || "";
        let domain = "";
        try { domain = new URL(sourceUrl).hostname; } catch {}
        const title = (meta.t || "").trim();
        if (thumb) out.push({ thumbnailUrl: thumb, sourceUrl, title, domain });
      } catch {}
    }
    return out;
  }, count);
}
