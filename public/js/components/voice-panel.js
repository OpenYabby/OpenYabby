/* ═══════════════════════════════════════════════════════
   YABBY — Voice Panel Component
   ═══════════════════════════════════════════════════════
   Manages the bottom-right orb + Yabby chat window.
   The Yabby chat renders as an ac-window (same style as
   agent chats) inside #agentChatsContainer. It cannot be
   closed, only minimized. It always appears rightmost.

   Scroll rules (user spec):
     1. On load, show the last PAGE_SIZE messages.
     2. Once loaded, instant-scroll to the bottom (no animation).
     3. On streaming / new messages: animate only the new bubble,
        and auto-scroll to bottom ONLY if the user is still pinned
        to the bottom. If the user scrolled up, freeze the view.
     4. If the user scrolls near the top, lazy-load the previous
        PAGE_SIZE messages and preserve the exact visual position.
*/

import { state } from '../state.js';
import { api } from '../api.js';
import {
  connect, disconnect, sendTextMessage,
  resumeFromWakeWord, getVoiceState, isTextOnlyMode
} from '../voice.js';
import { t } from '../i18n.js';

let yabbyOpen = false;
const PAGE_SIZE = 10;
// Distance from bottom (px) under which the user is considered "pinned" to the bottom
const STICK_THRESHOLD = 60;
// Distance from top (px) above which a lazy-load is triggered
const LOAD_OLDER_THRESHOLD = 80;

// ──────────────────────────────────────────────────────────────
// Scroll state for the Yabby chat
// ──────────────────────────────────────────────────────────────
// userPinnedBottom : true while the user wants the view to follow
//   new messages. Becomes false the moment the user manually
//   scrolls away from the bottom; becomes true again when they
//   scroll back down.
// isLoadingOlder   : guard while a lazy-load is in flight.
// isProgrammaticScroll : guard so our own scrollTop writes don't
//   flip userPinnedBottom via the scroll handler.
// scrollAnchor     : snapshot of {scrollHeight, scrollTop} taken
//   BEFORE a prepend, restored AFTER the DOM rewrite.
let userPinnedBottom = true;
let isLoadingOlder = false;
let isProgrammaticScroll = false;
let scrollAnchor = null;

export function initVoicePanel() {
  const panel = document.getElementById('voicePanel');
  const orbContainer = document.getElementById('orbContainer');
  const orb = document.getElementById('orb');

  if (!panel || !orb) return;

  // ── Orb click → toggle Yabby chat window ──
  orbContainer?.addEventListener('click', () => {
    yabbyOpen = !yabbyOpen;
    renderYabbyWindow();
  });

  // ── Orb itself → mic action ──
  orb.addEventListener('click', (e) => {
    e.stopPropagation();
    handleMicAction();
  });

  // ── Subscribe to state changes ──
  state.on('voiceStatus', updateOrbState);
  state.on('voiceStatusText', updateStatusText);
  state.on('currentAgent', updateAgentName);
  state.on('chatMessages', onChatMessagesChanged);

  // Initialize with current state
  updateOrbState(state.get('voiceStatus'));
  updateStatusText(state.get('voiceStatusText'));
  // Render the Yabby window (minimized tab on first load since yabbyOpen=false)
  renderYabbyWindow();

  // ── Keyboard shortcut: Ctrl/Cmd+K toggles Yabby window ──
  document.addEventListener('keydown', (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (isMod && e.key === 'k') {
      e.preventDefault();
      yabbyOpen = !yabbyOpen;
      renderYabbyWindow();
      if (yabbyOpen) {
        requestAnimationFrame(() => {
          document.getElementById('voiceInput')?.focus();
        });
      }
    }
  });

  // ── Load Yabby chat history from DB (lazy-load: last PAGE_SIZE only) ──
  api.conversation.getYabbyChat({ limit: PAGE_SIZE, offset: 0 }).then(data => {
    const messages = (data.turns || []).map(t => ({
      role: t.role,
      text: t.text,
      timestamp: t.ts,
      mediaAssetIds: t.mediaAssetIds || [],
      source: t.source || null,
    }));
    // Mark as initial so the render doesn't animate the bubbles
    state.set('yabbyChatMeta', {
      offset: messages.length,
      hasMore: data.hasMore === true,
      loading: false,
    });
    state.set('chatMessages', messages);
  }).catch(err => {
    console.error('[VoicePanel] Failed to load Yabby chat history:', err);
    state.set('yabbyChatMeta', { offset: 0, hasMore: false, loading: false });
  });

  console.log('[VoicePanel] Initialized');
}

