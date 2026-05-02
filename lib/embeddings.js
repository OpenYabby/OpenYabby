/* ═══════════════════════════════════════════════════════
   YABBY — Embedding Provider Abstraction
   ═══════════════════════════════════════════════════════
   embed(text, provider?) — supports OpenAI, Ollama,
   Mistral via Phase 3 providers.
*/

import { log } from "./logger.js";

/**
 * Generate embeddings for a text string.
 */
export async function embed(text, provider = "openai") {
  switch (provider) {
    case "openai":
      return embedOpenAI(text);
    case "ollama":
      return embedOllama(text);
    case "mistral":
      return embedMistral(text);
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}

/**
 * Batch embed multiple texts.
 */
export async function batchEmbed(texts, provider = "openai") {
  if (provider === "openai") {
    return batchEmbedOpenAI(texts);
  }
  // Fallback: sequential
  const results = [];
  for (const text of texts) {
    results.push(await embed(text, provider));
  }
  return results;
}

// ── OpenAI ──

async function embedOpenAI(text) {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI embed error: ${resp.status}`);
  const data = await resp.json();

  // Track embedding usage
  try {
    const { logUsage } = await import("../db/queries/usage.js");
    const tokens = data.usage?.total_tokens || 0;
    await logUsage({
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: tokens,
      outputTokens: 0,
      context: "embedding"
    });
  } catch (err) {
    log("[EMBED] Failed to log usage:", err.message);
  }

  return data.data[0].embedding;
}

async function batchEmbedOpenAI(texts) {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: texts,
    }),
  });
  if (!resp.ok) throw new Error(`OpenAI batch embed error: ${resp.status}`);
  const data = await resp.json();

  // Track batch embedding usage
  try {
    const { logUsage } = await import("../db/queries/usage.js");
    const totalTokens = data.usage?.total_tokens || 0;
    await logUsage({
      provider: "openai",
      model: "text-embedding-3-small",
      inputTokens: totalTokens,
      outputTokens: 0,
      context: "embedding_batch"
    });
  } catch (err) {
    log("[EMBED] Failed to log batch usage:", err.message);
  }

  return data.data.map(d => d.embedding);
}

// ── Ollama ──

async function embedOllama(text) {
  const resp = await fetch("http://localhost:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
  });
  if (!resp.ok) throw new Error(`Ollama embed error: ${resp.status}`);
  const data = await resp.json();
  return data.embedding;
}

// ── Mistral ──

async function embedMistral(text) {
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error("MISTRAL_API_KEY not set");

  const resp = await fetch("https://api.mistral.ai/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "mistral-embed",
      input: [text],
    }),
  });
  if (!resp.ok) throw new Error(`Mistral embed error: ${resp.status}`);
  const data = await resp.json();
  return data.data[0].embedding;
}
