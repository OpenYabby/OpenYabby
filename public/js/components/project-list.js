/* ═══════════════════════════════════════════════════════
   YABBY — Project List View
   ═══════════════════════════════════════════════════════
   Full page listing all projects with inline editing,
   clean deletion, filters, stats, and progress rings.
*/

import { state } from '../state.js';
import { api } from '../api.js';
import { esc, truncate, formatRelative, statusBadgeClass, statusLabel, debounce } from '../utils.js';
import { showToast } from './toast.js';
import { openCreateProjectModal } from './modal.js';
import { navigate } from '../router.js';
import { t } from '../i18n.js';

let allProjects = [];
let filteredProjects = [];
let filterStatus = 'all';
let filterType = 'all';
let searchQuery = '';
let editingProjectId = null;

export async function render(container) {
  // Reset local state
  allProjects = [];
  filteredProjects = [];
  filterStatus = 'all';
  filterType = 'all';
  searchQuery = '';
  editingProjectId = null;

  container.innerHTML = `
    <div class="pl-view">
      <div class="pl-header">
        <div class="ad-title-row" style="display:flex;align-items:center;justify-content:space-between;">
          <h2 class="tm-title">${t('projects.title')}</h2>
          <button class="btn btn-primary" id="plNewBtn">${t('projects.newProject')}</button>
        </div>
        <div class="pl-filters">
          <div class="tm-filter-group" style="display:flex;gap:var(--space-sm);">
            <select class="select tm-select" id="plFilterStatus" aria-label="${t('projects.allStatuses')}">
              <option value="all">${t('projects.allStatuses')}</option>
              <option value="active">${t('status.active')}</option>
              <option value="paused">${t('status.paused')}</option>
              <option value="completed">${t('status.completed')}</option>
            </select>
            <select class="select tm-select" id="plFilterType" aria-label="${t('projects.allTypes')}">
              <option value="all">${t('projects.allTypes')}</option>
            </select>
          </div>
          <div class="topbar-search-wrap tm-search-wrap">
            <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="6.5" cy="6.5" r="5"/><path d="M10.5 10.5L14.5 14.5"/>
            </svg>
            <input class="topbar-search tm-search" type="text" id="plSearch" placeholder="${t('projects.searchPlaceholder')}" aria-label="${t('projects.searchPlaceholder')}">
          </div>
        </div>
      </div>

      <div class="tm-stats" id="plStats"></div>

      <div class="card-grid pl-grid" id="plGrid">
        <div class="empty-state" style="padding:var(--space-xl);">${t('common.loading')}</div>
      </div>
    </div>
  `;

  // Bind filters
  document.getElementById('plFilterStatus')?.addEventListener('change', (e) => {
    filterStatus = e.target.value;
    applyFilters();
  });

  document.getElementById('plFilterType')?.addEventListener('change', (e) => {
    filterType = e.target.value;
    applyFilters();
  });

  const searchInput = document.getElementById('plSearch');
  const debouncedSearch = debounce((val) => {
    searchQuery = val.toLowerCase();
    applyFilters();
  }, 250);
  searchInput?.addEventListener('input', (e) => debouncedSearch(e.target.value));

  // New project button
  document.getElementById('plNewBtn')?.addEventListener('click', () => {
    openCreateProjectModal(() => loadProjects());
  });

  // Load data
  await loadProjects();

  // SSE live updates
  const onSSE = () => {
    if (!editingProjectId) loadProjects();
  };
  state.addEventListener('sse:heartbeat', onSSE);

  return () => {
    state.removeEventListener('sse:heartbeat', onSSE);
  };
}

async function loadProjects() {
  try {
    const data = await api.projects.list();
    allProjects = (data.projects || data || []).filter(p => p.id !== 'default' && p.status !== 'archived');

    // Populate type dropdown dynamically
    const types = [...new Set(allProjects.map(p => (p.projectType || p.project_type)).filter(Boolean))];
    const typeSelect = document.getElementById('plFilterType');
    if (typeSelect) {
      const current = typeSelect.value;
      typeSelect.innerHTML = `<option value="all">${t('projects.allTypes')}</option>` +
        types.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('');
      typeSelect.value = current;
    }

    applyFilters();
  } catch (err) {
    console.error('[ProjectList] Failed to load projects:', err);
    const grid = document.getElementById('plGrid');
    if (grid) grid.innerHTML = `<div class="empty-state" style="padding:var(--space-xl);color:var(--accent-red);">${t('common.loadError')}</div>`;
  }
}

