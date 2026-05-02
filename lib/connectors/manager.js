/* ═══════════════════════════════════════════════════════
   YABBY — Connector Manager
   ═══════════════════════════════════════════════════════
   Orchestrates connector lifecycle: connect, disconnect,
   tool execution. Delegates to MCP client or built-in engine.
*/

import { log } from "../logger.js";
import { decryptCredentials, encryptCredentials } from "../crypto.js";
import { getCatalogEntry, CONNECTOR_CATALOG } from "./catalog.js";
import { registerTool, removeTool } from "../plugins/tool-registry.js";
import * as mcpClient from "../mcp/client.js";
import { bridgeServerTools, unbridgeServerTools } from "../mcp/bridge.js";
import * as db from "../../db/queries/connectors.js";

// Active built-in connector instances: connectorId → BuiltinConnector
const builtinInstances = new Map();

// Track which tools belong to which connector (for cleanup)
const connectorToolNames = new Map(); // connectorId → string[]

// Connector summary cache — avoids repeated PG queries (invalidated on connect/disconnect)
let _summaryCache = { value: null, ts: 0 };
const SUMMARY_CACHE_TTL = 5 * 60_000; // 5 minutes

/**
 * Connect a connector (start MCP server or load built-in module)
 */
export async function connectConnector(connectorId) {
  const conn = await db.getConnector(connectorId);
  if (!conn) throw new Error(`Connector ${connectorId} not found`);

  const catalog = getCatalogEntry(conn.catalogId);
  if (!catalog) throw new Error(`Unknown catalog entry: ${conn.catalogId}`);

  const creds = decryptCredentials(conn.credentialsEncrypted);

  try {
    if (conn.backend === "mcp") {
      await connectMcp(conn, catalog, creds);
    } else {
      await connectBuiltin(conn, catalog, creds);
    }
    await db.updateConnector(connectorId, { status: "connected", errorMessage: null });
    _summaryCache.ts = 0; // invalidate connector summary cache
    log(`[CONNECTOR] Connected ${catalog.name} (${conn.backend})`);
  } catch (err) {
    await db.updateConnector(connectorId, { status: "error", errorMessage: err.message });
    log(`[CONNECTOR] Failed to connect ${catalog.name}: ${err.message}`);
    throw err;
  }
}

async function connectMcp(conn, catalog, creds) {
  if (!catalog.mcp) throw new Error(`${catalog.name} has no MCP backend`);

  const mcpName = `connector_${conn.catalogId}_${conn.id.slice(0, 8)}`;
  const env = resolveTemplate(catalog.mcp.env || {}, creds);
  const args = catalog.mcp.args.map(a => resolveTemplateStr(a, creds));

  const result = await mcpClient.connectServer({
    name: mcpName,
    command: catalog.mcp.command,
    args,
    env,
  });

  // Bridge MCP tools into voice tool registry
  const mcpTools = mcpClient.getServerTools(mcpName);
  bridgeServerTools(mcpName, mcpTools);

  // Track tools for this connector
  connectorToolNames.set(conn.id, mcpTools.map(t => `mcp_${mcpName}_${t.name}`));

  // Store the MCP name for later disconnect
  await db.updateConnector(conn.id, { mcpConfig: { ...catalog.mcp, _mcpName: mcpName } });
}

async function connectBuiltin(conn, catalog, creds) {
  if (!catalog.builtin) throw new Error(`${catalog.name} has no built-in backend`);

  // Dynamic import of the built-in connector module
  const modulePath = catalog.builtin.module;
  const mod = await import(modulePath);
  const ConnectorClass = Object.values(mod).find(v => typeof v === "function" && v.prototype);
  if (!ConnectorClass) throw new Error(`No connector class found in ${modulePath}`);

  const instance = new ConnectorClass(creds);
  builtinInstances.set(conn.id, instance);

  // Register tools in the voice tool registry
  const tools = instance.getTools();
  const toolNames = [];
  for (const tool of tools) {
    const toolName = `conn_${conn.catalogId}_${tool.name}`;
    registerTool({
      type: "function",
      name: toolName,
      description: `[${catalog.name}] ${tool.description || tool.name}`,
      parameters: tool.parameters || { type: "object", properties: {} },
      _connector: { connectorId: conn.id, catalogId: conn.catalogId, originalName: tool.name },
    });
    toolNames.push(toolName);
  }
  connectorToolNames.set(conn.id, toolNames);
}

