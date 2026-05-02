/* ═══════════════════════════════════════════════════════
   Media MIME helpers — ext ↔ mime ↔ kind
   ═══════════════════════════════════════════════════════
   Single source of truth for what we accept, so the store,
   the upload route, and future vision/gen modules all agree.
*/

import mimeTypes from "mime-types";

// Allowlist enforced on ingest by the upload route. Disallowed MIMEs are
// returned per-file in the 200-response errors[] array (partial success),
// or drive the whole response to 400 if every file is rejected. No 415
// is ever returned — keep callers aware.
// Audio is here for completeness (WhatsApp/Telegram voice notes), but Phase 1
// does not yet wire audio through the media store — it stays on its own path.
export const ALLOWED_MIMES = new Set([
  // Images
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/svg+xml",
  // Documents
  "application/pdf",
  "text/plain",
  "text/csv",
  "text/html",
  "text/markdown",
  "application/json",
  "application/xml",
  // Office
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",         // .xlsx
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",   // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.ms-excel",       // .xls
  "application/msword",             // .doc
  // Archives
  "application/zip",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/x-rar-compressed",
  // Video (Telegram sendVideo, WhatsApp sendVideo, Discord attachments).
  // Keep the set focused on formats the channel APIs can actually replay.
  "video/mp4",
  "video/quicktime",        // .mov
  "video/x-msvideo",        // .avi
  "video/x-matroska",       // .mkv
  "video/webm",
  "video/3gpp",             // common on WhatsApp
  "video/mpeg",
  // Audio (voice notes, music)
  "audio/mpeg",             // .mp3
  "audio/mp4",              // .m4a
  "audio/aac",
  "audio/ogg",              // WhatsApp voice notes (opus)
  "audio/opus",
  "audio/wav",
  "audio/webm",
  "audio/x-wav",
  "audio/amr",              // older mobile recordings
]);

/** kind is coarse-grained for the DB CHECK constraint. */
export function mimeToKind(mime) {
  if (!mime) return "file";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "file";
}

/** Extension without leading dot. Falls back to "bin" on unknown MIMEs. */
export function mimeToExt(mime) {
  if (!mime) return "bin";
  if (mime === "image/jpeg") return "jpg"; // mime-types returns "jpeg"; we prefer "jpg" on disk
  const ext = mimeTypes.extension(mime);
  return ext || "bin";
}

/** @returns {boolean} true if this MIME is allowed to enter the store. */
export function isAllowed(mime) {
  return ALLOWED_MIMES.has(mime);
}
