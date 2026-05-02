/* ═══════════════════════════════════════════════════════
   YABBY — Channels View
   ═══════════════════════════════════════════════════════
   Manage messaging channels (Telegram, Slack, Discord).
   View conversations, dead letters, and configuration.
*/

import { api } from '../api.js';
import { esc, formatRelative, statusBadgeClass, statusLabel, statusDotClass } from '../utils.js';
import { showToast } from './toast.js';
import { t, getLocale } from '../i18n.js';

let activeTab = 'overview';
let refreshInterval = null;
let isRendering = false;
let qrVisible = false; // Track if QR code is being displayed

export async function render(container) {
  container.innerHTML = `
    <div class="settings">
      <div class="settings-header">
        <h2 class="settings-title">${t('channels.title')}</h2>
      </div>

      <div class="tabs" id="channelTabs">
        <span class="tab active" data-tab="overview">${t('channels.overview')}</span>
        <span class="tab" data-tab="threads">${t('channels.whatsappThreads')}</span>
        <span class="tab" data-tab="conversations">${t('channels.conversations')}</span>
        <span class="tab" data-tab="deadletters">${t('channels.errors')}</span>
        <span class="tab" data-tab="config">${t('channels.config')}</span>
      </div>

      <div id="channelContent" class="settings-content">
        <div class="settings-loading">${t('common.loading')}</div>
      </div>
    </div>
  `;

  document.getElementById('channelTabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    activeTab = tab.dataset.tab;
    document.querySelectorAll('#channelTabs .tab').forEach(tb => tb.classList.remove('active'));
    tab.classList.add('active');
    renderTab();
  });

  await renderTab();
}

async function renderTab() {
  const el = document.getElementById('channelContent');
  if (!el) return;

  // Clear any existing refresh interval
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }

  el.innerHTML = `<div class="settings-loading">${t('common.loading')}</div>`;

  try {
    switch (activeTab) {
      case 'overview':
        await renderOverview(el);
        // Auto-refresh overview every 2 seconds to show connection state changes
        refreshInterval = setInterval(async () => {
          if (activeTab === 'overview' && document.getElementById('channelContent') && !qrVisible) {
            await renderOverview(el);
          }
        }, 2000);
        break;
      case 'threads': await renderThreads(el); break;
      case 'conversations': await renderConversations(el); break;
      case 'deadletters': await renderDeadLetters(el); break;
      case 'config': await renderConfig(el); break;
    }
  } catch (err) {
    el.innerHTML = `<div class="settings-error">${t('common.error')}: ${esc(err.message)}</div>`;
  }
}

const CHANNEL_META = {
  web:      { name: 'Web',      icon: '🌐', color: 'var(--accent-cyan)' },
  telegram: { name: 'Telegram', icon: '✈️', color: 'var(--accent-blue)' },
  slack:    { name: 'Slack',    icon: '#',   color: 'var(--accent-purple)' },
  discord:  { name: 'Discord',  icon: '🎮', color: 'var(--accent-cyan)' },
  whatsapp: { name: 'WhatsApp', icon: '💬', color: 'var(--accent-green)' },
  signal:   { name: 'Signal',   icon: '🔒', color: 'var(--accent-blue)' },
};

// ── Overview ──