/**
 * Programmatically open the Yabby principal chat window.
 * Used by the agents directory tile and any other entry point
 * that wants to focus the main Yabby chat.
 */
export function openYabbyChat() {
  if (!yabbyOpen) {
    yabbyOpen = true;
    renderYabbyWindow();
  }
  requestAnimationFrame(() => {
    document.getElementById('voiceInput')?.focus();
  });
}

// ──────────────────────────────────────────────────────────────
// Scroll helpers
// ──────────────────────────────────────────────────────────────

function getMsgArea() {
  return document.querySelector('.ac-window-yabby #yabbyChatMessages');
}

/** Instantly scroll to the bottom. Does NOT flip userPinnedBottom. */
function scrollToBottomNow(msgArea) {
  if (!msgArea) return;
  isProgrammaticScroll = true;
  msgArea.scrollTop = msgArea.scrollHeight;
  userPinnedBottom = true;
  // Release the guard on the next frame, after the browser emits the scroll event
  requestAnimationFrame(() => {
    isProgrammaticScroll = false;
  });
}

/** Is the user within STICK_THRESHOLD px of the bottom? */
function isNearBottom(msgArea) {
  if (!msgArea) return true;
  return msgArea.scrollHeight - msgArea.scrollTop - msgArea.clientHeight < STICK_THRESHOLD;
}

/** Scroll handler for the Yabby message area. */
function onYabbyScroll(e) {
  const msgArea = e.currentTarget;

  // Ignore our own programmatic scrolls
  if (isProgrammaticScroll) return;
  // Ignore scroll events during a lazy-load (we restore position manually)
  if (isLoadingOlder) return;

  userPinnedBottom = isNearBottom(msgArea);

  // Lazy-load previous messages when user scrolls near the top
  if (
    msgArea.scrollTop < LOAD_OLDER_THRESHOLD &&
    msgArea.scrollHeight > msgArea.clientHeight
  ) {
    loadOlderYabbyMessages();
  }
}

// ──────────────────────────────────────────────────────────────
// Lazy-load older messages (rule 4)
// ──────────────────────────────────────────────────────────────

async function loadOlderYabbyMessages() {
  const meta = state.get('yabbyChatMeta') || { offset: 0, hasMore: false, loading: false };
  if (isLoadingOlder || meta.loading || !meta.hasMore) return;

  const msgArea = getMsgArea();
  if (!msgArea) return;

  isLoadingOlder = true;
  state.set('yabbyChatMeta', { ...meta, loading: true });

  // Snapshot scroll anchor BEFORE the prepend so we can restore
  // the user's exact visual position.
  scrollAnchor = {
    scrollHeight: msgArea.scrollHeight,
    scrollTop: msgArea.scrollTop,
  };

  try {
    const data = await api.conversation.getYabbyChat({
      limit: PAGE_SIZE,
      offset: meta.offset,
    });
    const older = (data.turns || []).map(t => ({
      role: t.role,
      text: t.text,
      timestamp: t.ts,
      mediaAssetIds: t.mediaAssetIds || [],
      source: t.source || null,
    }));

    if (older.length === 0) {
      state.set('yabbyChatMeta', { ...meta, hasMore: false, loading: false });
      scrollAnchor = null;
      isLoadingOlder = false;
      return;
    }

    const current = state.get('chatMessages') || [];
    // Update meta FIRST so onChatMessagesChanged sees the new offset
    state.set('yabbyChatMeta', {
      offset: meta.offset + older.length,
      hasMore: data.hasMore === true && older.length === PAGE_SIZE,
      loading: false,
    });
    // Now prepend — triggers onChatMessagesChanged → prepend branch → restore scroll
    state.set('chatMessages', [...older, ...current]);
  } catch (err) {
    console.error('[VoicePanel] Failed to load older messages:', err);
    state.set('yabbyChatMeta', { ...meta, loading: false });
    scrollAnchor = null;
    isLoadingOlder = false;
  }
}

