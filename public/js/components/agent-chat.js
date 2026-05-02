/* ═══════════════════════════════════════════════════════
   YABBY — Multi-Agent Chat Windows
   ═══════════════════════════════════════════════════════
   Manages floating chat windows for agent conversations.
   Each agent gets its own window at bottom-right.
   Messages flow: user input → api.tasks.start/continue → SSE → chat.

   Render pipeline (incremental — no full destroy/rebuild):
     - renderChatWindows() does a structural diff: only creates/removes
       windows when the set of open windows changes. Everything else
       is patched in place.
     - updateWindowMessages() is a minimal state machine identical in
       spirit to voice-panel's (empty / lazy-prepend / streaming-mutate /
       append / rebuild). Scroll state is kept per-window inside
       windowScrollState so it survives across state.set() calls.
*/

import { state } from '../state.js';
import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

// Map taskId → agentId for routing SSE events
const taskAgentMap = new Map();

// Buffer for SSE events that arrive before taskAgentMap is set (race condition)
const unmappedBuffer = new Map(); // taskId → [event, event, ...]
const BUFFER_TTL = 30000; // 30s max buffer lifetime

const MAX_VISIBLE_WINDOWS = 4;
const PAGE_SIZE = 10;
const STICK_THRESHOLD = 60;
const LOAD_OLDER_THRESHOLD = 80;

/**
 * Per-window scroll + loading state. Lives outside of `state.agentChats`
 * so setting agentChats doesn't wipe it and so the scroll handler has a
 * single stable object to read/write.
 *   Map<agentId, {
 *     userPinnedBottom: bool,
 *     isLoadingOlder: bool,
 *     isProgrammaticScroll: bool,
 *     scrollAnchor: { scrollHeight, scrollTop } | null
 *   }>
 */
const windowScrollState = new Map();

function getWinState(agentId) {
  let s = windowScrollState.get(agentId);
  if (!s) {
    s = {
      userPinnedBottom: true,
      isLoadingOlder: false,
      isProgrammaticScroll: false,
      scrollAnchor: null,
    };
    windowScrollState.set(agentId, s);
  }
  return s;
}

// ──────────────────────────────────────────────────────────────
// Persistence — save open/minimized chat windows to localStorage
// so they survive a page reload. We ONLY persist UI state
// (agentId, agentName, windowState). Messages are reloaded from
// the server on restore via api.agentChats.get().
// ──────────────────────────────────────────────────────────────

const PERSIST_KEY = 'yabby-agent-chats';

function savePersistedChats() {
  try {
    const chats = state.get('agentChats') || {};
    const minimal = {};
    for (const [id, c] of Object.entries(chats)) {
      // Only persist windows that are actually visible; drop closed ones.
      if (c && (c.windowState === 'open' || c.windowState === 'minimized')) {
        minimal[id] = {
          agentId: c.agentId,
          agentName: c.agentName,
          windowState: c.windowState,
        };
      }
    }
    localStorage.setItem(PERSIST_KEY, JSON.stringify(minimal));
  } catch (err) {
    console.warn('[AgentChat] Failed to save chat state:', err);
  }
}

function loadPersistedChats() {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    console.warn('[AgentChat] Failed to load chat state:', err);
    return null;
  }
}

/** Initialize the agent chat system */
export function initAgentChats() {
  // Listen for SSE task events
  state.addEventListener('sse:task', (e) => handleTaskSSE(e.detail));

  // Listen for preview events routed to agents
  state.addEventListener('sse:preview', (e) => handlePreviewSSE(e.detail));

  // Listen for conversation updates (task results, WhatsApp messages, etc.)
  state.addEventListener('sse:conversation_update', (e) => handleConversationUpdate(e.detail));

  // Re-render + auto-save on every mutation. Hooking savePersistedChats
  // here means every code path that calls state.set('agentChats', ...)
  // automatically persists — no need to sprinkle save calls everywhere.
  state.on('agentChats', () => {
    renderChatWindows();
    savePersistedChats();
  });

  // Restore previously-open chats from localStorage
  restorePersistedChats();

  console.log('[AgentChat] Initialized');
}

/**
 * On page load, rebuild agentChats state from localStorage and fetch
 * each chat's message history. This does NOT block init — the windows
 * render empty first, then fill in as fetches complete.
 */
async function restorePersistedChats() {
  const persisted = loadPersistedChats();
  if (!persisted) return;

  const ids = Object.keys(persisted);
  if (ids.length === 0) return;

  // Seed state so the windows render immediately (even while we fetch).
  const seed = {};
  for (const id of ids) {
    const p = persisted[id];
    seed[id] = {
      agentId: p.agentId,
      agentName: p.agentName,
      windowState: p.windowState,
      unread: 0,
      messages: [],
      conversationId: null,
      streaming: false,
      streamBuffer: '',
      messagesOffset: 0,
      hasMoreHistory: false,
      loadingOlder: false,
    };
  }
  // enforceMaxWindows trims to MAX_VISIBLE_WINDOWS — keep most-recent 4 open,
  // spill the rest to minimized. Pass the first-open id as the "focused" anchor.
  const firstOpen = ids.find(id => seed[id].windowState === 'open');
  if (firstOpen) enforceMaxWindows(seed, firstOpen);
  state.set('agentChats', seed);

  // Fetch history for each restored chat in parallel. Failures are
  // non-fatal (chat just stays empty until user sends a message).
  await Promise.all(ids.map(async (id) => {
    try {
      const data = await api.agentChats.get(id, { limit: PAGE_SIZE, offset: 0 });
      const updated = { ...state.get('agentChats') };
      if (!updated[id]) return; // user closed it during the fetch
      updated[id] = {
        ...updated[id],
        conversationId: data.conversationId,
        messages: (data.turns || []).map(t => ({
          role: t.role,
          content: t.text,
          timestamp: t.ts,
          type: t.mediaAssetIds?.length ? 'media' : 'text',
          mediaAssetIds: t.mediaAssetIds || [],
          source: t.source || null,
        })),
        messagesOffset: (data.turns || []).length,
        hasMoreHistory: data.hasMore === true,
      };
      state.set('agentChats', updated);
    } catch (err) {
      console.error(`[AgentChat] Failed to restore history for ${id}:`, err);
    }
  }));
}

