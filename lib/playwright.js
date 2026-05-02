/* ═══════════════════════════════════════════════════════
   YABBY — Playwright Browser Automation
   ═══════════════════════════════════════════════════════
   Optional — only works if playwright is installed.
   Used for browser_action voice tool.
*/

import { log } from "./logger.js";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import { readFile } from "fs/promises";

let chromium;
let browser = null;
let page = null;

async function ensureBrowser() {
  if (!chromium) {
    try {
      const pw = await import("playwright");
      chromium = pw.chromium;
    } catch {
      throw new Error("Playwright not installed. Run: npx playwright install chromium");
    }
  }
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    log("[PLAYWRIGHT] Browser launched");
  }
  if (!page || page.isClosed()) {
    page = await browser.newPage();
  }
  return page;
}

export async function navigateTo(url) {
  const p = await ensureBrowser();
  await p.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
  return { url: p.url(), title: await p.title() };
}

export async function screenshot(opts = {}) {
  const p = await ensureBrowser();
  const path = opts.path || join(tmpdir(), `yabby-screenshot-${randomUUID()}.png`);
  await p.screenshot({ path, fullPage: opts.fullPage || false });
  const buffer = await readFile(path);
  return { path, buffer, contentType: "image/png" };
}

export async function extractText(selector) {
  const p = await ensureBrowser();
  const el = await p.$(selector);
  if (!el) return { text: null, found: false };
  const text = await el.textContent();
  return { text, found: true };
}

export async function click(selector) {
  const p = await ensureBrowser();
  await p.click(selector, { timeout: 5000 });
  return { clicked: true };
}

export async function fill(selector, text) {
  const p = await ensureBrowser();
  await p.fill(selector, text, { timeout: 5000 });
  return { filled: true };
}

/**
 * Set the page's HTML content directly (no navigation). Useful for rendering
 * synthesized HTML (e.g. html_screenshot tool) without hitting an external URL.
 * @param {string} html - the HTML document or fragment to render
 * @param {object} [opts]
 * @param {number} [opts.widthPx=1200] - viewport width for the render
 * @param {number} [opts.heightPx=800] - viewport height; auto-grows if content exceeds
 * @param {number} [opts.waitMs=0] - extra wait after setContent (for async content/fonts)
 * @returns {Promise<{ url: string, title: string, widthPx: number, heightPx: number }>}
 */
export async function setHtmlContent(html, opts = {}) {
  const p = await ensureBrowser();
  const widthPx = opts.widthPx || 1200;
  const heightPx = opts.heightPx || 800;
  await p.setViewportSize({ width: widthPx, height: heightPx });
  await p.setContent(html, { waitUntil: "domcontentloaded", timeout: 15000 });
  if (opts.waitMs && opts.waitMs > 0) {
    await p.waitForTimeout(opts.waitMs);
  }
  return { url: p.url(), title: await p.title(), widthPx, heightPx };
}

/**
 * Run an arbitrary function inside the page context. Useful for scrapers
 * that need to extract structured DOM data.
 */
export async function evaluate(fn, ...args) {
  const p = await ensureBrowser();
  return p.evaluate(fn, ...args);
}

/**
 * Wait for a selector to appear on the page (default 5s).
 */
export async function waitForSelector(selector, opts = {}) {
  const p = await ensureBrowser();
  await p.waitForSelector(selector, { timeout: opts.timeout || 5000 });
  return true;
}

export async function closeBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
    log("[PLAYWRIGHT] Browser closed");
  }
}
