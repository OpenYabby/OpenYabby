/**
 * Hallucination detector — binary action classifier.
 *
 * Used by voice and channel handlers (web/whatsapp/slack/...) to detect
 * when an LLM response claims an action was performed without actually
 * having called the corresponding tool. The result is logged as a warning
 * only — no automatic retry. The fix lives in the prompt: the LLM is
 * told the system watches for false claims, which discourages them.
 */

import { getProvider } from "./providers/index.js";

const SYSTEM_PROMPT =
  "You are a binary classifier. The user will give you a single message. " +
  "You must decide: does this message either (A) request or demand that an action be performed " +
  "(like fetching weather, creating a file, searching the web, sending an email, executing a task) " +
  "OR (B) claim that the author is currently performing, has just performed, or is about to perform " +
  "a concrete action? Answer ONLY with the word true or false. " +
  "A simple greeting, opinion, conversational reply, or question about the assistant itself is false.";

/**
 * @param {string} text - The text to classify.
 * @returns {Promise<boolean>} true if the text claims/requests an action.
 */
export async function detectActionClaim(text) {
  if (!text || text.length < 5) return false;
  try {
    const provider = getProvider("openai");
    // For gpt-5-mini, max_completion_tokens covers both reasoning AND visible
    // output. Small caps starve the reasoning step and yield empty output, so
    // we allocate a generous budget. The classifier is invoked rarely (per
    // assistant turn that has no tool call), so cost is negligible.
    const result = await provider.complete(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: text },
      ],
      { model: "gpt-5-mini", maxTokens: 256, context: "action_check" }
    );
    const raw = (result.text || "").trim().toLowerCase();
    // gpt-5-mini may wrap with punctuation; be tolerant.
    return raw.startsWith("true");
  } catch {
    return false;
  }
}