/** Open (or focus) a chat window for an agent */
export async function openAgentChat(agentId, agentName) {
  const chats = { ...state.get('agentChats') };
  const isNew = !chats[agentId];

  if (chats[agentId]) {
    chats[agentId] = { ...chats[agentId], windowState: 'open', unread: 0 };
  } else {
    chats[agentId] = {
      agentId,
      agentName: agentName || agentId,
      windowState: 'open',
      unread: 0,
      messages: [],
      conversationId: null, // Initialize early to avoid race condition
      streaming: false,
      streamBuffer: '',
    };
  }
  enforceMaxWindows(chats, agentId);
  state.set('agentChats', chats);

  // Load chat history AND conversationId IMMEDIATELY (prevents race condition with SSE)
  if (isNew) {
    try {
      // Lazy-load: only the most recent PAGE_SIZE messages
      const data = await api.agentChats.get(agentId, { limit: PAGE_SIZE, offset: 0 });
      const updated = { ...state.get('agentChats') };
      if (updated[agentId]) {
        // CRITICAL: Store conversationId BEFORE any message is sent
        // This ensures SSE conversation_update events can match the chat
        updated[agentId].conversationId = data.conversationId;

        updated[agentId].messages = (data.turns || []).map(t => ({
          role: t.role,
          content: t.text,
          timestamp: t.ts,
          type: t.mediaAssetIds?.length ? 'media' : 'text',
          mediaAssetIds: t.mediaAssetIds || [],
          source: t.source || null,
        }));
        updated[agentId].messagesOffset = updated[agentId].messages.length;
        updated[agentId].hasMoreHistory = data.hasMore === true;
        updated[agentId].loadingOlder = false;
        state.set('agentChats', updated);
      }
    } catch (err) {
      console.error('[AgentChat] Failed to load history:', err);
    }
  }
}

/** Load 10 older messages when user scrolls near top of an agent chat */
async function loadOlderAgentMessages(agentId) {
  const chats = state.get('agentChats') || {};
  const chat = chats[agentId];
  if (!chat || !chat.hasMoreHistory) return;

  const ws = getWinState(agentId);
  if (ws.isLoadingOlder) return;

  const msgArea = document.querySelector(`.ac-window[data-agent-id="${agentId}"] .ac-messages`);
  if (!msgArea) return;

  ws.isLoadingOlder = true;
  // Snapshot scroll anchor BEFORE the prepend so we can restore exactly.
  ws.scrollAnchor = {
    scrollHeight: msgArea.scrollHeight,
    scrollTop: msgArea.scrollTop,
  };

  try {
    const data = await api.agentChats.get(agentId, {
      limit: PAGE_SIZE,
      offset: chat.messagesOffset || 0,
    });
    const older = (data.turns || []).map(t => ({
      role: t.role,
      content: t.text,
      timestamp: t.ts,
      type: t.mediaAssetIds?.length ? 'media' : 'text',
      mediaAssetIds: t.mediaAssetIds || [],
      source: t.source || null,
    }));

    if (older.length === 0) {
      // Nothing more — clear flags
      ws.scrollAnchor = null;
      ws.isLoadingOlder = false;
      const fail = { ...state.get('agentChats') };
      if (fail[agentId]) {
        fail[agentId] = { ...fail[agentId], hasMoreHistory: false };
        state.set('agentChats', fail);
      }
      return;
    }

    const updated = { ...state.get('agentChats') };
    const cur = updated[agentId];
    if (!cur) {
      ws.scrollAnchor = null;
      ws.isLoadingOlder = false;
      return;
    }
    updated[agentId] = {
      ...cur,
      messages: [...older, ...cur.messages],
      messagesOffset: (cur.messagesOffset || 0) + older.length,
      hasMoreHistory: data.hasMore === true && older.length === PAGE_SIZE,
    };
    // updateWindowMessages will detect ws.isLoadingOlder + ws.scrollAnchor
    // and restore scroll, clearing both flags afterwards.
    state.set('agentChats', updated);
  } catch (err) {
    console.error('[AgentChat] Failed to load older messages:', err);
    ws.scrollAnchor = null;
    ws.isLoadingOlder = false;
  }
}