function handleMicAction() {
  const { connected: isConnected, isSuspended: isSusp } = getVoiceState();
  if (isConnected) {
    disconnect();
  } else if (isSusp && !isTextOnlyMode()) {
    resumeFromWakeWord();
  } else {
    connect();
  }
}

// ──────────────────────────────────────────────────────────────
// Window rendering
// ──────────────────────────────────────────────────────────────

/** Render or update the Yabby chat window inside agentChatsContainer */
function renderYabbyWindow() {
  const container = document.getElementById('agentChatsContainer');
  if (!container) return;

  let yabbyEl = container.querySelector('.ac-window-yabby');

  if (!yabbyOpen) {
    // Show minimized tab
    if (yabbyEl) yabbyEl.remove();
    let minTab = container.querySelector('.ac-minimized-yabby');
    if (!minTab) {
      minTab = document.createElement('div');
      minTab.className = 'ac-minimized ac-minimized-yabby';
      minTab.addEventListener('click', () => {
        yabbyOpen = true;
        renderYabbyWindow();
      });
      // Insert at beginning (rightmost due to row-reverse)
      container.prepend(minTab);
    }
    const status = state.get('voiceStatus') || 'idle';
    const agent = state.get('currentAgent');
    const name = agent ? agent.name : t('voicePanel.defaultName');
    minTab.innerHTML = `
      <span class="ac-status-dot ${status === 'connected' ? 'streaming' : 'idle'}"></span>
      <span class="ac-min-name">${escVP(name)}</span>
      <span class="voice-kbd-hint" style="margin-left:auto;">⌘K</span>
    `;
    return;
  }

  // Remove minimized tab if present
  container.querySelector('.ac-minimized-yabby')?.remove();

  const status = state.get('voiceStatus') || 'idle';
  const agent = state.get('currentAgent');
  const agentName = agent ? agent.name : t('voicePanel.defaultName');
  const txtOnly = isTextOnlyMode();
  const inputPlaceholder = t('voicePanel.inputConnected');
  const micTitle = txtOnly ? t('voicePanel.connectText') : t('voicePanel.speak');
  const micIcon = txtOnly ? '&#9997;' : '&#x1F3A4;';

  const html = `
    <div class="ac-header ac-header-yabby">
      <div class="ac-header-left">
        <span class="ac-status-dot ${status === 'connected' ? 'streaming' : status === 'suspended' ? 'suspended' : 'idle'}"></span>
        <span class="ac-agent-name">${escVP(agentName)}</span>
      </div>
      <div class="ac-header-actions">
        <button class="ac-btn" id="yabbyMinBtn" title="${t('voicePanel.minimize')}">&#8722;</button>
      </div>
    </div>
    <div class="ac-messages" id="yabbyChatMessages"></div>
    <div class="ac-input-row">
      <input type="file" id="yabbyFileInput" multiple accept="image/*,.pdf,.txt,.csv,.json,.xlsx,.docx,.zip" style="display:none">
      <button id="yabbyAttachBtn" title="Attach file" style="background:none;border:none;cursor:pointer;font-size:18px;padding:4px 8px;opacity:0.7">📎</button>
      <input class="ac-input" type="text" id="voiceInput"
        placeholder="${inputPlaceholder}"
        autocomplete="off">
      <button class="ac-send" id="voiceSendBtn">&#9654;</button>
    </div>
    <div class="ac-footer-yabby">
      <button class="mic-btn-mini ${status}" id="micBtn" title="${micTitle}">${micIcon}</button>
      <span class="ac-footer-label" id="micLabel">${escVP(state.get('voiceStatusText') || '')}</span>
      <span class="voice-kbd-hint">⌘K</span>
    </div>
  `;

  if (!yabbyEl) {
    yabbyEl = document.createElement('div');
    yabbyEl.className = 'ac-window ac-window-yabby';
    // Insert at beginning (rightmost due to row-reverse)
    container.prepend(yabbyEl);
  }
  yabbyEl.innerHTML = html;

  // Bind events
  yabbyEl.querySelector('#yabbyMinBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    yabbyOpen = false;
    renderYabbyWindow();
  });

  yabbyEl.querySelector('#micBtn')?.addEventListener('click', () => handleMicAction());

  const sendBtn = yabbyEl.querySelector('#voiceSendBtn');
  const input = yabbyEl.querySelector('#voiceInput');

  sendBtn?.addEventListener('click', () => {
    if (!input.value.trim()) return;
    sendTextMessage(input.value.trim());
    input.value = '';
  });

  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendBtn?.click();
    }
  });

  input?.addEventListener('input', () => {
    if (sendBtn) sendBtn.disabled = !input.value.trim();
  });

  // File upload
  const attachBtn = yabbyEl.querySelector('#yabbyAttachBtn');
  const fileInput = yabbyEl.querySelector('#yabbyFileInput');
  attachBtn?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    if (!fileInput.files?.length) return;
    for (const file of fileInput.files) {
      try {
        const form = new FormData();
        form.append('file', file);
        const resp = await fetch('/api/media/upload', { method: 'POST', body: form });
        const data = await resp.json();
        if (data.assets?.length) {
          const asset = data.assets[0];
          const caption = input?.value?.trim() || file.name;
          sendTextMessage(caption, [asset.id]);
          if (input) input.value = '';
        }
      } catch (err) {
        console.error('[VoicePanel] Upload error:', err);
      }
    }
    fileInput.value = '';
  });

  // Paint the current messages into the empty container, then pin to bottom.
  const msgArea = yabbyEl.querySelector('#yabbyChatMessages');
  if (msgArea) {
    paintAllMessages(msgArea, /* animate */ false);
    msgArea.addEventListener('scroll', onYabbyScroll);
    // Rule 2: on window first render, snap to bottom instantly (no animation).
    userPinnedBottom = true;
    // Defer to next frame so layout has computed scrollHeight
    requestAnimationFrame(() => scrollToBottomNow(msgArea));
  }
}

