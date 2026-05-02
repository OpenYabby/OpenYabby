/* ═══════════════════════════════════════════════════════
   YABBY — Agent Directory View (Phase 5)
   Card grid with filters, actions, and CRUD
   ═══════════════════════════════════════════════════════ */

import { state } from '../state.js';
import { api } from '../api.js';
import { esc, truncate, statusBadgeClass, statusDotClass } from '../utils.js';
import { showToast } from './toast.js';
import { openSendInstructionModal } from './modal.js';
import { openYabbyChat } from './voice-panel.js';
import { navigate } from '../router.js';
import { t } from '../i18n.js';

// Synthetic Yabby entry — not a real agent (no DB row). Pinned first in the
// directory. Cannot be suspended, activated or deleted. Clicking opens the
// main Yabby voice/chat window instead of navigating to an agent page.
const YABBY_AGENT_ID = '__yabby__';

// View state
let allAgents = [];
let filteredAgents = [];
let projects = [];
let filterProject = 'all';
let filterStatus = 'all';
let searchQuery = '';

/** Does this agent look like a "Yabby" entry we should hide in favour of the
 *  synthetic tile? (Matches legacy DB rows named "yabby" regardless of role.) */
function isYabbyLookalike(a) {
  if (!a) return false;
  const name = (a.name || '').trim().toLowerCase();
  return name === 'yabby';
}

/** Build the synthetic Yabby directory entry. */
function makeYabbyEntry() {
  return {
    id: YABBY_AGENT_ID,
    name: t('voicePanel.defaultName'),
    role: t('agentDirectory.yabbyRole'),
    status: 'active',
    projectId: null,
    projectName: t('agentDirectory.yabbyProject'),
    isLead: false,
    isSuperAgent: false,
    isYabby: true,
    lastHeartbeat: null,
  };
}

/**
 * Render the Yabby card. Deliberately distinct from regular agent cards:
 *   - animated orb icon instead of a status dot
 *   - gradient border / background
 *   - "Principal" badge instead of project name
 *   - single "Open chat" CTA button, no suspend/delete
 *   - clicking anywhere on the card opens the main Yabby window
 */
function renderYabbyCard(a) {
  return `<div class="card ad-card ad-card-yabby" data-agent-id="${YABBY_AGENT_ID}" data-yabby="1">
    <div class="ad-card-yabby-top">
      <div class="ad-card-yabby-orb" aria-hidden="true">
        <span class="ad-card-yabby-orb-core"></span>
        <span class="ad-card-yabby-orb-ring"></span>
      </div>
      <div class="ad-card-yabby-identity">
        <div class="ad-card-yabby-name">${esc(a.name)}</div>
        <div class="ad-card-yabby-role">${esc(a.role)}</div>
      </div>
      <span class="ad-card-yabby-badge" title="${esc(t('agentDirectory.yabbyBadge'))}">${esc(t('agentDirectory.yabbyBadge'))}</span>
    </div>
    <div class="ad-card-yabby-tagline">${esc(t('agentDirectory.yabbyTagline'))}</div>
    <div class="ad-card-yabby-cta">
      <svg viewBox="0 0 14 14" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M2 3h10a1 1 0 011 1v5a1 1 0 01-1 1H6l-3 3V4a1 1 0 011-1z"/>
      </svg>
      <span>${esc(t('agentDirectory.yabbyOpenChat'))}</span>
      <span class="voice-kbd-hint" style="margin-left:auto;">⌘K</span>
    </div>
  </div>`;
}