function applyFilters() {
  filteredProjects = allProjects.filter(p => {
    if (filterStatus !== 'all' && p.status !== filterStatus) return false;
    if (filterType !== 'all' && (p.projectType || p.project_type) !== filterType) return false;
    if (searchQuery) {
      const hay = `${p.name || ''} ${p.description || ''} ${(p.projectType || p.project_type) || ''}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });
  renderStats();
  renderGrid();
}

function renderStats() {
  const el = document.getElementById('plStats');
  if (!el) return;

  const active = allProjects.filter(p => p.status === 'active').length;
  const completed = allProjects.filter(p => p.status === 'completed').length;
  const withTasks = allProjects.filter(p => (p.taskCount || p.task_count || 0) > 0).length;

  el.innerHTML = `
    <span class="tm-stat"><span class="status-dot running"></span> ${active} ${t('projects.activeCount')}</span>
    <span class="tm-stat"><span class="status-dot done"></span> ${completed} ${t('projects.completedCount')}</span>
    <span class="tm-stat"><span class="status-dot paused"></span> ${withTasks} ${t('projects.withTasks')}</span>
    <span class="tm-stat-total">${filteredProjects.length}/${allProjects.length} ${t('projects.displayedCount')}</span>
  `;
}

function renderGrid() {
  const grid = document.getElementById('plGrid');
  if (!grid) return;

  if (filteredProjects.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="padding:var(--space-xl);">${t('projects.noProjects')}</div>`;
    return;
  }

  grid.innerHTML = filteredProjects.map(p => {
    if (editingProjectId === p.id) return renderEditCard(p);
    return renderViewCard(p);
  }).join('');

  bindCardEvents(grid);
}

function renderViewCard(p) {
  const progress = p.status === 'completed' ? 100 : (p.overallProgress || 0);
  const r = 22;
  const circ = 2 * Math.PI * r;
  const offset = circ - (progress / 100) * circ;
  const progressColor = progress >= 100 ? 'var(--accent-green)' : progress > 0 ? 'var(--accent-blue)' : 'var(--glass-border)';

  const agentCount = p.agentCount || p.agent_count || 0;
  const taskCount = p.taskCount || p.task_count || 0;
  const runningCount = p.activeTaskCount || p.running_task_count || 0;

  return `
    <div class="card pl-card" data-project-id="${p.id}">
      <div class="pl-card-top">
        <div class="pl-card-info">
          <div class="pl-card-name">${esc(p.name)}</div>
          ${(p.projectType || p.project_type) ? `<div class="pl-card-type">${esc((p.projectType || p.project_type))}</div>` : ''}
        </div>
        <svg class="project-ring" viewBox="0 0 50 50" width="40" height="40">
          <circle cx="25" cy="25" r="${r}" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="3"/>
          <circle cx="25" cy="25" r="${r}" fill="none" stroke="${progressColor}" stroke-width="3"
            stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
            stroke-linecap="round" transform="rotate(-90 25 25)"
            style="transition:stroke-dashoffset 0.8s ease"/>
          <text x="25" y="27" text-anchor="middle" font-size="10" fill="${progressColor}" font-weight="600">${progress}%</text>
        </svg>
      </div>
      ${p.description ? `<div class="pl-card-desc">${esc(truncate(p.description, 120))}</div>` : ''}
      <div class="pl-card-meta">
        <span>${agentCount} ${agentCount !== 1 ? t('projects.agents') : t('projects.agent')}</span>
        <span>${taskCount} ${taskCount !== 1 ? t('projects.taskPlural') : t('projects.task')}</span>
        ${runningCount > 0 ? `<span class="active-count">${runningCount} ${t('status.runningLower')}</span>` : ''}
      </div>
      <div class="pl-card-footer">
        <span class="pl-card-date">${(p.createdAt || p.created_at) ? formatRelative(p.createdAt || p.created_at) : ''}</span>
        <span class="badge ${statusBadgeClass(p.status)}">${statusLabel(p.status)}</span>
      </div>
      <div class="pl-card-actions">
        <button class="btn btn-sm" data-action="edit" data-project-id="${p.id}" title="${t('common.edit')}">&#9998;</button>
        <button class="btn btn-sm btn-danger" data-action="delete" data-project-id="${p.id}" title="${t('common.delete')}">&#128465;</button>
      </div>
    </div>`;
}

function renderEditCard(p) {
  return `
    <div class="card pl-card pl-card-editing" data-project-id="${p.id}">
      <div class="form-group">
        <label class="form-label">${t('common.name')}</label>
        <input class="input" type="text" id="plEditName" value="${esc(p.name || '')}" autocomplete="off">
      </div>
      <div class="form-group">
        <label class="form-label">${t('common.description')}</label>
        <textarea class="input" id="plEditDesc" rows="2">${esc(p.description || '')}</textarea>
      </div>
      <div class="pl-edit-row">
        <div class="form-group">
          <label class="form-label">${t('common.type')}</label>
          <input class="input" type="text" id="plEditType" value="${esc((p.projectType || p.project_type) || '')}" autocomplete="off">
        </div>
        <div class="form-group">
          <label class="form-label">${t('common.status')}</label>
          <select class="select" id="plEditStatus">
            <option value="active" ${p.status === 'active' ? 'selected' : ''}>${t('status.active')}</option>
            <option value="paused" ${p.status === 'paused' ? 'selected' : ''}>${t('status.paused')}</option>
            <option value="completed" ${p.status === 'completed' ? 'selected' : ''}>${t('status.completed')}</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('projects.context')}</label>
        <textarea class="input" id="plEditContext" rows="2">${esc(p.context || '')}</textarea>
      </div>
      <div class="pl-card-edit-actions">
        <button class="btn btn-sm" data-action="cancel-edit">${t('common.cancel')}</button>
        <button class="btn btn-sm btn-primary" data-action="save-edit" data-project-id="${p.id}">${t('common.save')}</button>
      </div>
    </div>`;
}

function bindCardEvents(grid) {
  // Card click → navigate to detail
  grid.querySelectorAll('.pl-card:not(.pl-card-editing)').forEach(card => {
    card.addEventListener('click', (e) => {
      // Don't navigate if clicking an action button
      if (e.target.closest('[data-action]')) return;
      const id = card.dataset.projectId;
      if (id) navigate(`/projects/${id}`);
    });
  });

  // Action buttons
  grid.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      const projectId = btn.dataset.projectId;

      switch (action) {
        case 'edit':
          editingProjectId = projectId;
          renderGrid();
          break;

        case 'cancel-edit':
          editingProjectId = null;
          renderGrid();
          break;

        case 'save-edit':
          handleSaveEdit(projectId);
          break;

        case 'delete':
          handleDelete(btn, projectId);
          break;
      }
    });
  });
}