// ──────────────────────────────────────────────────────────────
// Message painting
// ──────────────────────────────────────────────────────────────

/** Build a message DOM element. `animate` adds a one-shot fade-in. */
function buildMsgEl(m, animate) {
  // Raw task output → collapsed-by-default accordion (web-only bubble — never
  // sent to WhatsApp/Telegram/etc.; status + polished follow-up arrive
  // separately). Markdown is rendered inside so tables, lists, bold, etc.
  // read cleanly when expanded. The `<summary>` ("Voir la sortie brute")
  // is the toggle — closed by default so the timeline stays scannable.
  // Explicit `det.open = false` overrides any browser auto-restore that
  // could carry over the open state from a previous session.
  if (m.role === 'assistant' && m.source === 'task_result_raw' && typeof m.text === 'string') {
    const det = document.createElement('details');
    det.className = `ac-msg ac-msg-raw${animate ? ' ac-msg-appear' : ''}`;
    det.open = false;
    if (m.timestamp != null) det.dataset.ts = String(m.timestamp);
    const label = (t('agentChat.viewRawOutput') || 'View raw output');
    det.innerHTML = `<summary>${label}</summary><div class="ac-raw-body">${renderMd(m.text)}</div>`;
    if (animate) setTimeout(() => det.classList.remove('ac-msg-appear'), 400);
    return det;
  }

  const cls = m.role === 'user' ? 'ac-msg-user' : 'ac-msg-assistant';
  const div = document.createElement('div');
  div.className = `ac-msg ${cls}${m.streaming ? ' ac-msg-streaming' : ''}${animate ? ' ac-msg-appear' : ''}`;
  if (m.timestamp != null) div.dataset.ts = String(m.timestamp);
  let html = renderMd(m.text || '');
  // Render media attachments if present
  if (m.mediaAssetIds && m.mediaAssetIds.length > 0) {
    html += m.mediaAssetIds.map(id =>
      `<div style="margin-top:8px">
        <a href="/api/media/${id}" target="_blank" rel="noopener">
          <img src="/api/media/${id}" alt="media" style="max-width:300px;max-height:300px;border-radius:8px;cursor:pointer"
               onerror="this.parentElement.innerHTML='<a href=/api/media/${id} target=_blank style=color:var(--accent-blue)>📎 File ${id}</a>'" />
        </a>
      </div>`
    ).join('');
  }
  div.innerHTML = html;
  if (animate) {
    setTimeout(() => div.classList.remove('ac-msg-appear'), 400);
  }
  return div;
}

