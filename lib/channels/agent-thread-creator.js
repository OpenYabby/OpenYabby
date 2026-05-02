/**
 * Per-channel agent thread creators — used by both:
 *   - the assign_agent auto-create hook in routes/agents.js
 *   - the explicit /api/agents/{telegram,discord,slack}-thread endpoints
 *     that the CLI tool create_agent_thread dispatches to.
 *
 * Each creator returns a uniform object:
 *   { success, channel, thread_id, name, message }
 *
 * Errors throw with a clear message — the caller maps them to HTTP 400/500.
 *
 * Naming: every thread/topic/channel uses an opaque `yabby_<8hex>` so the
 * agent's role does not leak in the platform-visible name.
 */

import { randomBytes } from "crypto";
import { log } from "../logger.js";
import { getChannel } from "./index.js";
import { getThreadManager } from "./thread-binding-manager.js";
import { getChannelContainer } from "../../db/queries/channel-containers.js";
import { getOrCreateAgentConversation } from "../../db/queries/conversations.js";
import { serverMsg } from "../i18n.js";

function opaqueName(prefix = "yabby") {
  return `${prefix}_${randomBytes(4).toString("hex")}`;
}

/**
 * Build a human-readable thread name aligned on the WhatsApp convention
 * "💬 [role] [name]" — same semantics on every channel that supports
 * emojis + spaces in the platform-visible name.
 *
 * Telegram forum topics: emojis + spaces OK. Length limit 128 chars.
 * Discord channels: NO emojis, NO uppercase, NO spaces — must be a slug
 *   matching ^[a-z0-9-]+$ with max 100 chars. Caller passes channel="discord"
 *   to get a slugified variant.
 * Slack channels: lowercase, max 80 chars, only [a-z0-9-_]. Caller passes
 *   channel="slack" to get a slugified variant.
 */
