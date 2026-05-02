/* ═══════════════════════════════════════════════════════
   Media Store — content-addressed filesystem + DB index
   ═══════════════════════════════════════════════════════
   Layout:  media/{YYYY-MM}/{sha256}.{ext}
            media/{YYYY-MM}/{sha256}.json  (sidecar metadata)

   ID:      randomUUID().slice(0, 12), retried up to 3× on UNIQUE collision
   Dedup:   sha256 is UNIQUE — re-uploading the same bytes returns the
            existing asset row without rewriting the file.
   Delete:  soft-delete via deleted_at; bytes stay until the retention job.
*/

import { createHash, randomUUID } from "crypto";
import { writeFile, mkdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { query } from "../../db/pg.js";
import { log } from "../logger.js";
import { mimeToKind, mimeToExt, isAllowed } from "./mime.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MEDIA_ROOT = join(__dirname, "..", "..", "media");

const ID_RETRIES = 3;

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function yearMonth(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function newId() {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/**
 * Resolve the on-disk path for an asset row.
 * Returned path is absolute. Does not check existence.
 */
export function absolutePathFor(relativePath) {
  return join(MEDIA_ROOT, relativePath);
}

/**
 * Write a buffer to the store.
 * @param {Buffer} buffer - raw bytes
 * @param {string} mime   - declared MIME type (will be validated against allowlist)
 * @param {object} opts
 * @param {string} opts.source   - "inbound" | "generated" | "screenshot" | "diagram" | "search"
 * @param {object} [opts.metadata] - arbitrary JSONB; e.g. { prompt, model, sourceUrl }
 * @returns {Promise<{id, sha256, path, mime, size_bytes, kind, source, metadata, created_at, deduped: boolean}>}
 * @throws {Error} if mime is not in the allowlist
 */
export async function write(buffer, mime, { source, metadata = {} } = {}) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error("store.write: buffer must be a Buffer");
  }
  if (!isAllowed(mime)) {
    const err = new Error(`store.write: MIME "${mime}" not allowed`);
    err.code = "MIME_NOT_ALLOWED";
    throw err;
  }
  if (!source || typeof source !== "string") {
    throw new Error("store.write: opts.source is required");
  }

  const sha = sha256Hex(buffer);

  // Dedup: if a row with this sha already exists (and not soft-deleted), reuse it.
  const existing = await query(
    `SELECT id, sha256, path, mime, size_bytes, kind, source, metadata, created_at
     FROM media_assets
     WHERE sha256 = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [sha]
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    log(`[MEDIA] dedup hit ${row.id} (sha=${sha.slice(0, 8)}…)`);
    return { ...row, deduped: true };
  }

  // Fresh write. Compute layout.
  const ym = yearMonth();
  const ext = mimeToExt(mime);
  const relPath = join(ym, `${sha}.${ext}`);
  const absPath = absolutePathFor(relPath);
  const sidecarPath = absolutePathFor(join(ym, `${sha}.json`));

  await mkdir(dirname(absPath), { recursive: true });

  // Atomic write: O_CREAT | O_EXCL ("wx") — if the file already exists,
  // EEXIST is thrown and we swallow it (content is identical by sha256).
  // This avoids the TOCTOU window between existsSync() and writeFile().
  try {
    await writeFile(absPath, buffer, { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }

  const kind = mimeToKind(mime);
  const sizeBytes = buffer.byteLength;
  const sidecar = {
    sha256: sha,
    mime,
    size_bytes: sizeBytes,
    kind,
    source,
    metadata,
    created_at: new Date().toISOString(),
  };
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2));

  // DB insert with id-retry on UNIQUE collision.
  for (let attempt = 0; attempt < ID_RETRIES; attempt++) {
    const id = newId();
    try {
      const { rows } = await query(
        `INSERT INTO media_assets (id, sha256, path, mime, size_bytes, kind, source, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, sha256, path, mime, size_bytes, kind, source, metadata, created_at`,
        [id, sha, relPath, mime, sizeBytes, kind, source, metadata]
      );
      log(`[MEDIA] wrote ${id} (${kind}, ${sizeBytes}B, sha=${sha.slice(0, 8)}…)`);
      return { ...rows[0], deduped: false };
    } catch (err) {
      // 23505 = unique_violation (Postgres). If it's on the PK, retry with a fresh id.
      // If it's on sha256, that means a parallel write beat us — fetch and return.
      if (err.code === "23505") {
        if (/media_assets_pkey/.test(err.constraint || err.message || "")) {
          log(`[MEDIA] id collision (attempt ${attempt + 1}/${ID_RETRIES}), retrying`);
          continue;
        }
        if (/media_assets_sha256_key/.test(err.constraint || err.message || "")) {
          const race = await query(
            `SELECT id, sha256, path, mime, size_bytes, kind, source, metadata, created_at
             FROM media_assets WHERE sha256 = $1 AND deleted_at IS NULL LIMIT 1`,
            [sha]
          );
          if (race.rows.length > 0) return { ...race.rows[0], deduped: true };
        }
      }
      throw err;
    }
  }
  throw new Error(`store.write: exhausted ${ID_RETRIES} id retries`);
}

/**
 * Read an asset's bytes and row by id.
 * @param {string} id
 * @returns {Promise<{row, buffer} | null>}  null if id unknown or soft-deleted
 */
export async function read(id) {
  const { rows } = await query(
    `SELECT id, sha256, path, mime, size_bytes, kind, source, metadata, created_at, deleted_at
     FROM media_assets WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  if (row.deleted_at) return null;

  const abs = absolutePathFor(row.path);
  try {
    const buffer = await readFile(abs);
    return { row, buffer };
  } catch (err) {
    // Bytes missing on disk while row exists — mark deleted and report gone.
    if (err.code === "ENOENT") {
      log(`[MEDIA] ${id}: bytes missing at ${abs}, marking deleted_at`);
      await query(`UPDATE media_assets SET deleted_at = NOW() WHERE id = $1`, [id]);
      return null;
    }
    throw err;
  }
}

/** @returns {Promise<{row} | null>} lightweight metadata lookup without reading bytes. */
export async function head(id) {
  const { rows } = await query(
    `SELECT id, sha256, path, mime, size_bytes, kind, source, metadata, created_at, deleted_at
     FROM media_assets WHERE id = $1`,
    [id]
  );
  if (rows.length === 0) return null;
  if (rows[0].deleted_at) return null;
  return { row: rows[0] };
}