export async function render(container, params) {
  container.innerHTML = `
    <div class="ad-view">
      <div class="ad-header">
        <div class="ad-title-row">
          <h2 class="tm-title">${t('agentDirectory.title')}</h2>
        </div>
        <div class="ad-filters">
          <div class="tm-filter-group">
            <select class="select tm-select" id="adFilterProject" aria-label="${t('agentDirectory.allProjects')}">
              <option value="all">${t('agentDirectory.allProjects')}</option>
            </select>
            <select class="select tm-select" id="adFilterStatus" aria-label="${t('agentDirectory.allStatuses')}">
              <option value="all">${t('agentDirectory.allStatuses')}</option>
              <option value="active">${t('agentDirectory.activeAgents')}</option>
              <option value="suspended">${t('agentDirectory.suspendedAgents')}</option>
            </select>
          </div>
          <div class="topbar-search-wrap tm-search-wrap">
            <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="6.5" cy="6.5" r="5"/><path d="M10.5 10.5L14.5 14.5"/></svg>
            <input class="topbar-search tm-search" type="text" id="adSearch" placeholder="${t('agentDirectory.searchPlaceholder')}" aria-label="${t('agentDirectory.searchPlaceholder')}">
          </div>
        </div>
      </div>

      <div class="ad-stats" id="adStats"></div>

      <div class="card-grid ad-grid" id="adGrid">
        <div class="empty-state" style="padding: var(--space-xl);">${t('common.loading')}</div>
      </div>
    </div>
  `;

  // Bind filters
  document.getElementById('adFilterProject')?.addEventListener('change', (e) => {
    filterProject = e.target.value;
    applyFilters();
  });
  document.getElementById('adFilterStatus')?.addEventListener('change', (e) => {
    filterStatus = e.target.value;
    applyFilters();
  });
  document.getElementById('adSearch')?.addEventListener('input', (e) => {
    searchQuery = e.target.value.toLowerCase();
    applyFilters();
  });

  // Load data
  await loadAgents();

  // SSE
  const onHeartbeat = () => loadAgents();
  state.addEventListener('sse:heartbeat', onHeartbeat);

  return () => {
    state.removeEventListener('sse:heartbeat', onHeartbeat);
  };
}

async function loadAgents() {
  try {
    const [projectsRes, allAgentsRes] = await Promise.all([
      api.projects.list(),
      api.agents.list(), // Load ALL agents (including standalone)
    ]);

    projects = (projectsRes.projects || []).filter(p => p.id !== 'default');

    // Load agents from all projects heartbeats. Yabby (synthetic) is always
    // pinned first so users can always find the principal chat.
    allAgents = [makeYabbyEntry()];
    const hbResults = await Promise.all(
      projects.map(p => api.projects.heartbeat(p.id).catch(() => null))
    );

    for (let i = 0; i < projects.length; i++) {
      const hb = hbResults[i];
      if (!hb) continue;
      const agents = hb.agentStatuses || [];
      for (const a of agents) {
        // Hide any legacy DB row named "Yabby" — the synthetic tile above
        // is the single source of truth for the principal assistant.
        if (isYabbyLookalike(a)) continue;
        allAgents.push({
          ...a,
          projectId: projects[i].id,
          projectName: projects[i].name,
        });
      }
    }

    // Add standalone agents (no projectId). Legacy "Yabby" rows are filtered
    // out so the synthetic tile is never duplicated.
    const standaloneAgents = (allAgentsRes.agents || []).filter(
      a => !a.projectId && !isYabbyLookalike(a)
    );
    for (const a of standaloneAgents) {
      // Check if not already in list (from heartbeat)
      if (!allAgents.find(existing => existing.id === a.id)) {
        allAgents.push({
          id: a.id,
          name: a.name,
          role: a.role,
          status: a.status,
          projectId: null,
          projectName: t('agentDirectory.standalone'),
          isLead: false,
          lastHeartbeat: null, // No heartbeat for standalone
        });
      }
    }

    // Populate project filter (add "Standalone" option)
    const sel = document.getElementById('adFilterProject');
    if (sel && sel.options.length <= 1) {
      // Add standalone option
      const standaloneOpt = document.createElement('option');
      standaloneOpt.value = 'standalone';
      standaloneOpt.textContent = t('agentDirectory.standalone');
      sel.appendChild(standaloneOpt);

      // Add project options
      projects.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.id;
        opt.textContent = p.name;
        sel.appendChild(opt);
      });
    }

    applyFilters();
  } catch (err) {
    console.error('[AgentDirectory] Load error:', err);
  }
}

function applyFilters() {
  filteredAgents = allAgents.filter(a => {
    // Yabby always passes filters UNLESS a search query is active and
    // doesn't match — keeping it pinned yet still searchable.
    if (a.isYabby) {
      if (searchQuery) {
        const hay = `${a.name || ''} ${a.role || ''}`.toLowerCase();
        return hay.includes(searchQuery);
      }
      return true;
    }
    // Project filter
    if (filterProject !== 'all') {
      if (filterProject === 'standalone' && a.projectId !== null) return false;
      if (filterProject !== 'standalone' && a.projectId !== filterProject) return false;
    }
    // Status filter
    if (filterStatus !== 'all') {
      if (filterStatus === 'suspended' && a.status !== 'suspended') return false;
      if (filterStatus === 'active' && a.status === 'suspended') return false;
    }
    // Search query
    if (searchQuery) {
      const hay = `${a.name || ''} ${a.role || ''} ${a.projectName || ''}`.toLowerCase();
      if (!hay.includes(searchQuery)) return false;
    }
    return true;
  });

  // Keep Yabby pinned first (in case the array order gets permuted)
  filteredAgents.sort((a, b) => {
    if (a.isYabby && !b.isYabby) return -1;
    if (!a.isYabby && b.isYabby) return 1;
    return 0;
  });

  renderStats();
  renderGrid();
}