function formatThreadName(agent, channel) {
  const role = (agent.role || "agent").trim();
  const name = (agent.name || "").trim();

  if (channel === "telegram") {
    // Telegram forum topic — same emoji/format as WhatsApp groups.
    const human = `💬 ${role} [${name}]`;
    return human.slice(0, 128);
  }

  // Discord / Slack — strip emojis, lowercase, replace spaces, keep [a-z0-9-]
  const slug = `${role}-${name}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, channel === "slack" ? 76 : 96);
  return `yabby-${slug}` || `yabby-${randomBytes(4).toString("hex")}`;
}

async function ensureNoExistingBinding(channelName, agentId) {
  const manager = getThreadManager("_global", "main");
  const existing = await manager.getAllByAgentId(agentId);
  const already = existing.find(b => b.channel_name === channelName);
  if (already) {
    throw new Error(`Agent already has a ${channelName} thread (thread_id=${already.thread_id})`);
  }
}

/**
 * Telegram — create a forum topic in the paired forum container group.
 * thread_id is composed as "<chat_id>:<message_thread_id>" so the outgoing
 * send path can target the right topic.
 */
export async function createAgentTelegramTopic(agent) {
  const adapter = getChannel("telegram");
  if (!adapter?.running) throw new Error("Telegram adapter not running");

  const container = await getChannelContainer("telegram");
  if (!container) throw new Error("No Telegram forum container paired. Use /pairforum in a Telegram forum group first.");

  await ensureNoExistingBinding("telegram", agent.id);

  const name = formatThreadName(agent, "telegram");
  let topic;
  try {
    topic = await adapter.bot.api.createForumTopic(container.container_id, name);
  } catch (err) {
    throw new Error(`Telegram createForumTopic failed: ${err.message}`);
  }

  const conversationId = await getOrCreateAgentConversation(agent.id);
  const composedThreadId = `${container.container_id}:${topic.message_thread_id}`;

  const manager = getThreadManager("telegram", "main");
  await manager.bindThread({
    threadId: composedThreadId,
    conversationId,
    agentId: agent.id,
    sessionKey: `telegram-topic-${topic.message_thread_id}`,
    ownerUserId: container.owner_user_id,
    ownerUserName: container.owner_user_name,
    metadata: { container_id: container.container_id, topic_id: topic.message_thread_id, name },
  });

  log(`[AGENT-THREAD] Telegram topic created: agent=${agent.id} container=${container.container_id} topic=${topic.message_thread_id} owner=${container.owner_user_id}`);

  return {
    success: true,
    channel: "telegram",
    thread_id: composedThreadId,
    name,
    message: serverMsg().telegramTopicCreatedMsg,
  };
}

/**
 * Discord — create a private text channel in the paired guild. The channel
 * is invisible to @everyone via permissionOverwrites.
 */
export async function createAgentDiscordChannel(agent) {
  const adapter = getChannel("discord");
  if (!adapter?.running) throw new Error("Discord adapter not running");

  const container = await getChannelContainer("discord");
  if (!container) throw new Error("No Discord server paired. Use /pairserver inside the target server first.");

  await ensureNoExistingBinding("discord", agent.id);

  const { ChannelType, PermissionsBitField } = await import("discord.js");
  const guild = await adapter.client.guilds.fetch(container.container_id);
  if (!guild) throw new Error(`Discord guild ${container.container_id} not reachable`);

  const name = formatThreadName(agent, "discord");
  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    { id: container.owner_user_id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
    { id: adapter.client.user.id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages, PermissionsBitField.Flags.ReadMessageHistory] },
  ];

  let channel;
  try {
    channel = await guild.channels.create({
      name,
      type: ChannelType.GuildText,
      permissionOverwrites: overwrites,
    });
  } catch (err) {
    throw new Error(`Discord channel create failed: ${err.message}`);
  }

  const conversationId = await getOrCreateAgentConversation(agent.id);
  const manager = getThreadManager("discord", "main");
  await manager.bindThread({
    threadId: channel.id,
    conversationId,
    agentId: agent.id,
    sessionKey: `discord-channel-${channel.id}`,
    ownerUserId: container.owner_user_id,
    ownerUserName: container.owner_user_name,
    metadata: { guild_id: container.container_id, channel_id: channel.id, name },
  });

  log(`[AGENT-THREAD] Discord channel created: agent=${agent.id} guild=${container.container_id} channel=${channel.id} owner=${container.owner_user_id}`);

  return {
    success: true,
    channel: "discord",
    thread_id: channel.id,
    name,
    message: serverMsg().discordChannelCreatedMsg(name),
  };
}

/**
 * Slack — create a private conversations.create channel and invite the owner.
 * Note: workspace owner / admin can still see private channels via export /
 * compliance — surface this in the UI before the operator activates the flag.
 */
export async function createAgentSlackChannel(agent) {
  const adapter = getChannel("slack");
  if (!adapter?.running) throw new Error("Slack adapter not running");

  const container = await getChannelContainer("slack");
  if (!container) throw new Error("No Slack workspace paired. Use /yabbypair inside the target workspace first.");

  await ensureNoExistingBinding("slack", agent.id);

  const name = formatThreadName(agent, "slack");
  let result;
  try {
    result = await adapter.app.client.conversations.create({
      name,
      is_private: true,
    });
  } catch (err) {
    throw new Error(`Slack conversations.create failed: ${err.message}`);
  }

  const channelId = result.channel?.id;
  if (!channelId) throw new Error(`Slack conversations.create returned no channel.id`);

  // Invite the owner — non-fatal if it fails (channel still exists, owner can self-add)
  try {
    await adapter.app.client.conversations.invite({
      channel: channelId,
      users: container.owner_user_id,
    });
  } catch (err) {
    log(`[AGENT-THREAD] Slack invite owner failed (non-fatal): ${err.message}`);
  }

  const conversationId = await getOrCreateAgentConversation(agent.id);
  const manager = getThreadManager("slack", "main");
  await manager.bindThread({
    threadId: channelId,
    conversationId,
    agentId: agent.id,
    sessionKey: `slack-channel-${channelId}`,
    ownerUserId: container.owner_user_id,
    ownerUserName: container.owner_user_name,
    metadata: { workspace_id: container.container_id, channel_id: channelId, name },
  });

  log(`[AGENT-THREAD] Slack channel created: agent=${agent.id} workspace=${container.container_id} channel=${channelId} owner=${container.owner_user_id}`);

  return {
    success: true,
    channel: "slack",
    thread_id: channelId,
    name,
    message: serverMsg().slackChannelCreatedMsg(name),
  };
}

/**
 * Single-entry dispatcher — used by the CLI tool create_agent_thread + the
 * agent-thread routes. Validates the channel arg against the paired
 * containers / running adapters and returns a uniform "available channels"
 * payload when the input is missing or invalid.
 */
export async function createAgentThreadOnChannel(agent, channel) {
  if (!agent?.id) throw new Error("agent.id is required");
  switch (channel) {
    case "telegram": return createAgentTelegramTopic(agent);
    case "discord":  return createAgentDiscordChannel(agent);
    case "slack":    return createAgentSlackChannel(agent);
    default: throw new Error(`Unsupported channel: ${channel}`);
  }
}

export async function listChannelsAvailableForAgentThreads() {
  const supported = ["telegram", "discord", "slack"];
  const available = [];
  for (const c of supported) {
    const adapter = getChannel(c);
    if (!adapter?.running) continue;
    const container = await getChannelContainer(c);
    if (container) available.push(c);
  }
  return available;
}