/** Send a chat message to an agent */
export async function sendChatMessage(agentId, text, mediaAssetIds = []) {
  if (!text.trim() && !mediaAssetIds.length) return;

  const chats = { ...state.get('agentChats') };
  const chat = chats[agentId];
  if (!chat) return;

  // Add user message to UI immediately
  chat.messages = [...chat.messages, {
    role: 'user',
    content: text,
    timestamp: Date.now(),
    type: mediaAssetIds.length ? 'media' : 'text',
    mediaAssetIds,
  }];
  chat.messagesOffset = (chat.messagesOffset || 0) + 1;
  chat.streaming = true;
  chat.streamBuffer = '';
  state.set('agentChats', chats);

  try {
    // NEW: Use dedicated agent message endpoint (reuses WhatsApp's working channel handler)
    const result = await api.agents.sendMessage(agentId, text, mediaAssetIds);

    // Add assistant response to UI
    const updatedChats = { ...state.get('agentChats') };
    if (updatedChats[agentId]) {
      // conversationId already set in openAgentChat(), but update if changed (redundant safety)
      if (result.conversationId && !updatedChats[agentId].conversationId) {
        updatedChats[agentId].conversationId = result.conversationId;
      }

      updatedChats[agentId].messages = [...updatedChats[agentId].messages, {
        role: 'assistant',
        content: result.response,
        timestamp: Date.now(),
        type: 'text',
      }];
      updatedChats[agentId].messagesOffset = (updatedChats[agentId].messagesOffset || 0) + 1;
      updatedChats[agentId].streaming = false;
      updatedChats[agentId].streamBuffer = '';
      state.set('agentChats', updatedChats);
    }

  } catch (err) {
    const updated = { ...state.get('agentChats') };
    if (updated[agentId]) {
      updated[agentId] = {
        ...updated[agentId],
        streaming: false,
        messages: [...updated[agentId].messages, {
          role: 'assistant',
          content: `${t('agentChat.errorPrefix')}${err.message}`,
          timestamp: Date.now(),
          type: 'error',
        }],
        messagesOffset: (updated[agentId].messagesOffset || 0) + 1,
      };
      state.set('agentChats', updated);
    }
  }
}

/** Handle SSE task events — route to the correct chat */
function handleTaskSSE(data) {
  const { taskId } = data;
  const agentId = taskAgentMap.get(taskId);

  if (!agentId) {
    // Buffer the event — the mapping may arrive soon (race condition)
    if (!unmappedBuffer.has(taskId)) {
      unmappedBuffer.set(taskId, []);
      // Auto-cleanup after TTL
      setTimeout(() => unmappedBuffer.delete(taskId), BUFFER_TTL);
    }
    unmappedBuffer.get(taskId).push(data);
    return;
  }

  processTaskEvent(data, agentId);
}

/** Process a single SSE task event for a known agentId */
function processTaskEvent(data, agentId) {
  const { taskId, type, detail } = data;

  const chats = { ...state.get('agentChats') };
  const chat = chats[agentId];
  if (!chat) return;

  const updated = { ...chat };

  if ((type === 'claude_text' || type === 'runner_text') && detail?.text) {
    updated.streaming = true;
    updated.streamBuffer = (updated.streamBuffer || '') + detail.text;
  } else if (type === 'result' || type === 'runner_result') {
    // The 'result' event from spawner only has cost/duration, not text.
    // The actual text is in streamBuffer from claude_text events.
    const content = updated.streamBuffer || '';
    if (content) {
      updated.messages = [...updated.messages, {
        role: 'assistant',
        content,
        timestamp: Date.now(),
        type: 'text',
      }];
      updated.messagesOffset = (updated.messagesOffset || 0) + 1;
      // Persist assistant turn to DB
      api.agentChats.addTurn(agentId, 'assistant', content).catch(err =>
        console.error('[AgentChat] Failed to save assistant turn:', err)
      );
    }
    updated.streaming = false;
    updated.streamBuffer = '';
    updated.lastTaskId = taskId;
    updated.activeTaskId = null;
    if (updated.windowState === 'minimized') {
      updated.unread = (updated.unread || 0) + 1;
    }
  } else if (type === 'status') {
    const s = detail?.status;
    if (s === 'done' || s === 'error' || s === 'killed' || s === 'paused') {
      if (updated.streamBuffer) {
        const savedContent = updated.streamBuffer;
        updated.messages = [...updated.messages, {
          role: 'assistant',
          content: savedContent,
          timestamp: Date.now(),
          type: s === 'error' ? 'error' : 'text',
        }];
        updated.messagesOffset = (updated.messagesOffset || 0) + 1;
        // Persist assistant turn to DB
        api.agentChats.addTurn(agentId, 'assistant', savedContent).catch(err =>
          console.error('[AgentChat] Failed to save assistant turn:', err)
        );
      }
      updated.streaming = false;
      updated.streamBuffer = '';
      updated.lastTaskId = taskId;
      updated.activeTaskId = null;
      if (s === 'error' && detail?.error) {
        updated.messages = [...updated.messages, {
          role: 'assistant',
          content: `${t('agentChat.errorPrefix')}${detail.error}`,
          timestamp: Date.now(),
          type: 'error',
        }];
        updated.messagesOffset = (updated.messagesOffset || 0) + 1;
      }
      if (updated.windowState === 'minimized') {
        updated.unread = (updated.unread || 0) + 1;
      }
    }
  } else if (type === 'tool_use' || type === 'runner_tool_use') {
    const toolName = detail?.tool || 'tool';
    updated.messages = [...updated.messages, {
      role: 'system',
      content: toolName,
      timestamp: Date.now(),
      type: 'tool',
    }];
    updated.messagesOffset = (updated.messagesOffset || 0) + 1;
  }

  chats[agentId] = updated;
  state.set('agentChats', chats);
}

