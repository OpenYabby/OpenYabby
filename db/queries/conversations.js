import { query } from "../pg.js";
import { redis, KEY } from "../redis.js";

export const DEFAULT_CONV_ID = "00000000-0000-0000-0000-000000000001";
const MAX_TURNS = 50; // Increased to keep more conversation context

export async function getConversation(convId = DEFAULT_CONV_ID, limit = null) {
  async function fetchTurns() {
    try {
      return await query(
        limit
          ? `SELECT ct.id, ct.role, ct.text, ct.ts,
                    COALESCE(array_agg(tm.asset_id ORDER BY tm.position) FILTER (WHERE tm.asset_id IS NOT NULL), '{}') AS media_asset_ids
             FROM conversation_turns ct
             LEFT JOIN turn_media tm ON tm.turn_id = ct.id
             WHERE ct.conversation_id = $1 AND ct.active = TRUE
             GROUP BY ct.id, ct.role, ct.text, ct.ts
             ORDER BY ct.ts DESC LIMIT $2`
          : `SELECT ct.id, ct.role, ct.text, ct.ts,
                    COALESCE(array_agg(tm.asset_id ORDER BY tm.position) FILTER (WHERE tm.asset_id IS NOT NULL), '{}') AS media_asset_ids
             FROM conversation_turns ct
             LEFT JOIN turn_media tm ON tm.turn_id = ct.id
             WHERE ct.conversation_id = $1 AND ct.active = TRUE
             GROUP BY ct.id, ct.role, ct.text, ct.ts
             ORDER BY ct.ts ASC`,
        limit ? [convId, limit] : [convId]
      );
    } catch {
      // Fallback: turn_media table may not exist yet (pre-migration)
      return query(
        limit
          ? `SELECT id, role, text, ts FROM conversation_turns WHERE conversation_id = $1 AND active = TRUE ORDER BY ts DESC LIMIT $2`
          : `SELECT id, role, text, ts FROM conversation_turns WHERE conversation_id = $1 AND active = TRUE ORDER BY ts ASC`,
        limit ? [convId, limit] : [convId]
      );
    }
  }
  const [convResult, turnsResult, lastResponseId, updatedAt] = await Promise.all([
    query("SELECT summary FROM conversations WHERE id = $1", [convId]),
    fetchTurns(),
    redis.get(KEY(`conv:${convId}:lastResponseId`)),
    redis.get(KEY(`conv:${convId}:updatedAt`)),
  ]);

  const conv = convResult.rows[0] || {};
  // If limited, reverse to get chronological order (was DESC for LIMIT)
  const rows = limit ? turnsResult.rows.reverse() : turnsResult.rows;
  const turns = rows.map(r => ({
    role: r.role,
    text: r.text,
    ts: Number(r.ts),
    mediaAssetIds: Array.isArray(r.media_asset_ids) ? r.media_asset_ids.filter(Boolean) : [],
  }));

  return {
    lastResponseId: lastResponseId || null,
    updatedAt: updatedAt ? parseInt(updatedAt) : null,
    summary: conv.summary || "",
    turns,
    turnCount: turns.length,
  };
}

export async function saveLastResponseId(responseId, convId = DEFAULT_CONV_ID) {
  const current = await redis.get(KEY(`conv:${convId}:lastResponseId`));
  const changed = current !== responseId;

  await Promise.all([
    redis.set(KEY(`conv:${convId}:lastResponseId`), responseId),
    redis.set(KEY(`conv:${convId}:updatedAt`), String(Date.now())),
    query(
      "UPDATE conversations SET last_response_id = $1, updated_at = NOW() WHERE id = $2",
      [responseId, convId]
    ),
  ]);

  return changed;
}

export async function addTurn(role, text, convId = DEFAULT_CONV_ID, source = 'web', mediaAssetIds = []) {
  const ts = Date.now();

  // Insert the new turn with source tracking
  const turnResult = await query(
    `INSERT INTO conversation_turns (conversation_id, role, text, ts, source) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [convId, role, text, ts, source]
  );
  const turnId = turnResult.rows[0].id;

  // Write turn_media join rows
  if (Array.isArray(mediaAssetIds) && mediaAssetIds.length > 0) {
    for (let i = 0; i < mediaAssetIds.length; i++) {
      await query(
        `INSERT INTO turn_media (turn_id, asset_id, position) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [turnId, mediaAssetIds[i], i]
      );
    }
  }

  // Mark old turns as inactive (keep only the last MAX_TURNS active)
  await query(
    `UPDATE conversation_turns SET active = FALSE
     WHERE conversation_id = $1 AND active = TRUE
     AND id NOT IN (
       SELECT id FROM conversation_turns
       WHERE conversation_id = $1 AND active = TRUE
       ORDER BY ts DESC LIMIT $2
     )`,
    [convId, MAX_TURNS]
  );

  // Update Redis
  await redis.set(KEY(`conv:${convId}:updatedAt`), String(ts));
  const turnsSinceSummary = await redis.incr(KEY(`conv:${convId}:turnsSinceSummary`));

  // Get current active turn count
  const countResult = await query(
    "SELECT COUNT(*) as count FROM conversation_turns WHERE conversation_id = $1 AND active = TRUE",
    [convId]
  );

  return {
    turnCount: parseInt(countResult.rows[0].count),
    turnsSinceSummary,
  };
}

