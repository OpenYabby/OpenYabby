import { getConfig } from "./config.js";
import { validateSession, validateApiToken } from "../db/queries/auth.js";

// Paths that are NEVER gated by auth (WebRTC, wake word, SSE)
const EXEMPT_PATHS = ["/session", "/api/wake-word", "/api/wake-debug", "/api/logs/stream"];

/**
 * Optional auth middleware.
 * If config.auth.enabled is false, passes through (current behavior preserved).
 * If enabled, checks Authorization header (Bearer token) or X-Api-Token header.
 * Exempt paths (WebRTC /session, SSE, wake word) always pass through.
 */
export function optionalAuth(req, res, next) {
  const authConfig = getConfig("auth");
  if (!authConfig || !authConfig.enabled) {
    // Auth disabled — pass through (preserves current behavior)
    req.user = null;
    return next();
  }

  // Exempt paths — never require auth
  if (EXEMPT_PATHS.some(p => req.path === p || req.path.startsWith(p + "/"))) {
    req.user = null;
    return next();
  }

  // Extract token from headers
  const bearerHeader = req.headers.authorization;
  const apiTokenHeader = req.headers["x-api-token"];

  if (bearerHeader && bearerHeader.startsWith("Bearer ")) {
    const token = bearerHeader.slice(7);
    validateSession(token)
      .then((session) => {
        if (!session) return res.status(401).json({ error: "Invalid or expired session" });
        req.user = { userId: session.userId, type: "session" };
        next();
      })
      .catch(() => res.status(500).json({ error: "Auth check failed" }));
  } else if (apiTokenHeader) {
    validateApiToken(apiTokenHeader)
      .then((tokenData) => {
        if (!tokenData) return res.status(401).json({ error: "Invalid API token" });
        req.user = { tokenId: tokenData.id, name: tokenData.name, scopes: tokenData.scopes, type: "api_token" };
        next();
      })
      .catch(() => res.status(500).json({ error: "Auth check failed" }));
  } else {
    return res.status(401).json({ error: "Authentication required" });
  }
}

/**
 * Require auth — use after optionalAuth for routes that always need auth.
 * When auth is disabled globally, this passes through.
 */
export function requireAuth(req, res, next) {
  const authConfig = getConfig("auth");
  if (!authConfig || !authConfig.enabled) return next();
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  next();
}

/**
 * Require admin role.
 */
export function requireAdmin(req, res, next) {
  const authConfig = getConfig("auth");
  if (!authConfig || !authConfig.enabled) return next();
  if (!req.user) return res.status(401).json({ error: "Authentication required" });
  if (req.user.type === "api_token") return next(); // API tokens have full access
  if (req.user.role !== "admin") return res.status(403).json({ error: "Admin access required" });
  next();
}