/**
 * Disconnect a connector
 */
export async function disconnectConnector(connectorId) {
  const conn = await db.getConnector(connectorId);
  if (!conn) return;

  try {
    if (conn.backend === "mcp") {
      const mcpName = conn.mcpConfig?._mcpName;
      if (mcpName) {
        const tools = mcpClient.getServerTools(mcpName);
        unbridgeServerTools(mcpName, tools);
        await mcpClient.disconnectServer(mcpName);
      }
    } else {
      const instance = builtinInstances.get(connectorId);
      if (instance?.destroy) await instance.destroy();
      builtinInstances.delete(connectorId);
    }

    // Remove registered tools
    const toolNames = connectorToolNames.get(connectorId) || [];
    for (const name of toolNames) {
      removeTool(name);
    }
    connectorToolNames.delete(connectorId);

    await db.updateConnector(connectorId, { status: "disconnected" });
    _summaryCache.ts = 0; // invalidate connector summary cache
    log(`[CONNECTOR] Disconnected ${conn.catalogId}`);
  } catch (err) {
    log(`[CONNECTOR] Error disconnecting ${conn.catalogId}: ${err.message}`);
    await db.updateConnector(connectorId, { status: "disconnected", errorMessage: err.message });
  }
}

/**
 * Execute a tool on a built-in connector
 */
export async function executeBuiltinTool(connectorId, toolName, args) {
  const instance = builtinInstances.get(connectorId);
  if (!instance) throw new Error(`Built-in connector ${connectorId} not running`);
  return await instance.executeTool(toolName, args);
}

/**
 * Reconnect all connectors that were previously connected (server startup)
 */
export async function reconnectAll() {
  try {
    const connectors = await db.listConnectors();
    const toReconnect = connectors.filter(c => c.status === "connected" || c.status === "error");
    let success = 0;
    for (const conn of toReconnect) {
      try {
        await connectConnector(conn.id);
        success++;
      } catch (err) {
        log(`[CONNECTOR] Auto-reconnect failed for ${conn.catalogId}: ${err.message}`);
      }
    }
    if (toReconnect.length > 0) {
      log(`[CONNECTOR] Auto-reconnected ${success}/${toReconnect.length} connectors`);
    }
  } catch (err) {
    log(`[CONNECTOR] reconnectAll error: ${err.message}`);
  }
}

/**
 * Test credentials for a catalog entry without persisting
 */
