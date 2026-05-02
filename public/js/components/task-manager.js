/* ═══════════════════════════════════════════════════════
   YABBY — Task Manager View (Phase 5)
   Sortable table with filters, inline actions, expandable rows
   Incremental DOM updates — zero flashing on live data
   ═══════════════════════════════════════════════════════ */

import { state } from '../state.js';
import { api } from '../api.js';
import { esc, formatDuration, formatRelative, truncate, statusBadgeClass, statusLabel, debounce } from '../utils.js';
import { showToast } from './toast.js';
import { openCreateTaskModal, openModal } from './modal.js';
import { navigate } from '../router.js';
import { t } from '../i18n.js';
import { getAgentQueue } from '../api.js';

// View state
let allTasks = [];
let filteredTasks = [];
let displayedTasks = [];
let projects = [];
let sortCol = 'updated_at';
let sortDir = 'desc';
let filterStatus = 'all';
let filterProject = 'all';
let filterDate = 'all'; // all, today, yesterday, week, month
let searchQuery = '';
let expandedTaskId = null;

// Pagination state
let currentPage = 1; // Pages start at 1 for UI clarity
let pageSize = 50;
let totalPages = 1;

// Incremental update state
let taskDataMap = new Map();        // taskId → { status, elapsed, ... } for change detection
let expandedLogCount = 0;           // lines already rendered in expanded detail
let lastRenderIncremental = false;  // whether last renderTable() was incremental
let forceFullRebuild = false;       // force full table rebuild (expand/collapse toggle)

// Queue data cache: agentId → { queue_length, queued_tasks, agent_name }
let queueCache = new Map();

