/* ═══════════════════════════════════════════════════════
   YABBY — Credential Encryption (AES-256-GCM)
   ═══════════════════════════════════════════════════════
   Encrypts connector credentials before DB storage.
   Decrypts only when connecting to a service.
*/

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";
import { log } from "./logger.js";

const ALGORITHM = "aes-256-gcm";
const SALT = "yabby-connector-creds-v1";

let derivedKey = null;

function getKey() {
  if (derivedKey) return derivedKey;

  const secret = process.env.YABBY_SECRET;
  if (!secret || secret.length < 16) {
    // Auto-generate a stable secret from the existing OpenAI key (deterministic per install)
    const fallback = process.env.OPENAI_API_KEY || "yabby-default-secret-change-me";
    derivedKey = scryptSync(fallback, SALT, 32);
    log("[CRYPTO] Using derived encryption key (set YABBY_SECRET in .env for custom key)");
  } else {
    derivedKey = scryptSync(secret, SALT, 32);
  }
  return derivedKey;
}

/**
 * Encrypt a plaintext string → { iv, data, tag } (all hex-encoded, JSON-safe)
 */
export function encrypt(plaintext) {
  if (!plaintext) return null;
  const key = getKey();
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return { iv: iv.toString("hex"), data: encrypted, tag };
}

/**
 * Decrypt { iv, data, tag } → plaintext string
 */
export function decrypt(encryptedObj) {
  if (!encryptedObj || !encryptedObj.iv || !encryptedObj.data || !encryptedObj.tag) return null;
  const key = getKey();
  const iv = Buffer.from(encryptedObj.iv, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(Buffer.from(encryptedObj.tag, "hex"));
  let decrypted = decipher.update(encryptedObj.data, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/**
 * Encrypt a credentials object → encrypted JSONB-safe object
 * Each value is individually encrypted.
 */
export function encryptCredentials(creds) {
  if (!creds || typeof creds !== "object") return {};
  const encrypted = {};
  for (const [key, value] of Object.entries(creds)) {
    if (typeof value === "string" && value.length > 0) {
      encrypted[key] = encrypt(value);
    }
  }
  return encrypted;
}

/**
 * Decrypt an encrypted credentials object → plaintext credentials
 */
export function decryptCredentials(encryptedCreds) {
  if (!encryptedCreds || typeof encryptedCreds !== "object") return {};
  const decrypted = {};
  for (const [key, value] of Object.entries(encryptedCreds)) {
    if (value && typeof value === "object" && value.iv) {
      decrypted[key] = decrypt(value);
    }
  }
  return decrypted;
}
