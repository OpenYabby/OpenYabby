import { Router } from "express";
import { listPlugins, getPlugin, enablePlugin, disablePlugin } from "../lib/plugins/index.js";
import { getToolCount } from "../lib/plugins/tool-registry.js";

const router = Router();

// GET /api/plugins — list all plugins
router.get("/api/plugins", (_req, res) => {
  res.json({ plugins: listPlugins(), tools: getToolCount() });
});

// GET /api/plugins/:name — get a single plugin
router.get("/api/plugins/:name", (req, res) => {
  const info = getPlugin(req.params.name);
  if (!info) return res.status(404).json({ error: `Plugin "${req.params.name}" not found` });
  res.json(info);
});

// POST /api/plugins/:name/enable — enable a plugin
router.post("/api/plugins/:name/enable", async (req, res) => {
  try {
    const info = await enablePlugin(req.params.name);
    res.json({ ok: true, status: info.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/plugins/:name/disable — disable a plugin
router.post("/api/plugins/:name/disable", async (req, res) => {
  try {
    const info = await disablePlugin(req.params.name);
    res.json({ ok: true, status: info.status });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/plugins/:name/health — health check for a plugin
router.get("/api/plugins/:name/health", (req, res) => {
  const info = getPlugin(req.params.name);
  if (!info) return res.status(404).json({ error: "Not found" });
  res.json({
    name: info.name,
    status: info.status,
    error: info.error,
    version: info.version,
  });
});

export default router;