export async function render(container, params) {
  // Reset incremental state on fresh render
  taskDataMap.clear();
  queueCache.clear();
  expandedLogCount = 0;
  lastRenderIncremental = false;
  forceFullRebuild = false;
  queueDelegationBound = false;

  container.innerHTML = `
    <div class="tm-view">
      <div class="tm-header">
        <div class="tm-title-row">
          <h2 class="tm-title">${t('tasks.title')} <span class="tm-update-dot" id="tmUpdateDot"></span></h2>
          <button class="btn btn-primary" id="tmNewTaskBtn">${t('tasks.newTask')}</button>
        </div>
        <div class="tm-filters">
          <div class="tm-filter-group">
            <select class="select tm-select" id="tmFilterStatus" aria-label="${t('tasks.allStatuses')}">
              <option value="all">${t('tasks.allStatuses')}</option>
              <option value="running">${t('status.running')}</option>
              <option value="paused">${t('status.paused')}</option>
              <option value="done">${t('status.done')}</option>
              <option value="error">${t('status.error')}</option>
              <option value="killed">${t('status.killed')}</option>
            </select>
            <select class="select tm-select" id="tmFilterProject" aria-label="${t('tasks.allProjects')}">
              <option value="all">${t('tasks.allProjects')}</option>
            </select>
            <select class="select tm-select" id="tmFilterDate">
              <option value="all">${t('tasks.allDates')}</option>
              <option value="today">${t('tasks.today')}</option>
              <option value="yesterday">${t('tasks.yesterday')}</option>
              <option value="week">${t('tasks.thisWeek')}</option>
              <option value="month">${t('tasks.thisMonth')}</option>
            </select>
          </div>
          <div class="topbar-search-wrap tm-search-wrap">
            <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="5"/><path d="M10.5 10.5L14.5 14.5"/></svg>
            <input class="topbar-search tm-search" type="text" id="tmSearch" placeholder="${t('tasks.searchPlaceholder')}" aria-label="${t('tasks.searchPlaceholder')}">
          </div>
        </div>
      </div>

      <div class="tm-stats" id="tmStats"></div>

      <div class="table-wrap" id="tmTableWrap">
        <table class="table tm-table">
          <thead>
            <tr>
              <th data-sort="title" class="sortable">${t('tasks.task')}</th>
              <th data-sort="created_at" class="sortable">${t('common.date')}</th>
              <th data-sort="updated_at" class="sortable">${t('tasks.lastUpdate') || 'Last update'}</th>
              <th data-sort="project" class="sortable">${t('tasks.project')}</th>
              <th data-sort="agent" class="sortable">${t('tasks.agent')}</th>
              <th data-sort="status" class="sortable">${t('common.status')}</th>
              <th>${t('tasks.queue')}</th>
              <th data-sort="elapsed" class="sortable">${t('tasks.duration')}</th>
              <th style="text-align: right;">${t('common.actions')}</th>
            </tr>
          </thead>
          <tbody id="tmTableBody">
            <tr><td colspan="9" class="empty-state" style="padding: var(--space-xl);">${t('common.loading')}</td></tr>
          </tbody>
        </table>
      </div>

      <div id="tmPagination" style="display: none; margin-top: var(--space-lg); padding: var(--space-lg); border-top: 1px solid var(--border-color); display: flex; align-items: center; justify-content: space-between; gap: var(--space-md);">
        <div style="color: var(--text-secondary); font-size: var(--text-sm);">
          <span id="tmPaginationInfo"></span>
        </div>
        <div style="display: flex; gap: var(--space-xs);">
          <button class="btn btn-sm" id="tmPaginationFirst" title="${t('tasks.firstPage')}">
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M11 3l-5 4 5 4M6 3L1 7l5 4"/>
            </svg>
          </button>
          <button class="btn btn-sm" id="tmPaginationPrev" title="${t('tasks.prevPage') || 'Previous page'}">
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M9 3L4 7l5 4"/>
            </svg>
          </button>
          <div style="display: flex; align-items: center; gap: var(--space-xs); padding: 0 var(--space-sm);">
            <span style="font-size: var(--text-sm); color: var(--text-secondary);">Page</span>
            <input type="number" id="tmPaginationInput" min="1" style="width: 60px; text-align: center; padding: 4px 8px; border: 1px solid var(--border-color); border-radius: 4px; background: var(--bg-primary); color: var(--text-primary);" />
            <span style="font-size: var(--text-sm); color: var(--text-secondary);">/ <span id="tmPaginationTotal">1</span></span>
          </div>
          <button class="btn btn-sm" id="tmPaginationNext" title="${t('tasks.nextPage') || 'Next page'}">
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M5 3l5 4-5 4"/>
            </svg>
          </button>
          <button class="btn btn-sm" id="tmPaginationLast" title="${t('tasks.lastPage')}">
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8">
              <path d="M3 3l5 4-5 4M8 3l5 4-5 4"/>
            </svg>
          </button>
        </div>
        <div style="display: flex; align-items: center; gap: var(--space-sm);">
          <label for="tmPageSize" style="font-size: var(--text-sm); color: var(--text-secondary);">${t('tasks.tasksPerPage')}</label>
          <select class="select" id="tmPageSize" style="width: auto; min-width: 80px;">
            <option value="25">25</option>
            <option value="50" selected>50</option>
            <option value="100">100</option>
            <option value="200">200</option>
          </select>
        </div>
      </div>
    </div>
  `;

  // Bind new task
  document.getElementById('tmNewTaskBtn')?.addEventListener('click', () => {
    openCreateTaskModal(projects, (result) => {
      showToast({ type: 'success', title: t('tasks.launched'), message: result.task_id?.slice(0, 8) });
      loadTasks();
    });
  });

  // Bind filters
  document.getElementById('tmFilterStatus')?.addEventListener('change', (e) => {
    filterStatus = e.target.value;
    applyFilters();
  });
  document.getElementById('tmFilterProject')?.addEventListener('change', (e) => {
    filterProject = e.target.value;
    applyFilters();
  });
  document.getElementById('tmFilterDate')?.addEventListener('change', (e) => {
    filterDate = e.target.value;
    applyFilters();
  });
  document.getElementById('tmSearch')?.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    applyFilters();
  });

  // Bind table header sort
  container.querySelectorAll('th[data-sort]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.sort;
      if (sortCol === col) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortCol = col;
        sortDir = col === 'elapsed' ? 'desc' : 'asc';
      }
      updateSortIndicators();
      applyFilters();
    });
  });

  // Bind pagination controls
  document.getElementById('tmPaginationFirst')?.addEventListener('click', () => goToPage(1));
  document.getElementById('tmPaginationPrev')?.addEventListener('click', () => goToPage(currentPage - 1));
  document.getElementById('tmPaginationNext')?.addEventListener('click', () => goToPage(currentPage + 1));
  document.getElementById('tmPaginationLast')?.addEventListener('click', () => goToPage(totalPages));

  document.getElementById('tmPaginationInput')?.addEventListener('change', (e) => {
    const page = parseInt(e.target.value);
    if (page >= 1 && page <= totalPages) {
      goToPage(page);
    }
  });

  document.getElementById('tmPageSize')?.addEventListener('change', (e) => {
    pageSize = parseInt(e.target.value);
    currentPage = 1;
    applyFilters();
  });

  // Pre-apply filter from query params (e.g. /tasks?status=running from dashboard)
  if (params?.status) {
    filterStatus = params.status;
    const sel = document.getElementById('tmFilterStatus');
    if (sel) sel.value = params.status;
  }

  // Load data
  await loadTasks();

  // Set initial sort indicator
  updateSortIndicators();

  // SSE updates — debounced full refresh + immediate micro-updates
  const debouncedRefresh = debounce(() => loadTasks(true), 1500);
  const onTask = (e) => {
    applyMicroUpdate(e.detail);
    showUpdateIndicator();
    debouncedRefresh();
  };
  state.addEventListener('sse:task', onTask);

  // Per-row local tick (1s) — updates elapsed/duration on every running row
  // without any server call. Without this, a running task's duration freezes
  // until an SSE event fires.
  const liveTickHandle = setInterval(() => tickRunningRows(), 1000);

  // Light periodic refresh (10s) — picks up queue counts, last_update times,
  // and any status/action changes that didn't fire SSE. Per-row patch only —
  // never resets filters, page, or scroll position.
  const periodicRefreshHandle = setInterval(() => loadTasks(true), 10000);

  return () => {
    state.removeEventListener('sse:task', onTask);
    clearInterval(liveTickHandle);
    clearInterval(periodicRefreshHandle);
  };
}

/* ── Per-row local tick: keep running task durations live ── */

function tickRunningRows() {
  const now = Date.now();
  for (const task of allTasks) {
    if (task.status !== 'running') continue;
    if (!task.startTime) continue;
    const liveElapsed = Math.round((now - new Date(task.startTime).getTime()) / 1000);
    if (!Number.isFinite(liveElapsed) || liveElapsed < 0) continue;
    const row = document.querySelector(`.tm-row[data-task-id="${task.id}"]`);
    if (!row) continue;
    const elapsedCell = row.querySelector('.tm-cell-elapsed');
    if (elapsedCell) {
      const next = formatDuration(liveElapsed);
      if (elapsedCell.textContent !== next) elapsedCell.textContent = next;
    }
    // Also bump expanded detail's elapsed if this task is the one open
    if (task.id === expandedTaskId) {
      const expandedElapsed = document.querySelector('.tm-detail-elapsed');
      if (expandedElapsed) {
        const next = formatDuration(liveElapsed);
        if (expandedElapsed.textContent !== next) expandedElapsed.textContent = next;
      }
    }
  }
}

