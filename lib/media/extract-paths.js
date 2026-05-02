/* ═══════════════════════════════════════════════════════
   Media Path Extractor
   ═══════════════════════════════════════════════════════
   Detects file paths (images, PDFs) in plain text
   (typically CLI agent task results) and verifies they
   exist on disk. Used by agent-task-processor to
   auto-send media files to channels after task completion.
*/

import { access } from "fs/promises";
import { extname } from "path";
import { lookup } from "mime-types";

// Matches absolute paths ending in media extensions.
// Stops at whitespace, quotes, backticks, commas, semicolons,
// closing brackets/braces/parens — common delimiters in task output.
const MEDIA_PATH_RE = /(\/[^\s"'`,;)\]}>]+\.(?:pdf|png|jpe?g|webp|gif|svg|txt|csv|json|xml|html|md|xlsx|docx|pptx|xls|doc|zip|gz))/gi;

/**
 * Extract media file paths from text and verify they exist on disk.
 * @param {string} text — task result or activity log text
 * @returns {Promise<Array<{ path: string, ext: string, mime: string }>>}
 */
export async function extractMediaPaths(text) {
  if (!text) return [];
  const matches = [...new Set(text.match(MEDIA_PATH_RE) || [])];
  const results = [];
  for (const p of matches) {
    try {
      await access(p);
      const ext = extname(p).toLowerCase();
      const mime = lookup(ext) || "application/octet-stream";
      results.push({ path: p, ext, mime });
    } catch {
      // File doesn't exist on disk, skip silently
    }
  }
  return results;
}
