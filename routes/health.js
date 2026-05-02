import { Router } from "express";
import pool from "../db/pg.js";
import { redis } from "../db/redis.js";
import { listChannels } from "../lib/channels/index.js";
import { listPlugins } from "../lib/plugins/index.js";
import { getToolCount } from "../lib/plugins/tool-registry.js";
import { getTunnelCode } from "../lib/tunnel.js";

const router = Router();
const startTime = Date.now();

// GET /api/health — basic health check
router.get("/api/health", async (_req, res) => {
  const checks = {};

  // PostgreSQL
  try {
    await pool.query("SELECT 1");
    checks.pg = "ok";
  } catch (err) {
    checks.pg = `error: ${err.message}`;
  }

  // Redis
  try {
    await redis.ping();
    checks.redis = "ok";
  } catch (err) {
    checks.redis = `error: ${err.message}`;
  }

  const allOk = checks.pg === "ok" && checks.redis === "ok";
  const tunnelCode = getTunnelCode();
  res.status(allOk ? 200 : 503).json({
    status: allOk ? "healthy" : "degraded",
    uptime: Math.round((Date.now() - startTime) / 1000),
    ...checks,
    tunnel: tunnelCode ? {
      code: tunnelCode,
      relay: 'relay.openyabby.com',
    } : null,
  });
});

// GET /api/health/detailed — full system status
router.get("/api/health/detailed", async (_req, res) => {
  const result = {
    status: "healthy",
    uptime: Math.round((Date.now() - startTime) / 1000),
    subsystems: {},
  };

  // PG
  try {
    await pool.query("SELECT 1");
    result.subsystems.pg = { status: "ok" };
  } catch (err) {
    result.subsystems.pg = { status: "error", error: err.message };
    result.status = "degraded";
  }

  // Redis
  try {
    await redis.ping();
    result.subsystems.redis = { status: "ok" };
  } catch (err) {
    result.subsystems.redis = { status: "error", error: err.message };
    result.status = "degraded";
  }

  // Channels
  try {
    const channels = listChannels();
    const running = Object.values(channels).filter(c => c.running).length;
    const enabled = Object.values(channels).filter(c => c.enabled).length;
    result.subsystems.channels = { running, enabled, total: Object.keys(channels).length };
  } catch {
    result.subsystems.channels = { status: "unavailable" };
  }

  // Plugins
  try {
    const plugins = listPlugins();
    const active = plugins.filter(p => p.status === "active").length;
    const errors = plugins.filter(p => p.status === "error").length;
    result.subsystems.plugins = { total: plugins.length, active, errors };
  } catch {
    result.subsystems.plugins = { status: "unavailable" };
  }

  // Tools
  result.subsystems.tools = getToolCount();

  // OpenAI
  try {
    const resp = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      signal: AbortSignal.timeout(5000),
    });
    result.subsystems.openai = { status: resp.ok ? "ok" : "error", httpStatus: resp.status };
  } catch (err) {
    result.subsystems.openai = { status: "unreachable", error: err.message };
  }

  res.json(result);
});

// GET /api/usage — cost summary
router.get("/api/usage", async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    // Query usage_log table
    const { rows: byProvider } = await pool.query(
      `SELECT provider, model,
              COUNT(*) as calls,
              COALESCE(SUM(input_tokens), 0) as input_tokens,
              COALESCE(SUM(output_tokens), 0) as output_tokens,
              COALESCE(SUM(cost_usd), 0) as cost_usd
       FROM usage_log WHERE created_at >= $1
       GROUP BY provider, model ORDER BY cost_usd DESC`,
      [since]
    );

    const { rows: byDay } = await pool.query(
      `SELECT DATE(created_at) as day,
              COALESCE(SUM(cost_usd), 0) as cost_usd,
              COUNT(*) as calls
       FROM usage_log WHERE created_at >= $1
       GROUP BY DATE(created_at) ORDER BY day`,
      [since]
    );

    const totalCost = byProvider.reduce((sum, r) => sum + parseFloat(r.cost_usd), 0);

    res.json({ days, totalCost, byProvider, byDay });
  } catch (err) {
    // If usage_log table doesn't exist yet, return empty
    res.json({ days: 30, totalCost: 0, byProvider: [], byDay: [] });
  }
});

export default router;
