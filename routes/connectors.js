/* ═══════════════════════════════════════════════════════
   YABBY — Connector Routes
   ═══════════════════════════════════════════════════════ */

import { Router } from "express";
import { CONNECTOR_CATALOG, getCatalogEntry, getCatalogByCategory, getCategoryLabel, CATEGORY_ORDER } from "../lib/connectors/catalog.js";
import * as db from "../db/queries/connectors.js";
import * as manager from "../lib/connectors/manager.js";
import { encryptCredentials } from "../lib/crypto.js";
import { log, emitTaskEvent } from "../lib/logger.js";

const router = Router();

// ── Catalog ──

router.get("/api/connectors/catalog", (_req, res) => {
  // Return catalog without internal fields (module paths, etc.)
  const catalog = CONNECTOR_CATALOG.map(c => ({
    id: c.id,
    name: c.name,
    icon: c.icon,
    category: c.category,
    categoryLabel: getCategoryLabel(c.category),
    description: c.description,
    backends: c.backends,
    authType: c.authType,
    authFields: c.authConfig?.fields || [],
    helpUrl: c.helpUrl || null,
    helpSteps: c.helpSteps || [],
    testDescription: c.testDescription || null,
    comingSoon: !!c.comingSoon,
    quickInstall: !!c.quickInstall,
  }));
  // Build byCategory ordered by CATEGORY_ORDER
  const byCategory = {};
  for (const cat of CATEGORY_ORDER) {
    const items = catalog.filter(c => c.category === cat);
    if (items.length > 0) {
      byCategory[cat] = { label: getCategoryLabel(cat), items };
    }
  }
  res.json({ catalog, byCategory });
});

// ── Connectors CRUD ──

