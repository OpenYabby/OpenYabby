/**
 * get_channel_files tool — List files/images received from users on channels.
 *
 * Queries media_assets linked to conversation turns via turn_media.
 * CLI agents use this to find files sent by users (images, PDFs, docs)
 * and get the local path + metadata for processing.
 */

import { query } from "../../db/pg.js";
import { log } from "../logger.js";
import { join } from "path";

const MEDIA_ROOT = join(process.cwd(), "media");

/**
 * @param {{ conversation_id?: string, filename?: string, kind?: string, limit?: number }} args
 * @param {{ agentId?: string }} context
 */
export async function getChannelFiles(args, context) {
  const limit = Math.min(args.limit || 20, 100);
  let convId = args.conversation_id;

  // If no conversation_id, resolve from agent's conversation
  if (!convId && context?.agentId) {
    try {
      const { getOrCreateAgentConversation } = await import("../../db/queries/conversations.js");
      convId = await getOrCreateAgentConversation(context.agentId);
    } catch {}
  }

  const params = [];
  const conditions = ["ma.deleted_at IS NULL"];

  if (convId) {
    params.push(convId);
    conditions.push(`ct.conversation_id = $${params.length}`);
  }

  if (args.filename) {
    params.push(`%${args.filename}%`);
    conditions.push(`ma.metadata->>'originalName' ILIKE $${params.length}`);
  }

  if (args.kind) {
    params.push(args.kind);
    conditions.push(`ma.kind = $${params.length}`);
  }

  params.push(limit);

  const sql = `
    SELECT ma.id, ma.mime, ma.kind, ma.size_bytes, ma.path, ma.source,
           ma.metadata, ma.created_at,
           ct.conversation_id, ct.role AS turn_role
    FROM media_assets ma
    JOIN turn_media tm ON tm.asset_id = ma.id
    JOIN conversation_turns ct ON ct.id = tm.turn_id
    WHERE ${conditions.join(" AND ")}
    ORDER BY ma.created_at DESC
    LIMIT $${params.length}
  `;

  try {
    const result = await query(sql, params);
    const files = result.rows.map(r => ({
      assetId: r.id,
      mime: r.mime,
      kind: r.kind,
      sizeBytes: Number(r.size_bytes),
      filename: r.metadata?.originalName || null,
      localPath: r.path ? join(MEDIA_ROOT, r.path) : null,
      httpUrl: `/api/media/${r.id}`,
      source: r.source,
      conversationId: r.conversation_id,
      turnRole: r.turn_role,
      createdAt: r.created_at,
    }));

    log(`[TOOL:get_channel_files] Found ${files.length} file(s) (conv=${convId || 'any'}, filename=${args.filename || 'any'}, kind=${args.kind || 'any'})`);
    return { files, count: files.length };
  } catch (err) {
    log(`[TOOL:get_channel_files] Query error: ${err.message}`);
    // Fallback: if turn_media doesn't exist yet, return empty
    return { files: [], count: 0, error: err.message };
  }
}
