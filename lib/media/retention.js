/* ═══════════════════════════════════════════════════════
   Media Retention Job
   ═══════════════════════════════════════════════════════
   Soft-deletes expired media assets and removes their bytes
   from disk. Configured via media.retentionDaysGenerated
   and media.retentionDaysInbound.
*/

import { query } from "../../db/pg.js";
import { unlink } from "fs/promises";
import { log } from "../logger.js";
import { getConfig } from "../config.js";
import { absolutePathFor } from "./store.js";

const GENERATED_SOURCES = new Set(["generated", "screenshot", "search", "diagram"]);

/**
 * Run the retention cleanup. Called periodically by setInterval in server.js.
 * @returns {Promise<{ deleted: number, errors: number }>}
 */
export async function runRetention() {
  const cfg = getConfig("media") || {};
  const genDays = cfg.retentionDaysGenerated ?? 30;
  const inboundDays = cfg.retentionDaysInbound ?? null; // null = keep forever

  let deleted = 0;
  let errors = 0;

  // Clean generated assets older than genDays
  if (genDays !== null && genDays > 0) {
    const sourceList = [...GENERATED_SOURCES];
    const placeholders = sourceList.map((_, i) => `$${i + 2}`).join(",");
    const { rows } = await query(
      `SELECT id, path FROM media_assets
       WHERE deleted_at IS NULL
       AND source IN (${placeholders})
       AND created_at < NOW() - INTERVAL '1 day' * $1
       LIMIT 100`,
      [genDays, ...sourceList]
    );
    for (const row of rows) {
      try {
        await query(`UPDATE media_assets SET deleted_at = NOW() WHERE id = $1`, [row.id]);
        const absPath = absolutePathFor(row.path);
        const sidecarPath = absPath.replace(/\.[^.]+$/, ".json");
        await unlink(absPath).catch(() => {});
        await unlink(sidecarPath).catch(() => {});
        deleted++;
      } catch (err) {
        log(`[RETENTION] Error deleting ${row.id}: ${err.message}`);
        errors++;
      }
    }
  }

  // Clean inbound assets if configured (default: never)
  if (inboundDays !== null && inboundDays > 0) {
    const { rows } = await query(
      `SELECT id, path FROM media_assets
       WHERE deleted_at IS NULL
       AND source = 'inbound'
       AND created_at < NOW() - INTERVAL '1 day' * $1
       LIMIT 100`,
      [inboundDays]
    );
    for (const row of rows) {
      try {
        await query(`UPDATE media_assets SET deleted_at = NOW() WHERE id = $1`, [row.id]);
        const absPath = absolutePathFor(row.path);
        const sidecarPath = absPath.replace(/\.[^.]+$/, ".json");
        await unlink(absPath).catch(() => {});
        await unlink(sidecarPath).catch(() => {});
        deleted++;
      } catch (err) {
        errors++;
      }
    }
  }

  if (deleted > 0 || errors > 0) {
    log(`[RETENTION] Cleaned ${deleted} expired assets (${errors} errors)`);
  }
  return { deleted, errors };
}