/** Enforce max visible windows */
function enforceMaxWindows(chats, keepOpenId) {
  const openIds = Object.keys(chats)
    .filter(id => chats[id].windowState === 'open' && id !== keepOpenId);

  while (openIds.length >= MAX_VISIBLE_WINDOWS) {
    const oldest = openIds.shift();
    chats[oldest] = { ...chats[oldest], windowState: 'minimized' };
  }
}

// ──────────────────────────────────────────────────────────────
// Incremental render pipeline
// ──────────────────────────────────────────────────────────────

/**
 * Reconcile the DOM with `state.agentChats` without destroying windows
 * that are already on screen. Only windows whose visibility changes are
 * created or removed; everything else is patched in place.
 */
function renderChatWindows() {
  const container = document.getElementById('agentChatsContainer');
  if (!container) return;

  const chats = state.get('agentChats') || {};
  const openIds = Object.keys(chats).filter(id => chats[id].windowState === 'open');
  const minimizedIds = Object.keys(chats).filter(id => chats[id].windowState === 'minimized');
  const openSet = new Set(openIds);

  // 1. Remove agent windows whose agent is no longer open (closed or minimized).
  container.querySelectorAll('.ac-window:not(.ac-window-yabby)').forEach(winEl => {
    const id = winEl.dataset.agentId;
    if (!id || !openSet.has(id)) {
      winEl.remove();
      windowScrollState.delete(id);
    }
  });

  // 2. Create newly-opened windows (append — do NOT touch existing ones).
  for (const id of openIds) {
    const chat = chats[id];
    let winEl = container.querySelector(`.ac-window[data-agent-id="${id}"]`);
    if (!winEl) {
      winEl = document.createElement('div');
      winEl.className = 'ac-window';
      winEl.dataset.agentId = id;
      winEl.innerHTML = renderWindowShell(chat);
      // Insert BEFORE the Yabby window so agent windows sit to the left of Yabby
      // (container is flex row-reverse: first child = rightmost).
      const yabbyEl = container.querySelector('.ac-window-yabby');
      const minimizedBar = container.querySelector('.ac-minimized-bar');
      if (yabbyEl) {
        yabbyEl.insertAdjacentElement('afterend', winEl);
      } else if (minimizedBar) {
        container.insertBefore(winEl, minimizedBar);
      } else {
        container.appendChild(winEl);
      }
      bindWindowShellEvents(winEl, id);
      attachScrollHandler(winEl, id);
      // First paint: render all messages + pin to bottom
      const msgArea = winEl.querySelector('.ac-messages');
      if (msgArea) {
        paintAllMessages(msgArea, chat, /* animate */ false);
        const ws = getWinState(id);
        ws.userPinnedBottom = true;
        // Defer so layout is measured
        requestAnimationFrame(() => scrollToBottomNow(msgArea, ws));
      }
    } else {
      // Existing window — patch header state + message list in place.
      updateWindowHeader(winEl, chat);
      updateWindowInputRow(winEl, chat);
      const msgArea = winEl.querySelector('.ac-messages');
      if (msgArea) updateWindowMessages(msgArea, chat, id);
    }
  }

  // 3. Render / update the minimized bar.
  renderMinimizedBar(container, minimizedIds.map(id => chats[id]));
}

/** Build the window shell HTML (header + messages container + input + footer). */
function renderWindowShell(chat) {
  const isStreaming = chat.streaming;
  const isBusy = !!chat.activeTaskId;
  return `
    <div class="ac-header">
      <div class="ac-header-left">
        <span class="ac-status-dot ${isStreaming ? 'streaming' : 'idle'}"></span>
        <span class="ac-agent-name">${esc(chat.agentName)}</span>
      </div>
      <div class="ac-header-actions">
        <button class="ac-btn" data-action="minimize" data-agent-id="${chat.agentId}" title="${t('agentChat.minimize')}">&#8722;</button>
        <button class="ac-btn ac-btn-close" data-action="close" data-agent-id="${chat.agentId}" title="${t('agentChat.close')}">&times;</button>
      </div>
    </div>
    <div class="ac-messages"></div>
    <div class="ac-input-row">
      <input type="file" class="ac-file-input" data-agent-id="${chat.agentId}" multiple accept="image/*,.pdf,.txt,.csv,.json,.xlsx,.docx,.zip" style="display:none">
      <button class="ac-attach" data-agent-id="${chat.agentId}" ${isBusy ? 'disabled' : ''} title="Attach file" style="background:none;border:none;cursor:pointer;font-size:18px;padding:4px 8px;opacity:0.7">📎</button>
      <input class="ac-input" type="text" data-agent-id="${chat.agentId}"
        placeholder="${isBusy ? t('agentChat.waitingResponse') : t('agentChat.writeMessage')}"
        ${isBusy ? 'disabled' : ''} autocomplete="off">
      <button class="ac-send" data-agent-id="${chat.agentId}" ${isBusy ? 'disabled' : ''}>&#9654;</button>
    </div>`;
}

/** Update only the header (agent name, streaming dot) in place. */
function updateWindowHeader(winEl, chat) {
  const nameEl = winEl.querySelector('.ac-header .ac-agent-name');
  if (nameEl && nameEl.textContent !== chat.agentName) nameEl.textContent = chat.agentName;
  const dot = winEl.querySelector('.ac-header .ac-status-dot');
  if (dot) {
    const want = chat.streaming ? 'streaming' : 'idle';
    if (!dot.classList.contains(want)) {
      dot.classList.remove('streaming', 'idle');
      dot.classList.add(want);
    }
  }
}