/* ── Micro-updates: apply SSE data inline without full reload ── */

function applyMicroUpdate(data) {
  const { taskId, type, detail } = data;
  if (!taskId) return;

  if (type === 'status') {
    // Update local task cache
    const task = allTasks.find(tk => tk.id === taskId);
    if (task) {
      task.status = detail.status;
      if (detail.elapsed) task.elapsed = detail.elapsed;
    }

    // Update the row inline
    const row = document.querySelector(`.tm-row[data-task-id="${taskId}"]`);
    if (row) {
      const badge = row.querySelector('.badge');
      if (badge) {
        badge.className = `badge ${statusBadgeClass(detail.status)}`;
        badge.textContent = statusLabel(detail.status);
      }
      if (detail.elapsed) {
        const elapsedCell = row.querySelector('.tm-cell-elapsed');
        if (elapsedCell) elapsedCell.textContent = formatDuration(detail.elapsed);
      }
      // Update actions (depend on status)
      if (task) {
        const actionsCell = row.querySelector('.actions');
        if (actionsCell) {
          actionsCell.innerHTML = renderActions(task);
          actionsCell.querySelectorAll('[data-action]').forEach(btn => {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              handleAction(btn.dataset.action, btn.dataset.tid);
            });
          });
        }
      }
    }

    renderStats();
  }

  // Update local timestamp
  const task = allTasks.find(tk => tk.id === taskId);
  if (task) {
    task.last_log_time = new Date().toISOString();
  }
}

/* ── Update indicator ── */

function showUpdateIndicator() {
  document.getElementById('tmUpdateDot')?.classList.add('active');
}

function hideUpdateIndicator() {
  document.getElementById('tmUpdateDot')?.classList.remove('active');
}

/* ── Data loading ── */

async function loadTasks(isUpdate = false) {
  try {
    const [tasksRes, projectsRes] = await Promise.all([
      api.tasks.list(),
      api.projects.list(),
    ]);

    allTasks = tasksRes.tasks || [];
    projects = (projectsRes.projects || []).filter(p => p.id !== 'default');

    // Populate project filter dropdown (once)
    const sel = document.getElementById('tmFilterProject');
    if (sel && sel.options.length <= 1) {
      projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
    }

    // Don't reset page or scroll on SSE updates
    applyFilters(!isUpdate);
    loadQueueCounts(); // async, updates cells when ready

    if (isUpdate) hideUpdateIndicator();
  } catch (err) {
    console.error('[TaskManager] Load error:', err);
    if (isUpdate) hideUpdateIndicator();
  }
}

/* ── Filtering & sorting ── */

