import express from "express";
import { query } from "../db/pg.js";

const router = express.Router();

/**
 * GET /api/usage/detailed?days=7
 * Returns comprehensive usage analytics with breakdowns
 */
router.get("/detailed", async (req, res) => {
  const days = parseInt(req.query.days) || 7;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  try {
    // Summary totals
    const summaryResult = await query(`
      SELECT
        COUNT(*)::int as total_calls,
        COALESCE(SUM(input_tokens), 0)::bigint as total_input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint as total_output_tokens,
        COALESCE(SUM(cost_usd), 0)::numeric as total_cost
      FROM usage_log
      WHERE created_at >= $1
    `, [since]);

    // By provider
    const byProvider = await query(`
      SELECT
        provider,
        COUNT(*)::int as calls,
        COALESCE(SUM(input_tokens), 0)::bigint as input_tokens,
        COALESCE(SUM(output_tokens), 0)::bigint as output_tokens,
        COALESCE(SUM(cost_usd), 0)::numeric as cost
      FROM usage_log
      WHERE created_at >= $1
      GROUP BY provider
      ORDER BY cost DESC
    `, [since]);

    // By day
    const byDay = await query(`
      SELECT
        DATE(created_at) as date,
        COALESCE(SUM(cost_usd), 0)::numeric as cost
      FROM usage_log
      WHERE created_at >= $1
      GROUP BY DATE(created_at)
      ORDER BY date
    `, [since]);

    // By context
    const byContext = await query(`
      SELECT
        context,
        COUNT(*)::int as calls,
        COALESCE(SUM(cost_usd), 0)::numeric as cost
      FROM usage_log
      WHERE created_at >= $1
      GROUP BY context
      ORDER BY cost DESC
    `, [since]);

    // By model (top 10)
    const byModel = await query(`
      SELECT
        model,
        COUNT(*)::int as calls,
        COALESCE(SUM(cost_usd), 0)::numeric as cost
      FROM usage_log
      WHERE created_at >= $1
      GROUP BY model
      ORDER BY cost DESC
      LIMIT 10
    `, [since]);

    // Recent logs (last 100)
    const logs = await query(`
      SELECT
        id,
        provider,
        model,
        input_tokens,
        output_tokens,
        cost_usd,
        context,
        created_at
      FROM usage_log
      WHERE created_at >= $1
      ORDER BY created_at DESC
      LIMIT 100
    `, [since]);

    res.json({
      summary: summaryResult.rows[0] || {
        total_calls: 0,
        total_input_tokens: 0,
        total_output_tokens: 0,
        total_cost: 0
      },
      by_provider: byProvider.rows,
      by_day: byDay.rows,
      by_context: byContext.rows,
      by_model: byModel.rows,
      logs: logs.rows
    });

  } catch (err) {
    console.error("[USAGE-API] Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/usage/pricing
 * Returns pricing model for transparency
 */
router.get("/pricing", async (req, res) => {
  try {
    const { getAllPricing } = await import("../lib/pricing.js");
    res.json(getAllPricing());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