/** Replace the full contents of the message area without animation. */
function paintAllMessages(msgArea, animate) {
  const messages = state.get('chatMessages') || [];
  msgArea.innerHTML = '';
  if (messages.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ac-empty';
    empty.textContent = t('voicePanel.emptyMessages');
    msgArea.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const m of messages) frag.appendChild(buildMsgEl(m, animate));
  msgArea.appendChild(frag);
}

/** React to any change to state.chatMessages with a minimal DOM update. */
function onChatMessagesChanged() {
  if (!yabbyOpen) return;
  const msgArea = getMsgArea();
  if (!msgArea) return; // window not yet rendered

  const messages = state.get('chatMessages') || [];

  // Empty state
  if (messages.length === 0) {
    msgArea.innerHTML = `<div class="ac-empty">${t('voicePanel.emptyMessages')}</div>`;
    userPinnedBottom = true;
    return;
  }

  // Clear any "empty" placeholder
  const empty = msgArea.querySelector('.ac-empty');
  if (empty) empty.remove();

  const existingEls = msgArea.querySelectorAll('.ac-msg');
  const existingCount = existingEls.length;
  const newCount = messages.length;

  // ── Case A: lazy-load prepend (anchor present)
  if (isLoadingOlder && scrollAnchor) {
    // Rebuild the whole list in place (no animation on older messages)
    paintAllMessages(msgArea, /* animate */ false);
    const anchor = scrollAnchor;
    // Restore on the next frame, after the browser has measured the new height.
    // We use isProgrammaticScroll so the restore doesn't flip userPinnedBottom.
    requestAnimationFrame(() => {
      isProgrammaticScroll = true;
      msgArea.scrollTop = msgArea.scrollHeight - anchor.scrollHeight + anchor.scrollTop;
      scrollAnchor = null;
      isLoadingOlder = false;
      requestAnimationFrame(() => {
        isProgrammaticScroll = false;
      });
    });
    return;
  }

  // ── Case B: same count — could be streaming (last mutated in place) OR a
  // shifted window (e.g. WhatsApp pushed new turns while we're in sleep mode,
  // so `handleSSEConversationUpdate` refetched the last N turns and the whole
  // window silently shifted by K messages: the first K dropped off the front
  // and K new ones appeared at the end, but `messages.length` is unchanged).
  // Detect that by verifying every existing DOM element's `data-ts` still
  // matches the state's corresponding timestamp. If not, full rebuild.
  if (newCount === existingCount && existingCount > 0) {
    let windowIntact = true;
    // Check every element EXCEPT the last — the last is allowed to mutate
    // in place during streaming, so its timestamp may legitimately change.
    for (let i = 0; i < existingCount - 1; i++) {
      const stateTs = messages[i]?.timestamp;
      const domTs = existingEls[i]?.dataset?.ts;
      if (stateTs != null && domTs && String(stateTs) !== domTs) {
        windowIntact = false;
        break;
      }
    }
    if (!windowIntact) {
      paintAllMessages(msgArea, /* animate */ false);
      if (userPinnedBottom) scrollToBottomNow(msgArea);
      return;
    }

    const lastEl = existingEls[existingCount - 1];
    const lastMsg = messages[newCount - 1];
    if (lastEl && lastMsg) {
      // task_result_raw bubbles render as <details><summary>…</summary><div class="ac-raw-body">…</div></details>
      // — never overwrite their innerHTML with raw Markdown HTML, that would
      // strip the <summary> + body wrapper and break the toggle. Rebuild the
      // full inner template instead, preserving the <details> shell + open
      // state.
      if (lastEl.classList.contains('ac-msg-raw') && lastMsg.role === 'assistant' && lastMsg.source === 'task_result_raw') {
        const label = (t('agentChat.viewRawOutput') || 'View raw output');
        const newInner = `<summary>${label}</summary><div class="ac-raw-body">${renderMd(lastMsg.text || '')}</div>`;
        if (lastEl.innerHTML !== newInner) lastEl.innerHTML = newInner;
      } else {
        const newHtml = renderMd(lastMsg.text);
        if (lastEl.innerHTML !== newHtml) lastEl.innerHTML = newHtml;
      }
      // Update streaming class if it changed
      const wasStreaming = lastEl.classList.contains('ac-msg-streaming');
      if (wasStreaming && !lastMsg.streaming) {
        lastEl.classList.remove('ac-msg-streaming');
      } else if (!wasStreaming && lastMsg.streaming) {
        lastEl.classList.add('ac-msg-streaming');
      }
      if (lastMsg.timestamp != null) lastEl.dataset.ts = String(lastMsg.timestamp);
    }
    if (userPinnedBottom) scrollToBottomNow(msgArea);
    return;
  }

  // ── Case C: new messages appended at the end
  if (newCount > existingCount) {
    // Detect genuine append vs accidental prepend/reorder.
    // If the existing bubbles' timestamps no longer match the first N state
    // messages, fall back to a full rebuild.
    let isGenuineAppend = true;
    for (let i = 0; i < existingCount; i++) {
      const stateTs = messages[i]?.timestamp;
      const domTs = existingEls[i]?.dataset?.ts;
      if (stateTs != null && domTs && String(stateTs) !== domTs) {
        isGenuineAppend = false;
        break;
      }
    }

    if (!isGenuineAppend) {
      paintAllMessages(msgArea, /* animate */ false);
      if (userPinnedBottom) scrollToBottomNow(msgArea);
      return;
    }

    // Append only the new ones (with one-shot animation)
    const frag = document.createDocumentFragment();
    for (let i = existingCount; i < newCount; i++) {
      frag.appendChild(buildMsgEl(messages[i], /* animate */ true));
    }
    msgArea.appendChild(frag);

    // Keep yabbyChatMeta.offset in sync so future lazy-loads don't refetch.
    const appended = newCount - existingCount;
    const curMeta = state.get('yabbyChatMeta') || { offset: 0, hasMore: false, loading: false };
    if (curMeta.offset != null) {
      // Avoid re-triggering onChatMessagesChanged — this is a separate key.
      state.set('yabbyChatMeta', { ...curMeta, offset: curMeta.offset + appended });
    }

    if (userPinnedBottom) scrollToBottomNow(msgArea);
    return;
  }

  // ── Case D: messages removed or reset → full rebuild
  paintAllMessages(msgArea, /* animate */ false);
  if (userPinnedBottom) scrollToBottomNow(msgArea);
}