function applyFilters(resetPage = true) {
  // Save scroll position before filtering
  const scrollPos = window.scrollY;

  filteredTasks = allTasks.filter(t => {
    if (filterStatus !== 'all' && t.status !== filterStatus) return false;
    if (filterProject !== 'all' && t.project_id !== filterProject) return false;
    if (filterDate !== 'all') {
      const taskDate = new Date(t.created_at);
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterday = new Date(today);
      yesterday.setDate(yesterday.getDate() - 1);
      const weekStart = new Date(today);
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

      switch (filterDate) {
        case 'today':
          if (taskDate < today) return false;
          break;
        case 'yesterday':
          if (taskDate < yesterday || taskDate >= today) return false;
          break;
        case 'week':
          if (taskDate < weekStart) return false;
          break;
        case 'month':
          if (taskDate < monthStart) return false;
          break;
      }
    }
    if (searchQuery) {
      const hay = `${t.title || ''} ${t.id} ${t.agent_id || ''}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });

  // Sort
  filteredTasks.sort((a, b) => {
    let va, vb;
    switch (sortCol) {
      case 'title':
        va = (a.title || a.id || '').toLowerCase();
        vb = (b.title || b.id || '').toLowerCase();
        break;
      case 'project':
        va = findProjectName(a.project_id) || '';
        vb = findProjectName(b.project_id) || '';
        break;
      case 'agent':
        va = a.agent_id || '';
        vb = b.agent_id || '';
        break;
      case 'status':
        const order = { running: 0, paused: 1, error: 2, done: 3, killed: 4 };
        va = order[a.status] ?? 9;
        vb = order[b.status] ?? 9;
        break;
      case 'elapsed':
        va = a.elapsed || 0;
        vb = b.elapsed || 0;
        break;
      case 'updated_at':
        // Use last_log_time for more accurate sorting
        va = a.last_log_time || a.updated_at || a.created_at || '';
        vb = b.last_log_time || b.updated_at || b.created_at || '';
        break;
      default:
        va = a.created_at || '';
        vb = b.created_at || '';
    }
    if (va < vb) return sortDir === 'asc' ? -1 : 1;
    if (va > vb) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  // Reset to first page only when user changes filters (not on SSE updates)
  if (resetPage) {
    currentPage = 1;
  }

  // Calculate total pages
  totalPages = Math.max(1, Math.ceil(filteredTasks.length / pageSize));

  renderStats();
  renderTable();
  renderPagination();

  // Refresh expanded detail
  if (expandedTaskId && displayedTasks.find(tk => tk.id === expandedTaskId)) {
    if (lastRenderIncremental) {
      // Table rows updated in place — expanded detail still alive, do incremental log refresh
      refreshExpandedLogs(expandedTaskId);
    } else {
      // Table was fully rebuilt — expanded detail was recreated, do full load
      loadExpandedDetail(expandedTaskId);
    }
  }

  // Restore scroll position (don't scroll to top on updates)
  if (!resetPage) {
    requestAnimationFrame(() => {
      window.scrollTo(0, scrollPos);
    });
  }
}

/* ── Pagination ── */

function goToPage(page, shouldScroll = true) {
  if (page < 1 || page > totalPages || page === currentPage) return;

  currentPage = page;

  renderTable();
  renderPagination();

  // Scroll to top of table only when explicitly navigating (not on SSE updates)
  if (shouldScroll) {
    document.getElementById('tmTableWrap')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function renderPagination() {
  const paginationEl = document.getElementById('tmPagination');
  const infoEl = document.getElementById('tmPaginationInfo');
  const inputEl = document.getElementById('tmPaginationInput');
  const totalEl = document.getElementById('tmPaginationTotal');
  const firstBtn = document.getElementById('tmPaginationFirst');
  const prevBtn = document.getElementById('tmPaginationPrev');
  const nextBtn = document.getElementById('tmPaginationNext');
  const lastBtn = document.getElementById('tmPaginationLast');

  if (!paginationEl) return;

  // Hide pagination if only one page
  if (totalPages <= 1) {
    paginationEl.style.display = 'none';
    return;
  }

  paginationEl.style.display = 'flex';

  // Update info
  const startIdx = (currentPage - 1) * pageSize + 1;
  const endIdx = Math.min(currentPage * pageSize, filteredTasks.length);
  if (infoEl) {
    infoEl.textContent = t('tasks.showingRange', { start: startIdx, end: endIdx, total: filteredTasks.length });
  }

  // Update page input
  if (inputEl) {
    inputEl.value = currentPage;
    inputEl.max = totalPages;
  }

  if (totalEl) {
    totalEl.textContent = totalPages;
  }

  // Update button states
  if (firstBtn) firstBtn.disabled = currentPage === 1;
  if (prevBtn) prevBtn.disabled = currentPage === 1;
  if (nextBtn) nextBtn.disabled = currentPage === totalPages;
  if (lastBtn) lastBtn.disabled = currentPage === totalPages;
}

function renderStats() {
  const el = document.getElementById('tmStats');
  if (!el) return;

  const running = allTasks.filter(t => t.status === 'running').length;
  const paused = allTasks.filter(t => t.status === 'paused').length;
  const done = allTasks.filter(t => t.status === 'done').length;
  const errors = allTasks.filter(t => t.status === 'error').length;

  const displayedCount = displayedTasks.length;
  const filteredCount = filteredTasks.length;
  const totalCount = allTasks.length;

  el.innerHTML = `
    <span class="tm-stat"><span class="status-dot running"></span> ${running} ${t('status.runningLower')}</span>
    <span class="tm-stat"><span class="status-dot paused"></span> ${paused} ${t('status.pausedLower')}</span>
    <span class="tm-stat"><span class="status-dot done"></span> ${done} ${t('status.doneLower')}</span>
    <span class="tm-stat"><span class="status-dot error"></span> ${errors} ${t('status.errorLower')}</span>
    <span class="tm-stat-total">
      ${displayedCount}/${filteredCount} ${t('common.displayed')}
      ${filteredCount < totalCount ? ` (${filteredCount}/${totalCount} filtrées)` : ` (${totalCount} total)`}
    </span>
  `;
}

/* ── Table rendering with incremental updates ── */

function renderTable() {
  const tbody = document.getElementById('tmTableBody');
  if (!tbody) return;

  if (filteredTasks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="empty-state" style="padding: var(--space-xl);">
      ${allTasks.length === 0 ? t('tasks.noTasks') : t('tasks.noFilterResults')}
    </td></tr>`;
    displayedTasks = [];
    lastRenderIncremental = false;
    forceFullRebuild = false;
    return;
  }

  // Calculate current page slice
  const startIdx = (currentPage - 1) * pageSize;
  const endIdx = startIdx + pageSize;
  const pageTasks = filteredTasks.slice(startIdx, endIdx);
  displayedTasks = pageTasks;

  // Check if we can do an incremental update (same task IDs in same order)
  const existingRows = tbody.querySelectorAll('.tm-row');
  const existingIds = [...existingRows].map(r => r.dataset.taskId);
  const newIds = pageTasks.map(tk => tk.id);
  const sameSet = !forceFullRebuild &&
    existingIds.length === newIds.length &&
    existingIds.every((id, i) => id === newIds[i]);

  if (sameSet && existingIds.length > 0) {
    // Incremental: update individual cells without touching DOM structure
    lastRenderIncremental = true;
    existingRows.forEach((row, i) => {
      updateRowInPlace(row, pageTasks[i]);
    });
  } else {
    // Full rebuild (first load, filter/sort change, pagination, expand toggle, tasks added/removed)
    lastRenderIncremental = false;
    tbody.innerHTML = renderTaskRows(pageTasks);
    bindTableEvents(tbody);
    bindQueueButtons();
    // Populate taskDataMap for future change detection
    pageTasks.forEach(tk => {
      taskDataMap.set(tk.id, {
        status: tk.status,
        elapsed: tk.elapsed,
        updated_at: tk.updated_at,
        last_log_time: tk.last_log_time,
      });
    });
  }

  forceFullRebuild = false;
}

function updateRowInPlace(row, task) {
  const prev = taskDataMap.get(task.id);

  // Status badge
  const badge = row.querySelector('.badge');
  if (badge) {
    const newClass = `badge ${statusBadgeClass(task.status)}`;
    const newText = statusLabel(task.status);
    if (badge.className !== newClass) badge.className = newClass;
    if (badge.textContent !== newText) badge.textContent = newText;
  }

  // Elapsed
  const elapsed = task.elapsed ? formatDuration(task.elapsed) : '-';
  const elapsedCell = row.querySelector('.tm-cell-elapsed');
  if (elapsedCell && elapsedCell.textContent !== elapsed) {
    elapsedCell.textContent = elapsed;
  }

  // Updated at (2nd .tm-cell-date)
  const dateCells = row.querySelectorAll('.tm-cell-date');
  if (dateCells[1]) {
    const updatedAt = formatDateTime(task.last_log_time || task.updated_at || task.created_at);
    const dateSpan = dateCells[1].querySelector('.tm-date');
    const timeSpan = dateCells[1].querySelector('.tm-time');
    if (dateSpan && dateSpan.textContent !== updatedAt.date) dateSpan.textContent = updatedAt.date;
    if (timeSpan && timeSpan.textContent !== updatedAt.time) timeSpan.textContent = updatedAt.time;
  }

  // Actions — only if status changed
  if (!prev || prev.status !== task.status) {
    const actionsCell = row.querySelector('.actions');
    if (actionsCell) {
      actionsCell.innerHTML = renderActions(task);
      actionsCell.querySelectorAll('[data-action]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          handleAction(btn.dataset.action, btn.dataset.tid);
        });
      });
    }
  }

  // Update tracking map
  taskDataMap.set(task.id, {
    status: task.status,
    elapsed: task.elapsed,
    updated_at: task.updated_at,
    last_log_time: task.last_log_time,
  });
}

