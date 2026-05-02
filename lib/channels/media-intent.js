/* ═══════════════════════════════════════════════════════
   Media Intent Classifier
   ═══════════════════════════════════════════════════════
   Quick gpt-5-mini call to detect if the user's message
   implies a media action. Returns { kind, confidence }.
   When high-confidence, handler injects a system hint
   so the LLM prefers the right tool.
*/

import { log } from "../logger.js";

const PROMPT = `You classify user messages into one of these media intents:
- generate: user wants an AI-generated image ("draw me", "create a picture of", "generate an image", "dessine")
- search: user wants to see real photos/images from the web ("show me", "what does X look like", "find images of")
- screenshot: user wants a screenshot of a specific URL ("screenshot of", "capture", "show me this page")
- none: no media intent

Respond with ONLY one word: generate, search, screenshot, or none.`;

/**
 * @param {string} text - user message text
 * @returns {Promise<{ kind: "generate"|"search"|"screenshot"|null, confidence: "high"|"low" }>}
 */
export async function detectMediaIntent(text) {
  if (!text || text.length < 5) return { kind: null, confidence: "low" };

  try {
    const { getProvider } = await import("../providers/index.js");
    const provider = getProvider("openai");
    if (!provider) return { kind: null, confidence: "low" };

    const result = await provider.complete([
      { role: "system", content: PROMPT },
      { role: "user", content: text },
    ], { model: "gpt-5-mini", maxTokens: 5, context: "media_intent" });

    const word = (result.text || "").trim().toLowerCase();
    const VALID = new Set(["generate", "search", "screenshot"]);
    if (VALID.has(word)) {
      return { kind: word, confidence: "high" };
    }
    return { kind: null, confidence: "low" };
  } catch (err) {
    log(`[MEDIA-INTENT] classifier failed: ${err.message}`);
    return { kind: null, confidence: "low" };
  }
}

/** Map intent kind to tool name for the system-prompt hint. */
export function intentToToolHint(kind) {
  switch (kind) {
    case "generate": return "generate_image";
    case "search": return "search_images";
    case "screenshot": return "web_screenshot";
    default: return null;
  }
}
