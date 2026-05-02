/* ═══════════════════════════════════════════════════════
   Channel Message Normalization
   ═══════════════════════════════════════════════════════
   Unified message format across all channel adapters.
*/

/**
 * @typedef {Object} MediaRef
 * @property {"image"|"pdf"|"audio"|"video"|"file"} kind
 * @property {string} mime
 * @property {string} platformRef
 *   Platform-specific download handle (Telegram file_id, Discord URL,
 *   Baileys message envelope, Slack url_private, signal-cli path, etc.).
 *   Opaque to shared code — only the owning adapter knows how to resolve it.
 * @property {string|null} filename
 * @property {number|null} sizeBytes
 * @property {string|null} assetId
 *   Filled in AFTER download-attachment.js stores the bytes. Before that,
 *   null. Handler code should treat null as "not yet downloaded".
 */

/**
 * @typedef {Object} NormalizedMessage
 * @property {string} channelName - 'telegram', 'slack', 'discord'
 * @property {string} channelId - Platform chat/channel ID
 * @property {string} userId - Platform user ID
 * @property {string} userName - Display name
 * @property {string} text - Message text content
 * @property {boolean} isGroup - Whether from a group chat
 * @property {string|null} threadId - Thread ID (if threaded)
 * @property {string|null} replyTo - ID of message being replied to
 * @property {string|null} platformMsgId - Original platform message ID
 * @property {boolean} isAudio - Whether this was a voice/audio message
 * @property {string|null} targetAgentId - Route to specific agent (if bound)
 * @property {MediaRef[]} attachments - Inbound images/PDFs/docs (always an array, possibly empty)
 * @property {string|null} userLang - 2-letter locale hint from the platform (e.g. 'en', 'fr')
 */

/**
 * Create a normalized message object.
 */
export function normalize({
  channelName,
  channelId,
  userId,
  userName = "",
  text = "",
  isGroup = false,
  threadId = null,
  replyTo = null,
  platformMsgId = null,
  isAudio = false,
  targetAgentId = null,
  attachments = [],
  userLang = null,
}) {
  return {
    channelName,
    channelId: String(channelId),
    userId: String(userId),
    userName: userName || "Unknown",
    text: (text || "").trim(),
    isGroup,
    threadId: threadId ? String(threadId) : null,
    replyTo: replyTo ? String(replyTo) : null,
    platformMsgId: platformMsgId ? String(platformMsgId) : null,
    isAudio,
    targetAgentId: targetAgentId || null,
    attachments: Array.isArray(attachments) ? attachments : [],
    userLang: userLang ? String(userLang).toLowerCase().slice(0, 5) : null,
  };
}