function renderTaskRows(tasks) {
  return tasks.map(task => {
    const pName = findProjectName(task.project_id);
    const elapsed = task.elapsed ? formatDuration(task.elapsed) : '-';
    const createdAt = formatDateTime(task.created_at);
    // Use last_log_time for most accurate update time
    const updatedAt = formatDateTime(task.last_log_time || task.updated_at || task.created_at);
    const isExpanded = task.id === expandedTaskId;

    return `<tr class="tm-row ${isExpanded ? 'expanded' : ''}" data-task-id="${task.id}">
      <td class="tm-cell-title">
        <span class="tm-task-title">${esc(truncate(task.title || task.id, 70))}</span>
        <span class="tm-task-id">${task.id.slice(0, 8)}</span>
      </td>
      <td class="tm-cell-date">
        <span class="tm-date">${createdAt.date}</span>
        <span class="tm-time">${createdAt.time}</span>
      </td>
      <td class="tm-cell-date">
        <span class="tm-date">${updatedAt.date}</span>
        <span class="tm-time">${updatedAt.time}</span>
      </td>
      <td>${pName ? `<span class="tm-project-link" data-project-id="${task.project_id}">${esc(pName)}</span>` : '<span class="tm-no-value">-</span>'}</td>
      <td>${task.agent_id ? `<span class="tm-agent-id">${task.agent_id.slice(0, 8)}</span>` : '<span class="tm-no-value">-</span>'}</td>
      <td><span class="badge ${statusBadgeClass(task.status)}">${statusLabel(task.status)}</span></td>
      <td class="tm-cell-queue">${renderQueueCell(task)}</td>
      <td class="tm-cell-elapsed">${elapsed}</td>
      <td class="actions">${renderActions(task)}</td>
    </tr>
    ${isExpanded ? `<tr class="tm-expanded-row"><td colspan="9">
      <div class="tm-expanded-content" id="tmExpanded_${task.id}">${t('common.loading')}</div>
    </td></tr>` : ''}`;
  }).join('');
}

function bindTableEvents(tbody) {
  // Bind row clicks (expand/collapse)
  tbody.querySelectorAll('.tm-row').forEach(row => {
    if (row.dataset.bound) return;
    row.dataset.bound = 'true';

    row.addEventListener('click', (e) => {
      if (e.target.closest('.actions') || e.target.closest('.tm-project-link')) return;
      const tid = row.dataset.taskId;
      if (expandedTaskId === tid) {
        expandedTaskId = null;
      } else {
        expandedTaskId = tid;
      }
      expandedLogCount = 0;
      forceFullRebuild = true;
      renderTable();
      if (expandedTaskId) loadExpandedDetail(expandedTaskId);
    });
  });

  // Bind project links
  tbody.querySelectorAll('.tm-project-link').forEach(el => {
    if (el.dataset.bound) return;
    el.dataset.bound = 'true';

    el.addEventListener('click', (e) => {
      e.stopPropagation();
      navigate(`/projects/${el.dataset.projectId}`);
    });
  });

  // Bind action buttons
  tbody.querySelectorAll('[data-action]').forEach(btn => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = 'true';

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleAction(btn.dataset.action, btn.dataset.tid);
    });
  });
}

