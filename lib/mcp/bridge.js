/* ═══════════════════════════════════════════════════════
   YABBY — MCP → Tool Registry Bridge
   ═══════════════════════════════════════════════════════
   Converts MCP tool schemas to OpenAI function calling
   format and registers them in the tool registry.
*/

import { registerMcpTool, removeMcpTool, clearMcpTools } from "../plugins/tool-registry.js";
import { log } from "../logger.js";

/**
 * Convert MCP JSON Schema to OpenAI function calling parameters format.
 */
function convertSchema(mcpSchema) {
  if (!mcpSchema || !mcpSchema.inputSchema) {
    return { type: "object", properties: {}, required: [] };
  }
  const schema = mcpSchema.inputSchema;
  return {
    type: schema.type || "object",
    properties: schema.properties || {},
    required: schema.required || [],
  };
}

/**
 * Bridge all tools from an MCP server into the tool registry.
 */
export function bridgeServerTools(serverName, mcpTools) {
  let count = 0;
  for (const tool of mcpTools) {
    const def = {
      type: "function",
      name: `mcp_${serverName}_${tool.name}`,
      description: `[MCP:${serverName}] ${tool.description || tool.name}`,
      parameters: convertSchema(tool),
      _mcp: { server: serverName, originalName: tool.name },
    };
    registerMcpTool(def);
    count++;
  }
  log(`[MCP-BRIDGE] Bridged ${count} tools from ${serverName}`);
  return count;
}

/**
 * Remove all bridged tools for a specific MCP server.
 */
export function unbridgeServerTools(serverName, mcpTools) {
  let count = 0;
  for (const tool of mcpTools) {
    if (removeMcpTool(`mcp_${serverName}_${tool.name}`)) count++;
  }
  log(`[MCP-BRIDGE] Removed ${count} tools from ${serverName}`);
  return count;
}

/**
 * Clear all MCP tools from registry.
 */
export function clearAllMcpBridges() {
  return clearMcpTools();
}