/** Update input row disabled state in place. */
function updateWindowInputRow(winEl, chat) {
  const isBusy = !!chat.activeTaskId;
  const input = winEl.querySelector('.ac-input-row .ac-input');
  const sendBtn = winEl.querySelector('.ac-input-row .ac-send');
  if (input) {
    input.disabled = isBusy;
    input.placeholder = isBusy ? t('agentChat.waitingResponse') : t('agentChat.writeMessage');
  }
  if (sendBtn) sendBtn.disabled = isBusy;
}

/** Render / update the minimized bar. Only rebuilt if the set/state differs. */
function renderMinimizedBar(container, minimized) {
  let bar = container.querySelector('.ac-minimized-bar');
  if (minimized.length === 0) {
    if (bar) bar.remove();
    return;
  }
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'ac-minimized-bar';
    container.appendChild(bar);
  }
  // Build a signature so we only rewrite when it actually changes
  const sig = minimized.map(c =>
    `${c.agentId}|${c.streaming ? 1 : 0}|${c.unread || 0}|${esc(c.agentName)}`
  ).join(';');
  if (bar.dataset.sig !== sig) {
    bar.dataset.sig = sig;
    bar.innerHTML = minimized.map(c => renderMinimizedTab(c)).join('');
    bindMinimizedBarEvents(bar);
  }
}

// ──────────────────────────────────────────────────────────────
// Scroll helpers (per-window)
// ──────────────────────────────────────────────────────────────

function scrollToBottomNow(msgArea, ws) {
  if (!msgArea) return;
  ws.isProgrammaticScroll = true;
  msgArea.scrollTop = msgArea.scrollHeight;
  ws.userPinnedBottom = true;
  requestAnimationFrame(() => { ws.isProgrammaticScroll = false; });
}

function isNearBottom(msgArea) {
  if (!msgArea) return true;
  return msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight < STICK_THRESHOLD;
}

function attachScrollHandler(winEl, agentId) {
  const msgArea = winEl.querySelector('.ac-messages');
  if (!msgArea) return;
  const ws = getWinState(agentId);
  msgArea.addEventListener('scroll', () => {
    if (ws.isProgrammaticScroll || ws.isLoadingOlder) return;
    ws.userPinnedBottom = isNearBottom(msgArea);
    if (
      msgArea.scrollTop < LOAD_OLDER_THRESHOLD &&
      msgArea.scrollHeight > msgArea.clientHeight
    ) {
      loadOlderAgentMessages(agentId);
    }
  });
}

// ──────────────────────────────────────────────────────────────
// Message painting (incremental)
// ──────────────────────────────────────────────────────────────

/** Build a single message DOM element from a message object. */
function buildMsgEl(msg, animate) {
  const wrap = document.createElement('div');
  wrap.innerHTML = renderMessage(msg);
  const el = wrap.firstElementChild;
  if (!el) {
    const fallback = document.createElement('div');
    fallback.className = 'ac-msg ac-msg-assistant';
    return fallback;
  }
  if (msg.timestamp != null) el.dataset.ts = String(msg.timestamp);
  if (animate) {
    el.classList.add('ac-msg-appear');
    setTimeout(() => el.classList.remove('ac-msg-appear'), 400);
  }
  return el;
}

/** Rebuild the entire message area contents. */
function paintAllMessages(msgArea, chat, animate) {
  const messages = chat.messages || [];
  msgArea.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const m of messages) frag.appendChild(buildMsgEl(m, animate));
  // Streaming indicator
  if (chat.streaming && chat.streamBuffer) {
    const div = document.createElement('div');
    div.innerHTML = renderStreamingMessage(chat.streamBuffer);
    const el = div.firstElementChild;
    if (el) frag.appendChild(el);
  } else if (chat.streaming && !chat.streamBuffer) {
    const typing = document.createElement('div');
    typing.className = 'ac-typing';
    typing.innerHTML = '<span></span><span></span><span></span>';
    frag.appendChild(typing);
  }
  msgArea.appendChild(frag);
}