function renderActions(task) {
  const btns = [];
  switch (task.status) {
    case 'running':
      btns.push(`<button class="btn btn-sm btn-warning" data-action="pause" data-tid="${task.id}" title="${t('tasks.pause')}">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3v8M10 3v8"/></svg>
      </button>`);
      btns.push(`<button class="btn btn-sm btn-danger" data-action="kill" data-tid="${task.id}" title="${t('tasks.stop')}">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l8 8M11 3l-8 8"/></svg>
      </button>`);
      break;
    case 'paused':
      btns.push(`<button class="btn btn-sm btn-success" data-action="resume" data-tid="${task.id}" title="${t('tasks.resume')}">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3l8 4-8 4z"/></svg>
      </button>`);
      btns.push(`<button class="btn btn-sm btn-danger" data-action="kill" data-tid="${task.id}" title="${t('tasks.stop')}">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 3l8 8M11 3l-8 8"/></svg>
      </button>`);
      break;
    case 'done':
      btns.push(`<button class="btn btn-sm btn-primary" data-action="continue" data-tid="${task.id}" title="${t('tasks.continue')}">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 7h10M9 4l3 3-3 3"/></svg>
      </button>`);
      break;
    case 'error':
      btns.push(`<button class="btn btn-sm btn-primary" data-action="retry" data-tid="${task.id}" title="${t('common.retry')}">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 7a5 5 0 019-3M12 7a5 5 0 01-9 3"/><path d="M11 1v3h-3M3 13v-3h3"/></svg>
      </button>`);
      break;
    case 'paused_llm_limit':
      btns.push(`<button class="btn btn-sm btn-warning" data-action="resume-llm" data-tid="${task.id}" title="Reprendre (limite LLM)">
        <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3l8 4-8 4z"/></svg>
      </button>`);
      break;
  }
  // Recovery — for any task that's blocked (error / killed / paused_llm_limit
  // or even done if the user knows the session is wedged). Forks the
  // underlying Claude session by dropping the last N lines of the .jsonl,
  // points the agent + task at a fresh session id. Use when retry / continue
  // keep failing on the same internal-state error (image dimension limit,
  // corrupted history, model wedged on a tool result, etc.).
  if (task.status === 'error' || task.status === 'killed' || task.status === 'paused_llm_limit') {
    btns.push(`<button class="btn btn-sm btn-secondary" data-action="recover" data-tid="${task.id}" title="${t('tasks.recover') || 'Fork session (recovery)'}">
      <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M2 7h6M2 7l3-3M2 7l3 3M9 3v8"/></svg>
    </button>`);
  }
  return btns.join('');
}

/* ── Queue column ── */

function renderQueueCell(task) {
  if (!task.agent_id) {
    return '<span class="tm-no-value">-</span>';
  }
  const cached = queueCache.get(task.agent_id);
  if (!cached) {
    // Show clickable placeholder that triggers a fetch on click
    return `<button class="tm-queue-btn tm-queue-loading" data-queue-agent="${task.agent_id}" data-agent-queue="${task.agent_id}" title="${t('tasks.queueOverview')}">
      <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h8M3 7h8M3 10h5"/></svg>
    </button>`;
  }
  const count = cached.queue_length || 0;
  return `<span class="tm-queue-count ${count > 0 ? 'has-items' : 'empty'}">${count}</span>
    <button class="tm-queue-btn" data-queue-agent="${task.agent_id}" title="${t('tasks.queueOverview')}">
      <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h8M3 7h8M3 10h5"/></svg>
    </button>`;
}

async function loadQueueCounts() {
  const agentIds = [...new Set(
    displayedTasks
      .filter(tk => tk.agent_id)
      .map(tk => tk.agent_id)
  )];
  if (agentIds.length === 0) return;

  const results = await Promise.allSettled(
    agentIds.map(id => getAgentQueue(id).then(data => ({ id, data })))
  );

  for (const r of results) {
    if (r.status === 'fulfilled') {
      const { id, data } = r.value;
      queueCache.set(id, {
        queue_length: data.queue_length || 0,
        queued_tasks: data.queued_tasks || [],
        agent_name: data.agent_name || id.slice(0, 8),
      });
    }
  }

  // Patch queue cells in-place
  document.querySelectorAll('.tm-cell-queue').forEach(cell => {
    const placeholder = cell.querySelector('[data-agent-queue]');
    if (!placeholder) return;
    const agentId = placeholder.dataset.agentQueue;
    const row = cell.closest('.tm-row');
    const taskId = row?.dataset.taskId;
    const task = displayedTasks.find(tk => tk.id === taskId);
    if (task) cell.innerHTML = renderQueueCell(task);
  });

  bindQueueButtons();
}

let queueDelegationBound = false;
function bindQueueButtons() {
  if (queueDelegationBound) return;
  const wrap = document.getElementById('tmTableWrap');
  if (!wrap) return;
  queueDelegationBound = true;
  wrap.addEventListener('click', (e) => {
    const btn = e.target.closest('.tm-queue-btn');
    if (!btn) return;
    e.stopPropagation();
    openQueueModal(btn.dataset.queueAgent);
  });
}