async function renderOverview(el) {
  // Prevent concurrent renders
  if (isRendering) return;
  isRendering = true;

  try {
    const channels = await api.channels.list();
    let pairings = {};
    try {
      const resp = await fetch('/api/channels/pairings');
      if (resp.ok) pairings = await resp.json();
    } catch {}
    const PAIRABLE = new Set(['telegram', 'discord', 'slack', 'signal']);

  el.innerHTML = `
    <div class="settings-sections">
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4h14M2 9h14M2 14h14"/></svg>
          <h3>${t('channels.available')}</h3>
        </div>
        <div class="provider-grid">
          ${Object.entries(channels).map(([key, info]) => {
            const meta = CHANNEL_META[key] || { name: key, icon: '?', color: 'var(--text-muted)' };
            const pairing = pairings[key];
            const isPairable = PAIRABLE.has(key);
            return `
              <div class="provider-card ${info.running ? 'provider-enabled' : ''}">
                <div class="provider-card-top">
                  <div class="provider-indicator" style="background: ${info.running ? meta.color : 'var(--text-disabled)'}"></div>
                  <div class="provider-info">
                    <span class="provider-name">${meta.icon} ${esc(meta.name)}</span>
                    <span class="provider-env">${info.config?.dmPolicy || 'open'} · ${info.config?.hasToken ? t('channels.tokenConfigured') : t('channels.noToken')}</span>
                  </div>
                  <span class="badge ${info.running ? 'badge-running' : info.enabled ? 'badge-paused' : 'badge-killed'}">${info.running ? t('status.online') : info.enabled ? t('status.stopped') : t('status.disabled')}</span>
                </div>
                ${isPairable && info.enabled ? `
                  <div class="pairing-status" style="padding:var(--space-xs) 0;font-size:var(--text-sm)">
                    ${pairing?.paired
                      ? `<span style="color:var(--accent-green)">🔒 Paired with ${esc(pairing.owner?.userName || pairing.owner?.userId || 'user')}</span>`
                      : pairing?.pendingCode
                        ? `<span style="color:var(--accent-orange)">⏳ Awaiting pairing — send this code to the bot:<br><code style="font-size:var(--text-base);padding:4px 8px;background:var(--surface-2);border-radius:4px;display:inline-block;margin-top:4px;user-select:all">${esc(pairing.pendingCode.code)}</code> <span style="color:var(--text-muted)">(${Math.floor(pairing.pendingCode.ttlSeconds/60)}m ${pairing.pendingCode.ttlSeconds%60}s)</span></span>`
                        : `<span style="color:var(--accent-orange)">🔓 Unpaired — bot will ignore all messages until paired</span>`
                    }
                  </div>
                ` : ''}
                ${info.enabled ? `
                  <div class="provider-actions">
                    ${isPairable && !pairing?.paired ? `
                      <button class="btn btn-sm btn-primary" data-pair="${key}">🔑 ${pairing?.pendingCode ? 'New Code' : 'Pair Device'}</button>
                    ` : ''}
                    ${isPairable && pairing?.paired ? `
                      <button class="btn btn-sm btn-warning" data-unpair="${key}">🔓 Unpair</button>
                    ` : ''}
                    ${info.connectionState === 'connected' ? `
                      <button class="btn btn-sm btn-danger" data-disconnect="${key}">\u23f9 ${t('channels.disconnect')}</button>
                      <button class="btn btn-sm btn-danger" data-delete-connection="${key}">\ud83d\uddd1\ufe0f ${t('channels.deleteConnection')}</button>
                    ` : ''}
                    ${(key === 'whatsapp' || key === 'signal') && (info.connectionState === 'disconnected' || info.connectionState === 'connecting') ? `<button class="btn btn-sm btn-primary" data-show-qr="${key}">\ud83d\udcf1 ${t('channels.showQR')}</button>` : ''}
                    ${key === 'whatsapp' && info.connectionState === 'disconnected' && info.running !== false ? `<button class="btn btn-sm btn-warning" data-reconnect="${key}" title="${t('channels.reconnect')}">\u21bb ${t('channels.reconnect')}</button>` : ''}
                    ${info.connectionState === 'reconnecting' ? `<span class="badge badge-info">\u23f3 ${t('channels.connecting')}</span>` : ''}
                  </div>
                  <div id="qr-${key}" class="qr-container" style="display:none;"></div>
                  <div id="chat-${key}" class="chat-start-container" style="display:none;"></div>
                ` : `
                  <div class="provider-hint">${t('channels.configureInTab')}</div>
                `}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    </div>
  `;

  // Pair button: generate code
  el.querySelectorAll('[data-pair]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.pair;
      btn.disabled = true;
      try {
        const resp = await fetch(`/api/channels/${name}/pair`, { method: 'POST' });
        const data = await resp.json();
        if (data.ok) {
          showToast({ type: 'success', title: 'Pairing code generated', message: `Send ${data.code} to the bot` });
          await renderOverview(el);
        } else {
          showToast({ type: 'error', title: 'Error', message: data.error || 'Failed' });
        }
      } catch (err) {
        showToast({ type: 'error', title: 'Error', message: err.message });
      } finally {
        btn.disabled = false;
      }
    });
  });

  // Unpair button
  el.querySelectorAll('[data-unpair]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.unpair;
      if (!confirm(`Unpair ${name}? The bot will stop responding until you pair it again.`)) return;
      btn.disabled = true;
      try {
        const resp = await fetch(`/api/channels/${name}/pair`, { method: 'DELETE' });
        const data = await resp.json();
        if (data.ok) {
          showToast({ type: 'success', title: 'Unpaired', message: `${name} is now unpaired` });
          await renderOverview(el);
        } else {
          showToast({ type: 'error', title: 'Error', message: data.error || 'Failed' });
        }
      } catch (err) {
        showToast({ type: 'error', title: 'Error', message: err.message });
      } finally {
        btn.disabled = false;
      }
    });
  });

  el.querySelectorAll('[data-restart]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.restart;
      btn.disabled = true;
      btn.textContent = t('channels.restarting');
      try {
        // 10s timeout
        await Promise.race([
          api.channels.restart(name),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Restart timeout')), 10000)
          )
        ]);
        showToast({ type: 'success', title: t('channels.restarted'), message: `${name} ${t('channels.restarted').toLowerCase()}` });
        await renderOverview(el);
      } catch (err) {
        showToast({
          type: 'error',
          title: t('common.error'),
          message: err.message === 'Restart timeout' ? t('channels.restartFailed') : err.message
        });
        btn.disabled = false;
        btn.textContent = t('channels.restart');
      }
    });
  });

  el.querySelectorAll('[data-disconnect]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.disconnect;
      btn.disabled = true;
      btn.textContent = t('channels.disconnecting');
      try {
        await api.channels.stop(name);

        // Wait for backend to fully stop and update state
        await new Promise(resolve => setTimeout(resolve, 1500));

        showToast({ type: 'success', title: t('channels.disconnected'), message: `${name} ${t('channels.disconnected').toLowerCase()}` });

        // Wait for any ongoing render to complete, then force refresh
        isRendering = false;
        await renderOverview(el);
      } catch (err) {
        showToast({
          type: 'error',
          title: t('common.error'),
          message: err.message
        });
        btn.disabled = false;
        btn.textContent = t('channels.disconnect');
      }
    });
  });

  el.querySelectorAll('[data-reconnect]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.reconnect;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = t('channels.reconnecting');
      try {
        const res = await api.channels.reconnect(name);
        if (res?.ok) {
          showToast({
            type: 'success',
            title: t('channels.reconnect'),
            message: t('channels.reconnectTriggered')
          });
          await new Promise(resolve => setTimeout(resolve, 2500));
          isRendering = false;
          await renderOverview(el);
        } else {
          throw new Error(res?.error || 'Reconnect failed');
        }
      } catch (err) {
        showToast({
          type: 'error',
          title: t('common.error'),
          message: err.message
        });
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  });

  el.querySelectorAll('[data-delete-connection]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.deleteConnection;

      // Confirmation popup
      if (!confirm(t('channels.confirmDelete'))) {
        return;
      }

      btn.disabled = true;
      btn.textContent = t('channels.deleting');
      try {
        // Stop with clearSession = true to delete session + group
        await api.channels.stop(name, true);

        // Wait for backend to fully stop and clean up
        await new Promise(resolve => setTimeout(resolve, 1500));

        showToast({
          type: 'success',
          title: t('channels.deleted'),
          message: t('channels.connectionDeleted')
        });

        // Wait for any ongoing render to complete, then force refresh
        isRendering = false;
        await renderOverview(el);
      } catch (err) {
        showToast({
          type: 'error',
          title: t('common.error'),
          message: err.message
        });
        btn.disabled = false;
        btn.textContent = t('channels.deleteConnection');
      }
    });
  });

  el.querySelectorAll('[data-show-qr]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.showQr;
      const qrContainer = document.getElementById(`qr-${name}`);
      if (!qrContainer) return;

      if (qrContainer.style.display === 'none') {
        // Pause auto-refresh immediately to prevent re-rendering
        qrVisible = true;
        console.log('[Channels] Auto-refresh paused for QR display');

        btn.disabled = true;
        btn.textContent = t('channels.connecting') ;
        try {
          // First, stop and clear session to force new QR
          console.log(`[Channels] Stopping ${name} and clearing session for fresh QR...`);
          await api.channels.stop(name, true); // clearSession = true
          await new Promise(resolve => setTimeout(resolve, 500));

          // Now restart to generate new QR code
          console.log(`[Channels] Restarting ${name} to generate QR...`);
          await api.channels.restart(name);

          // Poll for QR code (max 10 attempts, 500ms intervals = 5s total)
          let qrData = null;
          let qrImageUrl = null;
          for (let i = 0; i < 10; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            console.log(`[Channels] Polling for QR code... attempt ${i + 1}/10`);
            const response = await fetch(`/api/channels/${name}/qr`);
            const data = await response.json();
            console.log(`[Channels] QR response:`, data);
            if (data.qr) {
              qrData = data.qr;
              console.log(`[Channels] QR code received! Length: ${qrData.length}`);
              break;
            }
            if (data.qrImageUrl) {
              qrImageUrl = data.qrImageUrl;
              console.log(`[Channels] QR image URL received: ${qrImageUrl}`);
              break;
            }
          }

          if (qrImageUrl) {
            // Signal: display QR as image from signal-cli API
            qrContainer.innerHTML = `<div style="text-align:center; padding:20px;">
              <img src="${qrImageUrl}" alt="QR Code" style="width:256px;height:256px;image-rendering:pixelated;" />
              <p style="margin-top:15px; color:var(--text-muted);">Scan with Signal app (Settings → Linked Devices)</p>
            </div>`;
            qrContainer.style.display = 'block';
            qrVisible = true;
            btn.textContent = t('channels.hideQR');
            console.log(`[Channels] Signal QR image displayed`);
          } else if (qrData) {
            console.log(`[Channels] Rendering QR code...`);
            // Use qrcode library to generate QR code as canvas
            const QRCode = window.QRCode;
            if (!QRCode) {
              console.error('[Channels] QRCode library not loaded!');
              showToast({ type: 'error', title: t('common.error'), message: t('channels.qrLibMissing') });
              btn.disabled = false;
              btn.textContent = t('channels.showQR');
              return;
            }
            qrContainer.innerHTML = '<div style="text-align:center; padding:20px;"><div id="qrcode"></div><p style="margin-top:15px; color:var(--text-muted);">Scan this QR code with your ' + name + ' app</p></div>';
            new QRCode(qrContainer.querySelector('#qrcode'), {
              text: qrData,
              width: 256,
              height: 256,
              colorDark: "#000000",
              colorLight: "#ffffff",
              correctLevel: QRCode.CorrectLevel.H
            });
            qrContainer.style.display = 'block';
            qrVisible = true; // Pause auto-refresh while QR is visible
            btn.textContent = t('channels.hideQR');
            console.log(`[Channels] QR code displayed successfully`);
          } else {
            console.warn('[Channels] QR code timeout - no QR received after 10 attempts');
            qrVisible = false; // Resume auto-refresh on timeout
            showToast({ type: 'warning', title: 'QR Code', message: 'QR code generation timed out. Please try again or check logs.' });
          }
        } catch (err) {
          qrVisible = false; // Resume auto-refresh on error
          showToast({ type: 'error', title: t('common.error'), message: err.message });
        }
        btn.disabled = false;
      } else {
        qrContainer.style.display = 'none';
        qrVisible = false; // Resume auto-refresh when QR is hidden
        btn.textContent = t('channels.showQR');
      }
    });
  });

  el.querySelectorAll('[data-start-chat]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const name = btn.dataset.startChat;
      const chatContainer = document.getElementById(`chat-${name}`);
      if (!chatContainer) return;

      if (chatContainer.style.display === 'none') {
        chatContainer.innerHTML = `
          <div style="padding:20px; background:rgba(255,255,255,0.05); border-radius:8px; margin-top:15px;">
            <h4 style="margin:0 0 10px 0; font-size:14px;">💬 Start a conversation</h4>
            <p style="margin:0 0 15px 0; font-size:12px; color:var(--text-muted);">Enter a phone number (with country code, e.g., 33612345678) or use your own number to message yourself</p>
            <div style="display:flex; gap:10px;">
              <input type="text" id="phone-${name}" placeholder="33612345678" style="flex:1; padding:8px 12px; background:rgba(0,0,0,0.2); border:1px solid rgba(255,255,255,0.1); border-radius:6px; color:var(--text-primary);">
              <button class="btn btn-sm btn-primary" id="send-${name}">Send "Hello"</button>
            </div>
          </div>
        `;
        chatContainer.style.display = 'block';
        btn.textContent = t('common.cancel');

        document.getElementById(`send-${name}`)?.addEventListener('click', async () => {
          const phoneInput = document.getElementById(`phone-${name}`);
          const phone = phoneInput.value.trim().replace(/[^0-9]/g, '');
          if (!phone) {
            showToast({ type: 'error', title: t('common.error'), message: t('channels.invalidPhone') });
            return;
          }

          const channelId = phone + '@s.whatsapp.net';
          try {
            await api.post(`/api/channels/${name}/send`, {
              channelId,
              text: 'Hello! I am Yabby, your AI assistant. How can I help you?'
            });
            showToast({ type: 'success', title: 'Message Sent', message: `First message sent to ${phone}. Check your WhatsApp!` });
            chatContainer.style.display = 'none';
            btn.textContent = t('channels.startChat');
          } catch (err) {
            showToast({ type: 'error', title: t('common.error'), message: err.message });
          }
        });
      } else {
        chatContainer.style.display = 'none';
        btn.textContent = t('channels.startChat');
      }
    });
  });
  } finally {
    isRendering = false;
  }
}

// ── WhatsApp Threads ──

async function renderThreads(el) {
  try {
    const res = await fetch('/api/whatsapp/threads').then(r => r.json());
    const threads = res.threads || [];

    // Get list of agents for the create thread dropdown
    const agentsRes = await fetch('/api/agents').then(r => r.json());
    const agents = (agentsRes.agents || []).filter(a => a.status === 'active');

    // Filter out agents that already have threads
    const threadAgentIds = new Set(threads.map(th => th.agent_id));
    const availableAgents = agents.filter(a => !threadAgentIds.has(a.id));

    el.innerHTML = `
      <div class="settings-sections">
        <div class="settings-section">
          <div class="settings-section-header">
            <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3">
              <rect x="2" y="2" width="14" height="14" rx="2"/>
              <path d="M6 7h6M6 11h4"/>
            </svg>
            <h3>${t('channels.whatsappThreads')} (${threads.length})</h3>
            <button class="btn btn-sm btn-primary" id="btnCreateThread" style="margin-left:auto">
              <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8">
                <path d="M7 3v8M3 7h8"/>
              </svg>
              ${t('channels.createThread')}
            </button>
          </div>

          ${threads.length === 0 ? `
            <p class="text-muted" style="padding: 20px;">
              ${t('channels.noThreads')}
            </p>
          ` : `
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>${t('tasks.agent')}</th>
                    <th>${t('projectDetail.role')}</th>
                    <th>${t('channels.threadName')}</th>
                    <th>${t('common.status')}</th>
                    <th>${t('common.date')}</th>
                    <th>${t('common.actions')}</th>
                  </tr>
                </thead>
                <tbody>
                  ${threads.map(th => `
                    <tr>
                      <td>
                        <a href="#/agents/${th.agent_id}" style="color: var(--accent-blue); text-decoration: none;">
                          ${esc(th.agent_name)}
                        </a>
                      </td>
                      <td>${esc(th.agent_role)}</td>
                      <td>
                        <span class="thread-name" data-thread-id="${th.agent_id}">${esc(th.group_name)}</span>
                      </td>
                      <td>
                        <span class="status-dot ${statusDotClass(th.agent_status)}"></span>
                        <span class="badge ${statusBadgeClass(th.agent_status)}">${statusLabel(th.agent_status)}</span>
                      </td>
                      <td>${formatRelative(th.created_at)}</td>
                      <td>
                        <button class="btn btn-sm btn-ghost" data-rename-thread="${th.agent_id}" title="${t('channels.rename')}">
                          ✏️
                        </button>
                        <button class="btn btn-sm btn-danger" data-delete-thread="${th.agent_id}" title="${t('common.delete')}">
                          🗑️
                        </button>
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
          `}
        </div>

        <!-- Create Thread Modal -->
        <div id="createThreadModal" style="display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: var(--surface-secondary); padding: 30px; border-radius: 12px; box-shadow: 0 10px 40px rgba(0,0,0,0.3); z-index: 10000; min-width: 400px;">
          <h3 style="margin: 0 0 20px 0;">${t('channels.createWhatsappThread')}</h3>
          <div class="form-group" style="margin-bottom: 20px;">
            <label class="form-label">${t('channels.selectAgent')}</label>
            <select id="selectAgent" class="select" style="width: 100%;">
              <option value="">${t('channels.chooseAgent')}</option>
              ${availableAgents.map(a => `
                <option value="${a.id}">${esc(a.name)} - ${esc(a.role)}</option>
              `).join('')}
            </select>
          </div>
          <div style="display: flex; gap: 10px; justify-content: flex-end;">
            <button class="btn btn-ghost" id="btnCancelCreate">${t('common.cancel')}</button>
            <button class="btn btn-primary" id="btnConfirmCreate">${t('common.create')}</button>
          </div>
        </div>

        <!-- Modal Backdrop -->
        <div id="threadModalBackdrop" style="display: none; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: rgba(0,0,0,0.6); z-index: 9999;"></div>
      </div>
    `;

    // Create thread button
    document.getElementById('btnCreateThread')?.addEventListener('click', () => {
      if (availableAgents.length === 0) {
        showToast({
          type: 'warning',
          title: t('channels.noAgentAvailable'),
          message: t('channels.allAgentsHaveThreads')
        });
        return;
      }
      document.getElementById('createThreadModal').style.display = 'block';
      document.getElementById('threadModalBackdrop').style.display = 'block';
    });

    // Cancel create
    document.getElementById('btnCancelCreate')?.addEventListener('click', () => {
      document.getElementById('createThreadModal').style.display = 'none';
      document.getElementById('threadModalBackdrop').style.display = 'none';
    });

    // Confirm create
    document.getElementById('btnConfirmCreate')?.addEventListener('click', async () => {
      const agentId = document.getElementById('selectAgent')?.value;
      if (!agentId) {
        showToast({ type: 'error', title: t('common.error'), message: t('channels.pleaseSelectAgent') });
        return;
      }

      try {
        document.getElementById('btnConfirmCreate').disabled = true;
        document.getElementById('btnConfirmCreate').textContent = t('channels.creating');

        const res = await fetch('/api/agents/whatsapp-thread', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent_id: agentId })
        }).then(r => r.json());

        if (res.error) throw new Error(res.error);

        showToast({
          type: 'success',
          title: t('channels.threadCreated'),
          message: res.message || `${t('channels.threadCreatedFor')} ${res.agent_name}`
        });

        // Close modal
        document.getElementById('createThreadModal').style.display = 'none';
        document.getElementById('threadModalBackdrop').style.display = 'none';

        // Refresh list
        await renderThreads(el);
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
        document.getElementById('btnConfirmCreate').disabled = false;
        document.getElementById('btnConfirmCreate').textContent = t('common.create');
      }
    });

    // Rename thread
    el.querySelectorAll('[data-rename-thread]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const agentId = btn.dataset.renameThread;
        const thread = threads.find(th => th.agent_id === agentId);
        if (!thread) return;

        const newName = prompt(t('channels.newThreadName'), thread.group_name);
        if (!newName || newName === thread.group_name) return;

        try {
          btn.disabled = true;
          const res = await fetch(`/api/whatsapp/threads/${agentId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ new_name: newName })
          }).then(r => r.json());

          if (res.error) throw new Error(res.error);

          showToast({
            type: 'success',
            title: t('channels.threadRenamed'),
            message: `"${res.old_name}" → "${res.new_name}"`
          });

          await renderThreads(el);
        } catch (err) {
          showToast({ type: 'error', title: t('common.error'), message: err.message });
          btn.disabled = false;
        }
      });
    });

    // Delete thread
    el.querySelectorAll('[data-delete-thread]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const agentId = btn.dataset.deleteThread;
        const thread = threads.find(th => th.agent_id === agentId);
        if (!thread) return;

        if (!confirm(t('channels.deleteThreadConfirm', { name: thread.group_name }))) {
          return;
        }

        try {
          btn.disabled = true;
          const res = await fetch(`/api/whatsapp/threads/${agentId}`, {
            method: 'DELETE'
          }).then(r => r.json());

          if (res.error) throw new Error(res.error);

          showToast({
            type: 'success',
            title: t('channels.threadDeleted'),
            message: `${t('channels.threadDeletedMessage')} ${res.agent_name}`
          });

          await renderThreads(el);
        } catch (err) {
          showToast({ type: 'error', title: t('common.error'), message: err.message });
          btn.disabled = false;
        }
      });
    });

  } catch (err) {
    el.innerHTML = `<div class="settings-error">${t('common.error')}: ${esc(err.message)}</div>`;
  }
}

// ── Conversations ──

async function renderConversations(el) {
  // Load conversations for all channels
  const channels = await api.channels.list();
  const enabledChannels = Object.keys(channels).filter(k => channels[k].enabled);

  const allConvos = [];
  for (const ch of enabledChannels) {
    try {
      const res = await api.channels.conversations(ch);
      for (const c of (res.conversations || [])) {
        allConvos.push(c);
      }
    } catch {}
  }

  // Sort by last message
  allConvos.sort((a, b) => new Date(b.last_message_at) - new Date(a.last_message_at));

  el.innerHTML = `
    <div class="settings-sections">
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4l7 5 7-5"/><rect x="1" y="3" width="16" height="12" rx="2"/></svg>
          <h3>${t('channels.conversations')} (${allConvos.length})</h3>
        </div>
        ${allConvos.length === 0 ? `<p class="text-muted">${t('channels.noConversations')}</p>` : `
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>${t('channels.channel')}</th>
                  <th>${t('channels.user')}</th>
                  <th>${t('common.type')}</th>
                  <th>${t('channels.lastMessage')}</th>
                </tr>
              </thead>
              <tbody>
                ${allConvos.slice(0, 50).map(c => `
                  <tr class="clickable-row" data-conv-id="${c.id}">
                    <td><span class="provider-dot" style="background:${(CHANNEL_META[c.channel_name] || {}).color || 'var(--text-muted)'}"></span>${esc(c.channel_name)}</td>
                    <td>${esc(c.user_name || c.user_id)}</td>
                    <td>${c.is_group ? t('channels.group') : t('channels.dm')}</td>
                    <td>${formatRelative(c.last_message_at)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
      <div id="convMessages" style="display:none" class="settings-section">
        <div class="settings-section-header">
          <h3 id="convTitle">${t('channels.messages')}</h3>
        </div>
        <div id="convMsgList" class="channel-messages"></div>
      </div>
    </div>
  `;

  // Click to view messages
  el.querySelectorAll('[data-conv-id]').forEach(row => {
    row.addEventListener('click', async () => {
      const convId = row.dataset.convId;
      const msgSection = document.getElementById('convMessages');
      const msgList = document.getElementById('convMsgList');
      const title = document.getElementById('convTitle');

      msgSection.style.display = 'block';
      msgList.innerHTML = `<span class="text-muted">${t('common.loading')}</span>`;

      try {
        const res = await api.channels.messages(convId);
        const messages = res.messages || [];
        title.textContent = `${t('channels.messages')} (${messages.length})`;
        msgList.innerHTML = messages.length === 0 ? `<span class="text-muted">${t('channels.noMessages')}</span>` :
          messages.map(m => `
            <div class="channel-msg channel-msg-${m.role}">
              <span class="channel-msg-role">${m.role === 'assistant' ? 'Yabby' : 'User'}</span>
              <span class="channel-msg-text">${esc(m.content)}</span>
              <span class="channel-msg-time">${new Date(m.created_at).toLocaleTimeString(getLocale() === 'fr' ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
          `).join('');
      } catch (err) {
        msgList.innerHTML = `<span style="color:var(--accent-red)">${esc(err.message)}</span>`;
      }
    });
  });
}

// ── Dead Letters ──

async function renderDeadLetters(el) {
  const res = await api.channels.deadLetters();
  const letters = res.deadLetters || [];

  el.innerHTML = `
    <div class="settings-sections">
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="9" cy="9" r="7"/><path d="M9 6v4"/><circle cx="9" cy="13" r=".5" fill="currentColor"/></svg>
          <h3>${t('channels.deadLetters')} (${letters.length})</h3>
          ${letters.length > 0 ? `<button class="btn btn-sm btn-ghost" id="clearDeadLetters" style="margin-left:auto">${t('channels.clearAll')}</button>` : ''}
        </div>
        ${letters.length === 0 ? `<p class="text-muted">${t('channels.noErrors')}</p>` : `
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>${t('channels.channel')}</th>
                  <th>${t('channels.user')}</th>
                  <th>${t('channels.message')}</th>
                  <th>${t('common.error')}</th>
                  <th>${t('channels.attempts')}</th>
                  <th>${t('common.date')}</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                ${letters.map(l => `
                  <tr>
                    <td>${esc(l.channel_name)}</td>
                    <td>${esc(l.user_id || '—')}</td>
                    <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(l.content || '—')}</td>
                    <td style="color:var(--accent-red);max-width:200px;overflow:hidden;text-overflow:ellipsis">${esc(l.error || '—')}</td>
                    <td>${l.attempts}</td>
                    <td>${formatRelative(l.created_at)}</td>
                    <td><button class="btn btn-sm btn-icon" data-delete-dl="${l.id}" title="${t('common.delete')}">✕</button></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>
    </div>
  `;

  document.getElementById('clearDeadLetters')?.addEventListener('click', async () => {
    try {
      await api.channels.clearDeadLetters();
      showToast({ type: 'success', title: t('channels.cleaned'), message: t('channels.deadLettersDeleted') });
      await renderDeadLetters(el);
    } catch (err) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  });

  el.querySelectorAll('[data-delete-dl]').forEach(btn => {
    btn.addEventListener('click', async () => {
      try {
        await api.channels.deleteDeadLetter(btn.dataset.deleteDl);
        await renderDeadLetters(el);
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
    });
  });
}

// ── Config ──

async function renderConfig(el) {
  const config = await api.config.getAll();
  const channels = config.channels || {};

  el.innerHTML = `
    <div class="settings-sections">
      ${['telegram', 'slack', 'discord', 'whatsapp', 'signal'].map(ch => {
        const meta = CHANNEL_META[ch] || { name: ch, icon: '?', color: 'var(--text-muted)' };
        const cfg = channels[ch] || {};
        return `
          <div class="settings-section">
            <div class="settings-section-header">
              <span style="font-size:18px">${meta.icon}</span>
              <h3>${meta.name}</h3>
            </div>
            <div class="settings-grid">
              <div class="form-group">
                <label class="toggle">
                  <input type="checkbox" class="ch-enabled" data-ch="${ch}" ${cfg.enabled ? 'checked' : ''} />
                  <span class="toggle-track"></span>
                  ${t('common.activate')}
                </label>
              </div>
              ${ch === 'whatsapp' ? `
              <div class="form-group" style="grid-column: 1/-1">
                <p class="form-hint" style="margin: 0">
                  <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" style="vertical-align: -2px; opacity: 0.6"><circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4v5M8 11v1"/></svg>
                  ${t('channels.whatsappInfo')}
                </p>
              </div>
              ` : ''}
              ${ch !== 'whatsapp' && ch !== 'signal' ? `
              <div class="form-group">
                <label class="form-label">${t('channels.botToken')}</label>
                <input class="input ch-token" data-ch="${ch}" type="password" value="${esc(cfg.botToken || cfg.token || '')}" placeholder="${t('channels.tokenPlaceholder')}" />
              </div>
              ` : ''}
              ${ch === 'slack' ? `
                <div class="form-group">
                  <label class="form-label">${t('channels.appToken')}</label>
                  <input class="input ch-app-token" data-ch="${ch}" type="password" value="${esc(cfg.appToken || '')}" placeholder="xapp-..." />
                </div>
              ` : ''}
              ${ch === 'signal' ? `
                <div class="form-group">
                  <label class="form-label">${t('channels.apiUrl')}</label>
                  <input class="input ch-api-url" data-ch="${ch}" type="text" value="${esc(cfg.apiUrl || '')}" placeholder="http://localhost:8080" />
                </div>
                <div class="form-group">
                  <label class="form-label">${t('channels.phoneNumber')}</label>
                  <input class="input ch-phone" data-ch="${ch}" type="text" value="${esc(cfg.phoneNumber || '')}" placeholder="+33612345678" />
                </div>
                <div class="form-group">
                  <label class="form-label">${t('channels.mode')}</label>
                  <select class="select ch-mode" data-ch="${ch}">
                    <option value="polling" ${(cfg.mode || 'polling') === 'polling' ? 'selected' : ''}>Polling</option>
                    <option value="websocket" ${cfg.mode === 'websocket' ? 'selected' : ''}>WebSocket</option>
                  </select>
                </div>
              ` : ''}
              ${ch !== 'whatsapp' ? `
              <div class="form-group">
                <label class="form-label">${t('channels.dmPolicy')}</label>
                <select class="select ch-policy" data-ch="${ch}">
                  <option value="open" ${cfg.dmPolicy === 'open' ? 'selected' : ''}>${t('channels.dmOpen')}</option>
                  <option value="closed" ${cfg.dmPolicy === 'closed' ? 'selected' : ''}>${t('channels.dmWhitelist')}</option>
                </select>
              </div>
              <div class="form-group ch-allowed-wrap" data-ch="${ch}" style="${cfg.dmPolicy === 'closed' ? '' : 'display:none'}">
                <label class="form-label">${t('channels.allowedUsers')}</label>
                <textarea class="input ch-allowed" data-ch="${ch}" rows="3" placeholder="uuid-or-phone-number">${(cfg.allowedUsers || []).join('\n')}</textarea>
                <div class="ch-recent-users" data-ch="${ch}" style="margin-top: 8px"></div>
              </div>
              <div class="form-group">
                <label class="toggle">
                  <input type="checkbox" class="ch-mention" data-ch="${ch}" ${cfg.groupMentionGating !== false ? 'checked' : ''} />
                  <span class="toggle-track"></span>
                  ${t('channels.mentionRequired')}
                </label>
              </div>
              ` : ''}
            </div>
            <button class="btn btn-primary btn-sm settings-save" data-save-ch="${ch}">${t('common.save')} ${meta.name}</button>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // Toggle allowed users visibility when DM policy changes
  el.querySelectorAll('.ch-policy').forEach(sel => {
    sel.addEventListener('change', () => {
      const ch = sel.dataset.ch;
      const wrap = el.querySelector(`.ch-allowed-wrap[data-ch="${ch}"]`);
      if (wrap) wrap.style.display = sel.value === 'closed' ? '' : 'none';
      if (sel.value === 'closed') loadRecentUsers(el, ch);
    });
  });

  // Load recent users for channels with closed DM policy
  async function loadRecentUsers(container, ch) {
    const panel = container.querySelector(`.ch-recent-users[data-ch="${ch}"]`);
    if (!panel) return;
    try {
      const data = await api.channels.users(ch);
      const users = data.users || [];
      if (users.length === 0) {
        panel.innerHTML = '<p class="form-hint" style="margin:0;opacity:0.6">No users found yet. Set DM policy to Open first, then users who message will appear here.</p>';
        return;
      }
      const textarea = container.querySelector(`.ch-allowed[data-ch="${ch}"]`);
      const currentAllowed = (textarea?.value || '').split('\n').map(s => s.trim()).filter(Boolean);
      panel.innerHTML = `
        <p class="form-hint" style="margin:0 0 6px;font-weight:600">Recent users — click + to whitelist:</p>
        ${users.map(u => {
          const alreadyAdded = currentAllowed.includes(u.user_id);
          return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:13px">
            <button class="btn btn-sm ch-add-user" data-ch="${ch}" data-uid="${esc(u.user_id)}" style="padding:2px 8px;min-width:28px" ${alreadyAdded ? 'disabled' : ''}>
              ${alreadyAdded ? '✓' : '+'}
            </button>
            <span style="font-weight:500">${esc(u.user_name)}</span>
            <code style="opacity:0.6;font-size:11px">${esc(u.user_id)}</code>
          </div>`;
        }).join('')}
      `;
      panel.querySelectorAll('.ch-add-user').forEach(btn => {
        btn.addEventListener('click', () => {
          const uid = btn.dataset.uid;
          const ta = container.querySelector(`.ch-allowed[data-ch="${btn.dataset.ch}"]`);
          if (!ta) return;
          const lines = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
          if (!lines.includes(uid)) {
            lines.push(uid);
            ta.value = lines.join('\n');
          }
          btn.textContent = '✓';
          btn.disabled = true;
        });
      });
    } catch (err) {
      panel.innerHTML = `<p class="form-hint" style="color:var(--danger)">Failed to load users: ${esc(err.message)}</p>`;
    }
  }

  // Auto-load recent users for already-closed channels
  el.querySelectorAll('.ch-policy').forEach(sel => {
    if (sel.value === 'closed') loadRecentUsers(el, sel.dataset.ch);
  });

  // Save handlers
  el.querySelectorAll('[data-save-ch]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const ch = btn.dataset.saveCh;
      const enabled = el.querySelector(`.ch-enabled[data-ch="${ch}"]`)?.checked || false;
      const botToken = el.querySelector(`.ch-token[data-ch="${ch}"]`)?.value || '';

      // WhatsApp: force specific defaults (group isolation mode)
      let dmPolicy, groupMentionGating;
      if (ch === 'whatsapp') {
        dmPolicy = 'open';
        groupMentionGating = false; // Always false for WhatsApp (group isolation)
      } else {
        dmPolicy = el.querySelector(`.ch-policy[data-ch="${ch}"]`)?.value || 'open';
        groupMentionGating = el.querySelector(`.ch-mention[data-ch="${ch}"]`)?.checked ?? true;
      }

      const channelCfg = { enabled, botToken, dmPolicy, groupMentionGating };

      // Allowed users for closed DM policy
      if (dmPolicy === 'closed') {
        const allowedText = el.querySelector(`.ch-allowed[data-ch="${ch}"]`)?.value || '';
        channelCfg.allowedUsers = allowedText.split('\n').map(s => s.trim()).filter(Boolean);
      }

      // Slack: extra appToken
      const appTokenEl = el.querySelector(`.ch-app-token[data-ch="${ch}"]`);
      if (appTokenEl) channelCfg.appToken = appTokenEl.value;

      // WhatsApp / Signal: phoneNumber
      const phoneEl = el.querySelector(`.ch-phone[data-ch="${ch}"]`);
      if (phoneEl) channelCfg.phoneNumber = phoneEl.value;

      // Signal: apiUrl + mode
      const apiUrlEl = el.querySelector(`.ch-api-url[data-ch="${ch}"]`);
      if (apiUrlEl) channelCfg.apiUrl = apiUrlEl.value;
      const modeEl = el.querySelector(`.ch-mode[data-ch="${ch}"]`);
      if (modeEl) channelCfg.mode = modeEl.value;

      // Merge with existing channels config
      const fullConfig = await api.config.getAll();
      const allChannels = fullConfig.channels || {};
      const wasEnabled = allChannels[ch]?.enabled || false;
      allChannels[ch] = channelCfg;

      try {
        await api.config.set('channels', allChannels);

        // If disabling, stop the channel
        if (wasEnabled && !enabled) {
          try {
            await api.channels.stop(ch);
            showToast({ type: 'success', title: t('channels.saved'), message: `${CHANNEL_META[ch]?.name || ch} ${t('channels.disconnected')}` });
          } catch (stopErr) {
            showToast({ type: 'warning', title: t('channels.saved'), message: `${CHANNEL_META[ch]?.name || ch} config saved but disconnect failed` });
          }
        } else if (enabled) {
          // Auto-restart channel to apply new config
          try {
            await api.channels.restart(ch);
            showToast({ type: 'success', title: t('channels.saved'), message: `${CHANNEL_META[ch]?.name || ch} ${t('channels.updated')} & restarted` });
          } catch (restartErr) {
            showToast({ type: 'warning', title: t('channels.saved'), message: `${CHANNEL_META[ch]?.name || ch} config saved but restart failed: ${restartErr.message}` });
          }
        } else {
          showToast({ type: 'success', title: t('channels.saved'), message: `${CHANNEL_META[ch]?.name || ch} ${t('channels.updated')}` });
        }
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
    });
  });
}
