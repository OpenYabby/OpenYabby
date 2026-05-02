/* ═══════════════════════════════════════════════════════
   YABBY — MCP Client Manager
   ═══════════════════════════════════════════════════════
   Manages connections to MCP servers via stdio transport.
*/

import { log } from "../logger.js";

// Active MCP server connections: name → { config, client, transport, tools }
const servers = new Map();

let Client, StdioClientTransport;

async function loadSdk() {
  if (Client) return;
  try {
    const sdk = await import("@modelcontextprotocol/sdk/client/index.js");
    Client = sdk.Client;
    const transport = await import("@modelcontextprotocol/sdk/client/stdio.js");
    StdioClientTransport = transport.StdioClientTransport;
  } catch (err) {
    log("[MCP] SDK not installed — MCP features disabled. Install with: npm i @modelcontextprotocol/sdk");
    throw new Error("@modelcontextprotocol/sdk not installed");
  }
}

export async function connectServer(config) {
  await loadSdk();

  const { name, command, args = [], env = {} } = config;
  if (!name || !command) throw new Error("MCP server config needs name and command");

  // Disconnect existing if reconnecting
  if (servers.has(name)) {
    await disconnectServer(name);
  }

  const transport = new StdioClientTransport({ command, args, env: { ...process.env, ...env } });
  const client = new Client({ name: `yabby-${name}`, version: "1.0.0" }, { capabilities: {} });

  await client.connect(transport);

  // List available tools
  let tools = [];
  try {
    const result = await client.listTools();
    tools = result.tools || [];
  } catch (err) {
    log(`[MCP] Could not list tools for ${name}:`, err.message);
  }

  servers.set(name, { config, client, transport, tools });
  log(`[MCP] Connected to ${name} (${tools.length} tools)`);

  return { name, tools: tools.map(t => ({ name: t.name, description: t.description })) };
}

export async function disconnectServer(name) {
  const server = servers.get(name);
  if (!server) return false;

  try {
    await server.client.close();
  } catch (err) {
    log(`[MCP] Error closing ${name}:`, err.message);
  }

  servers.delete(name);
  log(`[MCP] Disconnected ${name}`);
  return true;
}

export function listServers() {
  return [...servers.entries()].map(([name, s]) => ({
    name,
    command: s.config.command,
    args: s.config.args,
    toolCount: s.tools.length,
    tools: s.tools.map(t => ({ name: t.name, description: t.description })),
  }));
}

export function getServerTools(name) {
  const server = servers.get(name);
  if (!server) return [];
  return server.tools;
}

export async function callTool(serverName, toolName, args = {}) {
  const server = servers.get(serverName);
  if (!server) throw new Error(`MCP server "${serverName}" not connected`);

  const result = await server.client.callTool({ name: toolName, arguments: args });
  return result;
}

export async function closeAllServers() {
  for (const name of servers.keys()) {
    await disconnectServer(name);
  }
}
