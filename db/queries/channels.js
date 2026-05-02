import { query } from "../pg.js";
import { log } from "../../lib/logger.js";

// ── Conversations ──

export async function findOrCreateConversation(channelName, channelId, userId, userName, isGroup = false) {
  // Try find existing
  const { rows } = await query(
    `SELECT * FROM channel_conversations WHERE channel_name = $1 AND user_id = $2 AND channel_id = $3 LIMIT 1`,
    [channelName, userId, channelId]
  );
  if (rows.length > 0) return rows[0];

  // Create new
  const { rows: created } = await query(
    `INSERT INTO channel_conversations (channel_name, channel_id, user_id, user_name, is_group)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [channelName, channelId, userId, userName, isGroup]
  );
  return created[0];
}

export async function getConversation(id) {
  const { rows } = await query(`SELECT * FROM channel_conversations WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function listConversations(channelName, limit = 50) {
  const params = [];
  let sql = `SELECT * FROM channel_conversations`;
  if (channelName) {
    sql += ` WHERE channel_name = $1`;
    params.push(channelName);
  }
  sql += ` ORDER BY last_message_at DESC LIMIT ${parseInt(limit)}`;
  const { rows } = await query(sql, params);
  return rows;
}

export async function touchConversation(id) {
  await query(`UPDATE channel_conversations SET last_message_at = NOW() WHERE id = $1`, [id]);
}

// ── Messages ──

export async function addMessage(conversationId, role, content, platformMsgId = null) {
  try {
    const { rows } = await query(
      `INSERT INTO channel_messages (conversation_id, role, content, platform_msg_id)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [conversationId, role, content, platformMsgId]
    );
    await touchConversation(conversationId);
    return rows[0];
  } catch (err) {
    // Si duplicate key (constraint violation), retourner null au lieu de throw
    if (err.code === '23505' && err.constraint === 'idx_channel_messages_platform_msg_unique') {
      log(`[CHANNELS] Duplicate platform_msg_id detected: ${platformMsgId}, skipping`);
      return null;  // Message déjà traité
    }
    throw err;
  }
}

export async function getMessages(conversationId, limit = 20) {
  const { rows } = await query(
    `SELECT * FROM channel_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [conversationId, limit]
  );
  return rows.reverse(); // chronological order
}

// ── Dead Letters ──

export async function insertDeadLetter(channelName, userId, content, error, attempts) {
  const { rows } = await query(
    `INSERT INTO dead_letters (channel_name, user_id, content, error, attempts)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [channelName, userId, content, error, attempts]
  );
  return rows[0];
}

export async function listDeadLetters(channelName, limit = 50) {
  const params = [];
  let sql = `SELECT * FROM dead_letters`;
  if (channelName) {
    sql += ` WHERE channel_name = $1`;
    params.push(channelName);
  }
  sql += ` ORDER BY created_at DESC LIMIT ${parseInt(limit)}`;
  const { rows } = await query(sql, params);
  return rows;
}

export async function deleteDeadLetter(id) {
  await query(`DELETE FROM dead_letters WHERE id = $1`, [id]);
}

export async function clearDeadLetters(channelName) {
  if (channelName) {
    await query(`DELETE FROM dead_letters WHERE channel_name = $1`, [channelName]);
  } else {
    await query(`DELETE FROM dead_letters`);
  }
}

// ── Conversation reset ──

export async function clearConversationMessages(conversationId) {
  await query(`DELETE FROM channel_messages WHERE conversation_id = $1`, [conversationId]);
}
