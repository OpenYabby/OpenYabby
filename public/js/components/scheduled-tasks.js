/* ═══════════════════════════════════════════════════════
   YABBY — Scheduled Tasks (Planification) View
   ═══════════════════════════════════════════════════════
   Card grid of scheduled/cyclical tasks with inline editing,
   run history panel, and real-time status.
*/

import { state } from '../state.js';
import { api } from '../api.js';
import { esc, truncate, formatRelative, formatFutureTime, statusBadgeClass, statusLabel, debounce } from '../utils.js';
import { showToast } from './toast.js';
import { t } from '../i18n.js';

let allTasks = [];
let filteredTasks = [];
let filterStatus = 'all';
let filterType = 'all';
let searchQuery = '';
let editingTaskId = null;
let runsPanel = null; // { taskId, taskName }
let projects = [];
let agents = [];

export async function render(container) {
  allTasks = [];
  filteredTasks = [];
  filterStatus = 'all';
  filterType = 'all';
  searchQuery = '';
  editingTaskId = null;
  runsPanel = null;

  container.innerHTML = `
    <div class="sc-view">
      <div class="sc-header">
        <div class="ad-title-row" style="display:flex;align-items:center;justify-content:space-between;">
          <h2 class="tm-title">${t('scheduledTasks.title')}</h2>
          <button class="btn btn-primary" id="scNewBtn">${t('scheduledTasks.newScheduled')}</button>
        </div>
        <div class="sc-filters">
          <div class="tm-filter-group" style="display:flex;gap:var(--space-sm);">
            <select class="select tm-select" id="scFilterStatus">
              <option value="all">${t('scheduledTasks.allStatuses')}</option>
              <option value="active">${t('scheduledTasks.activeLower')}</option>
              <option value="paused">${t('scheduledTasks.pausedLower')}</option>
            </select>
            <select class="select tm-select" id="scFilterType">
              <option value="all">${t('scheduledTasks.allTypes')}</option>
              <option value="interval">${t('scheduledTasks.interval')}</option>
              <option value="cron">${t('scheduledTasks.cron')}</option>
              <option value="manual">${t('scheduledTasks.manual')}</option>
            </select>
          </div>
          <div class="topbar-search-wrap tm-search-wrap">
            <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="6.5" cy="6.5" r="5"/><path d="M10.5 10.5L14.5 14.5"/>
            </svg>
            <input class="topbar-search tm-search" type="text" id="scSearch" placeholder="${t('scheduledTasks.searchPlaceholder')}">
          </div>
        </div>
      </div>

      <div class="tm-stats" id="scStats"></div>

      <div class="card-grid sc-grid" id="scGrid">
        <div class="empty-state" style="padding:var(--space-xl);">${t('common.loading')}</div>
      </div>
    </div>
    <div id="scRunsContainer"></div>
  `;

  // Bind filters
  document.getElementById('scFilterStatus')?.addEventListener('change', (e) => {
    filterStatus = e.target.value;
    applyFilters();
  });
  document.getElementById('scFilterType')?.addEventListener('change', (e) => {
    filterType = e.target.value;
    applyFilters();
  });

  const debouncedSearch = debounce((val) => {
    searchQuery = val.toLowerCase();
    applyFilters();
  }, 250);
  document.getElementById('scSearch')?.addEventListener('input', (e) => debouncedSearch(e.target.value));

  // New button → create in edit mode
  document.getElementById('scNewBtn')?.addEventListener('click', () => {
    editingTaskId = '__new__';
    renderGrid();
  });

  // Load reference data + scheduled tasks
  await Promise.all([loadTasks(), loadRefs()]);

  // SSE live updates
  const onTask = () => { if (!editingTaskId) loadTasks(); };
  state.addEventListener('sse:task', onTask);

  return () => {
    state.removeEventListener('sse:task', onTask);
  };
}

