/**
 * Provider Registry — loads providers from config, exposes getProvider/getDefault/list.
 */
import { getConfig } from "../config.js";
import { log } from "../logger.js";

import { OpenAIProvider } from "./openai.js";
import { AnthropicProvider } from "./anthropic.js";
import { GoogleProvider } from "./google.js";
import { GroqProvider } from "./groq.js";
import { OllamaProvider } from "./ollama.js";
import { MistralProvider } from "./mistral.js";
import { OpenRouterProvider } from "./openrouter.js";

const PROVIDER_CLASSES = {
  openai: OpenAIProvider,
  anthropic: AnthropicProvider,
  google: GoogleProvider,
  groq: GroqProvider,
  ollama: OllamaProvider,
  mistral: MistralProvider,
  openrouter: OpenRouterProvider,
};

/** @type {Map<string, import('./base.js').LLMProvider>} */
const providers = new Map();

/** Initialize providers from config */
export function initProviders() {
  providers.clear();

  // Auto-detect providers from environment variables
  const ENV_KEYS = {
    openai: "OPENAI_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    groq: "GROQ_API_KEY",
    google: "GOOGLE_API_KEY",
    mistral: "MISTRAL_API_KEY",
    openrouter: "OPENROUTER_API_KEY",
  };

  for (const [name, envKey] of Object.entries(ENV_KEYS)) {
    if (process.env[envKey]) {
      const ProviderClass = PROVIDER_CLASSES[name];
      if (ProviderClass) {
        providers.set(name, new ProviderClass({ enabled: true }));
      }
    }
  }

  // Load additional providers from config
  const llmConfig = getConfig("llm");
  if (llmConfig?.providers) {
    for (const [name, cfg] of Object.entries(llmConfig.providers)) {
      if (!cfg.enabled) continue;
      const ProviderClass = PROVIDER_CLASSES[name];
      if (!ProviderClass) {
        log(`[PROVIDERS] Unknown provider: ${name}`);
        continue;
      }
      // Don't overwrite env-based providers unless config has an apiKey
      if (providers.has(name) && !cfg.apiKey) continue;
      try {
        providers.set(name, new ProviderClass(cfg));
        log(`[PROVIDERS] Loaded: ${name}`);
      } catch (err) {
        log(`[PROVIDERS] Error loading ${name}: ${err.message}`);
      }
    }
  }

  log(`[PROVIDERS] ${providers.size} provider(s) active: ${[...providers.keys()].join(", ") || "none"}`);
}

/** Get a specific provider by name */
export function getProvider(name) {
  return providers.get(name) || null;
}

/** Get the default provider (from config, or first available) */
export function getDefaultProvider() {
  const llmConfig = getConfig("llm");
  const defaultName = llmConfig?.defaultProvider || "openai";
  return providers.get(defaultName) || providers.values().next().value || null;
}

/** List all providers with status */
export function listProviders() {
  const result = {};
  for (const [name] of Object.entries(PROVIDER_CLASSES)) {
    const provider = providers.get(name);
    result[name] = {
      enabled: !!provider,
      hasApiKey: !!provider,
    };
  }
  return result;
}

/** Get all active provider names */
export function activeProviderNames() {
  return [...providers.keys()];
}
