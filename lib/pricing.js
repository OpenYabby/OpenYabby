// Last updated: 2026-03-31
// Source: https://openai.com/api/pricing/
// Next check: 2026-04-30

/**
 * Pricing Model - Central source of truth for all LLM API costs
 *
 * Prices are in USD per 1 million tokens (unless specified otherwise)
 *
 * Special pricing types:
 * - audio: USD per minute (Whisper transcription)
 * - characters: USD per 1 million characters (TTS services)
 */

const PRICING = {
  // ============================================================================
  // OpenAI Models
  // ============================================================================

  "gpt-4o": {
    input: 2.50,
    output: 10.00
  },

  "gpt-4o-mini": {
    input: 0.150,
    output: 0.600
  },

  "gpt-4-turbo": {
    input: 10.00,
    output: 30.00
  },

  "gpt-3.5-turbo": {
    input: 0.50,
    output: 1.50
  },

  // GPT-4.1 series
  "gpt-4.1": {
    input: 2.00,
    output: 8.00
  },

  "gpt-4.1-mini": {
    input: 0.40,
    output: 1.60
  },

  "gpt-4.1-nano": {
    input: 0.10,
    output: 0.40
  },

  // o-series reasoning models
  "o3": {
    input: 2.00,
    output: 8.00
  },

  "o3-mini": {
    input: 1.10,
    output: 4.40
  },

  "o4-mini": {
    input: 1.10,
    output: 4.40
  },

  // Realtime API (Voice WebRTC)
  "gpt-realtime": {
    input: 5.00,        // audio input tokens
    output: 20.00,      // audio output tokens
    text_input: 2.50,   // text input tokens
    text_output: 10.00  // text output tokens
  },

  // Whisper Transcription (audio → text)
  "gpt-4o-mini-transcribe": {
    audio: 0.10  // per minute
  },

  // Text-to-Speech
  "gpt-4o-mini-tts": {
    characters: 0.015  // per 1M characters
  },

  // Embeddings
  "text-embedding-3-small": {
    input: 0.020,
    output: 0
  },

  "text-embedding-3-large": {
    input: 0.130,
    output: 0
  },

  // Memory extraction (Mem0 uses this)
  "gpt-5-mini": {
    input: 0.150,
    output: 0.600
  },

  // ============================================================================
  // Anthropic Models
  // ============================================================================

  "claude-opus-4-6": {
    input: 15.00,
    output: 75.00
  },

  "claude-sonnet-4-5-20250929": {
    input: 3.00,
    output: 15.00
  },

  "claude-haiku-4-5-20251001": {
    input: 0.80,
    output: 4.00
  },

  // ============================================================================
  // Google Models
  // ============================================================================

  "gemini-2.0-flash-exp": {
    input: 0,
    output: 0  // free tier
  },

  "gemini-1.5-pro": {
    input: 1.25,
    output: 5.00
  },

  "gemini-1.5-flash": {
    input: 0.075,
    output: 0.30
  },

  // ============================================================================
  // Groq Models
  // ============================================================================

  "llama-3.3-70b-versatile": {
    input: 0.59,
    output: 0.79
  },

  "mixtral-8x7b-32768": {
    input: 0.24,
    output: 0.24
  },

  "llama-3.1-8b-instant": {
    input: 0.05,
    output: 0.08
  },

  // ============================================================================
  // Mistral Models
  // ============================================================================

  "mistral-large-latest": {
    input: 2.00,
    output: 6.00
  },

  "mistral-small-latest": {
    input: 0.20,
    output: 0.60
  },

  "mistral-embed": {
    input: 0.10,
    output: 0
  },

  // ============================================================================
  // ElevenLabs TTS
  // ============================================================================

  "eleven_multilingual_v2": {
    characters: 0.30  // per 1M characters
  },

  "eleven_turbo_v2": {
    characters: 0.30  // per 1M characters
  },

  // ============================================================================
  // OpenRouter
  // ============================================================================
  // OpenRouter acts as a pass-through proxy
  // Use same pricing as the underlying model

  // ============================================================================
  // Ollama (self-hosted)
  // ============================================================================
  // Cost is $0 for self-hosted models
};

/**
 * Calculate cost for token usage
 *
 * @param {string} provider - Provider name (openai, anthropic, google, etc.)
 * @param {string} model - Model name (gpt-4o, claude-sonnet-4-5, etc.)
 * @param {number} inputTokens - Number of input tokens
 * @param {number} outputTokens - Number of output tokens
 * @param {object} extra - Extra data for special pricing:
 *                         - audio_minutes: for Whisper transcription
 *                         - characters: for TTS services
 * @returns {number} Cost in USD
 */
export function calculateCost(provider, model, inputTokens, outputTokens, extra = {}) {
  // Self-hosted models have no cost
  if (provider === "ollama") {
    return 0;
  }

  const pricing = PRICING[model];

  if (!pricing) {
    console.warn(`[PRICING] No pricing data for model: ${model} (provider: ${provider})`);
    return 0;
  }

  let cost = 0;

  // Standard token-based pricing
  if (pricing.input !== undefined && pricing.output !== undefined) {
    cost += (inputTokens / 1_000_000) * pricing.input;
    cost += (outputTokens / 1_000_000) * pricing.output;
  }

  // Audio-based pricing (Whisper - per minute)
  if (pricing.audio !== undefined && extra.audio_minutes) {
    cost = extra.audio_minutes * pricing.audio;
  }

  // Character-based pricing (TTS - per 1M characters)
  if (pricing.characters !== undefined && extra.characters) {
    cost = (extra.characters / 1_000_000) * pricing.characters;
  }

  return cost;
}

/**
 * Get pricing info for a specific model
 *
 * @param {string} model - Model name
 * @returns {object|null} Pricing object or null if not found
 */
export function getPricing(model) {
  return PRICING[model] || null;
}

/**
 * Get all pricing data (for transparency/debugging)
 *
 * @returns {object} Complete pricing table
 */
export function getAllPricing() {
  return PRICING;
}

/**
 * Estimate token count from text
 * Rough approximation: 1 token ≈ 4 characters
 *
 * @param {string} text - Text to estimate
 * @returns {number} Estimated token count
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.round(text.length / 4);
}