async function loadRefs() {
  try {
    const [pRes, aRes] = await Promise.all([api.projects.list(), api.agents.list()]);
    projects = (pRes.projects || []).filter(p => p.id !== 'default' && p.status !== 'archived');
    agents = (aRes.agents || aRes || []).filter(a => a.status !== 'archived');
  } catch {}
}

async function loadTasks() {
  try {
    const data = await api.scheduled.list();
    allTasks = data.tasks || [];
    applyFilters();
  } catch (err) {
    console.error('[ScheduledTasks] Load error:', err);
    const grid = document.getElementById('scGrid');
    if (grid) grid.innerHTML = `<div class="empty-state" style="padding:var(--space-xl);color:var(--accent-red);">${t('common.loadError')}</div>`;
  }
}

function applyFilters() {
  filteredTasks = allTasks.filter(tk => {
    if (filterStatus !== 'all' && tk.status !== filterStatus) return false;
    if (filterType !== 'all' && tk.scheduleType !== filterType) return false;
    if (searchQuery) {
      const hay = `${tk.name || ''} ${tk.description || ''} ${tk.taskTemplate || ''}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });
  renderStats();
  renderGrid();
}

function renderStats() {
  const el = document.getElementById('scStats');
  if (!el) return;

  const active = allTasks.filter(tk => tk.status === 'active').length;
  const paused = allTasks.filter(tk => tk.status === 'paused').length;
  const totalErrors = allTasks.reduce((sum, tk) => sum + (tk.errorCount || 0), 0);
  const totalRuns = allTasks.reduce((sum, tk) => sum + (tk.runCount || 0), 0);

  el.innerHTML = `
    <span class="tm-stat"><span class="status-dot running"></span> ${active} ${t('status.activeLower')}</span>
    <span class="tm-stat"><span class="status-dot paused"></span> ${paused} ${t('status.pausedLower')}</span>
    <span class="tm-stat"><span class="status-dot done"></span> ${totalRuns} ${t('status.doneLower')}</span>
    <span class="tm-stat"><span class="status-dot error"></span> ${totalErrors} ${t('status.errorLower')}</span>
    <span class="tm-stat-total">${filteredTasks.length}/${allTasks.length} ${t('common.displayed')}</span>
  `;
}

function renderGrid() {
  const grid = document.getElementById('scGrid');
  if (!grid) return;

  let cards = '';

  // If creating new, show edit card at top
  if (editingTaskId === '__new__') {
    cards += renderEditCard({
      id: '__new__', name: '', description: '', taskTemplate: '',
      scheduleType: 'interval', scheduleConfig: { interval_ms: 3600000 },
      projectId: null, agentId: null, maxRetries: 3, retryDelayMs: 60000,
    });
  }

  if (filteredTasks.length === 0 && editingTaskId !== '__new__') {
    grid.innerHTML = `<div class="empty-state" style="padding:var(--space-xl);">${t('scheduledTasks.noScheduledTasks')}</div>`;
    return;
  }

  cards += filteredTasks.map(tk => {
    if (editingTaskId === tk.id) return renderEditCard(tk);
    return renderViewCard(tk);
  }).join('');

  grid.innerHTML = cards;
  bindCardEvents(grid);
}

function renderViewCard(task) {
  const scheduleText = formatSchedule(task.scheduleType, task.scheduleConfig);
  const nextRun = task.nextRunAt ? formatFutureTime(task.nextRunAt) : '-';
  const lastRun = task.lastRunAt ? formatRelative(task.lastRunAt) : t('scheduledTasks.never');

  return `
    <div class="card sc-card" data-task-id="${task.id}">
      <div class="sc-card-top">
        <div class="sc-card-info">
          <div class="sc-card-name">${esc(task.name)}</div>
        </div>
        <span class="sc-schedule-badge ${task.scheduleType}">${esc(task.scheduleType)}</span>
      </div>
      ${task.description ? `<div class="sc-card-desc">${esc(truncate(task.description, 120))}</div>` : ''}
      <div class="sc-card-schedule">${esc(scheduleText)}</div>
      ${task.nextRunAt ? `<div class="sc-card-next-run">${t('scheduledTasks.next')} ${esc(nextRun)}</div>` : ''}
      <div class="sc-card-stats">
        <span>${task.runCount || 0} ${(task.runCount || 0) !== 1 ? t('scheduledTasks.executions') : t('scheduledTasks.execution')}</span>
        ${task.errorCount > 0 ? `<span class="error-count">${task.errorCount} ${t('status.errorLower')}</span>` : ''}
      </div>
      <div class="sc-card-footer">
        <span class="sc-card-date">${t('scheduledTasks.lastRun')}: ${esc(lastRun)}</span>
        <span class="badge ${statusBadgeClass(task.status)}">${statusLabel(task.status)}</span>
      </div>
      <div class="sc-card-actions">
        <button class="btn btn-sm" data-action="edit" data-tid="${task.id}" title="${t('scheduledTasks.editBtn')}">&#9998;</button>
        ${task.status === 'active'
          ? `<button class="btn btn-sm btn-warning" data-action="pause" data-tid="${task.id}" title="${t('scheduledTasks.pauseBtn')}">&#10074;&#10074;</button>`
          : `<button class="btn btn-sm btn-success" data-action="activate" data-tid="${task.id}" title="${t('scheduledTasks.activateBtn')}">&#9654;</button>`
        }
        <button class="btn btn-sm btn-primary" data-action="trigger" data-tid="${task.id}" title="${t('scheduledTasks.triggerBtn')}">&#9889;</button>
        <button class="btn btn-sm" data-action="runs" data-tid="${task.id}" title="${t('scheduledTasks.history')}">&#128196;</button>
        <button class="btn btn-sm btn-danger" data-action="archive" data-tid="${task.id}" title="${t('scheduledTasks.archiveBtn')}">&#128465;</button>
      </div>
    </div>`;
}

function renderEditCard(task) {
  const isNew = task.id === '__new__';
  const config = task.scheduleConfig || {};
  const intervalMs = config.interval_ms || config.intervalMs || 3600000; // Support both formats
  // Convert to best unit
  let intervalVal, intervalUnit;
  if (intervalMs >= 86400000) { intervalVal = Math.round(intervalMs / 86400000); intervalUnit = 'days'; }
  else if (intervalMs >= 3600000) { intervalVal = Math.round(intervalMs / 3600000); intervalUnit = 'hours'; }
  else { intervalVal = Math.round(intervalMs / 60000); intervalUnit = 'minutes'; }

  return `
    <div class="card sc-card sc-card-editing" data-task-id="${task.id}">
      <div class="form-group">
        <label class="form-label">${t('common.name')}</label>
        <input class="input" type="text" id="scEditName" value="${esc(task.name || '')}" placeholder="${t('scheduledTasks.namePlaceholder')}" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">${t('common.description')}</label>
        <textarea class="input" id="scEditDesc" rows="2" placeholder="${t('scheduledTasks.descPlaceholder')}">${esc(task.description || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">${t('scheduledTasks.promptLabel')}</label>
        <textarea class="input" id="scEditTemplate" rows="3" placeholder="${t('scheduledTasks.promptPlaceholder')}">${esc(task.taskTemplate || '')}</textarea>
      </div>
      <div class="form-group">
        <label class="form-label">${t('scheduledTasks.scheduleType')}</label>
        <select class="select" id="scEditType">
          <option value="interval" ${task.scheduleType === 'interval' ? 'selected' : ''}>${t('scheduledTasks.intervalType')}</option>
          <option value="cron" ${task.scheduleType === 'cron' ? 'selected' : ''}>${t('scheduledTasks.cronType')}</option>
          <option value="manual" ${task.scheduleType === 'manual' ? 'selected' : ''}>${t('scheduledTasks.manualType')}</option>
        </select>
      </div>
      <div id="scEditScheduleFields">
        ${renderScheduleFields(task.scheduleType, intervalVal, intervalUnit, config.cronExpression || config.cron || '')}
      </div>
      <div class="sc-edit-row">
        <div class="form-group">
          <label class="form-label">${t('scheduledTasks.projectOptional')}</label>
          <select class="select" id="scEditProject">
            <option value="">${t('scheduledTasks.none')}</option>
            ${projects.map(p => `<option value="${p.id}" ${task.projectId === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">${t('scheduledTasks.agentOptional')}</label>
          <select class="select" id="scEditAgent">
            <option value="">${t('scheduledTasks.none')}</option>
            ${agents.map(a => `<option value="${a.id}" ${task.agentId === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="sc-edit-row">
        <div class="form-group">
          <label class="form-label">${t('scheduledTasks.maxRetries')}</label>
          <input class="input" type="number" id="scEditRetries" value="${task.maxRetries ?? 3}" min="0" max="10">
        </div>
        <div class="form-group">
          <label class="form-label">${t('scheduledTasks.retryDelay')}</label>
          <input class="input" type="number" id="scEditRetryDelay" value="${Math.round((task.retryDelayMs || 60000) / 1000)}" min="10">
        </div>
      </div>
      <div class="sc-card-edit-actions">
        <button class="btn btn-sm" data-action="cancel-edit">${t('common.cancel')}</button>
        <button class="btn btn-sm btn-primary" data-action="save-edit" data-tid="${task.id}">${isNew ? t('common.create') : t('common.save')}</button>
      </div>
    </div>`;
}

function renderScheduleFields(type, intervalVal, intervalUnit, cronExpr) {
  if (type === 'interval') {
    return `
      <div class="sc-edit-row">
        <div class="form-group">
          <label class="form-label">${t('scheduledTasks.interval')}</label>
          <input class="input" type="number" id="scEditIntervalVal" value="${intervalVal || 1}" min="1">
        </div>
        <div class="form-group">
          <label class="form-label">${t('scheduledTasks.unit')}</label>
          <select class="select" id="scEditIntervalUnit">
            <option value="minutes" ${intervalUnit === 'minutes' ? 'selected' : ''}>${t('scheduledTasks.minutes')}</option>
            <option value="hours" ${intervalUnit === 'hours' ? 'selected' : ''}>${t('scheduledTasks.hours')}</option>
            <option value="days" ${intervalUnit === 'days' ? 'selected' : ''}>${t('scheduledTasks.days')}</option>
          </select>
        </div>
      </div>`;
  }
  if (type === 'cron') {
    return `
      <div class="form-group">
        <label class="form-label">${t('scheduledTasks.cronType')}</label>
        <input class="input" type="text" id="scEditCron" value="${esc(cronExpr)}" placeholder="0 */2 * * *" autocomplete="off">
        <div class="sc-edit-help">${t('scheduledTasks.cronHelp')}</div>
      </div>`;
  }
  return `<div class="sc-edit-help" style="padding:var(--space-xs) 0;">${t('scheduledTasks.manualHelp')}</div>`;
}

function bindCardEvents(grid) {
  // Card click (no action on editing cards)
  grid.querySelectorAll('.sc-card:not(.sc-card-editing)').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-action]')) return;
      // Open runs panel on card click
      const tid = card.dataset.taskId;
      const task = allTasks.find(tk => tk.id === tid);
      if (task) openRunsPanel(tid, task.name);
    });
  });

  // Schedule type change → re-render fields
  const typeSelect = grid.querySelector('#scEditType');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      const fields = document.getElementById('scEditScheduleFields');
      if (fields) fields.innerHTML = renderScheduleFields(typeSelect.value, 1, 'hours', '');
    });
  }

  // Action buttons
  grid.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const tid = btn.dataset.tid;

      switch (action) {
        case 'edit':
          editingTaskId = tid;
          renderGrid();
          break;
        case 'cancel-edit':
          editingTaskId = null;
          renderGrid();
          break;
        case 'save-edit':
          handleSave(tid);
          break;
        case 'pause':
          handlePause(tid);
          break;
        case 'activate':
          handleActivate(tid);
          break;
        case 'trigger':
          handleTrigger(tid);
          break;
        case 'runs':
          const task = allTasks.find(tk => tk.id === tid);
          openRunsPanel(tid, task?.name || tid);
          break;
        case 'archive':
          handleArchive(btn, tid);
          break;
      }
    });
  });
}

function buildScheduleConfig() {
  const type = document.getElementById('scEditType')?.value;
  if (type === 'interval') {
    const val = parseInt(document.getElementById('scEditIntervalVal')?.value) || 1;
    const unit = document.getElementById('scEditIntervalUnit')?.value || 'hours';
    const multipliers = { minutes: 60000, hours: 3600000, days: 86400000 };
    return { interval_ms: val * (multipliers[unit] || 3600000) };
  }
  if (type === 'cron') {
    return { cronExpression: document.getElementById('scEditCron')?.value.trim() || '', timezone: 'Europe/Paris' };
  }
  return {};
}

async function handleSave(taskId) {
  const isNew = taskId === '__new__';
  const name = document.getElementById('scEditName')?.value.trim();
  const description = document.getElementById('scEditDesc')?.value.trim();
  const taskTemplate = document.getElementById('scEditTemplate')?.value.trim();
  const scheduleType = document.getElementById('scEditType')?.value;
  const scheduleConfig = buildScheduleConfig();
  const projectId = document.getElementById('scEditProject')?.value || null;
  const agentId = document.getElementById('scEditAgent')?.value || null;
  const maxRetries = parseInt(document.getElementById('scEditRetries')?.value) || 3;
  const retryDelayMs = (parseInt(document.getElementById('scEditRetryDelay')?.value) || 60) * 1000;

  if (!name || !taskTemplate) {
    showToast({ type: 'error', title: t('common.error'), message: t('scheduledTasks.nameRequired') });
    return;
  }

  try {
    const data = { name, description, taskTemplate, scheduleType, scheduleConfig,
                   projectId, agentId, maxRetries, retryDelayMs };
    if (isNew) {
      await api.scheduled.create(data);
      showToast({ type: 'success', title: t('scheduledTasks.taskCreated'), message: name });
    } else {
      await api.scheduled.update(taskId, data);
      showToast({ type: 'success', title: t('scheduledTasks.taskUpdated'), message: name });
    }
    editingTaskId = null;
    await loadTasks();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

async function handlePause(taskId) {
  try {
    await api.scheduled.pause(taskId);
    showToast({ type: 'warning', title: t('scheduledTasks.schedulePaused'), message: taskId.slice(0, 8) });
    await loadTasks();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

async function handleActivate(taskId) {
  try {
    await api.scheduled.activate(taskId);
    showToast({ type: 'success', title: t('scheduledTasks.scheduleActivated'), message: taskId.slice(0, 8) });
    await loadTasks();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

async function handleTrigger(taskId) {
  try {
    await api.scheduled.trigger(taskId);
    showToast({ type: 'success', title: t('scheduledTasks.triggerStarted'), message: taskId.slice(0, 8) });
    await loadTasks();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

function handleArchive(archiveBtn, taskId) {
  const task = allTasks.find(tk => tk.id === taskId);
  const original = archiveBtn.outerHTML;
  const confirmEl = document.createElement('span');
  confirmEl.className = 'inline-confirm';
  confirmEl.innerHTML = `${t('scheduledTasks.archiveConfirm')} <button class="btn btn-sm btn-danger ic-yes">${t('common.yes')}</button> <button class="btn btn-sm ic-no">${t('common.no')}</button>`;
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
      await api.scheduled.archive(taskId);
      const card = confirmEl.closest('.sc-card');
      if (card) {
        card.style.transition = 'opacity 0.3s, transform 0.3s';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.95)';
        await new Promise(r => setTimeout(r, 300));
      }
      showToast({ type: 'info', title: t('scheduledTasks.taskArchived'), message: task?.name || taskId });
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

// ── Runs Panel ──

async function openRunsPanel(taskId, taskName) {
  const container = document.getElementById('scRunsContainer');
  if (!container) return;

  runsPanel = { taskId, taskName };

  container.innerHTML = `
    <div class="sc-runs-overlay" id="scRunsOverlay"></div>
    <div class="sc-runs-panel">
      <div class="sc-runs-header">
        <h3>${t('scheduledTasks.historyTitle')}${esc(taskName)}</h3>
        <button class="btn btn-sm" id="scRunsClose">&times;</button>
      </div>
      <div class="sc-runs-body" id="scRunsBody">
        <div class="empty-state">${t('common.loading')}</div>
      </div>
    </div>
  `;

  container.querySelector('#scRunsClose')?.addEventListener('click', closeRunsPanel);
  container.querySelector('#scRunsOverlay')?.addEventListener('click', closeRunsPanel);

  try {
    const data = await api.scheduled.runs(taskId);
    const runs = data.runs || [];
    const body = container.querySelector('#scRunsBody');
    if (!body) return;

    if (runs.length === 0) {
      body.innerHTML = `<div class="empty-state" style="padding:var(--space-lg);">${t('scheduledTasks.noRuns')}</div>`;
      return;
    }

    body.innerHTML = `
      <table class="sc-runs-table">
        <thead>
          <tr><th>${t('scheduledTasks.colDate')}</th><th>${t('common.status')}</th><th>${t('tasks.task')}</th><th>${t('scheduledTasks.colResult')}</th></tr>
        </thead>
        <tbody>
          ${runs.map(r => `
            <tr>
              <td>${r.startedAt ? formatRelative(r.startedAt) : formatRelative(r.createdAt)}</td>
              <td><span class="badge ${statusBadgeClass(r.status)}">${statusLabel(r.status)}</span></td>
              <td>${r.taskId ? `<span style="font-family:var(--font-mono);font-size:var(--text-2xs)">${r.taskId}</span>` : '-'}</td>
              <td>${r.error ? `<span style="color:var(--accent-red)">${esc(truncate(r.error, 80))}</span>` : r.result ? esc(truncate(r.result, 80)) : '-'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  } catch (err) {
    const body = container.querySelector('#scRunsBody');
    if (body) body.innerHTML = `<div class="empty-state" style="color:var(--accent-red);">${t('scheduledTasks.errorPrefix')} ${esc(err.message)}</div>`;
  }
}

function closeRunsPanel() {
  const container = document.getElementById('scRunsContainer');
  if (container) container.innerHTML = '';
  runsPanel = null;
}

// ── Utils ──

function formatSchedule(type, config) {
  if (type === 'manual') return t('scheduledTasks.manualTrigger');
  if (type === 'interval') {
    const ms = config?.interval_ms || config?.intervalMs; // Support both formats
    if (!ms) return t('scheduledTasks.undefinedInterval');
    if (ms >= 86400000) return `${t('scheduledTasks.every')} ${Math.round(ms / 86400000)}${t('scheduledTasks.daysAbbrev')}`;
    if (ms >= 3600000) return `${t('scheduledTasks.every')} ${Math.round(ms / 3600000)}${t('scheduledTasks.hoursAbbrev')}`;
    return `${t('scheduledTasks.every')} ${Math.round(ms / 60000)}${t('scheduledTasks.minutesAbbrev')}`;
  }
  if (type === 'cron') return config?.cronExpression || config?.cron || t('scheduledTasks.undefinedCron');
  return '?';
}
