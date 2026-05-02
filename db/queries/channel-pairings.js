/**
 * Channel Pairings — owner identity per channel.
 *
 * One owner per channel (Telegram, Discord, Slack, Signal, WhatsApp).
 * Pending pairing codes live in Redis with a 10-min TTL.
 */
import { query } from "../pg.js";
import { redis } from "../redis.js";
import { randomBytes } from "crypto";

const PAIRING_CODE_TTL_SEC = 600; // 10 minutes
const PAIRING_CODE_PREFIX = "yabby:pairing-code:";

function codeKey(channelName) {
  return `${PAIRING_CODE_PREFIX}${channelName}`;
}

function genCode() {
  // Format: YABBY-XXXX-XXXX (easy to type, 8 hex chars)
  const bytes = randomBytes(4).toString("hex").toUpperCase();
  return `YABBY-${bytes.slice(0, 4)}-${bytes.slice(4, 8)}`;
}

/**
 * Generate a new pairing code for a channel. Invalidates any previous code.
 * Returns { code, expiresAt }.
 */
export async function generatePairingCode(channelName) {
  const code = genCode();
  const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_SEC * 1000).toISOString();
  await redis.set(codeKey(channelName), code, { EX: PAIRING_CODE_TTL_SEC });
  return { code, expiresAt, ttlSeconds: PAIRING_CODE_TTL_SEC };
}

/**
 * Get the current pending pairing code for a channel (if any).
 */
export async function getPairingCode(channelName) {
  const code = await redis.get(codeKey(channelName));
  if (!code) return null;
  const ttl = await redis.ttl(codeKey(channelName));
  return { code, ttlSeconds: ttl > 0 ? ttl : 0 };
}

/**
 * Consume the pairing code — returns true if the provided code matches.
 * Deletes the code on success (one-shot).
 */
export async function consumePairingCode(channelName, providedCode) {
  const code = await redis.get(codeKey(channelName));
  if (!code) return false;
  if (code !== providedCode) return false;
  await redis.del(codeKey(channelName));
  return true;
}

/**
 * Get the current owner of a channel, or null if unpaired.
 */
export async function getOwner(channelName) {
  const { rows } = await query(
    `SELECT channel_name, owner_user_id, owner_user_name, owner_chat_id, paired_at
     FROM channel_pairings WHERE channel_name = $1`,
    [channelName]
  );
  return rows[0] || null;
}

/**
 * Claim ownership for a channel. Upserts — replaces any existing owner.
 */
export async function claimOwner(channelName, { userId, userName, chatId }) {
  const { rows } = await query(
    `INSERT INTO channel_pairings (channel_name, owner_user_id, owner_user_name, owner_chat_id, paired_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (channel_name) DO UPDATE SET
       owner_user_id = EXCLUDED.owner_user_id,
       owner_user_name = EXCLUDED.owner_user_name,
       owner_chat_id = EXCLUDED.owner_chat_id,
       paired_at = NOW()
     RETURNING *`,
    [channelName, String(userId), userName || null, String(chatId)]
  );
  return rows[0];
}

/**
 * Check if a given userId is the owner of the channel.
 */
export async function isOwner(channelName, userId) {
  const owner = await getOwner(channelName);
  if (!owner) return false;
  return owner.owner_user_id === String(userId);
}

/**
 * Remove the owner for a channel (unpair).
 */
export async function unpair(channelName) {
  await query(`DELETE FROM channel_pairings WHERE channel_name = $1`, [channelName]);
  await redis.del(codeKey(channelName));
}

/**
 * List all pairing statuses across channels.
 */
export async function listPairings() {
  const { rows } = await query(
    `SELECT channel_name, owner_user_id, owner_user_name, owner_chat_id, paired_at
     FROM channel_pairings`
  );
  const map = {};
  for (const r of rows) map[r.channel_name] = r;
  return map;
}
