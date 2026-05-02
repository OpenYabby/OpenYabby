/**
 * OpenYabby Relay Tunnel Client
 * Connects to relay.openyabby.com and proxies HTTP + WebSocket traffic
 * to the local OpenYabby server.
 */

import { WebSocket } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '..', '.env');

const RELAY_SECRET = process.env.RELAY_SECRET || '';
const LOCAL_PORT = process.env.PORT || 3000;
const LOCAL_BASE = `http://localhost:${LOCAL_PORT}`;

/** Build relay URL, appending saved code if available */
function getRelayUrl() {
  const base = process.env.RELAY_URL || `wss://relay.openyabby.com/register?secret=${RELAY_SECRET}`;
  const saved = process.env.TUNNEL_CODE;
  if (saved) {
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}code=${saved}`;
  }
  return base;
}

/** Persist TUNNEL_CODE to .env so it survives restarts */
function saveTunnelCodeToEnv(code) {
  try {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    if (/^TUNNEL_CODE=.*/m.test(content)) {
      content = content.replace(/^TUNNEL_CODE=.*/m, `TUNNEL_CODE=${code}`);
    } else {
      content = content.trimEnd() + `\n\n# Tunnel code (persisted – do not change)\nTUNNEL_CODE=${code}\n`;
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
    // Also set in current process so reconnects within same session use it
    process.env.TUNNEL_CODE = code;
  } catch (err) {
    log(`[TUNNEL] Warning: could not save TUNNEL_CODE to .env: ${err.message}`);
  }
}

let tunnelCode = null;
let reconnectDelay = 2000;
let stopped = false;

// Active WebSocket proxies: wsId -> WebSocket (local)
const localWsSockets = new Map();

export function getTunnelCode() {
  return tunnelCode;
}

export function startTunnel() {
  if (stopped) return;
  if (!RELAY_SECRET) {
    log('[TUNNEL] No RELAY_SECRET set — tunnel disabled');
    return;
  }
  connect();
}

export function stopTunnel() {
  stopped = true;
}

function connect() {
  if (stopped) return;

  const relayUrl = getRelayUrl();
  log(`[TUNNEL] Connecting to relay: ${relayUrl}`);
  const ws = new WebSocket(relayUrl);

  ws.on('open', () => {
    reconnectDelay = 2000; // reset backoff on success
    log('[TUNNEL] Connected to relay, waiting for code...');
  });

  ws.on('message', async (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Relay assigned us a tunnel code
    if (msg.type === 'assigned') {
      tunnelCode = msg.code;
      saveTunnelCodeToEnv(msg.code);
      log(`[TUNNEL] ✅ Tunnel code: ${msg.code}`);
      log(`[TUNNEL] Mobile app: connect with code ${msg.code}`);
      return;
    }

    // Relay is proxying an HTTP request through the tunnel
    if (msg.type === 'request') {
      handleHttpRequest(ws, msg);
      return;
    }

    // Relay is opening a WebSocket proxy
    if (msg.type === 'ws-open') {
      handleWsOpen(ws, msg);
      return;
    }

    // Relay is forwarding a WS message from the client
    if (msg.type === 'ws-message') {
      const localWs = localWsSockets.get(msg.id);
      if (localWs && localWs.readyState === WebSocket.OPEN) {
        localWs.send(Buffer.from(msg.data, 'base64'));
      }
      return;
    }

    // Relay closed the WS proxy
    if (msg.type === 'ws-close') {
      const localWs = localWsSockets.get(msg.id);
      if (localWs) {
        localWs.close();
        localWsSockets.delete(msg.id);
      }
      return;
    }
  });

  ws.on('close', () => {
    tunnelCode = null;
    if (stopped) return;
    log(`[TUNNEL] Disconnected. Reconnecting in ${reconnectDelay / 1000}s...`);
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 30000); // max 30s backoff
  });

  ws.on('error', (err) => {
    log(`[TUNNEL] Error: ${err.message}`);
  });
}

async function handleHttpRequest(relayWs, msg) {
  const { id, method, path, headers, body } = msg;

  // Strip hop-by-hop headers
  const safeHeaders = { ...headers };
  delete safeHeaders['host'];
  delete safeHeaders['connection'];
  delete safeHeaders['transfer-encoding'];

  const bodyBuf = body ? Buffer.from(body, 'base64') : null;

  try {
    const url = new URL(path, LOCAL_BASE);
    const options = {
      hostname: 'localhost',
      port: LOCAL_PORT,
      path: url.pathname + url.search,
      method: method || 'GET',
      headers: {
        ...safeHeaders,
        host: `localhost:${LOCAL_PORT}`,
      },
    };

    await new Promise((resolve) => {
      const req = http.request(options, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks);
          // Remove hop-by-hop headers from response
          const resHeaders = { ...res.headers };
          delete resHeaders['transfer-encoding'];
          delete resHeaders['connection'];

          relayWs.send(JSON.stringify({
            type: 'response',
            id,
            status: res.statusCode,
            headers: resHeaders,
            body: responseBody.toString('base64'),
          }));
          resolve();
        });
        res.on('error', resolve);
      });

      req.on('error', (err) => {
        log(`[TUNNEL] Local request error: ${err.message}`);
        relayWs.send(JSON.stringify({
          type: 'response',
          id,
          status: 502,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ error: err.message })).toString('base64'),
        }));
        resolve();
      });

      if (bodyBuf && bodyBuf.length > 0) {
        req.write(bodyBuf);
      }
      req.end();
    });
  } catch (err) {
    log(`[TUNNEL] Request handler error: ${err.message}`);
    relayWs.send(JSON.stringify({
      type: 'response',
      id,
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ error: err.message })).toString('base64'),
    }));
  }
}

function handleWsOpen(relayWs, msg) {
  const { id, path, headers } = msg;

  const safeHeaders = { ...headers };
  delete safeHeaders['host'];
  delete safeHeaders['connection'];
  delete safeHeaders['upgrade'];

  const localWsUrl = `ws://localhost:${LOCAL_PORT}${path}`;
  let localWs;

  try {
    localWs = new WebSocket(localWsUrl, {
      headers: {
        ...safeHeaders,
        host: `localhost:${LOCAL_PORT}`,
      },
    });
  } catch (err) {
    log(`[TUNNEL] WS open error: ${err.message}`);
    relayWs.send(JSON.stringify({ type: 'ws-close', id }));
    return;
  }

  localWsSockets.set(id, localWs);

  localWs.on('message', (data) => {
    relayWs.send(JSON.stringify({
      type: 'ws-message',
      id,
      data: Buffer.from(data).toString('base64'),
    }));
  });

  localWs.on('close', () => {
    localWsSockets.delete(id);
    relayWs.send(JSON.stringify({ type: 'ws-close', id }));
  });

  localWs.on('error', (err) => {
    log(`[TUNNEL] Local WS error (${id}): ${err.message}`);
    localWsSockets.delete(id);
    relayWs.send(JSON.stringify({ type: 'ws-close', id }));
  });
}
