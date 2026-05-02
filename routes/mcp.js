import { Router } from "express";
import { connectServer, disconnectServer, listServers, callTool } from "../lib/mcp/client.js";
import { bridgeServerTools, unbridgeServerTools } from "../lib/mcp/bridge.js";
import { getMcpTools } from "../lib/plugins/tool-registry.js";

const router = Router();

// GET /api/mcp/servers — list connected MCP servers
router.get("/api/mcp/servers", (_req, res) => {
  res.json({ servers: listServers() });
});

// POST /api/mcp/servers — connect a new MCP server
router.post("/api/mcp/servers", async (req, res) => {
  try {
    const { name, command, args, env } = req.body;
    if (!name || !command) return res.status(400).json({ error: "name and command required" });

    const result = await connectServer({ name, command, args, env });

    // Bridge tools into voice tool registry
    const serverTools = result.tools;
    bridgeServerTools(name, serverTools);

    res.json({ status: "connected", ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/mcp/servers/:name — disconnect an MCP server
router.delete("/api/mcp/servers/:name", async (req, res) => {
  try {
    const servers = listServers();
    const server = servers.find(s => s.name === req.params.name);

    if (server) {
      unbridgeServerTools(req.params.name, server.tools);
    }

    const ok = await disconnectServer(req.params.name);
    if (!ok) return res.status(404).json({ error: `Server "${req.params.name}" not found` });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/mcp/tools — list all MCP-bridged tools
router.get("/api/mcp/tools", (_req, res) => {
  const tools = getMcpTools();
  res.json({ tools: tools.map(t => ({ name: t.name, description: t.description })) });
});

// POST /api/mcp/call — call an MCP tool directly
router.post("/api/mcp/call", async (req, res) => {
  try {
    const { server, tool, args } = req.body;
    if (!server || !tool) return res.status(400).json({ error: "server and tool required" });
    const result = await callTool(server, tool, args || {});
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