// ──────────────────────────────────────────────────────────────
// Markdown + status updaters (unchanged)
// ──────────────────────────────────────────────────────────────

function renderMd(text) {
  if (!text) return '';
  try {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(marked.parse(text));
    }
  } catch {}
  return escVP(text);
}

function updateOrbState(status) {
  const orb = document.getElementById('orb');
  if (orb) orb.className = 'orb ' + (status || 'idle');

  const micBtn = document.getElementById('micBtn');
  const input = document.getElementById('voiceInput');
  const sendBtn = document.getElementById('voiceSendBtn');
  const statusDot = document.querySelector('.ac-window-yabby .ac-status-dot');
  const isConnected = status === 'connected';

  if (micBtn) micBtn.className = `mic-btn-mini ${status || 'idle'}`;
  if (sendBtn) sendBtn.disabled = !(input?.value?.trim());
  if (statusDot) {
    statusDot.className = `ac-status-dot ${isConnected ? 'streaming' : status === 'suspended' ? 'suspended' : 'idle'}`;
  }
  if (input) {
    input.placeholder = t('voicePanel.inputConnected');
  }
}

function updateStatusText(text) {
  const micLabel = document.getElementById('micLabel');
  if (micLabel) micLabel.textContent = text || '';
}

function updateAgentName(agent) {
  // Update in-place — do NOT rebuild the whole window, otherwise
  // scroll state is lost every time the voice session switches agent.
  const name = agent ? agent.name : t('voicePanel.defaultName');
  const nameEl = document.querySelector('.ac-window-yabby .ac-agent-name');
  if (nameEl) nameEl.textContent = name;
  const minNameEl = document.querySelector('.ac-minimized-yabby .ac-min-name');
  if (minNameEl) minNameEl.textContent = name;
}

function escVP(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