/** Minimal state machine — mirrors voice-panel's updateChatMessages. */
function updateWindowMessages(msgArea, chat, agentId) {
  const ws = getWinState(agentId);
  const messages = chat.messages || [];

  // Case A: lazy-load in progress → rebuild then restore anchor.
  if (ws.isLoadingOlder && ws.scrollAnchor) {
    const anchor = ws.scrollAnchor;
    paintAllMessages(msgArea, chat, /* animate */ false);
    requestAnimationFrame(() => {
      ws.isProgrammaticScroll = true;
      msgArea.scrollTop = msgArea.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
      ws.scrollAnchor = null;
      ws.isLoadingOlder = false;
      requestAnimationFrame(() => { ws.isProgrammaticScroll = false; });
    });
    return;
  }

  // Collect current committed message DOM nodes (exclude streaming indicator)
  const allBubbles = msgArea.querySelectorAll('.ac-msg, .ac-task-notification');
  const committedEls = [];
  for (const el of allBubbles) {
    if (el.classList.contains('ac-msg-streaming-live')) continue;
    committedEls.push(el);
  }
  const existingCount = committedEls.length;
  const newCount = messages.length;

  // Determine if the tail-aligned existing bubbles match `messages`.
  // We compare timestamps when available. If anything is out of order,
  // fall back to a full rebuild (rare — happens e.g. on conversation reload).
  let isGenuineAppend = true;
  if (existingCount > 0) {
    for (let i = 0; i < Math.min(existingCount, newCount); i++) {
      const domTs = committedEls[i]?.dataset?.ts;
      const stateTs = messages[i]?.timestamp;
      if (domTs && stateTs != null && String(stateTs) !== domTs) {
        isGenuineAppend = false;
        break;
      }
    }
  }
  if (!isGenuineAppend || newCount < existingCount) {
    // Full rebuild (no animation — old messages already seen).
    paintAllMessages(msgArea, chat, /* animate */ false);
    if (ws.userPinnedBottom) scrollToBottomNow(msgArea, ws);
    updateStreamingBubble(msgArea, chat, ws);
    return;
  }

  // Append any new messages at the tail (with one-shot animation).
  if (newCount > existingCount) {
    // Remove any transient streaming/typing nodes before appending
    msgArea.querySelectorAll('.ac-msg-streaming-live, .ac-typing').forEach(el => el.remove());
    const frag = document.createDocumentFragment();
    for (let i = existingCount; i < newCount; i++) {
      frag.appendChild(buildMsgEl(messages[i], /* animate */ true));
    }
    msgArea.appendChild(frag);
    if (ws.userPinnedBottom) scrollToBottomNow(msgArea, ws);
  }

  // Always reconcile the streaming bubble (mutate / add / remove) in place.
  updateStreamingBubble(msgArea, chat, ws);
}

/**
 * Reconcile the transient streaming-message bubble (or typing indicator)
 * with chat.streaming / chat.streamBuffer. Marked with .ac-msg-streaming-live
 * so the committed-message diff can skip it.
 */
function updateStreamingBubble(msgArea, chat, ws) {
  const existing = msgArea.querySelector('.ac-msg-streaming-live, .ac-typing');

  if (!chat.streaming) {
    if (existing) existing.remove();
    return;
  }

  if (chat.streamBuffer) {
    // Streaming text available → render / update streaming bubble
    if (existing && existing.classList.contains('ac-msg-streaming-live')) {
      const newHtml = renderMarkdown(chat.streamBuffer);
      // Preserve the cursor span at the end
      existing.innerHTML = newHtml + '<span class="ac-cursor"></span>';
    } else {
      if (existing) existing.remove();
      const wrap = document.createElement('div');
      wrap.innerHTML = renderStreamingMessage(chat.streamBuffer);
      const el = wrap.firstElementChild;
      if (el) {
        el.classList.add('ac-msg-streaming-live');
        msgArea.appendChild(el);
      }
    }
    if (ws.userPinnedBottom) scrollToBottomNow(msgArea, ws);
  } else {
    // Streaming but no buffer yet → show typing indicator
    if (!existing || !existing.classList.contains('ac-typing')) {
      if (existing) existing.remove();
      const typing = document.createElement('div');
      typing.className = 'ac-typing';
      typing.innerHTML = '<span></span><span></span><span></span>';
      msgArea.appendChild(typing);
      if (ws.userPinnedBottom) scrollToBottomNow(msgArea, ws);
    }
  }
}

// ──────────────────────────────────────────────────────────────
// Render helpers (unchanged from previous version, returning HTML strings)
// ──────────────────────────────────────────────────────────────

function renderMinimizedTab(chat) {
  return `
    <div class="ac-minimized" data-agent-id="${chat.agentId}" data-action="restore">
      <span class="ac-status-dot ${chat.streaming ? 'streaming' : 'idle'}"></span>
      <span class="ac-min-name">${esc(chat.agentName)}</span>
      ${chat.unread > 0 ? `<span class="ac-badge">${chat.unread}</span>` : ''}
      <button class="ac-btn ac-btn-close ac-min-close" data-action="close" data-agent-id="${chat.agentId}">&times;</button>
    </div>`;
}

function renderMessage(msg) {
  if (msg.type === 'tool') {
    return `<div class="ac-msg ac-msg-tool"><span class="ac-tool-icon">&#9881;</span> ${esc(msg.content)}</div>`;
  }

  if (msg.type === 'preview' && typeof msg.content === 'object') {
    return renderChatPreviewBlock(msg.content);
  }

  // Raw task output → collapsed-by-default accordion (web-only bubble —
  // never sent to WhatsApp/Telegram/etc.; status + polished follow-up
  // arrive separately). Markdown is rendered (bold, lists, inline code,
  // etc.) so the raw output reads cleanly when expanded.
  if (msg.role === 'assistant' && msg.source === 'task_result_raw' && typeof msg.content === 'string') {
    return `<details class="ac-msg ac-msg-raw"><summary>${esc(t('agentChat.viewRawOutput') || 'View raw output')}</summary><div class="ac-raw-body">${renderMarkdown(msg.content)}</div></details>`;
  }

  // Detect task completion notification (starts with "Le directeur X a terminé" / "Director X finished")
  if (msg.role === 'assistant' && msg.content && typeof msg.content === 'string' && msg.content.match(/^(Le directeur|Director) .+ (a terminé|finished) \(\d+s\)\./)) {
    return renderTaskNotification(msg);
  }

  const cls = msg.role === 'user' ? 'ac-msg-user' : msg.type === 'error' ? 'ac-msg-error' : 'ac-msg-assistant';
  const content = msg.role === 'user' ? esc(msg.content) : renderMarkdown(msg.content);

  // Render media attachments if present
  let mediaHtml = '';
  if (msg.mediaAssetIds && msg.mediaAssetIds.length > 0) {
    mediaHtml = msg.mediaAssetIds.map(id =>
      `<div class="ac-msg-media" style="margin-top:8px">
        <a href="/api/media/${esc(id)}" target="_blank" rel="noopener">
          <img src="/api/media/${esc(id)}" alt="media" style="max-width:300px;max-height:300px;border-radius:8px;cursor:pointer"
               onerror="this.parentElement.innerHTML='<a href=/api/media/${esc(id)} target=_blank style=color:var(--accent-blue)>📎 File ${esc(id)}</a>'" />
        </a>
      </div>`
    ).join('');
  }

  return `<div class="ac-msg ${cls}">${content}${mediaHtml}</div>`;
}

