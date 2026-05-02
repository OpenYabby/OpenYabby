/* ═══════════════════════════════════════════════════════
   YABBY — Simple Tasks View
   ═══════════════════════════════════════════════════════
   Dedicated page for standalone tasks (no project, no agent).
   Incremental DOM updates — zero flashing on live data.
*/

import { state } from '../state.js';
import { api } from '../api.js';
import { esc, truncate, formatDuration, formatRelative, statusBadgeClass, statusLabel, debounce } from '../utils.js';
import { showToast } from './toast.js';
import { openCreateTaskModal } from './modal.js';
import { t } from '../i18n.js';

let allTasks = [];
let filteredTasks = [];
let filterStatus = 'all';
let searchQuery = '';
let expandedTaskId = null;

// Incremental update state
let expandedLogCount = 0;
let lastRenderIncremental = false;
let forceFullRebuild = false;

export async function render(container) {
  allTasks = [];
  filteredTasks = [];
  filterStatus = 'all';
  searchQuery = '';
  expandedTaskId = null;
  expandedLogCount = 0;
  lastRenderIncremental = false;
  forceFullRebuild = false;

  container.innerHTML = `
    <div class="st-view">
      <div class="st-header">
        <div class="ad-title-row" style="display:flex;align-items:center;justify-content:space-between;">
          <h2 class="tm-title">${t('simpleTasks.title')} <span class="tm-update-dot" id="stUpdateDot"></span></h2>
          <button class="btn btn-primary" id="stNewBtn">${t('simpleTasks.newTask')}</button>
        </div>
        <div class="st-filters">
          <div class="tm-filter-group" style="display:flex;gap:var(--space-sm);">
            <select class="select tm-select" id="stFilterStatus">
              <option value="all">${t('tasks.allStatuses')}</option>
              <option value="running">${t('status.running')}</option>
              <option value="paused">${t('status.paused')}</option>
              <option value="done">${t('status.done')}</option>
              <option value="error">${t('status.error')}</option>
              <option value="killed">${t('status.killed')}</option>
            </select>
          </div>
          <div class="topbar-search-wrap tm-search-wrap">
            <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="6.5" cy="6.5" r="5"/><path d="M10.5 10.5L14.5 14.5"/>
            </svg>
            <input class="topbar-search tm-search" type="text" id="stSearch" placeholder="${t('simpleTasks.searchPlaceholder')}">
          </div>
        </div>
      </div>

      <div class="tm-stats" id="stStats"></div>

      <div class="card-grid st-grid" id="stGrid">
        <div class="empty-state" style="padding:var(--space-xl);">${t('common.loading')}</div>
      </div>
    </div>
  `;

  // Bind filters
  document.getElementById('stFilterStatus')?.addEventListener('change', (e) => {
    filterStatus = e.target.value;
    applyFilters();
  });

  const debouncedSearch = debounce((val) => {
    searchQuery = val.toLowerCase();
    applyFilters();
  }, 250);
  document.getElementById('stSearch')?.addEventListener('input', (e) => debouncedSearch(e.target.value));

  // New task button — no project pre-selected
  document.getElementById('stNewBtn')?.addEventListener('click', () => {
    openCreateTaskModal([], () => loadTasks());
  });

  await loadTasks();

  // SSE live updates — debounced + micro-updates
  const debouncedRefresh = debounce(() => loadTasks(true), 1500);
  const onTask = (e) => {
    applyMicroUpdate(e.detail);
    document.getElementById('stUpdateDot')?.classList.add('active');
    debouncedRefresh();
  };
  state.addEventListener('sse:task', onTask);

  return () => {
    state.removeEventListener('sse:task', onTask);
  };
}

/* ── Micro-updates: apply SSE data inline ── */

function applyMicroUpdate(data) {
  const { taskId, type, detail } = data;
  if (!taskId) return;

  if (type === 'status') {
    const task = allTasks.find(tk => tk.id === taskId);
    if (task) {
      task.status = detail.status;
      if (detail.elapsed) task.elapsed = detail.elapsed;
    }

    // Update badge and elapsed in card
    const card = document.querySelector(`.st-card[data-task-id="${taskId}"]`);
    if (card) {
      const badge = card.querySelector('.badge');
      if (badge) {
        badge.className = `badge ${statusBadgeClass(detail.status)}`;
        badge.textContent = statusLabel(detail.status);
      }
      if (detail.elapsed) {
        const metaSpans = card.querySelectorAll('.st-card-meta span');
        if (metaSpans[0]) metaSpans[0].textContent = formatDuration(detail.elapsed);
      }
      // Update actions
      if (task) {
        const actionsEl = card.querySelector('.st-card-actions');
        if (actionsEl) {
          actionsEl.innerHTML = renderActions(task);
          bindActionButtons(actionsEl);
        }
      }
    }

    renderStats();
  }
}

