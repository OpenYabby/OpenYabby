/* ═══════════════════════════════════════════════════════
   Image Generation Client — HTTP to sidecar
   ═══════════════════════════════════════════════════════
   Fail-open: if the sidecar is unreachable, returns
   { error: "image generation service unavailable" }
   instead of throwing. The LLM interprets this and
   explains in natural language.
*/

import { getConfig } from "../config.js";
import { write as storeWrite } from "../media/store.js";
import { log } from "../logger.js";

/**
 * Call the sidecar to generate an image.
 * @param {{ prompt, model?, steps?, width?, height?, seed?, negative_prompt? }} opts
 * @returns {Promise<{ assetId, prompt, model, elapsed_ms } | { error: string }>}
 */
export async function generate(opts) {
  const cfg = getConfig("imagegen") || {};
  if (!cfg.enabled) {
    return { error: "image generation is disabled (not running on macOS or manually disabled)" };
  }

  const baseUrl = cfg.serviceUrl || "http://localhost:3002";
  const timeoutMs = cfg.timeoutMs || 30000;
  const model = opts.model || cfg.defaultModel || "stabilityai/sdxl-turbo";
  const [defaultW, defaultH] = (cfg.defaultSize || "512x512").split("x").map(Number);
  const steps = opts.steps || cfg.defaultSteps || 4;
  const width = opts.width || defaultW || 512;
  const height = opts.height || defaultH || 512;

  const body = {
    prompt: opts.prompt,
    model,
    steps,
    width,
    height,
    seed: opts.seed ?? null,
    negative_prompt: opts.negative_prompt ?? null,
  };

  log(`[IMAGEGEN] Requesting: "${opts.prompt?.slice(0, 80)}" model=${model} steps=${steps} ${width}x${height}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const res = await fetch(`${baseUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (res.status === 429) {
      return { error: "image generation queue full, please try again in a moment" };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { error: `image generation failed (${res.status}): ${text.slice(0, 200)}` };
    }

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const elapsedMs = parseInt(res.headers.get("X-Elapsed-Ms") || "0", 10);
    const usedModel = res.headers.get("X-Model") || model;

    log(`[IMAGEGEN] Generated ${buffer.byteLength}B in ${elapsedMs}ms (model=${usedModel})`);

    const asset = await storeWrite(buffer, "image/png", {
      source: "generated",
      metadata: {
        prompt: opts.prompt,
        model: usedModel,
        steps,
        width,
        height,
        seed: opts.seed ?? null,
        negative_prompt: opts.negative_prompt ?? null,
        elapsed_ms: elapsedMs,
      },
    });

    return {
      assetId: asset.id,
      prompt: opts.prompt,
      model: usedModel,
      elapsed_ms: elapsedMs,
    };
  } catch (err) {
    if (err.name === "AbortError") {
      log(`[IMAGEGEN] Request timed out after ${timeoutMs}ms`);
      return { error: `image generation timed out after ${timeoutMs / 1000}s` };
    }
    log(`[IMAGEGEN] Request failed: ${err.message}`);
    return { error: "image generation service unavailable" };
  }
}

/**
 * Check sidecar health/status.
 * @returns {Promise<{ ready, model, queue_depth } | null>}
 */
export async function getStatus() {
  const cfg = getConfig("imagegen") || {};
  if (!cfg.enabled) return null;
  const baseUrl = cfg.serviceUrl || "http://localhost:3002";
  try {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${baseUrl}/status`, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
