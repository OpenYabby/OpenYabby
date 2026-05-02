/* ═══════════════════════════════════════════════════════
   YABBY — Notification Center
   ═══════════════════════════════════════════════════════
   Manages the bell badge + dropdown. Aggregates pending
   items from plan reviews, project questions, connector
   requests, and speaker notifications.
*/

import { api } from './api.js';
import { state } from './state.js';
import { t } from './i18n.js';

let dropdownOpen = false;
let pendingItems = []; // unified list of actionable items

/** Initialize notification bell and listeners */
export function initNotifications() {
  const bell = document.getElementById('notifBell');
  const dropdown = document.getElementById('notifDropdown');
  if (!bell || !dropdown) return;

  // Toggle dropdown on bell click
  bell.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdownOpen = !dropdownOpen;
    dropdown.classList.toggle('open', dropdownOpen);
    if (dropdownOpen) refreshNotifications();
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (dropdownOpen && !dropdown.contains(e.target) && !bell.contains(e.target)) {
      dropdownOpen = false;
      dropdown.classList.remove('open');
    }
  });

  // Listen for SSE events that add notifications
  state.addEventListener('sse:plan_review', () => refreshNotifications());
  state.addEventListener('sse:plan_review_resolved', () => refreshNotifications());
  state.addEventListener('sse:project_question', () => refreshNotifications());
  state.addEventListener('sse:project_question_resolved', () => refreshNotifications());
  state.addEventListener('sse:task', (e) => {
    if (e.detail?.type === 'connector_request' || e.detail?.type === 'status') {
      refreshNotifications();
    }
    // Refresh LLM limit button on any task status change
    if (e.detail?.type === 'status') {
      refreshLlmLimitButton();
    }
  });
  state.addEventListener('sse:speaker_notify', () => refreshNotifications());

  // Mark all read button
  document.getElementById('notifMarkAllRead')?.addEventListener('click', () => {
    pendingItems = [];
    updateBadge(0);
    renderDropdown();
  });

  // Initial fetch
  refreshNotifications();

  // Initialize LLM limit resume button
  initLlmLimitButton();

  // Periodic refresh (every 30s)
  setInterval(refreshNotifications, 30000);
}

/** ── LLM Limit resume button ── */

async function refreshLlmLimitButton() {
  const btn = document.getElementById('llmResumeBtn');
  if (!btn) return;

  // Respect user preference — hide completely if disabled
  const enabled = localStorage.getItem('yabby-show-llm-resume-btn') !== 'false';
  if (!enabled) {
    btn.style.display = 'none';
    return;
  }

  try {
    const res = await fetch('/api/tasks/llm-limit');
    const data = await res.json();
    const badge = document.getElementById('llmResumeBadge');
    if (!badge) return;

    if (data.count > 0) {
      btn.style.display = 'flex';
      badge.textContent = data.count;
      btn.title = t('notifications.llmLimitTooltip', { count: data.count });
    } else {
      btn.style.display = 'none';
    }
  } catch (err) {
    console.error('[LLM-BTN] Refresh failed:', err);
  }
}

function initLlmLimitButton() {
  const btn = document.getElementById('llmResumeBtn');
  if (!btn) return;

  // Expose refresh function globally so settings + task components can trigger it
  window.refreshLlmLimitButton = refreshLlmLimitButton;

  // Click handler → batch resume
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('resuming')) return;
    btn.classList.add('resuming');

    try {
      const res = await fetch('/api/tasks/resume-llm-limit', { method: 'POST' });
      const data = await res.json();

      const { showToast } = await import('./components/toast.js');
      showToast({
        type: data.failed ? 'warning' : 'success',
        title: t('toast.llmResumeTitle'),
        message: data.failed ? t('toast.tasksResumedWithFails', { resumed: data.resumed || 0, failed: data.failed }) : t('toast.tasksResumed', { resumed: data.resumed || 0 }),
      });

      await refreshLlmLimitButton();
    } catch (err) {
      console.error('[LLM-BTN] Resume failed:', err);
      const { showToast } = await import('./components/toast.js');
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    } finally {
      btn.classList.remove('resuming');
    }
  });

  // Initial fetch + poll every 15s (fallback for SSE miss)
  refreshLlmLimitButton();
  setInterval(refreshLlmLimitButton, 15000);
}

