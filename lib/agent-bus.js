/**
 * Agent messaging bus — Redis pub/sub for inter-agent communication.
 *
 * When an agent sends a message to another agent, the bus:
 * 1. Stores the message in the DB (agent_messages table)
 * 2. Publishes a notification via Redis pub/sub
 * 3. Listeners can trigger follow-up tasks (e.g., auto-deliver to recipient agent)
 */
import { createClient } from "redis";
import { sendMessage } from "../db/queries/agent-messages.js";
import { getAgent } from "../db/queries/agents.js";
import { logEvent } from "../db/queries/events.js";
import { log } from "./logger.js";

const CHANNEL = "yabby:agent-bus";

let publisher = null;
let subscriber = null;
const listeners = new Map(); // agentId -> callback[]

export async function initBus() {
  const url = process.env.REDIS_URL || "redis://localhost:6379";

  publisher = createClient({ url });
  subscriber = publisher.duplicate();

  publisher.on("error", (err) => log("[AGENT-BUS] Publisher error:", err.message));
  subscriber.on("error", (err) => log("[AGENT-BUS] Subscriber error:", err.message));

  await publisher.connect();
  await subscriber.connect();

  await subscriber.subscribe(CHANNEL, (message) => {
    try {
      const data = JSON.parse(message);
      const callbacks = listeners.get(data.toAgent) || [];
      for (const cb of callbacks) {
        cb(data).catch(err => log("[AGENT-BUS] Listener error:", err.message));
      }
    } catch (err) {
      log("[AGENT-BUS] Parse error:", err.message);
    }
  });

  log("[AGENT-BUS] Initialized");
}

/**
 * Send a message from one agent to another.
 * Stores in DB + publishes notification.
 */
export async function agentSend(fromAgentId, toAgentId, projectId, content, msgType = "message") {
  // Store in DB
  const msg = await sendMessage(fromAgentId, toAgentId, projectId, content, msgType);

  const fromAgent = await getAgent(fromAgentId);
  const toAgent = await getAgent(toAgentId);

  log(`[AGENT-BUS] ${fromAgent?.name || fromAgentId} → ${toAgent?.name || toAgentId}: ${content.slice(0, 100)}`);

  await logEvent("agent_message", {
    projectId,
    agentId: fromAgentId,
    detail: {
      toAgent: toAgentId,
      msgType,
      preview: content.slice(0, 200),
    },
  });

  // Publish notification
  if (publisher) {
    await publisher.publish(CHANNEL, JSON.stringify({
      id: msg.id,
      fromAgent: fromAgentId,
      fromName: fromAgent?.name,
      toAgent: toAgentId,
      toName: toAgent?.name,
      projectId,
      content,
      msgType,
    }));
  }

  return msg;
}

/**
 * Register a listener for messages to a specific agent.
 */
export function onAgentMessage(agentId, callback) {
  if (!listeners.has(agentId)) listeners.set(agentId, []);
  listeners.get(agentId).push(callback);
}

/**
 * Cleanup
 */
export async function closeBus() {
  if (subscriber) await subscriber.unsubscribe(CHANNEL).catch(() => {});
  if (subscriber) await subscriber.quit().catch(() => {});
  if (publisher) await publisher.quit().catch(() => {});
  listeners.clear();
}
