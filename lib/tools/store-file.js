/**
 * store_file tool — Ingest a local file into the media store.
 *
 * Reads a file from disk, validates path security + size + MIME,
 * then delegates to lib/media/store.js. Returns an assetId that
 * can be sent via send_media or dispatched to WhatsApp/channels.
 */

import { readFile, stat } from "fs/promises";
import { resolve, basename } from "path";
import { lookup as mimeLookup } from "mime-types";
import { write as storeWrite } from "../media/store.js";
import { isAllowed } from "../media/mime.js";
import { log } from "../logger.js";

const MAX_SIZE = 50_000_000; // 50 MB

const WORKSPACE_ROOT = process.cwd(); // /Users/.../OpenYabby at runtime

const ALLOWED_ROOTS = [
  WORKSPACE_ROOT,
  "/tmp",
  "/Users", // Agent workspaces live under ~/Documents/Yabby Workspace/
];

function isPathSafe(absPath) {
  if (!absPath.startsWith("/")) return false;
  if (absPath.includes("..")) return false;
  return ALLOWED_ROOTS.some(root => absPath.startsWith(root));
}

/**
 * @param {{ path: string, filename?: string, caption?: string }} args
 * @returns {Promise<{ assetId: string, mime: string, size_bytes: number, filename: string, caption: string|null }>}
 */
export async function storeFile(args) {
  const rawPath = args?.path;
  if (!rawPath || typeof rawPath !== "string") {
    throw new Error("store_file: 'path' is required (absolute path)");
  }

  const absPath = resolve(rawPath);

  if (!isPathSafe(absPath)) {
    throw new Error(`store_file: path rejected — must be under workspace or /tmp (got: ${absPath})`);
  }

  const info = await stat(absPath);
  if (!info.isFile()) throw new Error("store_file: not a regular file");
  if (info.size === 0) throw new Error("store_file: file is empty");
  if (info.size > MAX_SIZE) throw new Error(`store_file: file too large (${(info.size / 1e6).toFixed(1)} MB, max 50 MB)`);

  const mime = mimeLookup(absPath) || "application/octet-stream";

  if (!isAllowed(mime)) {
    throw new Error(`store_file: MIME "${mime}" not in allowlist — see lib/media/mime.js`);
  }

  const buffer = await readFile(absPath);
  const asset = await storeWrite(buffer, mime, { source: "store_file" });

  const filename = args.filename || basename(absPath);
  log(`[TOOL:store_file] ${absPath} → ${asset.id} (${mime}, ${buffer.length} bytes)`);

  return {
    assetId: asset.id,
    mime,
    size_bytes: buffer.length,
    filename,
    caption: args.caption || null,
  };
}