export async function testCredentials(catalogId, credentials, backend = "builtin") {
  const catalog = getCatalogEntry(catalogId);
  if (!catalog) throw new Error(`Unknown catalog entry: ${catalogId}`);

  if (backend === "builtin" && catalog.builtin) {
    const modulePath = catalog.builtin.module;
    const mod = await import(modulePath);
    const ConnectorClass = Object.values(mod).find(v => typeof v === "function" && v.prototype);
    if (!ConnectorClass) throw new Error("No connector class found");
    const instance = new ConnectorClass(credentials);
    await instance.testCredentials();
    if (instance.destroy) await instance.destroy();
    return true;
  }

  // For MCP or connectors without builtin test, do a basic auth check
  if (catalogId === "github" && credentials.GITHUB_TOKEN) {
    const r = await fetch("https://api.github.com/user", {
      headers: { Authorization: `token ${credentials.GITHUB_TOKEN}`, Accept: "application/vnd.github.v3+json" },
    });
    if (!r.ok) throw new Error(`GitHub API : ${r.status}`);
    return true;
  }

  if (catalogId === "slack" && credentials.SLACK_BOT_TOKEN) {
    const r = await fetch("https://slack.com/api/auth.test", {
      headers: { Authorization: `Bearer ${credentials.SLACK_BOT_TOKEN}` },
    });
    const data = await r.json();
    if (!data.ok) throw new Error(data.error || "Token Slack invalide");
    return true;
  }

  if (catalogId === "notion" && credentials.NOTION_TOKEN) {
    const r = await fetch("https://api.notion.com/v1/users/me", {
      headers: { Authorization: `Bearer ${credentials.NOTION_TOKEN}`, "Notion-Version": "2022-06-28" },
    });
    if (!r.ok) throw new Error(`Notion API : ${r.status}`);
    return true;
  }

  if (catalogId === "linear" && credentials.LINEAR_API_KEY) {
    const r = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { Authorization: credentials.LINEAR_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ viewer { id } }" }),
    });
    if (!r.ok) throw new Error(`Linear API : ${r.status}`);
    const data = await r.json();
    if (data.errors) throw new Error(data.errors[0]?.message || "Cl\u00e9 Linear invalide");
    return true;
  }

  if (catalogId === "brave-search" && credentials.BRAVE_API_KEY) {
    const r = await fetch("https://api.search.brave.com/res/v1/web/search?q=test&count=1", {
      headers: { "X-Subscription-Token": credentials.BRAVE_API_KEY, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`Brave Search API : ${r.status}`);
    return true;
  }

  if (catalogId === "jira" && credentials.JIRA_HOST && credentials.JIRA_EMAIL && credentials.JIRA_API_TOKEN) {
    const host = credentials.JIRA_HOST.replace(/\/+$/, "");
    const basic = Buffer.from(`${credentials.JIRA_EMAIL}:${credentials.JIRA_API_TOKEN}`).toString("base64");
    const r = await fetch(`${host}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`Jira API : ${r.status}`);
    return true;
  }

  if (catalogId === "confluence" && credentials.CONFLUENCE_DOMAIN && credentials.CONFLUENCE_EMAIL && credentials.CONFLUENCE_API_TOKEN) {
    let domain = credentials.CONFLUENCE_DOMAIN.replace(/\/+$/, "");
    if (!domain.startsWith("http")) domain = `https://${domain}`;
    const basic = Buffer.from(`${credentials.CONFLUENCE_EMAIL}:${credentials.CONFLUENCE_API_TOKEN}`).toString("base64");
    const r = await fetch(`${domain}/wiki/rest/api/user/current`, {
      headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`Confluence API : ${r.status}`);
    return true;
  }

  if (catalogId === "trello" && credentials.TRELLO_API_KEY && credentials.TRELLO_TOKEN) {
    const r = await fetch(`https://api.trello.com/1/members/me?key=${encodeURIComponent(credentials.TRELLO_API_KEY)}&token=${encodeURIComponent(credentials.TRELLO_TOKEN)}`);
    if (!r.ok) throw new Error(`Trello API : ${r.status}`);
    return true;
  }

  if (catalogId === "todoist" && credentials.TODOIST_API_TOKEN) {
    const r = await fetch("https://api.todoist.com/rest/v2/projects", {
      headers: { Authorization: `Bearer ${credentials.TODOIST_API_TOKEN}` },
    });
    if (!r.ok) throw new Error(`Todoist API : ${r.status}`);
    return true;
  }

  if (catalogId === "figma" && credentials.FIGMA_API_KEY) {
    const r = await fetch("https://api.figma.com/v1/me", {
      headers: { "X-Figma-Token": credentials.FIGMA_API_KEY },
    });
    if (!r.ok) throw new Error(`Figma API : ${r.status}`);
    return true;
  }

  if (catalogId === "sentry" && credentials.SENTRY_AUTH_TOKEN) {
    const r = await fetch("https://sentry.io/api/0/", {
      headers: { Authorization: `Bearer ${credentials.SENTRY_AUTH_TOKEN}` },
    });
    if (!r.ok) throw new Error(`Sentry API : ${r.status}`);
    return true;
  }

  if (catalogId === "supabase" && credentials.SUPABASE_URL && credentials.SUPABASE_API_KEY) {
    const url = credentials.SUPABASE_URL.replace(/\/+$/, "");
    const r = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: credentials.SUPABASE_API_KEY, Authorization: `Bearer ${credentials.SUPABASE_API_KEY}` },
    });
    if (!r.ok) throw new Error(`Supabase API : ${r.status}`);
    return true;
  }

  // No-auth connectors (filesystem, web-fetch, git, puppeteer, memory) — always valid
  if (catalog.authType === "none") return true;

  // Fallback: no specific test — assume valid
  return true;
}