/** Fetch all pending items and update badge */
export async function refreshNotifications() {
  const items = [];

  try {
    // Plan reviews — pass all=true so plans already auto-shown stay listed
    // in the notification dropdown (user can still reopen them via "Voir")
    const reviews = await api.planReviews.list(null, { all: true }).catch(() => []);
    for (const r of (reviews || [])) {
      items.push({
        id: `plan_${r.id}`,
        type: 'plan_review',
        icon: '📋',
        title: t('notifications.planReview'),
        message: `${r.projectName || r.project_name || 'Project'} — ${(r.agentName || r.agent_name || 'Agent')}`,
        time: r.createdAt || r.created_at,
        data: r,
      });
    }

    // Project questions
    const questions = await api.projectQuestions.list().catch(() => []);
    for (const q of (questions || [])) {
      items.push({
        id: `question_${q.id}`,
        type: 'project_question',
        icon: '❓',
        title: t('notifications.projectQuestion'),
        message: (q.question || '').slice(0, 100),
        time: q.createdAt || q.created_at,
        data: q,
      });
    }

    // Connector requests
    const requests = await api.connectors.requests().catch(() => []);
    for (const r of (requests || [])) {
      items.push({
        id: `connector_${r.id}`,
        type: 'connector_request',
        icon: '🔌',
        title: t('notifications.connectorRequest'),
        message: `${r.catalogId} — ${(r.reason || '').slice(0, 80)}`,
        time: r.createdAt || r.created_at,
        data: r,
      });
    }
  } catch {}

  // Sort by time (newest first)
  items.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

  pendingItems = items;
  updateBadge(items.length);

  if (dropdownOpen) renderDropdown();
}

function updateBadge(count) {
  const badge = document.getElementById('notifBadge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

function renderDropdown() {
  const body = document.getElementById('notifDropdownBody');
  const title = document.getElementById('notifDropdownTitle');
  if (!body) return;

  if (title) title.textContent = `${t('notifications.title')} (${pendingItems.length})`;

  if (pendingItems.length === 0) {
    body.innerHTML = `<div class="notif-empty">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.4"><path d="M12 2a7 7 0 017 7v4l2 3H3l2-3V9a7 7 0 017-7z"/><path d="M9 18a3 3 0 006 0"/></svg>
      <span>${t('notifications.empty')}</span>
    </div>`;
    return;
  }

  body.innerHTML = pendingItems.map(item => `
    <div class="notif-item" data-notif-id="${esc(item.id)}" data-notif-type="${item.type}">
      <div class="notif-item-icon">${item.icon}</div>
      <div class="notif-item-content">
        <span class="notif-item-title">${esc(item.title)}</span>
        <span class="notif-item-message">${esc(item.message)}</span>
        <span class="notif-item-time">${formatTime(item.time)}</span>
      </div>
      <div class="notif-item-actions">
        ${renderActions(item)}
      </div>
    </div>
  `).join('');

  wireDropdownActions();
}

function renderActions(item) {
  switch (item.type) {
    case 'plan_review':
      return `<button class="btn btn-sm btn-primary" data-notif-action="view-plan" data-notif-ref="${esc(item.data.id)}">${t('notifications.view')}</button>`;
    case 'project_question':
      return `<button class="btn btn-sm btn-primary" data-notif-action="answer-question" data-notif-ref="${esc(item.data.id)}">${t('notifications.answer')}</button>`;
    case 'connector_request':
      return `
        <button class="btn btn-sm btn-primary" data-notif-action="approve-connector" data-notif-ref="${esc(item.data.id)}">${t('notifications.approve')}</button>
        <button class="btn btn-sm" data-notif-action="reject-connector" data-notif-ref="${esc(item.data.id)}">✕</button>
      `;
    default:
      return '';
  }
}

function wireDropdownActions() {
  const dropdown = document.getElementById('notifDropdown');
  if (!dropdown) return;

  // Plan review → open modal
  dropdown.querySelectorAll('[data-notif-action="view-plan"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.notifRef;
      const item = pendingItems.find(i => i.data?.id === id && i.type === 'plan_review');
      if (!item) return;
      closeDropdown();
      const { openPlanReviewModal } = await import('./components/plan-review.js');
      openPlanReviewModal({ ...item.data, reviewId: item.data.id });
    });
  });

  // Project question → notify user to use voice (no modal popup)
  dropdown.querySelectorAll('[data-notif-action="answer-question"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.notifRef;
      const item = pendingItems.find(i => i.data?.id === id && i.type === 'project_question');
      if (!item) return;
      closeDropdown();
      // Modal popup removed — inform user to answer via voice
      const { showToast } = await import('./components/toast.js');
      showToast('info', t('notifications.useVoiceToAnswer') || 'Use voice to answer this question');
    });
  });

  // Connector request → approve
  dropdown.querySelectorAll('[data-notif-action="approve-connector"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.connectors.resolveRequest(btn.dataset.notifRef, 'approved');
        refreshNotifications();
      } catch {}
    });
  });

  // Connector request → reject
  dropdown.querySelectorAll('[data-notif-action="reject-connector"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.connectors.resolveRequest(btn.dataset.notifRef, 'rejected');
        refreshNotifications();
      } catch {}
    });
  });
}

function closeDropdown() {
  dropdownOpen = false;
  const dropdown = document.getElementById('notifDropdown');
  if (dropdown) dropdown.classList.remove('open');
}

function formatTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return t('notifications.justNow');
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return d.toLocaleDateString();
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