/** Render task completion notification as a clickable card */
function renderTaskNotification(msg) {
  // Extract task info from message: "Le directeur X a terminé (20s). CONTENT..." / "Director X finished (20s). CONTENT..."
  const match = msg.content.match(/^(?:Le directeur|Director) (.+) (?:a terminé|finished) \((\d+)s\)\.\s*(.*)/s);
  if (!match) {
    // Fallback to normal rendering if pattern doesn't match
    return `<div class="ac-msg ac-msg-assistant">${renderMarkdown(msg.content)}</div>`;
  }

  const [, agentName, duration, result] = match;

  // Extract first line as preview (strip markdown)
  const lines = result.split('\n').filter(l => l.trim());
  let preview = '';

  // Find first meaningful line (skip headers, separators)
  for (const line of lines) {
    const clean = line.replace(/^#+\s*|[\|#\-\*_]/g, '').trim();
    if (clean.length > 10) {
      preview = clean.slice(0, 80) + (clean.length > 80 ? '...' : '');
      break;
    }
  }

  if (!preview) {
    preview = t('agentChat.taskCompletedSuccess');
  }

  return `
    <div class="ac-task-notification">
      <div class="ac-task-header">
        <span class="ac-task-icon">✅</span>
        <div class="ac-task-info">
          <div class="ac-task-title">${esc(agentName)} ${t('agentChat.hasFinished')}</div>
          <div class="ac-task-meta">${esc(duration)}s</div>
        </div>
      </div>
      <div class="ac-task-preview">${esc(preview)}</div>
      <div class="ac-task-hint">${t('agentChat.taskHint')}</div>
    </div>
  `;
}

function renderStreamingMessage(buffer) {
  return `<div class="ac-msg ac-msg-assistant ac-msg-streaming">${renderMarkdown(buffer)}<span class="ac-cursor"></span></div>`;
}

function renderMarkdown(text) {
  if (!text) return '';
  try {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(marked.parse(text));
    }
  } catch {}
  return esc(text);
}

// ──────────────────────────────────────────────────────────────
// Event binding (scoped to a single window / the minimized bar)
// ──────────────────────────────────────────────────────────────

function bindWindowShellEvents(winEl, agentId) {
  // Header action buttons (minimize / close)
  winEl.querySelectorAll('.ac-header [data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const chats = { ...state.get('agentChats') };
      if (!chats[agentId]) return;
      if (action === 'minimize') {
        chats[agentId] = { ...chats[agentId], windowState: 'minimized' };
      } else if (action === 'close') {
        chats[agentId] = { ...chats[agentId], windowState: 'closed' };
      }
      state.set('agentChats', chats);
    });
  });

  // File upload
  const attachBtn = winEl.querySelector('.ac-attach');
  const fileInput = winEl.querySelector('.ac-file-input');
  attachBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    if (!fileInput.files?.length) return;
    const input = winEl.querySelector('.ac-input');
    for (const file of fileInput.files) {
      try {
        const form = new FormData();
        form.append('file', file);
        const resp = await fetch('/api/media/upload', { method: 'POST', body: form });
        const data = await resp.json();
        if (data.assets?.length) {
          const asset = data.assets[0];
          const caption = input?.value?.trim() || file.name;
          await sendChatMessage(agentId, `[file: ${file.name}] ${caption}`, [asset.id]);
          if (input) input.value = '';
        }
      } catch (err) {
        console.error('[agent-chat] Upload error:', err);
      }
    }
    fileInput.value = '';
  });

  // Send button
  const sendBtn = winEl.querySelector('.ac-send');
  const input = winEl.querySelector('.ac-input');
  sendBtn?.addEventListener('click', () => {
    if (input && input.value.trim()) {
      sendChatMessage(agentId, input.value.trim());
      input.value = '';
    }
  });
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (input.value.trim()) {
        sendChatMessage(agentId, input.value.trim());
        input.value = '';
      }
    }
  });

  // Preview toggles (delegated because preview blocks are added dynamically)
  winEl.addEventListener('click', (e) => {
    const toggle = e.target.closest?.('.pv-toggle');
    if (toggle) {
      e.stopPropagation();
      const block = toggle.closest('.pv-block');
      if (block) block.classList.toggle('collapsed');
      return;
    }
    const header = e.target.closest?.('.pv-header');
    if (header && !e.target.closest('.pv-btn')) {
      const block = header.closest('.pv-block');
      if (block) block.classList.toggle('collapsed');
    }
  });
}

