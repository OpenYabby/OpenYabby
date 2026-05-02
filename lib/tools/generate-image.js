/* ═══════════════════════════════════════════════════════
   generate_image tool
   ═══════════════════════════════════════════════════════
   Calls the local image generation sidecar to produce an
   image from a text prompt. Returns an asset id that the
   handler dispatches via adapter.sendImage().

   Fail-open: if the sidecar is down or disabled, returns
   a clear error object — the LLM can then explain to the
   user that image generation is unavailable.
*/

import { generate } from "../imagegen/client.js";
import { log } from "../logger.js";

/**
 * @param {{ prompt: string, model?: string, size?: string, steps?: number, negative_prompt?: string, seed?: number }} args
 * @returns {Promise<{ assetId, prompt_used, model, elapsed_ms } | { error: string }>}
 */
export async function generateImage(args) {
  const prompt = (args?.prompt || "").trim();
  if (!prompt) {
    throw new Error("generate_image: prompt is required");
  }

  // Parse size string "WxH" into width + height
  let width, height;
  if (args?.size && /^\d+x\d+$/.test(args.size)) {
    [width, height] = args.size.split("x").map(Number);
  }

  log(`[TOOL:generate_image] prompt="${prompt.slice(0, 80)}" model=${args?.model || "default"}`);

  const result = await generate({
    prompt,
    model: args?.model,
    steps: args?.steps,
    width,
    height,
    seed: args?.seed,
    negative_prompt: args?.negative_prompt,
  });

  if (result.error) {
    log(`[TOOL:generate_image] error: ${result.error}`);
    return { error: result.error };
  }

  log(`[TOOL:generate_image] generated ${result.assetId} in ${result.elapsed_ms}ms`);
  return {
    assetId: result.assetId,
    prompt_used: result.prompt,
    model: result.model,
    elapsed_ms: result.elapsed_ms,
  };
}