async function openQueueModal(agentId) {
  console.log('[QueueModal] Opening for agentId:', agentId);
  let data = queueCache.get(agentId);
  console.log('[QueueModal] Cache:', data);

  // Refresh from API
  try {
    const fresh = await getAgentQueue(agentId);
    console.log('[QueueModal] Fresh API response:', fresh);
    data = {
      queue_length: fresh.queue_length || 0,
      queued_tasks: fresh.queued_tasks || [],
      agent_name: fresh.agent_name || agentId.slice(0, 8),
    };
    queueCache.set(agentId, data);
  } catch (err) {
    console.error('[QueueModal] API error:', err);
  }

  if (!data || data.queued_tasks.length === 0) {
    showToast({ type: 'info', title: t('tasks.queueTitle'), message: t('tasks.queueEmpty') });
    return;
  }

  const rows = data.queued_tasks.map((q, i) => {
    const title = esc(q.title || truncate(q.instruction, 80));
    const source = esc(q.source || '-');
    const priority = q.priority || 50;
    const created = q.created_at ? formatRelative(q.created_at) : '-';

    return `<tr>
      <td style="text-align:center;color:var(--text-muted);font-weight:600">${i + 1}</td>
      <td>${title}</td>
      <td><span class="badge badge-muted">${source}</span></td>
      <td style="text-align:center">${priority}</td>
      <td style="color:var(--text-muted);font-size:var(--text-2xs)">${created}</td>
    </tr>`;
  }).join('');

  const body = `
    <div class="tm-queue-modal">
      <div class="tm-queue-modal-info">
        <span>Agent : <strong>${esc(data.agent_name)}</strong></span>
        <span>${data.queued_tasks.length} ${t('tasks.queue').toLowerCase()}</span>
      </div>
      <div class="tm-queue-modal-table-wrap">
        <table class="table" style="font-size:var(--text-xs)">
          <thead>
            <tr>
              <th style="width:40px">#</th>
              <th>${t('tasks.task')}</th>
              <th>${t('tasks.queueSource')}</th>
              <th style="width:60px">${t('tasks.queuePriority')}</th>
              <th>${t('tasks.queueCreated')}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>
  `;

  openModal({
    title: `${t('tasks.queueTitle')} \u2014 ${esc(data.agent_name)}`,
    body,
    submitLabel: t('common.close') || 'Fermer',
    cancelLabel: '',
    onSubmit: () => {},
  });
}

