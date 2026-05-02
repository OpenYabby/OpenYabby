/* ═══════════════════════════════════════════════════════
   YABBY — WebSocket Gateway
   ═══════════════════════════════════════════════════════
   Real-time bidirectional communication. Broadcasts same
   events as SSE. Supports auth, presence, typing.
*/

import { log } from "./logger.js";

let WebSocketServer;
let wss = null;
const wsClients = new Set();

// Track presence
const presenceMap = new Map(); // ws → { userId, connectedAt }

/**
 * Attach WebSocket server to an existing HTTP server.
 */
export async function initWebSocket(httpServer) {
  try {
    const ws = await import("ws");
    WebSocketServer = ws.WebSocketServer;
  } catch {
    log("[WS] ws package not installed — WebSocket disabled. Install with: npm i ws");
    return;
  }

  wss = new WebSocketServer({ server: httpServer, path: "/ws" });

  wss.on("connection", (ws, req) => {
    wsClients.add(ws);
    const clientId = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    presenceMap.set(ws, { clientId, connectedAt: new Date().toISOString() });

    log(`[WS] Client connected (${wsClients.size} total)`);

    // Broadcast presence update
    broadcastWs({ type: "presence", clients: wsClients.size });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        handleWsMessage(ws, msg);
      } catch {}
    });

    ws.on("close", () => {
      wsClients.delete(ws);
      presenceMap.delete(ws);
      log(`[WS] Client disconnected (${wsClients.size} remaining)`);
      broadcastWs({ type: "presence", clients: wsClients.size });
    });

    ws.on("error", () => {
      wsClients.delete(ws);
      presenceMap.delete(ws);
    });

    // Send welcome
    ws.send(JSON.stringify({ type: "welcome", clientId, timestamp: new Date().toISOString() }));
  });

  log("[WS] WebSocket gateway initialized on /ws");
}

function handleWsMessage(ws, msg) {
  switch (msg.type) {
    case "ping":
      ws.send(JSON.stringify({ type: "pong", timestamp: new Date().toISOString() }));
      break;

    case "typing":
      // Broadcast to other clients
      for (const client of wsClients) {
        if (client !== ws && client.readyState === 1) {
          client.send(JSON.stringify({ type: "typing", from: presenceMap.get(ws)?.clientId }));
        }
      }
      break;

    case "subscribe":
      // Store subscription preferences (future use)
      break;
  }
}

/**
 * Broadcast a message to all connected WS clients.
 */
export function broadcastWs(data) {
  if (!wss || wsClients.size === 0) return;
  const payload = JSON.stringify(data);
  for (const client of wsClients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

/**
 * Get the set of WS clients for logger integration.
 */
export function getWsClients() {
  return wsClients;
}

export function getWsClientCount() {
  return wsClients.size;
}

export async function closeWebSocket() {
  if (wss) {
    for (const client of wsClients) {
      client.close();
    }
    wsClients.clear();
    wss.close();
    wss = null;
    log("[WS] WebSocket gateway closed");
  }
}
