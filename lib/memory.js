import { Memory } from "mem0ai/oss";
import { log } from "./logger.js";
import { getConfig } from "./config.js";

const DEFAULT_USER_ID = "default";

let memory;
let memoryInitFailed = false;

// Profile cache — avoids repeated Qdrant queries (invalidated on extract/clear)
let _profileCache = { value: null, ts: 0 };
const PROFILE_CACHE_TTL = 5 * 60_000; // 5 minutes

async function getMemory() {
  if (memory) return memory;
  if (memoryInitFailed) return null;

  // CRITICAL: Read memory model from config. Pinned to gpt-5-mini by default.
  // DO NOT change — nano misses French names. See CLAUDE.md.
  const memConfig = getConfig("memory") || {};
  const llmModel = memConfig.model || "gpt-5-mini";
  const embedModel = memConfig.embedder || "text-embedding-3-small";

  try {
    memory = new Memory({
      version: "v1.1",
      llm: {
        provider: "openai",
        config: {
          model: llmModel,
          apiKey: process.env.OPENAI_API_KEY,
        },
      },
      embedder: {
        provider: "openai",
        config: {
          model: embedModel,
          apiKey: process.env.OPENAI_API_KEY,
          embeddingDims: 1536,
        },
      },
      customPrompt: `You are a Personal Information Organizer. Extract distinct facts from conversations. Focus on personal details (names, age, location, profession), preferences, plans, and relationships.

CRITICAL: Always extract the user's NAME when mentioned. French expressions like "je m'appelle X", "moi c'est X", "c'est X" mean "Name is X".

Examples:

Input: Hi, my name is John. I am a software engineer.
Output: {"facts": ["Name is John", "Is a software engineer"]}

Input: Salut, moi c'est Marie. J'ai 28 ans.
Output: {"facts": ["Name is Marie", "Age is 28"]}

Input: Je m'appelle Lucas et j'habite à Paris.
Output: {"facts": ["Name is Lucas", "Lives in Paris"]}

Input: Hi.
Output: {"facts": []}

Return a JSON object with a "facts" key containing an array of strings.`,
    });

    log(`[MEMORY] Mem0 initialized (LLM: ${llmModel}, embedder: ${embedModel}, Qdrant store)`);
    return memory;
  } catch (err) {
    log("[MEMORY] Failed to initialize Mem0:", err.message);
    memoryInitFailed = true;
    // Retry after 60s in case quota recovers
    setTimeout(() => { memoryInitFailed = false; }, 60000);
    return null;
  }
}

/**
 * Extract and store facts from recent conversation turns.
 */
export async function extractMemories(turns, userId = DEFAULT_USER_ID) {
  if (!turns || turns.length < 2) return;

  const mem = await getMemory();
  if (!mem) {
    log("[MEMORY] Skipping extraction — Mem0 unavailable");
    return;
  }

  const messages = turns.map(t => ({
    role: t.role === "assistant" ? "assistant" : "user",
    content: t.text,
  }));

  try {
    // Estimate tokens (rough: 4 chars = 1 token)
    const messagesText = JSON.stringify(messages);
    const estimatedInputTokens = Math.round(messagesText.length / 4);
    const estimatedOutputTokens = 100; // typical memory facts output

    const result = await mem.add(messages, { userId });
    const count = result?.results?.length || result?.length || 0;
    log("[MEMORY] Extracted", count, "memories from", turns.length, "turns");

    // Invalidate profile cache so next getMemoryProfile() fetches fresh data
    _profileCache.ts = 0;

    // Track usage (Mem0 uses gpt-5-mini for extraction)
    try {
      const { logUsage } = await import("../db/queries/usage.js");
      await logUsage({
        provider: "openai",
        model: "gpt-5-mini",
        inputTokens: estimatedInputTokens,
        outputTokens: estimatedOutputTokens,
        context: "memory_extraction"
      });
    } catch (err) {
      log("[MEMORY] Failed to log usage:", err.message);
    }

    return result;
  } catch (err) {
    log("[MEMORY] Error extracting:", err.message);
  }
}

/**
 * Get all stored memories for a user, formatted as a bullet list string.
 */
export async function getMemoryProfile(userId = DEFAULT_USER_ID) {
  // Return cached profile if still fresh
  if (_profileCache.value !== null && Date.now() - _profileCache.ts < PROFILE_CACHE_TTL) {
    return _profileCache.value;
  }

  const mem = await getMemory();
  if (!mem) return "";

  try {
    const result = await mem.getAll({ userId });
    const memories = result?.results || result || [];

    if (!memories.length) {
      _profileCache = { value: "", ts: Date.now() };
      return "";
    }

    const lines = memories.map(m => `- ${m.memory}`);
    const profile = lines.join("\n");
    _profileCache = { value: profile, ts: Date.now() };
    return profile;
  } catch (err) {
    log("[MEMORY] Error getting profile:", err.message);
    return "";
  }
}

/**
 * Search memories relevant to a specific query.
 */
export async function searchMemories(queryStr, userId = DEFAULT_USER_ID, limit = 10) {
  const mem = await getMemory();
  if (!mem) return [];

  try {
    const result = await mem.search(queryStr, { userId, limit });
    return result?.results || result || [];
  } catch (err) {
    log("[MEMORY] Error searching:", err.message);
    return [];
  }
}

/**
 * Delete all memories for a user (used on conversation reset).
 */
export async function clearMemories(userId = DEFAULT_USER_ID) {
  const mem = await getMemory();
  if (!mem) return;

  try {
    await mem.deleteAll({ userId });
    _profileCache = { value: null, ts: 0 }; // invalidate cache
    log("[MEMORY] Cleared all memories for user:", userId);
  } catch (err) {
    log("[MEMORY] Error clearing:", err.message);
  }
}