/**
 * Get allowed tool names for a project (global + project-linked connectors).
 * Returns null if no project scoping needed (all tools allowed).
 */
export async function getAllowedToolNamesForProject(projectId) {
  if (!projectId) return null; // no scoping

  try {
    // Get connectors linked to this project
    const projectConnectors = await db.getProjectConnectors(projectId);
    // Get global connectors
    const globalConnectors = await db.getGlobalConnectors();

    // Merge unique connector IDs
    const allowedIds = new Set();
    for (const c of projectConnectors) {
      if (c.enabled !== false) allowedIds.add(c.id);
    }
    for (const c of globalConnectors) {
      allowedIds.add(c.id);
    }

    // Collect all tool names for allowed connectors
    const toolNames = [];
    for (const connId of allowedIds) {
      const names = connectorToolNames.get(connId) || [];
      toolNames.push(...names);
    }

    return toolNames;
  } catch (err) {
    log(`[CONNECTOR] Error getting project tools: ${err.message}`);
    return null; // fallback: all tools
  }
}

/**
 * Get summary of all connectors for voice instructions
 */
export async function getConnectorSummary() {
  // Return cached summary if still fresh
  if (_summaryCache.value !== null && Date.now() - _summaryCache.ts < SUMMARY_CACHE_TTL) {
    return _summaryCache.value;
  }

  try {
    const connectors = await db.listConnectors();
    if (connectors.length === 0) {
      _summaryCache = { value: "", ts: Date.now() };
      return "";
    }

    const lines = [];
    for (const c of connectors) {
      const catalog = getCatalogEntry(c.catalogId);
      const name = catalog?.name || c.catalogId;
      const toolCount = (connectorToolNames.get(c.id) || []).length;
      if (c.status === "connected") {
        lines.push(`- ${name} (connect\u00e9, ${c.backend}) : ${toolCount} outils`);
      } else {
        lines.push(`- ${name} (${c.status}) \u2014 disponible dans le catalogue`);
      }
    }
    const summary = lines.join("\n");
    _summaryCache = { value: summary, ts: Date.now() };
    return summary;
  } catch {
    return "";
  }
}

/**
 * Get the list of registered tool names for a connector
 */
export function getConnectorTools(connectorId) {
  return connectorToolNames.get(connectorId) || [];
}

/**
 * Get the connector ID and original tool name from a registered tool name
 */
export function resolveConnectorTool(toolName) {
  for (const [connectorId, toolNames] of connectorToolNames.entries()) {
    if (toolNames.includes(toolName)) {
      // Extract original tool name from registered name
      // Format: conn_{catalogId}_{originalName}
      const parts = toolName.split("_");
      const originalName = parts.slice(2).join("_");
      return { connectorId, originalName };
    }
  }
  return null;
}

// ── Template helpers ──

function resolveTemplate(obj, creds) {
  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = resolveTemplateStr(String(value), creds);
  }
  return result;
}

function resolveTemplateStr(str, creds) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, key) => creds[key] || "");
}
