import { Router } from "express";
import { getProvider, listProviders, getDefaultProvider } from "../lib/providers/index.js";
import { getUsageSummary, getUsageByDay } from "../db/queries/usage.js";

const router = Router();

// GET /api/providers — list all providers with status
router.get("/api/providers", (_req, res) => {
  res.json(listProviders());
});

// GET /api/providers/:name/models — list models for a provider
router.get("/api/providers/:name/models", async (req, res) => {
  const provider = getProvider(req.params.name);
  if (!provider) return res.status(404).json({ error: `Provider "${req.params.name}" not found or not enabled` });
  try {
    const models = await provider.getModels();
    res.json({ provider: req.params.name, models });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/providers/:name/test — test connectivity
router.post("/api/providers/:name/test", async (req, res) => {
  const provider = getProvider(req.params.name);
  if (!provider) return res.status(404).json({ error: `Provider "${req.params.name}" not found or not enabled` });
  try {
    const result = await provider.test();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/providers/:name/complete — run a completion
router.post("/api/providers/:name/complete", async (req, res) => {
  const provider = getProvider(req.params.name);
  if (!provider) return res.status(404).json({ error: `Provider "${req.params.name}" not found or not enabled` });
  try {
    const { messages, model, temperature, maxTokens } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }
    const result = await provider.complete(messages, { model, temperature, maxTokens, context: "api" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/complete — use default provider
router.post("/api/complete", async (req, res) => {
  const provider = getDefaultProvider();
  if (!provider) return res.status(503).json({ error: "No LLM provider configured" });
  try {
    const { messages, model, temperature, maxTokens } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "messages array required" });
    }
    const result = await provider.complete(messages, { model, temperature, maxTokens, context: "api" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/usage — usage summary
router.get("/api/usage", async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const [summary, byDay] = await Promise.all([
      getUsageSummary(days),
      getUsageByDay(days),
    ]);
    const totalCost = summary.reduce((sum, r) => sum + parseFloat(r.total_cost || 0), 0);
    res.json({
      days,
      total_cost: totalCost,
      by_provider: summary,
      by_day: byDay,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
