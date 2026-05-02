import { Router } from "express";
import { getConfig, setConfig, validateConfig, getAllConfigCached } from "../lib/config.js";
import { initProviders } from "../lib/providers/index.js";

const router = Router();

// Map provider name → process.env key
const ENV_KEY_MAP = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

// Lightweight API key validation per provider
async function validateApiKey(name, apiKey) {
  const timeout = 8000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);

  try {
    switch (name) {
      case "openai": {
        const r = await fetch("https://api.openai.com/v1/models?limit=1", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`OpenAI API returned ${r.status}`);
        break;
      }
      case "anthropic": {
        const r = await fetch("https://api.anthropic.com/v1/models?limit=1", {
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`Anthropic API returned ${r.status}`);
        break;
      }
      case "groq": {
        const r = await fetch("https://api.groq.com/openai/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`Groq API returned ${r.status}`);
        break;
      }
      case "mistral": {
        const r = await fetch("https://api.mistral.ai/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`Mistral API returned ${r.status}`);
        break;
      }
      case "google": {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1/models?key=${apiKey}&pageSize=1`, {
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`Google AI API returned ${r.status}`);
        break;
      }
      case "openrouter": {
        const r = await fetch("https://openrouter.ai/api/v1/models?limit=1", {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: ctrl.signal,
        });
        if (!r.ok) throw new Error(`OpenRouter API returned ${r.status}`);
        break;
      }
      default:
        // Unknown provider — skip validation
        break;
    }
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/config/api-keys/status — which keys are configured (no secrets exposed)
// IMPORTANT: must be before /api/config/:key to avoid param capture
router.get("/api/config/api-keys/status", (_req, res) => {
  const llmConfig = getConfig("llm");
  const tasksConfig = getConfig("tasks");
  const status = {};
  for (const [name, envKey] of Object.entries(ENV_KEY_MAP)) {
    const hasEnv = !!process.env[envKey];
    const hasConfig = !!llmConfig?.providers?.[name]?.apiKey;
    status[name] = {
      configured: hasEnv || hasConfig,
      source: hasConfig ? "config" : hasEnv ? "env" : "none",
    };
  }
  // Include runner info for frontend runner-aware key display
  status._runner = tasksConfig?.runner || "claude";
  res.json(status);
});

// GET /api/config — return all config
router.get("/api/config", (_req, res) => {
  try {
    const config = getAllConfigCached();
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/config/:key — return a single config key
router.get("/api/config/:key", (req, res) => {
  try {
    const value = getConfig(req.params.key);
    if (value === null) return res.status(404).json({ error: "Config key not found" });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/config/:key — update a config key (validates with Zod)
router.put("/api/config/:key", async (req, res) => {
  const { key } = req.params;
  const value = req.body;

  if (value === undefined || value === null) {
    return res.status(400).json({ error: "Request body is required" });
  }

  // Validate first
  const validation = validateConfig(key, value);
  if (!validation.valid) {
    return res.status(400).json({ error: "Validation failed", details: validation.errors });
  }

  try {
    await setConfig(key, value);

    // Auto-create workspace structure when sandboxRoot changes
    if (key === "projects" && value.sandboxRoot) {
      try {
        const { initWorkspaceStructure } = await import("../lib/sandbox.js");
        await initWorkspaceStructure();
      } catch (err) {
        // Non-fatal — log but still return success
        console.error("[CONFIG] Failed to create workspace:", err.message);
      }
    }

    res.json({ ok: true, value: getConfig(key) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/config/validate — validate without saving
router.post("/api/config/validate", (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: "key is required" });

  const result = validateConfig(key, value);
  res.json(result);
});

// POST /api/config/reload — force reload from DB
router.post("/api/config/reload", async (_req, res) => {
  try {
    const { loadConfig } = await import("../lib/config.js");
    await loadConfig();
    res.json({ ok: true, config: getAllConfigCached() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/api-keys — save and validate API keys
router.post("/api/config/api-keys", async (req, res) => {
  const { keys } = req.body;
  if (!keys || typeof keys !== "object") {
    return res.status(400).json({ error: "keys object required" });
  }

  const results = {};
  const llmConfig = getConfig("llm") || {};
  const providers = { ...(llmConfig.providers || {}) };

  for (const [name, apiKey] of Object.entries(keys)) {
    if (!apiKey || typeof apiKey !== "string") continue;
    try {
      await validateApiKey(name, apiKey.trim());
      providers[name] = { ...(providers[name] || {}), apiKey: apiKey.trim(), enabled: true };
      // Update process.env so direct reads work immediately
      const envKey = ENV_KEY_MAP[name];
      if (envKey) process.env[envKey] = apiKey.trim();
      results[name] = { valid: true };
    } catch (err) {
      results[name] = { valid: false, error: err.message };
    }
  }

  // Save all valid keys to DB config
  try {
    await setConfig("llm", { ...llmConfig, providers });
    initProviders();
  } catch (err) {
    return res.status(500).json({ error: "Failed to save: " + err.message, results });
  }

  res.json({ results });
});

export default router;
