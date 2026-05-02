/* ═══════════════════════════════════════════════════════
   send_media tool
   ═══════════════════════════════════════════════════════
   Resends a previously-stored media asset. The tool itself
   just validates the asset id and returns it; the channel
   handler dispatches adapter.sendImage(channelId, { assetId })
   after the function-calling loop completes (same path used
   by web_screenshot, html_screenshot, search_images, and the
   future generate_image tool).
*/

import { head as storeHead } from "../media/store.js";
import { log } from "../logger.js";

/**
 * @param {{ asset_id: string, caption?: string }} args
 * @returns {Promise<{ assetId, kind, mime, caption?, sent: true }>}
 */
export async function sendMedia(args) {
  const assetId = args?.asset_id || args?.assetId;
  if (!assetId || typeof assetId !== "string" || !/^[a-f0-9]{12}$/i.test(assetId)) {
    throw new Error("send_media: asset_id must be a 12-hex media id");
  }
  const meta = await storeHead(assetId);
  if (!meta) {
    throw new Error(`send_media: asset ${assetId} not found or deleted`);
  }
  log(`[TOOL:send_media] queueing ${assetId} (${meta.row.kind}, ${meta.row.mime})`);
  return {
    assetId,
    kind: meta.row.kind,
    mime: meta.row.mime,
    caption: args?.caption || null,
    sent: true,
  };
}