async function handleSaveEdit(projectId) {
  const name = document.getElementById('plEditName')?.value.trim();
  const description = document.getElementById('plEditDesc')?.value.trim();
  const project_type = document.getElementById('plEditType')?.value.trim();
  const status = document.getElementById('plEditStatus')?.value;
  const context = document.getElementById('plEditContext')?.value.trim();

  if (!name) {
    showToast({ type: 'error', title: t('common.error'), message: t('projects.nameRequired') });
    return;
  }

  try {
    await api.projects.update(projectId, { name, description, project_type, status, context });
    showToast({ type: 'success', title: t('projects.updated'), message: name });
    editingProjectId = null;
    await loadProjects();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

function handleDelete(deleteBtn, projectId) {
  const project = allProjects.find(p => p.id === projectId);
  if (!project) return;

  const original = deleteBtn.outerHTML;
  const confirmEl = document.createElement('span');
  confirmEl.className = 'inline-confirm';
  confirmEl.innerHTML = `${t('projects.deleteConfirm')} <button class="btn btn-sm btn-danger ic-yes">${t('common.yes')}</button> <button class="btn btn-sm ic-no">${t('common.no')}</button>`;
  deleteBtn.replaceWith(confirmEl);

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
      handleDelete(orig, projectId);
    });
  };

  confirmEl.querySelector('.ic-yes').addEventListener('click', async (e) => {
    e.stopPropagation();
    resolved = true;

    // Replace with progress indicator
    confirmEl.innerHTML = `<span class="pl-delete-progress">${t('projects.stoppingTasks')}</span>`;

    try {
      // 1. Kill running tasks
      const tasksData = await api.projects.tasks(projectId);
      const running = (tasksData.tasks || tasksData || []).filter(t => t.status === 'running');
      if (running.length > 0) {
        await Promise.all(running.map(t => api.tasks.kill(t.id).catch(() => {})));
        await new Promise(r => setTimeout(r, 1000));
      }

      // 2. Delete (archive) project
      confirmEl.innerHTML = `<span class="pl-delete-progress">${t('projects.deleting')}</span>`;
      await api.projects.delete(projectId);

      // 3. Fade out card
      const card = confirmEl.closest('.pl-card');
      if (card) {
        card.style.transition = 'opacity 0.3s, transform 0.3s';
        card.style.opacity = '0';
        card.style.transform = 'scale(0.95)';
        await new Promise(r => setTimeout(r, 300));
      }

      showToast({ type: 'info', title: t('projects.deleted'), message: project.name });
      await loadProjects();
    } catch (err) {
      showToast({ type: 'error', title: t('projects.deleteError'), message: err.message });
      await loadProjects();
    }
  });

  confirmEl.querySelector('.ic-no')?.addEventListener('click', (e) => {
    e.stopPropagation();
    cleanup();
  });

  setTimeout(cleanup, 5000);
}