function renderStats() {
  const el = document.getElementById('adStats');
  if (!el) return;

  // Yabby is synthetic — exclude from counts so stats reflect real agents only.
  const realAgents = allAgents.filter(a => !a.isYabby);
  const realFiltered = filteredAgents.filter(a => !a.isYabby);

  const active = realAgents.filter(a => a.status !== 'suspended').length;
  const suspended = realAgents.filter(a => a.status === 'suspended').length;
  const working = realAgents.filter(a => a.lastHeartbeat?.status === 'working').length;

  el.innerHTML = `
    <span class="tm-stat"><span class="status-dot active"></span> ${active} ${t('status.activeLower')}</span>
    <span class="tm-stat"><span class="status-dot suspended"></span> ${suspended} ${t('status.suspendedLower')}</span>
    <span class="tm-stat"><span class="status-dot running"></span> ${working} ${t('status.runningLower')}</span>
    <span class="tm-stat-total">${realFiltered.length}/${realAgents.length} ${t('common.displayed')}</span>
  `;
}

function renderGrid() {
  const grid = document.getElementById('adGrid');
  if (!grid) return;

  if (filteredAgents.length === 0 && allAgents.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="padding: var(--space-xl); grid-column: 1 / -1;">
      <div style="font-size: var(--text-md); color: var(--text-muted);">${t('agentDirectory.noAgents')}</div>
      <div style="font-size: var(--text-xs); color: var(--text-disabled);">${t('agentDirectory.agentCreationHint')}</div>
    </div>`;
    return;
  }

  if (filteredAgents.length === 0) {
    grid.innerHTML = `<div class="empty-state" style="padding: var(--space-xl); grid-column: 1 / -1;">
      ${t('common.noResults')}
    </div>`;
    return;
  }

  grid.innerHTML = filteredAgents.map(a => {
    if (a.isYabby) return renderYabbyCard(a);

    const hb = a.lastHeartbeat;
    const status = hb?.status || 'idle';
    const progress = hb?.progress || 0;
    const isSuspended = a.status === 'suspended';
    const isSuperAgent = a.isSuperAgent === true;
    const isRunning = a.taskStatus === 'running' && !!a.activeTaskId;

    return `<div class="card ad-card ${isSuspended ? 'ad-card-suspended' : ''} ${isSuperAgent ? 'ad-card-super' : ''}" data-agent-id="${a.id}">
      <div class="ad-card-top">
        <div class="ad-card-identity">
          <div class="ad-card-name-row">
            <span class="status-dot ${statusDotClass(isSuspended ? 'suspended' : status)}"></span>
            <span class="ad-card-name">${esc(a.name)}</span>
            ${isSuperAgent ? `<span class="ad-card-super-badge" title="${t('agentDirectory.systemAgent')}">🛡️</span>` : ''}
          </div>
          <div class="ad-card-role">${esc(a.role || t('agentDirectory.defaultRole'))}</div>
        </div>
        ${a.isLead ? `<span class="ad-card-lead" title="${t('agentDirectory.director')}">★</span>` : ''}
      </div>

      ${a.projectId ? `<div class="ad-card-project" data-nav-project="${a.projectId}">
        <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="3" width="12" height="9" rx="1.5"/><path d="M4 3V2a1 1 0 011-1h4a1 1 0 011 1v1"/></svg>
        ${esc(a.projectName || '')}
      </div>` : `<div class="ad-card-project" style="opacity: 0.6;">
        <svg viewBox="0 0 14 14" width="11" height="11" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="4"/><path d="M7 5v4M5 7h4"/></svg>
        ${esc(a.projectName || t('agentDirectory.standalone'))}
      </div>`}

      ${progress > 0 ? `
      <div class="ad-card-progress">
        <div class="progress-bar">
          <div class="progress-bar-fill ${progress >= 100 ? 'green' : status === 'blocked' ? 'red' : ''}" style="width: ${progress}%;"></div>
        </div>
        <span class="ad-card-progress-label">${progress}%</span>
      </div>` : ''}

      ${hb?.summary ? `<div class="ad-card-summary">${esc(truncate(hb.summary, 80))}</div>` : ''}

      <div class="ad-card-actions">
        <button class="btn btn-sm" data-action="instruct" data-agent-id="${a.id}" data-agent-name="${esc(a.name)}" title="${t('projectDetail.instruction')}">
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 10l2-2h7a1 1 0 001-1V3a1 1 0 00-1-1H3a1 1 0 00-1 1v4"/></svg>
        </button>
        ${isRunning ? `
        <button class="btn btn-sm btn-warning" data-action="pause-task" data-agent-id="${a.id}" data-task-id="${a.activeTaskId}" title="${t('projectDetail.suspend')}">
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3v8M10 3v8"/></svg>
        </button>` : ''}
        <button class="btn btn-sm btn-danger" data-action="delete" data-agent-id="${a.id}" data-agent-name="${esc(a.name)}" title="${isSuperAgent ? t('agentDirectory.systemAgentUndeletable') : t('common.delete')}" ${isSuperAgent ? 'disabled style="opacity: 0.3; cursor: not-allowed;"' : ''}>
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M4 4v8a1 1 0 001 1h4a1 1 0 001-1V4"/></svg>
        </button>
      </div>
    </div>`;
  }).join('');

  // Bind card actions
  grid.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleAction(
        btn.dataset.action,
        btn.dataset.agentId,
        btn.dataset.agentName,
        btn.dataset.taskId
      );
    });
  });

  // Bind project links
  grid.querySelectorAll('[data-nav-project]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      navigate(`/projects/${el.dataset.navProject}`);
    });
  });

  // Bind card click → navigate to project detail or agent detail.
  // Yabby card opens the principal chat window instead (no routing).
  grid.querySelectorAll('.ad-card').forEach(card => {
    card.addEventListener('click', () => {
      if (card.dataset.yabby === '1') {
        openYabbyChat();
        return;
      }
      const agent = filteredAgents.find(a => a.id === card.dataset.agentId);
      if (agent) {
        if (agent.projectId) {
          navigate(`/projects/${agent.projectId}`);
        } else {
          navigate(`/agents/${agent.id}`); // Standalone agent → agent detail page
        }
      }
    });
  });
}

async function handleAction(action, agentId, agentName, taskId) {
  // Yabby is synthetic and cannot be suspended/activated/deleted/instructed
  // via the agent API. Guard against any stray call.
  if (agentId === YABBY_AGENT_ID) return;
  try {
    switch (action) {
      case 'instruct':
        openSendInstructionModal(agentId, agentName, (result) => {
          showToast({ type: 'info', title: t('projectDetail.instructionSent'), message: agentName || agentId });
        });
        return;
      case 'pause-task':
        if (!taskId) return;
        await api.tasks.pause(taskId);
        showToast({ type: 'warning', title: t('projectDetail.taskPaused') || t('projectDetail.agentSuspended'), message: agentName || agentId });
        break;
      case 'delete':
        // Inline confirmation on the delete button
        const deleteBtn = document.querySelector(`[data-action="delete"][data-agent-id="${agentId}"]`);
        if (!deleteBtn) return;
        const original = deleteBtn.outerHTML;
        const confirmEl = document.createElement('span');
        confirmEl.className = 'inline-confirm';
        confirmEl.innerHTML = `${t('agentDirectory.deleteConfirm')} <button class="btn btn-sm btn-danger ic-yes">${t('common.yes')}</button> <button class="btn btn-sm ic-no">${t('common.no')}</button>`;
        deleteBtn.replaceWith(confirmEl);

        let resolved = false;
        const cleanup = () => {
          if (resolved) return;
          resolved = true;
          const temp = document.createElement('div');
          temp.innerHTML = original;
          const orig = temp.firstElementChild;
          confirmEl.replaceWith(orig);
          // Re-bind click
          orig.addEventListener('click', (e) => {
            e.stopPropagation();
            handleAction('delete', agentId, agentName);
          });
        };

        confirmEl.querySelector('.ic-yes').addEventListener('click', async (e) => {
          e.stopPropagation();
          resolved = true;
          try {
            await api.agents.delete(agentId);
            showToast({ type: 'info', title: t('projectDetail.agentDeleted'), message: agentName || agentId });
            await loadAgents();
          } catch (err) {
            showToast({ type: 'error', title: t('common.error'), message: err.message });
          }
        });

        confirmEl.querySelector('.ic-no').addEventListener('click', (e) => {
          e.stopPropagation();
          cleanup();
        });

        setTimeout(cleanup, 3000);
        return;
    }
    await loadAgents();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}