export async function getActiveTurns(convId = DEFAULT_CONV_ID) {
  const result = await query(
    `SELECT role, text, ts FROM conversation_turns
     WHERE conversation_id = $1 AND active = TRUE
     ORDER BY ts ASC`,
    [convId]
  );
  return result.rows.map(r => ({ role: r.role, text: r.text, ts: Number(r.ts) }));
}

export async function updateSummary(summaryText, convId = DEFAULT_CONV_ID) {
  await Promise.all([
    query(
      "UPDATE conversations SET summary = $1, updated_at = NOW() WHERE id = $2",
      [summaryText, convId]
    ),
    redis.set(KEY(`conv:${convId}:turnsSinceSummary`), "0"),
  ]);
}

export async function resetConversation(convId = DEFAULT_CONV_ID) {
  await Promise.all([
    query("UPDATE conversations SET summary = '', last_response_id = NULL, updated_at = NOW() WHERE id = $1", [convId]),
    query("UPDATE conversation_turns SET active = FALSE WHERE conversation_id = $1", [convId]),
    redis.del(KEY(`conv:${convId}:lastResponseId`)),
    redis.del(KEY(`conv:${convId}:updatedAt`)),
    redis.set(KEY(`conv:${convId}:turnsSinceSummary`), "0"),
  ]);
}

/** Get or create a conversation for an agent (one conversation per agent) */
export async function getOrCreateAgentConversation(agentId) {
  const existing = await query(
    "SELECT id FROM conversations WHERE agent_id = $1",
    [agentId]
  );

  if (existing.rows[0]) {
    return existing.rows[0].id;
  }

  try {
    const result = await query(
      "INSERT INTO conversations (agent_id) VALUES ($1) RETURNING id",
      [agentId]
    );
    return result.rows[0].id;
  } catch (err) {
    // Race condition: another request created it first
    if (err.code === "23505") {
      const retry = await query(
        "SELECT id FROM conversations WHERE agent_id = $1",
        [agentId]
      );
      return retry.rows[0].id;
    }
    throw err;
  }
}

/** Get all turns for a conversation (both active and inactive), for UI display */
export async function getAllTurns(convId, limit = 30, offset = 0, excludeSources = []) {
  const params = [convId];
  let sourceFilter = "";
  if (excludeSources.length > 0) {
    const placeholders = excludeSources.map((_, i) => `$${params.length + 1 + i}`).join(',');
    sourceFilter = ` AND (ct.source IS NULL OR ct.source NOT IN (${placeholders}))`;
    params.push(...excludeSources);
  }
  const limitOffset = ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  let result;
  try {
    result = await query(
      `SELECT ct.role, ct.text, ct.ts, ct.source,
              COALESCE(array_agg(tm.asset_id ORDER BY tm.position) FILTER (WHERE tm.asset_id IS NOT NULL), '{}') AS media_asset_ids
       FROM conversation_turns ct
       LEFT JOIN turn_media tm ON tm.turn_id = ct.id
       WHERE ct.conversation_id = $1${sourceFilter}
       GROUP BY ct.id, ct.role, ct.text, ct.ts, ct.source
       ORDER BY ct.ts DESC${limitOffset}`, params);
  } catch {
    // Fallback if turn_media doesn't exist yet
    const params2 = [convId];
    let sf2 = "";
    if (excludeSources.length > 0) {
      const ph = excludeSources.map((_, i) => `$${params2.length + 1 + i}`).join(',');
      sf2 = ` AND (source IS NULL OR source NOT IN (${ph}))`;
      params2.push(...excludeSources);
    }
    params2.push(limit, offset);
    result = await query(
      `SELECT role, text, ts, source FROM conversation_turns WHERE conversation_id = $1${sf2} ORDER BY ts DESC LIMIT $${params2.length - 1} OFFSET $${params2.length}`, params2);
  }
  return result.rows.reverse().map(r => ({
    role: r.role,
    text: r.text,
    ts: Number(r.ts),
    source: r.source,
    mediaAssetIds: Array.isArray(r.media_asset_ids) ? r.media_asset_ids.filter(Boolean) : [],
  }));
}
