import { Router } from "express";
import { getConfig } from "../lib/config.js";
import {
  verifyUserPassword, createUser, getUserCount,
  createSession, revokeSession, validateSession,
  createApiToken, listApiTokens, revokeApiToken,
} from "../db/queries/auth.js";

const router = Router();

// GET /api/auth/me — check auth status
// Note: auth routes are mounted BEFORE optionalAuth, so we validate the token directly.
router.get("/api/auth/me", async (req, res) => {
  const authConfig = getConfig("auth");
  if (!authConfig || !authConfig.enabled) {
    return res.json({ enabled: false });
  }

  // Check for Bearer token
  const bearer = req.headers.authorization;
  if (bearer && bearer.startsWith("Bearer ")) {
    const session = await validateSession(bearer.slice(7));
    if (session) {
      return res.json({ enabled: true, user: { userId: session.userId, type: "session" } });
    }
  }

  return res.status(401).json({ error: "Not authenticated", enabled: true });
});

// POST /api/auth/setup — create initial admin user (only when no users exist)
router.post("/api/auth/setup", async (req, res) => {
  try {
    const count = await getUserCount();
    if (count > 0) {
      return res.status(400).json({ error: "Admin user already exists" });
    }
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    }
    const user = await createUser(username, password, "admin");
    const session = await createSession(user.id);
    res.json({ ok: true, user: { id: user.id, username: user.username, role: user.role }, ...session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login — authenticate with username+password or gateway password
router.post("/api/auth/login", async (req, res) => {
  try {
    const authConfig = getConfig("auth");

    // Gateway password login (simple mode — no users table needed)
    if (req.body.password && !req.body.username) {
      if (!authConfig || !authConfig.enabled) {
        return res.json({ ok: true, message: "Auth is disabled" });
      }
      if (req.body.password === authConfig.gatewayPassword) {
        // Check if any admin user exists, create default if not
        const count = await getUserCount();
        let userId;
        if (count === 0) {
          const user = await createUser("admin", req.body.password, "admin");
          userId = user.id;
        } else {
          // Try to validate against admin user
          const user = await verifyUserPassword("admin", req.body.password);
          if (user) {
            userId = user.id;
          } else {
            // Gateway password matches but user doesn't exist with that password
            // Create session with a virtual user ID
            const session = await createSession("gateway");
            return res.json({ ok: true, ...session });
          }
        }
        const session = await createSession(userId);
        return res.json({ ok: true, ...session });
      }
      return res.status(401).json({ error: "Invalid password" });
    }

    // Username + password login
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: "username and password required" });
    }
    const user = await verifyUserPassword(username, password);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    const authCfg = getConfig("auth");
    const ttlDays = authCfg?.sessionTtlDays || 7;
    const session = await createSession(user.id, ttlDays);
    res.json({ ok: true, user, ...session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout — revoke current session
router.post("/api/auth/logout", async (req, res) => {
  try {
    const bearerHeader = req.headers.authorization;
    if (bearerHeader && bearerHeader.startsWith("Bearer ")) {
      await revokeSession(bearerHeader.slice(7));
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/token — create API token (requires auth when enabled)
// Note: auth routes are mounted BEFORE optionalAuth middleware, so we validate the token directly.
router.post("/api/auth/token", async (req, res) => {
  const authConfig = getConfig("auth");
  if (authConfig?.enabled) {
    const bearer = req.headers.authorization;
    if (!bearer || !bearer.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    const session = await validateSession(bearer.slice(7));
    if (!session) {
      return res.status(401).json({ error: "Invalid or expired session" });
    }
  }
  try {
    const { name, scopes } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const token = await createApiToken(name, scopes || ["*"]);
    res.json(token);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/tokens — list API tokens
router.get("/api/auth/tokens", async (_req, res) => {
  try {
    const tokens = await listApiTokens();
    res.json(tokens);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/auth/tokens/:id — revoke API token
router.delete("/api/auth/tokens/:id", async (req, res) => {
  try {
    await revokeApiToken(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