/* ── Data loading ── */

async function loadTasks(isUpdate = false) {
  try {
    const data = await api.tasks.listSimple();
    allTasks = data.tasks || [];
    applyFilters(!isUpdate);
    if (isUpdate) document.getElementById('stUpdateDot')?.classList.remove('active');
  } catch (err) {
    console.error('[SimpleTasks] Load error:', err);
    if (isUpdate) document.getElementById('stUpdateDot')?.classList.remove('active');
    const grid = document.getElementById('stGrid');
    if (grid) grid.innerHTML = `<div class="empty-state" style="padding:var(--space-xl);color:var(--accent-red);">${t('common.loadError')}</div>`;
  }
}

function applyFilters(resetPage = true) {
  const scrollPos = window.scrollY;

  filteredTasks = allTasks.filter(tk => {
    if (filterStatus !== 'all' && tk.status !== filterStatus) return false;
    if (searchQuery) {
      const hay = `${tk.title || ''} ${tk.id}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });
  renderStats();
  renderGrid();

  // Refresh expanded detail
  if (expandedTaskId && filteredTasks.find(tk => tk.id === expandedTaskId)) {
    if (lastRenderIncremental) {
      refreshExpandedLogs(expandedTaskId);
    } else {
      loadDetail(expandedTaskId);
    }
  }

  // Restore scroll on SSE updates
  if (!resetPage) {
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollPos);
    });
  }
}

function renderStats() {
  const el = document.getElementById('stStats');
  if (!el) return;

  const running = allTasks.filter(tk => tk.status === 'running').length;
  const paused = allTasks.filter(tk => tk.status === 'paused').length;
  const done = allTasks.filter(tk => tk.status === 'done').length;
  const errors = allTasks.filter(tk => tk.status === 'error').length;

  el.innerHTML = `
    <span class="tm-stat"><span class="status-dot running"></span> ${running} ${t('status.runningLower')}</span>
    <span class="tm-stat"><span class="status-dot paused"></span> ${paused} ${t('status.pausedLower')}</span>
    <span class="tm-stat"><span class="status-dot done"></span> ${done} ${t('status.doneLower')}</span>
    <span class="tm-stat"><span class="status-dot error"></span> ${errors} ${t('status.errorLower')}</span>
    <span class="tm-stat-total">${filteredTasks.length}/${allTasks.length} ${t('common.displayed')}</span>
  `;
}

/* ── Grid rendering with incremental updates ── */

function renderGrid() {
  const grid = document.getElementById('stGrid');
  if (!grid) return;

  if (filteredTasks.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="padding:var(--space-xl);">
      ${allTasks.length === 0 ? t('simpleTasks.noTasks') : t('tasks.noFilterResults')}
    </div>`;
    lastRenderIncremental = false;
    forceFullRebuild = false;
    return;
  }

  // Check if same set of cards for incremental update
  const existingCards = grid.querySelectorAll('.st-card');
  const existingIds = [...existingCards].map(c => c.dataset.taskId);
  const newIds = filteredTasks.map(tk => tk.id);
  const sameSet = !forceFullRebuild &&
    existingIds.length === newIds.length &&
    existingIds.every((id, i) => id === newIds[i]);

  if (sameSet && existingIds.length > 0) {
    // Incremental: update each card in place
    lastRenderIncremental = true;
    existingCards.forEach((card, i) => {
      updateCardInPlace(card, filteredTasks[i]);
    });
  } else {
    // Full rebuild
    lastRenderIncremental = false;
    grid.innerHTML = filteredTasks.map(tk => renderCard(tk)).join('');
    bindCardEvents(grid);
  }

  forceFullRebuild = false;
}

function updateCardInPlace(card, tk) {
  // Status badge
  const badge = card.querySelector('.badge');
  if (badge) {
    const newClass = `badge ${statusBadgeClass(tk.status)}`;
    const newText = statusLabel(tk.status);
    if (badge.className !== newClass) badge.className = newClass;
    if (badge.textContent !== newText) badge.textContent = newText;
  }

  // Elapsed (first span in meta)
  const metaSpans = card.querySelectorAll('.st-card-meta span');
  if (metaSpans[0]) {
    const elapsed = tk.elapsed ? formatDuration(tk.elapsed) : '-';
    if (metaSpans[0].textContent !== elapsed) metaSpans[0].textContent = elapsed;
  }

  // Relative date (second span in meta)
  if (metaSpans[1] && tk.created_at) {
    const rel = formatRelative(tk.created_at);
    if (metaSpans[1].textContent !== rel) metaSpans[1].textContent = rel;
  }
}

function renderCard(tk) {
  const elapsed = tk.elapsed ? formatDuration(tk.elapsed) : '-';
  const isExpanded = tk.id === expandedTaskId;

  return `
    <div class="card st-card" data-task-id="${tk.id}">
      <div class="st-card-top">
        <span class="st-card-title">${esc(tk.title || tk.id)}</span>
        <span class="badge ${statusBadgeClass(tk.status)}">${statusLabel(tk.status)}</span>
      </div>
      <span class="st-card-id">${tk.id}</span>
      ${tk.result ? `<div class="st-card-result">${esc(truncate(tk.result, 150))}</div>` : ''}
      <div class="st-card-meta">
        <span>${elapsed}</span>
        <span>${tk.created_at ? formatRelative(tk.created_at) : ''}</span>
      </div>
      ${isExpanded ? renderExpandedDetail(tk) : ''}
      <div class="st-card-actions">
        ${renderActions(tk)}
      </div>
    </div>`;
}

function renderExpandedDetail(tk) {
  return `
    <div class="st-card-detail" id="stDetail_${tk.id}">
      <pre>${t('simpleTasks.loadingDetails')}</pre>
    </div>`;
}

function renderActions(tk) {
  const btns = [];
  switch (tk.status) {
    case 'running':
      btns.push(`<button class="btn btn-sm btn-warning" data-action="pause" data-tid="${tk.id}" title="${t('tasks.pause')}">&#10074;&#10074;</button>`);
      btns.push(`<button class="btn btn-sm btn-danger" data-action="kill" data-tid="${tk.id}" title="${t('tasks.stop')}">&times;</button>`);
      break;
    case 'paused':
      btns.push(`<button class="btn btn-sm btn-success" data-action="resume" data-tid="${tk.id}" title="${t('tasks.resume')}">&#9654;</button>`);
      btns.push(`<button class="btn btn-sm btn-danger" data-action="kill" data-tid="${tk.id}" title="${t('tasks.stop')}">&times;</button>`);
      break;
    case 'paused_llm_limit':
      btns.push(`<button class="btn btn-sm btn-warning" data-action="resume-llm" data-tid="${tk.id}" title="${t('tasks.resumeLlmLimit')}">&#9654; ${t('tasks.resume')}</button>`);
      btns.push(`<button class="btn btn-sm" data-action="archive" data-tid="${tk.id}" title="${t('common.archive')}">&#128451;</button>`);
      break;
    case 'done':
    case 'killed':
      btns.push(`<button class="btn btn-sm" data-action="archive" data-tid="${tk.id}" title="${t('common.archive')}">&#128451;</button>`);
      break;
    case 'error':
      btns.push(`<button class="btn btn-sm btn-primary" data-action="retry" data-tid="${tk.id}" title="${t('common.retry')}">&#8635;</button>`);
      btns.push(`<button class="btn btn-sm" data-action="archive" data-tid="${tk.id}" title="${t('common.archive')}">&#128451;</button>`);
      break;
  }
  return btns.join('');
}

function bindCardEvents(grid) {
  // Card click → expand/collapse
  grid.querySelectorAll('.st-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      const tid = card.dataset.taskId;
      if (expandedTaskId === tid) {
        expandedTaskId = null;
      } else {
        expandedTaskId = tid;
      }
      expandedLogCount = 0;
      forceFullRebuild = true;
      renderGrid();
      if (expandedTaskId) loadDetail(expandedTaskId);
    });
  });

  // Action buttons
  grid.querySelectorAll('.st-card-actions').forEach(el => bindActionButtons(el));
}