async function handleAction(action, taskId) {
  try {
    switch (action) {
      case 'pause':
        await api.tasks.pause(taskId);
        showToast({ type: 'warning', title: t('tasks.paused'), message: taskId.slice(0, 8) });
        break;
      case 'kill':
        await api.tasks.kill(taskId);
        showToast({ type: 'info', title: t('tasks.killed'), message: taskId.slice(0, 8) });
        break;
      case 'resume':
        await api.tasks.continue(taskId, 'continue');
        showToast({ type: 'success', title: t('tasks.resumed'), message: taskId.slice(0, 8) });
        break;
      case 'continue':
        await api.tasks.continue(taskId, 'continue');
        showToast({ type: 'success', title: t('tasks.continued'), message: taskId.slice(0, 8) });
        break;
      case 'retry':
        const task = allTasks.find(t => t.id === taskId);
        if (task) {
          const opts = {};
          if (task.project_id) opts.project_id = task.project_id;
          if (task.agent_id) opts.agent_id = task.agent_id;
          await api.tasks.start(task.title || 'Retry', opts);
          showToast({ type: 'success', title: t('tasks.retried'), message: taskId.slice(0, 8) });
        }
        break;
      case 'resume-llm': {
        const res = await fetch('/api/tasks/resume-llm-limit', { method: 'POST' });
        const data = await res.json();
        showToast({
          type: data.failed ? 'warning' : 'success',
          title: t('toast.llmResumeTitle'),
          message: data.failed ? t('toast.tasksResumedWithFails', { resumed: data.resumed, failed: data.failed }) : t('toast.tasksResumed', { resumed: data.resumed }),
        });
        if (typeof window.refreshLlmLimitButton === 'function') window.refreshLlmLimitButton();
        break;
      }
      case 'recover': {
        // One-click recovery — the server walks the session .jsonl from
        // the tail to find the latest real user message, then seeds a
        // brand-new session with just that message. Prior history is
        // dropped (kept as a backup), which clears any poisoned payload
        // regardless of where in history it lives.
        const data = await api.tasks.recover(taskId);
        const preview = data.seedPreview ? `\n"${data.seedPreview}"` : '';
        showToast({
          type: 'success',
          title: t('tasks.recovered') || 'Session recovered',
          message: `${data.reason || 'Forked from your latest message.'}${preview}`,
        });
        break;
      }
    }
    await loadTasks();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

/* ── Expanded detail — full load (first open or DOM rebuild) ── */

async function loadExpandedDetail(taskId) {
  const el = document.getElementById(`tmExpanded_${taskId}`);
  if (!el) return;

  try {
    const task = await api.tasks.get(taskId);

    let logLines = [];
    try {
      const logRes = await api.tasks.getLog(taskId, 999999);
      logLines = logRes.lines || logRes.log || [];
    } catch {}

    expandedLogCount = logLines.length;

    el.innerHTML = `
      <div class="tm-detail-grid">
        <div class="tm-detail-info">
          <div class="tm-detail-row">
            <span class="tm-detail-label">${t('tasks.fullId')}</span>
            <span class="tm-detail-value">${task.id}</span>
          </div>
          ${task.elapsed ? `<div class="tm-detail-row">
            <span class="tm-detail-label">${t('tasks.duration')}</span>
            <span class="tm-detail-value tm-detail-elapsed">${formatDuration(task.elapsed)}</span>
          </div>` : ''}
          ${task.project_id ? `<div class="tm-detail-row">
            <span class="tm-detail-label">${t('tasks.project')}</span>
            <span class="tm-detail-value">${esc(findProjectName(task.project_id) || task.project_id)}</span>
          </div>` : ''}
          ${task.agent_id ? `<div class="tm-detail-row">
            <span class="tm-detail-label">${t('tasks.agent')}</span>
            <span class="tm-detail-value">${task.agent_id}</span>
          </div>` : ''}
        </div>
        <div class="tm-detail-result">
          ${task.result ? `<div class="tm-detail-section-title">${t('common.result')}</div>
            <div class="pd-detail-result">${esc(task.result)}</div>` : ''}
          ${task.error ? `<div class="tm-detail-section-title">${t('common.error')}</div>
            <div class="pd-detail-result pd-detail-error">${esc(task.error)}</div>` : ''}
          ${logLines.length > 0 ? `<div class="tm-detail-section-title tm-log-title">Logs (${logLines.length} lignes)</div>
            <div class="pd-detail-log">${logLines.map(l => esc(typeof l === 'string' ? l : l.text || JSON.stringify(l))).join('\n')}</div>` : ''}
          ${!task.result && !task.error && logLines.length === 0 ? `<div class="tm-no-detail" style="color: var(--text-disabled); font-size: var(--text-xs);">${t('tasks.noDetail')}</div>` : ''}
        </div>
      </div>
    `;
  } catch (err) {
    el.innerHTML = `<div style="color: var(--accent-red); font-size: var(--text-xs);">${t('common.error')}: ${esc(err.message)}</div>`;
  }
}

/* ── Expanded detail — incremental refresh (SSE updates, preserves scroll) ── */

async function refreshExpandedLogs(taskId) {
  const el = document.getElementById(`tmExpanded_${taskId}`);
  if (!el) return;

  try {
    const [task, logRes] = await Promise.all([
      api.tasks.get(taskId),
      api.tasks.getLog(taskId, 999999).catch(() => ({ lines: [] })),
    ]);

    const logLines = logRes.lines || logRes.log || [];

    // Update elapsed in detail info
    const elapsedEl = el.querySelector('.tm-detail-elapsed');
    if (elapsedEl && task.elapsed) {
      elapsedEl.textContent = formatDuration(task.elapsed);
    }

    // Update result if it appeared or changed
    const resultSection = el.querySelector('.tm-detail-result');
    if (resultSection) {
      let resultEl = resultSection.querySelector('.pd-detail-result:not(.pd-detail-error)');
      if (task.result && !resultEl) {
        const noDetail = resultSection.querySelector('.tm-no-detail');
        if (noDetail) noDetail.remove();
        const titleDiv = document.createElement('div');
        titleDiv.className = 'tm-detail-section-title';
        titleDiv.textContent = t('common.result');
        const contentDiv = document.createElement('div');
        contentDiv.className = 'pd-detail-result';
        contentDiv.textContent = task.result;
        const firstChild = resultSection.firstChild;
        resultSection.insertBefore(contentDiv, firstChild);
        resultSection.insertBefore(titleDiv, contentDiv);
      } else if (task.result && resultEl) {
        resultEl.textContent = task.result;
      }

      let errorEl = resultSection.querySelector('.pd-detail-error');
      if (task.error && !errorEl) {
        const noDetail = resultSection.querySelector('.tm-no-detail');
        if (noDetail) noDetail.remove();
        const titleDiv = document.createElement('div');
        titleDiv.className = 'tm-detail-section-title';
        titleDiv.textContent = t('common.error');
        const contentDiv = document.createElement('div');
        contentDiv.className = 'pd-detail-result pd-detail-error';
        contentDiv.textContent = task.error;
        const logTitle = resultSection.querySelector('.tm-log-title');
        if (logTitle) {
          resultSection.insertBefore(contentDiv, logTitle);
          resultSection.insertBefore(titleDiv, contentDiv);
        } else {
          resultSection.appendChild(titleDiv);
          resultSection.appendChild(contentDiv);
        }
      } else if (task.error && errorEl) {
        errorEl.textContent = task.error;
      }
    }

    // Handle log lines
    const logContainer = el.querySelector('.pd-detail-log');

    if (logContainer && logLines.length > expandedLogCount) {
      const newLines = logLines.slice(expandedLogCount);
      const isAtBottom = logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 30;

      const newText = '\n' + newLines.map(l =>
        typeof l === 'string' ? l : l.text || JSON.stringify(l)
      ).join('\n');
      logContainer.appendChild(document.createTextNode(newText));

      expandedLogCount = logLines.length;

      const logTitle = el.querySelector('.tm-log-title');
      if (logTitle) logTitle.textContent = `Logs (${logLines.length} lignes)`;

      if (isAtBottom) {
        logContainer.scrollTop = logContainer.scrollHeight;
      }
    } else if (logContainer && logLines.length < expandedLogCount) {
      loadExpandedDetail(taskId);
      return;
    } else if (!logContainer && logLines.length > 0) {
      loadExpandedDetail(taskId);
      return;
    }
  } catch (err) {
    console.error('[TaskManager] Expanded refresh error:', err);
  }
}

/* ── Utilities ── */

function updateSortIndicators() {
  document.querySelectorAll('.tm-table th[data-sort]').forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === sortCol) {
      th.classList.add(sortDir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  });
}

function findProjectName(projectId) {
  if (!projectId) return '';
  const p = projects.find(p => p.id === projectId);
  return p?.name || '';
}

function formatDateTime(dateString) {
  if (!dateString) return { date: '-', time: '-' };

  const date = new Date(dateString);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  // Format time (HH:MM:SS)
  const hours = date.getHours().toString().padStart(2, '0');
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const seconds = date.getSeconds().toString().padStart(2, '0');
  const time = `${hours}:${minutes}:${seconds}`;

  // Format date
  let dateStr;
  if (date >= today) {
    dateStr = t('tasks.today');
  } else if (date >= yesterday) {
    dateStr = t('tasks.yesterday');
  } else {
    const day = date.getDate().toString().padStart(2, '0');
    const month = (date.getMonth() + 1).toString().padStart(2, '0');
    const year = date.getFullYear();
    dateStr = `${day}/${month}/${year}`;
  }

  return { date: dateStr, time };
}
