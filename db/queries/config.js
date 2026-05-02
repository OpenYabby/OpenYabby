import { query } from "../pg.js";
import { redis, KEY } from "../redis.js";

const CONFIG_TTL = 86400; // 24h cache in Redis

export async function getConfigValue(key) {
  // Redis first
  const cached = await redis.get(KEY(`config:${key}`));
  if (cached) return JSON.parse(cached);

  // Fallback to PG
  const r = await query("SELECT value FROM config WHERE key = $1", [key]);
  if (!r.rows[0]) return null;

  const value = r.rows[0].value;
  await redis.set(KEY(`config:${key}`), JSON.stringify(value), { EX: CONFIG_TTL });
  return value;
}

export async function setConfigValue(key, value) {
  await query(
    `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
  await redis.set(KEY(`config:${key}`), JSON.stringify(value), { EX: CONFIG_TTL });

  // Notify subscribers of config change
  await redis.publish("yabby:config-change", JSON.stringify({ key, value }));
}

export async function getAllConfig() {
  const r = await query("SELECT key, value FROM config ORDER BY key");
  const config = {};
  for (const row of r.rows) {
    config[row.key] = row.value;
  }
  return config;
}

export async function deleteConfigValue(key) {
  await query("DELETE FROM config WHERE key = $1", [key]);
  await redis.del(KEY(`config:${key}`));
}