function bindActionButtons(container) {
  container.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const tid = btn.dataset.tid;

      switch (action) {
        case 'pause':      handlePause(tid); break;
        case 'kill':       handleKill(tid); break;
        case 'resume':     handleResume(tid); break;
        case 'resume-llm': handleResumeLlmLimit(); break;
        case 'retry':      handleRetry(tid); break;
        case 'archive':    handleArchive(btn, tid); break;
      }
    });
  });
}

async function handleResumeLlmLimit() {
  try {
    const res = await fetch('/api/tasks/resume-llm-limit', { method: 'POST' });
    const data = await res.json();
    showToast({
      type: data.failed ? 'warning' : 'success',
      title: t('tasks.resumeLlmLimit'),
      message: t('tasks.resumedLlmLimit', { resumed: data.resumed, failed: data.failed || 0 }),
    });
    await loadTasks();
    if (typeof window.refreshLlmLimitButton === 'function') window.refreshLlmLimitButton();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

/* ── Expanded detail — full load ── */

async function loadDetail(taskId) {
  const el = document.getElementById(`stDetail_${taskId}`);
  if (!el) return;

  try {
    const task = await api.tasks.get(taskId);
    let logLines = [];
    try {
      const logRes = await api.tasks.getLog(taskId, 999999);
      logLines = logRes.lines || [];
    } catch {}

    expandedLogCount = logLines.length;

    const parts = [];
    if (task.result) parts.push(`${t('common.result')}:\n${task.result}`);
    if (task.error) parts.push(`${t('common.error')}:\n${task.error}`);
    if (logLines.length > 0) {
      parts.push(`${t('simpleTasks.allLogs')} (${logLines.length}):\n${logLines.map(l => typeof l === 'string' ? l : l.text || JSON.stringify(l)).join('\n')}`);
    }

    el.innerHTML = parts.length > 0
      ? `<pre class="st-detail-pre">${esc(parts.join('\n\n'))}</pre>`
      : `<pre style="color:var(--text-disabled);">${t('tasks.noDetail')}</pre>`;
  } catch (err) {
    el.innerHTML = `<pre style="color:var(--accent-red);">${t('common.error')}: ${esc(err.message)}</pre>`;
  }
}

/* ── Expanded detail — incremental refresh (preserves scroll) ── */

async function refreshExpandedLogs(taskId) {
  const el = document.getElementById(`stDetail_${taskId}`);
  if (!el) return;

  try {
    const [task, logRes] = await Promise.all([
      api.tasks.get(taskId),
      api.tasks.getLog(taskId, 999999).catch(() => ({ lines: [] })),
    ]);

    const logLines = logRes.lines || [];
    const pre = el.querySelector('.st-detail-pre');

    if (pre && logLines.length > expandedLogCount) {
      const newLines = logLines.slice(expandedLogCount);

      // Detect auto-scroll
      const isAtBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;

      // Append new lines as text node
      const newText = '\n' + newLines.map(l =>
        typeof l === 'string' ? l : l.text || JSON.stringify(l)
      ).join('\n');
      pre.appendChild(document.createTextNode(newText));

      expandedLogCount = logLines.length;

      // Auto-scroll only if user was following
      if (isAtBottom) {
        pre.scrollTop = pre.scrollHeight;
      }
    } else if (pre && logLines.length < expandedLogCount) {
      // Log was reset — full re-render
      loadDetail(taskId);
      return;
    } else if (!pre && (task.result || task.error || logLines.length > 0)) {
      // Content appeared for the first time
      loadDetail(taskId);
      return;
    }
  } catch (err) {
    console.error('[SimpleTasks] Expanded refresh error:', err);
  }
}

/* ── Action handlers ── */

async function handlePause(taskId) {
  try {
    await api.tasks.pause(taskId);
    showToast({ type: 'warning', title: t('tasks.paused'), message: taskId.slice(0, 8) });
    await loadTasks();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

async function handleKill(taskId) {
  try {
    await api.tasks.kill(taskId);
    showToast({ type: 'info', title: t('tasks.killed'), message: taskId.slice(0, 8) });
    await loadTasks();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

async function handleResume(taskId) {
  try {
    await api.tasks.continue(taskId, 'continue');
    showToast({ type: 'success', title: t('tasks.resumed'), message: taskId.slice(0, 8) });
    await loadTasks();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

async function handleRetry(taskId) {
  const task = allTasks.find(tk => tk.id === taskId);
  if (!task) return;
  try {
    await api.tasks.start(task.title || 'Retry');
    showToast({ type: 'success', title: t('tasks.retried'), message: taskId.slice(0, 8) });
    await loadTasks();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

function handleArchive(archiveBtn, taskId) {
  const original = archiveBtn.outerHTML;
  const confirmEl = document.createElement('span');
  confirmEl.className = 'inline-confirm';
  confirmEl.innerHTML = `${t('tasks.archiveConfirm')} <button class="btn btn-sm btn-danger ic-yes">${t('common.yes')}</button> <button class="btn btn-sm ic-no">${t('common.no')}</button>`;
  archiveBtn.replaceWith(confirmEl);

  let resolved = false;
  const cleanup = () => {
    if (resolved) return;
    resolved = true;
    const temp = document.createElement('div');
    temp.innerHTML = original;
    const orig = temp.firstElementChild;
    confirmEl.replaceWith(orig);
    orig.addEventListener('click', (e) => {
      e.stopPropagation();
      handleArchive(orig, taskId);
    });
  };

  confirmEl.querySelector('.ic-yes').addEventListener('click', async (e) => {
    e.stopPropagation();
    resolved = true;
    try {
      await api.tasks.archive(taskId);
      // Fade out card
      const card = confirmEl.closest('.st-card');
      if (card) {
        card.style.transition = 'opacity 0.3s, transform 0.3s';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.95)';
        await new Promise(r => setTimeout(r, 300));
      }
      showToast({ type: 'info', title: t('tasks.archived'), message: taskId.slice(0, 8) });
      await loadTasks();
    } catch (err) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  });

  confirmEl.querySelector('.ic-no')?.addEventListener('click', (e) => {
    e.stopPropagation();
    cleanup();
  });

  setTimeout(cleanup, 5000);
}