router.get("/api/connectors", async (_req, res) => {
  try {
    const connectors = await db.listConnectors();
    // Strip encrypted credentials and add tool count
    const safe = connectors.map(c => {
      const result = stripCredentials(c);
      const tools = manager.getConnectorTools(c.id);
      result.tools = tools;
      result.toolCount = tools.length;
      return result;
    });
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/connectors", async (req, res) => {
  const { catalogId, label, backend, credentials, isGlobal, autoConnect } = req.body;

  if (!catalogId) return res.status(400).json({ error: "catalogId required" });

  const catalog = getCatalogEntry(catalogId);
  if (!catalog) return res.status(400).json({ error: `Unknown catalog entry: ${catalogId}` });

  const effectiveBackend = backend || catalog.backends[0] || "builtin";
  if (!catalog.backends.includes(effectiveBackend)) {
    return res.status(400).json({ error: `Backend ${effectiveBackend} not available for ${catalogId}` });
  }

  try {
    const credentialsEncrypted = encryptCredentials(credentials || {});
    const connector = await db.createConnector({
      catalogId,
      label: label || catalog.name,
      backend: effectiveBackend,
      authType: catalog.authType,
      credentialsEncrypted,
      isGlobal: !!isGlobal,
    });

    if (autoConnect !== false && catalog.authType !== "none" ? Object.keys(credentials || {}).length > 0 : true) {
      try {
        await manager.connectConnector(connector.id);
        connector.status = "connected";
      } catch (err) {
        connector.status = "error";
        connector.errorMessage = err.message;
      }
    }

    const result = stripCredentials(connector);
    result.tools = manager.getConnectorTools(connector.id);
    result.toolCount = result.tools.length;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/connectors/:id", async (req, res) => {
  try {
    const conn = await db.getConnector(req.params.id);
    if (!conn) return res.status(404).json({ error: "Not found" });
    res.json(stripCredentials(conn));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/api/connectors/:id", async (req, res) => {
  const { label, credentials, isGlobal, backend } = req.body;
  try {
    const updates = {};
    if (label !== undefined) updates.label = label;
    if (isGlobal !== undefined) updates.isGlobal = isGlobal;
    if (backend !== undefined) updates.backend = backend;
    if (credentials) updates.credentialsEncrypted = encryptCredentials(credentials);

    await db.updateConnector(req.params.id, updates);
    const updated = await db.getConnector(req.params.id);
    res.json(stripCredentials(updated));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/connectors/:id", async (req, res) => {
  try {
    await manager.disconnectConnector(req.params.id);
    await db.archiveConnector(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Connect / Disconnect ──

router.post("/api/connectors/:id/connect", async (req, res) => {
  try {
    await manager.connectConnector(req.params.id);
    const conn = await db.getConnector(req.params.id);
    const result = stripCredentials(conn);
    result.tools = manager.getConnectorTools(req.params.id);
    result.toolCount = result.tools.length;
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/connectors/:id/disconnect", async (req, res) => {
  try {
    await manager.disconnectConnector(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Test credentials ──

router.post("/api/connectors/:id/test", async (req, res) => {
  const { credentials, catalogId, backend } = req.body;
  try {
    // Can test with provided credentials (before saving) or from existing connector
    if (credentials && catalogId) {
      await manager.testCredentials(catalogId, credentials, backend);
      res.json({ valid: true });
    } else {
      // Test existing connector's credentials
      const conn = await db.getConnector(req.params.id);
      if (!conn) return res.status(404).json({ error: "Not found" });
      const { decryptCredentials: decrypt } = await import("../lib/crypto.js");
      const creds = decrypt(conn.credentialsEncrypted);
      await manager.testCredentials(conn.catalogId, creds, conn.backend);
      res.json({ valid: true });
    }
  } catch (err) {
    res.json({ valid: false, error: err.message });
  }
});

// ── Project-Connector links ──

router.get("/api/projects/:pid/connectors", async (req, res) => {
  try {
    const connectors = await db.getProjectConnectors(req.params.pid);
    res.json(connectors.map(stripCredentials));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/projects/:pid/connectors", async (req, res) => {
  const { connectorId } = req.body;
  if (!connectorId) return res.status(400).json({ error: "connectorId required" });
  try {
    const result = await db.linkToProject(req.params.pid, connectorId, req.body.linkedBy || "user");
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/api/projects/:pid/connectors/:cid", async (req, res) => {
  try {
    await db.unlinkFromProject(req.params.pid, req.params.cid);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Built-in tool call proxy ──

router.post("/api/connectors/tool-call", async (req, res) => {
  const { toolName, args } = req.body;
  if (!toolName) return res.status(400).json({ error: "toolName required" });

  try {
    const resolved = manager.resolveConnectorTool(toolName);
    if (!resolved) return res.status(404).json({ error: `Tool ${toolName} not found` });
    const result = await manager.executeBuiltinTool(resolved.connectorId, resolved.originalName, args || {});
    res.json(typeof result === "string" ? JSON.parse(result) : result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Connector Requests ──

router.post("/api/connector-requests", async (req, res) => {
  const { catalogId, projectId, agentId, reason } = req.body;
  if (!catalogId || !projectId || !reason) {
    return res.status(400).json({ error: "catalogId, projectId, and reason required" });
  }
  try {
    const request = await db.createRequest({
      catalogId,
      projectId,
      agentId: agentId || "system",
      reason,
    });

    // Emit SSE event for real-time frontend notification
    const catalog = getCatalogEntry(catalogId);
    emitTaskEvent(null, "connector_request", {
      requestId: request.id,
      catalogId,
      connectorName: catalog?.name || catalogId,
      reason,
      projectId,
      agentId: agentId || "system",
    });

    res.json(request);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/api/connector-requests", async (req, res) => {
  try {
    const requests = await db.getPendingRequests(req.query.projectId || null);
    res.json(requests);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/api/connector-requests/:id/resolve", async (req, res) => {
  const { status } = req.body;
  if (!["approved", "rejected", "deferred"].includes(status)) {
    return res.status(400).json({ error: "status must be approved, rejected, or deferred" });
  }
  try {
    const request = await db.getRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "Request not found" });

    await db.resolveRequest(req.params.id, status);

    // If approved, auto-link matching connected connectors to the project
    if (status === "approved" && request.projectId) {
      try {
        const allConnectors = await db.listConnectors();
        const matching = allConnectors.filter(
          c => c.catalogId === request.catalogId && c.status === "connected"
        );
        for (const conn of matching) {
          await db.linkToProject(request.projectId, conn.id, "agent");
          log(`[CONNECTOR] Auto-linked ${conn.catalogId} to project ${request.projectId} (approved request)`);
        }
      } catch (err) {
        log(`[CONNECTOR] Auto-link failed: ${err.message}`);
      }
    }

    // Emit SSE event for real-time UI update
    emitTaskEvent(null, "connector_request_resolved", {
      requestId: req.params.id,
      status,
      catalogId: request.catalogId,
      agentId: request.agentId,
      projectId: request.projectId,
    });

    res.json({ ok: true, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helpers ──

function stripCredentials(conn) {
  if (!conn) return conn;
  const { credentialsEncrypted, ...rest } = conn;
  return {
    ...rest,
    credentialsConfigured: credentialsEncrypted && Object.keys(credentialsEncrypted).length > 0,
    credentialFields: Object.keys(credentialsEncrypted || {}),
  };
}

export default router;
