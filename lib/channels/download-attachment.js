/* ═══════════════════════════════════════════════════════
   Shared helper: download a platform attachment and
   persist to the media store. Each adapter calls this
   with a platform-specific fetchBytes() callback.
   ═══════════════════════════════════════════════════════
*/

import { write as storeWrite } from "../media/store.js";
import { isAllowed, mimeToKind } from "../media/mime.js";
import { log } from "../logger.js";

/**
 * @param {import('./normalize.js').MediaRef} ref - inbound ref (assetId is null)
 * @param {() => Promise<{ buffer: Buffer, mime?: string, filename?: string, sizeBytes?: number }>} fetchBytes
 * @param {{ source: string, channelName: string }} ctx
 *   - `source`: channel name (e.g. "telegram")
 *   - `channelName`: same as source, used for logging
 * @returns {Promise<import('./normalize.js').MediaRef | null>} — new ref with assetId populated, or null on failure
 */
export async function downloadAttachment(ref, fetchBytes, { source, channelName }) {
  try {
    const fetched = await fetchBytes();
    if (!fetched || !fetched.buffer || !Buffer.isBuffer(fetched.buffer)) {
      log(`[CHANNEL:${channelName}] download-attachment: fetchBytes returned no buffer`);
      return null;
    }
    const mime = fetched.mime || ref.mime;
    if (!isAllowed(mime)) {
      log(`[CHANNEL:${channelName}] download-attachment: MIME "${mime}" not allowed — skipping`);
      return null;
    }

    const asset = await storeWrite(fetched.buffer, mime, {
      source,
      metadata: {
        originalName: fetched.filename || ref.filename || null,
        platformRef: ref.platformRef || null,
        channelName,
      },
    });

    return {
      kind: mimeToKind(mime),
      mime,
      platformRef: ref.platformRef,
      filename: fetched.filename || ref.filename || null,
      sizeBytes: fetched.sizeBytes || asset.size_bytes || null,
      assetId: asset.id,
    };
  } catch (err) {
    log(`[CHANNEL:${channelName}] download-attachment error: ${err.message}`);
    return null;
  }
}

/**
 * Batch version — resolves an array of inbound refs in parallel.
 * Failures are silently skipped (logged), so the returned array may be
 * shorter than the input.
 * @param {Array} refs - inbound MediaRefs (assetId null)
 * @param {(ref) => () => Promise<{ buffer, mime?, filename?, sizeBytes? }>} makeFetcher
 *   - takes a ref, returns a thunk that resolves to bytes
 * @param {{ source, channelName }} ctx
 * @returns {Promise<Array>} — MediaRefs with assetId populated; failed refs dropped
 */
export async function downloadAll(refs, makeFetcher, ctx) {
  if (!Array.isArray(refs) || refs.length === 0) return [];
  const promises = refs.map((ref) => downloadAttachment(ref, makeFetcher(ref), ctx));
  const results = await Promise.all(promises);
  return results.filter((r) => r !== null);
}