function bindMinimizedBarEvents(bar) {
  bar.querySelectorAll('.ac-minimized').forEach(tab => {
    tab.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="close"]')) {
        e.stopPropagation();
        const agentId = tab.dataset.agentId;
        const chats = { ...state.get('agentChats') };
        if (chats[agentId]) {
          chats[agentId] = { ...chats[agentId], windowState: 'closed' };
          state.set('agentChats', chats);
        }
        return;
      }
      const agentId = tab.dataset.agentId;
      const chats = { ...state.get('agentChats') };
      if (!chats[agentId]) return;
      chats[agentId] = { ...chats[agentId], windowState: 'open', unread: 0 };
      enforceMaxWindows(chats, agentId);
      state.set('agentChats', chats);
    });
  });
}

/** Handle preview SSE events routed to agent chats */
function handlePreviewSSE(data) {
  if (data.event !== 'push' || !data.block?.agentId) return;

  const agentId = data.block.agentId;
  const chats = { ...state.get('agentChats') };
  const chat = chats[agentId];
  if (!chat) return;

  const updated = { ...chat };
  updated.messages = [...updated.messages, {
    role: 'assistant',
    content: data.block,
    timestamp: Date.now(),
    type: 'preview',
  }];
  updated.messagesOffset = (updated.messagesOffset || 0) + 1;

  if (updated.windowState === 'minimized') {
    updated.unread = (updated.unread || 0) + 1;
  }

  chats[agentId] = updated;
  state.set('agentChats', chats);
}

/**
 * Handle conversation_update SSE events to reload agent chat in real-time.
 * This fixes the "empty bubble" issue when task results arrive after initial response.
 */
async function handleConversationUpdate(data) {
  const { conversationId, turnCount } = data;

  const chats = state.get('agentChats') || {};

  // Find agent chat with this conversationId
  const agentId = Object.keys(chats).find(id => chats[id]?.conversationId === conversationId);
  if (!agentId) {
    console.log('[AgentChat] Conversation update for unknown agent:', conversationId);
    return;
  }

  const chat = chats[agentId];
  console.log(`[AgentChat] Conversation update for ${chat.agentName}: ${turnCount} turns`);

  try {
    // Reload only the window the user has loaded — NOT the full history.
    // This preserves lazy-load state and avoids loading thousands of turns on long conversations.
    const desiredLimit = Math.max(PAGE_SIZE, chat.messages?.length || PAGE_SIZE);
    const conversation = await api.agentChats.get(agentId, { limit: desiredLimit, offset: 0 });

    if (!conversation || !conversation.turns) {
      console.error('[AgentChat] Invalid conversation data received');
      return;
    }

    // Update messages array with new turns
    const updated = { ...chat };
    updated.messages = conversation.turns.map(turn => ({
      role: turn.role,
      content: turn.text,
      timestamp: turn.ts || Date.now(),
      type: turn.mediaAssetIds?.length ? 'media' : 'text',
      mediaAssetIds: turn.mediaAssetIds || [],
      source: turn.source || null,
    }));
    updated.messagesOffset = updated.messages.length;
    updated.hasMoreHistory = conversation.hasMore === true;

    // Stop streaming indicator if it was active
    updated.streaming = false;

    // Increment unread if minimized
    if (updated.windowState === 'minimized') {
      updated.unread = (updated.unread || 0) + 1;
    }

    const newChats = { ...state.get('agentChats') };
    newChats[agentId] = updated;
    state.set('agentChats', newChats);

    console.log(`[AgentChat] Reloaded ${chat.agentName} conversation (${updated.messages.length} messages)`);
  } catch (err) {
    console.error('[AgentChat] Error reloading conversation:', err);
  }
}

/** Render a compact preview block inside an agent chat */
function renderChatPreviewBlock(block) {
  const lines = (block.content || '').split('\n').length;
  const collapsed = lines > 5 ? 'collapsed' : '';
  const typeIcons = { html: '&#x1F310;', code: '&#x1F4BB;', markdown: '&#x1F4DD;' };
  const typeLabels = { html: 'HTML', code: block.language || 'Code', markdown: 'Markdown' };

  function escCodeChat(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escAttrChat(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  let inner;
  if (block.type === 'html') {
    inner = `<iframe class="pv-iframe pv-iframe-chat" sandbox="allow-scripts" srcdoc="${escAttrChat(block.content)}"></iframe>`;
  } else if (block.type === 'code') {
    const langClass = block.language ? `language-${esc(block.language)}` : '';
    inner = `<pre class="pv-code pv-code-chat"><code class="${langClass}">${escCodeChat(block.content)}</code></pre>`;
  } else {
    inner = `<div class="pv-markdown pv-markdown-chat">${renderMarkdown(block.content)}</div>`;
  }

  return `<div class="ac-msg ac-msg-preview pv-block ${collapsed}" data-block-id="${block.id}" data-type="${block.type}">
    <div class="pv-header pv-header-chat">
      <span class="pv-type-icon">${typeIcons[block.type] || ''}</span>
      <span class="pv-title">${esc(block.title || typeLabels[block.type])}</span>
      <button class="pv-btn pv-toggle" title="Toggle">
        <svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>
      </button>
    </div>
    <div class="pv-content">${inner}</div>
  </div>`;
}
