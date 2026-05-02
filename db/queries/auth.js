import { query } from "../pg.js";
import { redis, KEY } from "../redis.js";
import { randomBytes, scrypt, timingSafeEqual, createHash } from "crypto";

const SESSION_TTL = 7 * 24 * 3600; // 7 days in seconds

// ── Password Hashing (Node.js built-in scrypt, zero deps) ──

function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const salt = randomBytes(16).toString("hex");
    scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(salt + ":" + derived.toString("hex"));
    });
  });
}

function verifyPassword(password, stored) {
  return new Promise((resolve, reject) => {
    const [salt, hash] = stored.split(":");
    scrypt(password, salt, 64, (err, derived) => {
      if (err) reject(err);
      else resolve(timingSafeEqual(Buffer.from(hash, "hex"), derived));
    });
  });
}

// ── Users ──

export async function createUser(username, password, role = "admin") {
  const passwordHash = await hashPassword(password);
  const { rows } = await query(
    `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id, username, role, created_at`,
    [username, passwordHash, role]
  );
  return rows[0];
}

export async function getUserByUsername(username) {
  const { rows } = await query("SELECT * FROM users WHERE username = $1", [username]);
  return rows[0] || null;
}

export async function verifyUserPassword(username, password) {
  const user = await getUserByUsername(username);
  if (!user) return null;
  const ok = await verifyPassword(password, user.password_hash);
  return ok ? { id: user.id, username: user.username, role: user.role } : null;
}

export async function getUserCount() {
  const { rows } = await query("SELECT count(*)::int AS cnt FROM users");
  return rows[0].cnt;
}

// ── Sessions ──

export async function createSession(userId, ttlDays = 7) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + ttlDays * 86400_000);
  await query(
    "INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)",
    [token, userId, expiresAt]
  );
  // Cache in Redis for fast lookup
  await redis.set(KEY(`session:${token}`), JSON.stringify({ userId, expiresAt: expiresAt.toISOString() }), { EX: ttlDays * 86400 });
  return { token, expiresAt };
}

export async function validateSession(token) {
  // Check Redis first
  const cached = await redis.get(KEY(`session:${token}`));
  if (cached) {
    const data = JSON.parse(cached);
    if (new Date(data.expiresAt) > new Date()) return data;
    // Expired — clean up
    await redis.del(KEY(`session:${token}`));
  }
  // Fallback to PG
  const { rows } = await query(
    "SELECT user_id, expires_at FROM sessions WHERE token = $1 AND expires_at > NOW()",
    [token]
  );
  if (rows.length === 0) return null;
  const session = { userId: rows[0].user_id, expiresAt: rows[0].expires_at.toISOString() };
  // Re-cache
  const ttl = Math.floor((new Date(session.expiresAt) - Date.now()) / 1000);
  if (ttl > 0) await redis.set(KEY(`session:${token}`), JSON.stringify(session), { EX: ttl });
  return session;
}

export async function revokeSession(token) {
  await query("DELETE FROM sessions WHERE token = $1", [token]);
  await redis.del(KEY(`session:${token}`));
}

export async function cleanExpiredSessions() {
  await query("DELETE FROM sessions WHERE expires_at < NOW()");
}

// ── API Tokens ──

function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export async function createApiToken(name, scopes = ["*"]) {
  const rawToken = "ybt_" + randomBytes(24).toString("hex");
  const tokenHash = hashToken(rawToken);
  const tokenPrefix = rawToken.slice(0, 8);
  await query(
    "INSERT INTO api_tokens (name, token_hash, token_prefix, scopes) VALUES ($1, $2, $3, $4)",
    [name, tokenHash, tokenPrefix, JSON.stringify(scopes)]
  );
  // Return raw token ONCE — it cannot be retrieved later
  return { token: rawToken, prefix: tokenPrefix, name, scopes };
}

export async function validateApiToken(rawToken) {
  const tokenHash = hashToken(rawToken);
  // Check Redis cache
  const cached = await redis.get(KEY(`apitoken:${tokenHash}`));
  if (cached) {
    const data = JSON.parse(cached);
    // Update last_used_at asynchronously
    query("UPDATE api_tokens SET last_used_at = NOW() WHERE token_hash = $1", [tokenHash]).catch(() => {});
    return data;
  }
  // Fallback to PG
  const { rows } = await query(
    "SELECT id, name, scopes FROM api_tokens WHERE token_hash = $1",
    [tokenHash]
  );
  if (rows.length === 0) return null;
  const data = { id: rows[0].id, name: rows[0].name, scopes: rows[0].scopes };
  await redis.set(KEY(`apitoken:${tokenHash}`), JSON.stringify(data), { EX: 3600 });
  query("UPDATE api_tokens SET last_used_at = NOW() WHERE token_hash = $1", [tokenHash]).catch(() => {});
  return data;
}

export async function listApiTokens() {
  const { rows } = await query(
    "SELECT id, name, token_prefix, scopes, last_used_at, created_at FROM api_tokens ORDER BY created_at DESC"
  );
  return rows;
}

export async function revokeApiToken(id) {
  const { rows } = await query("SELECT token_hash FROM api_tokens WHERE id = $1", [id]);
  if (rows.length > 0) {
    await redis.del(KEY(`apitoken:${rows[0].token_hash}`));
  }
  await query("DELETE FROM api_tokens WHERE id = $1", [id]);
}
