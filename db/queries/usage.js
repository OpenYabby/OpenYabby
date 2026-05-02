import { query } from "../pg.js";
import { calculateCost } from "../../lib/pricing.js";

export async function logUsage({ provider, model, inputTokens, outputTokens, costUsd, context, extra = {} }) {
  // Auto-calculate cost if not provided
  const finalCost = costUsd !== undefined
    ? costUsd
    : calculateCost(provider, model, inputTokens || 0, outputTokens || 0, extra);

  await query(
    `INSERT INTO usage_log (provider, model, input_tokens, output_tokens, cost_usd, context, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [provider, model, inputTokens || 0, outputTokens || 0, finalCost, context || "chat"]
  );

  // Log for debugging (only if cost > 0)
  if (finalCost > 0) {
    console.log(`[USAGE] ${provider}/${model}: ${inputTokens}→${outputTokens} tokens = $${finalCost.toFixed(6)} (${context || "chat"})`);
  }
}

export async function getUsageSummary(days = 30) {
  const { rows } = await query(
    `SELECT
       provider,
       count(*)::int AS calls,
       sum(input_tokens)::int AS total_input,
       sum(output_tokens)::int AS total_output,
       sum(cost_usd)::numeric AS total_cost
     FROM usage_log
     WHERE created_at > NOW() - INTERVAL '1 day' * $1
     GROUP BY provider
     ORDER BY total_cost DESC`,
    [days]
  );
  return rows;
}

export async function getUsageByDay(days = 30) {
  const { rows } = await query(
    `SELECT
       date_trunc('day', created_at)::date AS day,
       provider,
       count(*)::int AS calls,
       sum(input_tokens)::int AS input_tokens,
       sum(output_tokens)::int AS output_tokens,
       sum(cost_usd)::numeric AS cost
     FROM usage_log
     WHERE created_at > NOW() - INTERVAL '1 day' * $1
     GROUP BY day, provider
     ORDER BY day DESC`,
    [days]
  );
  return rows;
}
