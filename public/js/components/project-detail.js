/* ═══════════════════════════════════════════════════════
   YABBY — Project Detail View (Phase 4)
   3-column layout: Agent tree | Tabs | Detail panel
   ═══════════════════════════════════════════════════════ */

import { state } from '../state.js';
import { api } from '../api.js';
import { esc, formatDuration, formatTime, formatRelative, truncate, statusBadgeClass, statusDotClass, statusLabel, eventTypeBadge, msgTypeBadge } from '../utils.js';
import { getAgentQueue } from '../api.js';
import { showToast } from './toast.js';
import { openCreateAgentModal, openCreateTaskModal, openSendInstructionModal } from './modal.js';
import { t } from '../i18n.js';

// Local view state
let projectId = null;
let project = null;
let agents = [];
let tasks = [];
let messages = [];
let events = [];
let selectedAgentId = null;
let selectedTaskId = null;
let activeTab = 'messages';
let refreshTimer = null;

export async function render(container, params) {
  projectId = params.id;

  container.innerHTML = `
    <div class="three-col">
      <!-- Left column: Agent hierarchy -->
      <div class="col col-agents">
        <div class="col-header">
          <span class="section-title">${t('projectDetail.agentsSection')}</span>
          <div style="display: flex; gap: var(--space-xs); align-items: center;">
            <button class="btn btn-sm" id="pdViewPlanBtn" title="${t('projectDetail.viewPlanTitle')}" style="display: none;">
              ${t('projectDetail.viewPlan')}
            </button>
            <button class="btn btn-sm btn-primary" id="pdAddAgentBtn">${t('projectDetail.addAgent')}</button>
          </div>
        </div>
        <div class="col-scroll" id="pdAgentTree">
          <div class="empty-state" style="padding: var(--space-lg);">${t('common.loading')}</div>
        </div>
      </div>

      <!-- Center column: Tabs -->
      <div class="col col-center">
        <div class="col-header" style="padding: 0;">
          <div class="tabs" id="pdTabs">
            <div class="tab active" data-tab="messages">${t('projectDetail.exchanges')}</div>
            <div class="tab" data-tab="events">${t('projectDetail.events')}</div>
            <div class="tab" data-tab="tasks">${t('projectDetail.tasksTab')}</div>
            <div class="tab" data-tab="logs">${t('projectDetail.logs')}</div>
          </div>
        </div>
        <div class="col-scroll" id="pdTabContent">
          <div class="empty-state" style="padding: var(--space-lg);">${t('common.loading')}</div>
        </div>
      </div>

      <!-- Right column: Detail panel -->
      <div class="col col-detail">
        <div class="col-header">
          <span class="section-title">${t('projectDetail.detail')}</span>
        </div>
        <div class="col-scroll" id="pdDetailPanel">
          <div class="empty-state" style="padding: var(--space-lg);">${t('projectDetail.selectAgentOrTask')}</div>
        </div>
      </div>
    </div>
  `;

  // Bind tabs
  document.getElementById('pdTabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    activeTab = tab.dataset.tab;
    document.querySelectorAll('#pdTabs .tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderTabContent();
  });

  // Bind add agent
  document.getElementById('pdAddAgentBtn')?.addEventListener('click', () => {
    openCreateAgentModal(projectId, agents, (result) => {
      showToast({ type: 'success', title: t('projectDetail.agentCreated'), message: result.name || result.id });
      loadAll();
    });
  });

  // Bind "View plan" — opens the plan-review modal in read-only mode.
  // Hidden by default; refreshLatestPlan() unhides it once we confirm a
  // plan exists for this project.
  document.getElementById('pdViewPlanBtn')?.addEventListener('click', async () => {
    try {
      const review = await api.planReviews.latest(projectId);
      // The endpoint returns `{ review: null }` when no plan exists — guard
      // against that explicitly so we don't deref undefined fields.
      if (!review || review.review === null || !review.id) {
        showToast({ type: 'info', title: t('common.info') || 'Info', message: t('projectDetail.noPlan') || 'No plan submitted yet for this project.' });
        return;
      }
      const { openPlanReviewModal } = await import('./plan-review.js');
      openPlanReviewModal({
        reviewId: review.id,
        planContent: review.planContent,
        projectName: review.projectName,
        agentName: review.agentName,
        viewOnly: true,
        status: review.status,
      });
    } catch (err) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  });

  // Load all data
  await loadAll();
  refreshLatestPlanButton();

  // SSE subscriptions
  const unsubs = [
    state.on('activities', () => {
      if (activeTab === 'logs') renderTabContent();
    }),
  ];

  const onTask = () => loadTasks().then(() => { if (activeTab === 'tasks') renderTabContent(); });
  const onHeartbeat = () => loadHierarchy();
  const onSpeaker = () => {
    loadMessages().then(() => { if (activeTab === 'messages') renderTabContent(); });
    loadEvents().then(() => { if (activeTab === 'events') renderTabContent(); });
  };

  state.addEventListener('sse:task', onTask);
  state.addEventListener('sse:heartbeat', onHeartbeat);
  state.addEventListener('sse:speaker_notify', onSpeaker);

  // Periodic refresh for data that doesn't come via SSE
  refreshTimer = setInterval(() => { loadAll(); refreshLatestPlanButton(); }, 15000);

  // Return cleanup
  return () => {
    unsubs.forEach(u => u());
    state.removeEventListener('sse:task', onTask);
    state.removeEventListener('sse:heartbeat', onHeartbeat);
    state.removeEventListener('sse:speaker_notify', onSpeaker);
    if (refreshTimer) clearInterval(refreshTimer);
  };
}

// ═══════════════════════════════════════════════════
// Data loading
// ═══════════════════════════════════════════════════

async function loadAll() {
  try {
    await Promise.all([loadHierarchy(), loadMessages(), loadEvents(), loadTasks()]);
    renderTabContent();
  } catch (err) {
    console.error('[ProjectDetail] Load error:', err);
  }
}

// Show the "View plan" button only when a plan actually exists for this
// project (any status — pending, approved, revised, cancelled). The endpoint
// now returns `{ review: null }` for "no plan yet" so we check the payload
// instead of relying on a 404 (which generated red console noise).
async function refreshLatestPlanButton() {
  const btn = document.getElementById('pdViewPlanBtn');
  if (!btn) return;
  try {
    const result = await api.planReviews.latest(projectId);
    if (result && result.id && result.review !== null) {
      btn.style.display = '';
    } else {
      btn.style.display = 'none';
    }
  } catch {
    btn.style.display = 'none';
  }
}

async function loadHierarchy() {
  try {
    const hb = await api.projects.heartbeat(projectId);
    project = hb;
    agents = hb.agentStatuses || [];

    // Update breadcrumb with project name
    const bc = document.getElementById('breadcrumb');
    if (bc) {
      bc.innerHTML = `<span class="sep">/</span><span>Projets</span><span class="sep">/</span><span>${esc(hb.projectName || projectId)}</span>`;
    }

    renderAgentTree();

    // If we have a selected agent, refresh its detail
    if (selectedAgentId) renderAgentDetail(selectedAgentId);
  } catch (err) {
    // Project deleted / archived since we loaded this view → stop polling and
    // bounce back to the projects list instead of spamming 404s in the console.
    if (String(err?.message || '').toLowerCase().includes('not found')) {
      console.warn(`[ProjectDetail] Project ${projectId} no longer exists — redirecting to projects list`);
      if (typeof window !== 'undefined') {
        window.location.hash = '#/projects';
      }
      return;
    }
    const tree = document.getElementById('pdAgentTree');
    if (tree) tree.innerHTML = `<div class="empty-state" style="padding: var(--space-lg);">${t('common.loadError')}</div>`;
  }
}

async function loadMessages() {
  try {
    const res = await api.projects.messages(projectId, 100);
    messages = res.messages || [];
  } catch { messages = []; }
}

async function loadEvents() {
  try {
    const res = await api.projects.events(projectId, 100);
    events = res.events || [];
  } catch { events = []; }
}

async function loadTasks() {
  try {
    const res = await api.projects.tasks(projectId);
    tasks = res.tasks || [];
  } catch { tasks = []; }
}

// ═══════════════════════════════════════════════════
// Agent tree (left column)
// ═══════════════════════════════════════════════════

function renderAgentTree() {
  const tree = document.getElementById('pdAgentTree');
  if (!tree) return;

  if (agents.length === 0) {
    tree.innerHTML = `<div class="empty-state" style="padding: var(--space-lg);">
      <div style="font-size: var(--text-sm); color: var(--text-muted);">${t('projectDetail.noAgents')}</div>
      <div style="font-size: var(--text-xs); color: var(--text-disabled); margin-top: var(--space-xs);">${t('projectDetail.createAgentHint')}</div>
    </div>`;
    return;
  }

  // Project summary at top
  const running = tasks.filter(t => t.status === 'running').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const errors = tasks.filter(t => t.status === 'error').length;
  const progress = project?.overallProgress || 0;

  let html = `
    <div class="pd-project-summary">
      <div class="pd-project-name">${esc(project?.projectName || t('tasks.project'))}</div>
      <div class="pd-project-stats">
        <span>${agents.length} ${t('projects.agents')}</span>
        <span>${running} ${t('status.runningLower')}</span>
        <span>${done} ${t('status.doneLower')}</span>
        ${errors ? `<span class="pd-stat-error">${errors} ${t('status.errorLower')}</span>` : ''}
      </div>
      ${progress > 0 ? `
      <div class="progress-bar" style="margin-top: var(--space-xs);">
        <div class="progress-bar-fill ${progress >= 100 ? 'green' : ''}" style="width: ${progress}%;"></div>
      </div>
      <div style="font-size: var(--text-2xs); color: var(--text-disabled); margin-top: 2px;">${t('projectDetail.progress')}: ${progress}%</div>
      ` : ''}
      <div class="pd-sandbox-row" style="margin-top: var(--space-sm); display: flex; align-items: center; gap: var(--space-sm);">
        <button class="btn btn-sm" id="pdOpenSandbox" title="${t('projectDetail.openFolder')}">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 4v8a1 1 0 001 1h10a1 1 0 001-1V6a1 1 0 00-1-1H8L6.5 3.5H3A1 1 0 002 4z"/></svg>
          ${t('projectDetail.openFolder')}
        </button>
        <span class="pd-sandbox-path" id="pdSandboxPath" style="font-size: var(--text-2xs); color: var(--text-disabled); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></span>
      </div>
    </div>
  `;

  // Build tree recursively
  html += buildTreeHTML(null, 0);
  tree.innerHTML = html;

  // Bind click events
  tree.querySelectorAll('[data-agent-id]').forEach(node => {
    node.addEventListener('click', (e) => {
      // Don't select if clicking an action button
      if (e.target.closest('.pd-agent-actions')) return;
      selectedAgentId = node.dataset.agentId;
      selectedTaskId = null;
      renderAgentTree(); // re-render to update selection
      renderAgentDetail(selectedAgentId);
    });
  });

  // Bind action buttons
  tree.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const agentId = btn.closest('[data-agent-id]')?.dataset.agentId;
      if (!agentId) return;
      handleAgentAction(btn.dataset.action, agentId);
    });
  });

  // Sandbox: load info and wire open button
  const openBtn = document.getElementById('pdOpenSandbox');
  const pathEl = document.getElementById('pdSandboxPath');
  if (openBtn && projectId) {
    api.projects.sandbox(projectId).then(info => {
      if (pathEl && info?.path) pathEl.textContent = info.path;
    }).catch(() => {});

    openBtn.addEventListener('click', async () => {
      openBtn.disabled = true;
      try {
        await api.projects.openSandbox(projectId);
      } catch {}
      setTimeout(() => { openBtn.disabled = false; }, 1000);
    });
  }
}

function buildTreeHTML(parentId, depth) {
  const children = agents.filter(a => (a.parentAgentId || null) === parentId);
  let html = '';

  for (const agent of children) {
    const hb = agent.lastHeartbeat;
    const progress = hb?.progress || 0;
    const hbStatus = hb?.status || 'idle';
    const isSuspended = agent.status === 'suspended';
    // Runtime task status (set by spawner/queue) takes priority over the
    // last heartbeat: a freshly-spawned task flips taskStatus → 'running'
    // immediately, before the agent's first heartbeat lands. Heartbeat
    // status is the fallback for finer-grained states (working/blocked/
    // waiting) that the agent itself reports via /api/heartbeat.
    const isRunning = agent.taskStatus === 'running';
    const status = isSuspended ? 'suspended' : (isRunning ? 'running' : hbStatus);
    const isSelected = agent.id === selectedAgentId;
    const hasChildren = agents.some(a => a.parentAgentId === agent.id);
    const icon = agent.isLead ? '\u2605' : hasChildren ? '\u25C6' : '\u25CF';

    html += `
      <div class="pd-tree-node ${isSelected ? 'selected' : ''}" data-agent-id="${agent.id}" style="padding-left: ${depth * 16 + 8}px;">
        <div class="pd-tree-main">
          <span class="pd-tree-icon"><span class="status-dot ${statusDotClass(status)}"></span></span>
          <div class="pd-tree-info">
            <div class="pd-tree-name">
              <span class="pd-tree-name-text">${icon} ${esc(agent.name)}</span>
              ${isRunning && !isSuspended ? `<span class="badge badge-running">${esc(t('projectDetail.running') || 'running')}</span>` : ''}
              ${isSuspended ? `<span class="badge badge-paused">${esc(t('projectDetail.suspendedBadge') || 'suspended')}</span>` : ''}
            </div>
            <div class="pd-tree-role">${esc(agent.role || '')}</div>
          </div>
          <div class="pd-agent-actions">
            <button class="btn btn-sm" data-action="instruct" title="${t('projectDetail.instruction')}">
              <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 10l2-2h7a1 1 0 001-1V3a1 1 0 00-1-1H3a1 1 0 00-1 1v4"/></svg>
            </button>
            ${isRunning && agent.activeTaskId ? `
            <button class="btn btn-sm btn-warning" data-action="pause-task" title="${t('projectDetail.suspend')}">
              <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 3v8M10 3v8"/></svg>
            </button>` : ''}
          </div>
        </div>
        ${progress > 0 ? `<div class="progress-bar" style="margin: 2px 0 0 20px;"><div class="progress-bar-fill ${progress >= 100 ? 'green' : hbStatus === 'blocked' ? 'red' : ''}" style="width: ${progress}%;"></div></div>` : ''}
        ${hb?.summary ? `<div class="pd-tree-summary">${esc(truncate(hb.summary, 60))}</div>` : ''}
      </div>
    `;

    // Recurse into children
    html += buildTreeHTML(agent.id, depth + 1);
  }

  return html;
}

async function handleAgentAction(action, agentId) {
  const agent = agents.find(a => a.id === agentId);
  if (!agent) return;

  try {
    switch (action) {
      case 'pause-task':
        if (!agent.activeTaskId) return;
        await api.tasks.pause(agent.activeTaskId);
        showToast({ type: 'warning', title: t('projectDetail.taskPaused') || t('projectDetail.agentSuspended'), message: agent.name });
        break;
      case 'instruct':
        openSendInstructionModal(agentId, agent.name, (result) => {
          showToast({ type: 'info', title: t('projectDetail.instructionSent'), message: agent.name });
          loadTasks();
        });
        return; // Modal handles the rest
      case 'delete':
        // Use inline confirmation — find the triggering button and transform it
        requestInlineConfirm(agentId, async () => {
          await api.agents.delete(agentId);
          showToast({ type: 'info', title: t('projectDetail.agentDeleted'), message: agent.name });
          if (selectedAgentId === agentId) {
            selectedAgentId = null;
            document.getElementById('pdDetailPanel').innerHTML = `<div class="empty-state" style="padding: var(--space-lg);">${t('projectDetail.selectAgentOrTask')}</div>`;
          }
          await loadHierarchy();
        });
        return; // Don't reload yet — wait for confirm
    }
    await loadHierarchy();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

// ═══════════════════════════════════════════════════
// Tab content (center column)
// ═══════════════════════════════════════════════════

function renderTabContent() {
  const container = document.getElementById('pdTabContent');
  if (!container) return;

  switch (activeTab) {
    case 'messages': renderMessagesTab(container); break;
    case 'events':   renderEventsTab(container);   break;
    case 'tasks':    renderTasksTab(container);    break;
    case 'logs':     renderLogsTab(container);     break;
  }
}

function renderMessagesTab(container) {
  if (messages.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding: var(--space-xl);">${t('projectDetail.noExchanges')}</div>`;
    return;
  }

  container.innerHTML = messages.map(m => {
    const time = formatTime(m.created_at || m.createdAt);
    const typeClass = m.msg_type || m.msgType || 'message';
    return `<div class="pd-msg-item">
      <div class="pd-msg-header">
        <div class="pd-msg-route">
          <span class="pd-msg-from">${esc(m.from_name || m.fromName || '?')}</span>
          <svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6h8M7 3l3 3-3 3"/></svg>
          <span class="pd-msg-to">${esc(m.to_name || m.toName || '?')}</span>
          <span class="badge ${msgTypeBadge(typeClass)}">${typeClass.replace(/_/g, ' ')}</span>
        </div>
        <span class="pd-msg-time">${time}</span>
      </div>
      <div class="pd-msg-content">${esc(truncate(m.content, 500))}</div>
    </div>`;
  }).join('');
}

function renderEventsTab(container) {
  if (events.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding: var(--space-xl);">${t('projectDetail.noEvents')}</div>`;
    return;
  }

  container.innerHTML = events.map(ev => {
    const time = formatTime(ev.created_at || ev.createdAt);
    const type = ev.event_type || ev.eventType || 'event';
    const detail = ev.detail ? (typeof ev.detail === 'string' ? ev.detail : JSON.stringify(ev.detail)) : '';
    return `<div class="pd-event-item">
      <span class="pd-event-time">${time}</span>
      <span class="badge ${eventTypeBadge(type)}">${type.replace(/_/g, ' ')}</span>
      <span class="pd-event-detail">${esc(truncate(detail, 200))}</span>
    </div>`;
  }).join('');
}

function renderTasksTab(container) {
  // "New task" button at top
  let html = `<div class="pd-tasks-header">
    <button class="btn btn-sm btn-primary" id="pdNewTaskBtn">${t('projectDetail.newTask')}</button>
    <span class="pd-tasks-count">${tasks.length} ${tasks.length > 1 ? t('projects.taskPlural') : t('projects.task')}</span>
  </div>`;

  if (tasks.length === 0) {
    html += `<div class="empty-state" style="padding: var(--space-xl);">${t('projectDetail.noTasks')}</div>`;
    container.innerHTML = html;
    bindNewTaskBtn();
    return;
  }

  // Sort: running first, then paused, then done, then error
  const sortOrder = { running: 0, paused: 1, error: 2, done: 3, killed: 4 };
  const sorted = [...tasks].sort((a, b) => (sortOrder[a.status] ?? 9) - (sortOrder[b.status] ?? 9));

  html += sorted.map(t => {
    const status = t.status || 'unknown';
    const elapsed = t.elapsed ? formatDuration(t.elapsed) : '';
    const agentName = findAgentName(t.agent_id || t.agentId);
    const isSelected = t.id === selectedTaskId;

    return `<div class="pd-task-item ${isSelected ? 'selected' : ''}" data-task-id="${t.id}">
      <div class="pd-task-top">
        <div class="pd-task-info">
          <span class="pd-task-title">${esc(truncate(t.title || t.id, 80))}</span>
          ${agentName ? `<span class="pd-task-agent">${esc(agentName)}</span>` : ''}
        </div>
        <span class="badge ${statusBadgeClass(status)}">${statusLabel(status)}</span>
      </div>
      <div class="pd-task-bottom">
        <span class="pd-task-elapsed">${elapsed}</span>
        <div class="pd-task-actions">
          ${renderTaskActions(t)}
        </div>
      </div>
    </div>`;
  }).join('');

  container.innerHTML = html;
  bindNewTaskBtn();
  bindTaskItems(container);
  bindTaskActions(container);
}

function renderTaskActions(task) {
  const btns = [];
  switch (task.status) {
    case 'running':
      btns.push(`<button class="btn btn-sm btn-warning" data-task-action="pause" data-tid="${task.id}">${t('tasks.pause')}</button>`);
      btns.push(`<button class="btn btn-sm btn-danger" data-task-action="kill" data-tid="${task.id}">${t('tasks.stop')}</button>`);
      break;
    case 'paused':
      btns.push(`<button class="btn btn-sm btn-success" data-task-action="resume" data-tid="${task.id}">${t('tasks.resume')}</button>`);
      btns.push(`<button class="btn btn-sm btn-danger" data-task-action="kill" data-tid="${task.id}">${t('tasks.stop')}</button>`);
      break;
    case 'done':
      btns.push(`<button class="btn btn-sm" data-task-action="view" data-tid="${task.id}">${t('common.result')}</button>`);
      btns.push(`<button class="btn btn-sm btn-primary" data-task-action="continue" data-tid="${task.id}">${t('tasks.continue')}</button>`);
      break;
    case 'error':
      btns.push(`<button class="btn btn-sm" data-task-action="view" data-tid="${task.id}">${t('common.error')}</button>`);
      btns.push(`<button class="btn btn-sm btn-primary" data-task-action="retry" data-tid="${task.id}">${t('common.retry')}</button>`);
      break;
  }
  return btns.join('');
}

function renderLogsTab(container) {
  const activities = state.get('activities') || [];

  if (activities.length === 0) {
    container.innerHTML = `<div class="empty-state" style="padding: var(--space-xl);">${t('projectDetail.waitingLogs')}</div>`;
    return;
  }

  container.innerHTML = `<div class="pd-logs">` +
    activities.slice(0, 200).map(a => {
      const time = new Date(a.time).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const hasVerbose = a.verbose && a.verbose.length > 120;
      return `<div class="activity-item${hasVerbose ? ' has-verbose' : ''}">
        <span class="activity-time">${time}</span>
        <span class="activity-icon ${a.type || ''}">${getActivityIcon(a.type)}</span>
        <span class="activity-text ${a.type || ''}">${esc(a.text)}</span>
        ${hasVerbose ? `<div class="activity-verbose">${esc(a.verbose)}</div>` : ''}
      </div>`;
    }).join('') + `</div>`;

  // Bind expand/collapse on verbose items
  container.querySelectorAll('.activity-item.has-verbose').forEach(item => {
    item.addEventListener('click', () => item.classList.toggle('expanded'));
  });
}

function getActivityIcon(type) {
  switch (type) {
    case 'tool':        return '\u{1F527}';
    case 'tool_result': return '\u{1F4E4}';
    case 'claude':      return '\u{1F4AC}';
    case 'status':      return '\u25CF';
    case 'error':       return '\u26A0';
    case 'notif':       return '\u{1F514}';
    default:            return '\u2022';
  }
}

function bindNewTaskBtn() {
  document.getElementById('pdNewTaskBtn')?.addEventListener('click', () => {
    const projects = state.get('projects') || [];
    openCreateTaskModal(projects, (result) => {
      showToast({ type: 'success', title: t('toast.taskLaunched'), message: result.task_id?.slice(0, 8) });
      loadTasks().then(() => renderTabContent());
    });
  });
}

function bindTaskItems(container) {
  container.querySelectorAll('[data-task-id]').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('[data-task-action]')) return;
      selectedTaskId = item.dataset.taskId;
      selectedAgentId = null;
      renderTasksTab(container); // re-render to update selection
      renderTaskDetail(selectedTaskId);
    });
  });
}

function bindTaskActions(container) {
  container.querySelectorAll('[data-task-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = btn.dataset.tid;
      const action = btn.dataset.taskAction;
      await handleTaskAction(action, taskId);
    });
  });
}

async function handleTaskAction(action, taskId) {
  try {
    switch (action) {
      case 'pause':
        await api.tasks.pause(taskId);
        showToast({ type: 'warning', title: t('projectDetail.taskPaused'), message: taskId.slice(0, 8) });
        break;
      case 'kill':
        await api.tasks.kill(taskId);
        showToast({ type: 'info', title: t('projectDetail.taskStopped'), message: taskId.slice(0, 8) });
        break;
      case 'resume':
        await api.tasks.continue(taskId, 'continue');
        showToast({ type: 'success', title: t('projectDetail.taskResumed'), message: taskId.slice(0, 8) });
        break;
      case 'continue':
        await api.tasks.continue(taskId, 'continue');
        showToast({ type: 'success', title: t('projectDetail.taskContinued'), message: taskId.slice(0, 8) });
        break;
      case 'retry':
        // Get original task to re-launch
        const task = tasks.find(t => t.id === taskId);
        if (task) {
          await api.tasks.start(task.title || 'Retry', {
            project_id: projectId,
            agent_id: task.agent_id || task.agentId,
          });
          showToast({ type: 'success', title: t('toast.taskRestarted'), message: taskId.slice(0, 8) });
        }
        break;
      case 'view':
        selectedTaskId = taskId;
        selectedAgentId = null;
        renderTaskDetail(taskId);
        return; // Don't reload tasks
    }
    await loadTasks();
    renderTabContent();
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

// ═══════════════════════════════════════════════════
// Detail panel (right column)
// ═══════════════════════════════════════════════════

async function renderAgentDetail(agentId) {
  const panel = document.getElementById('pdDetailPanel');
  if (!panel) return;

  const agent = agents.find(a => a.id === agentId);
  if (!agent) {
    panel.innerHTML = '<div class="empty-state" style="padding: var(--space-lg);">Agent non trouvé</div>';
    return;
  }

  const hb = agent.lastHeartbeat;
  const status = hb?.status || 'idle';
  const progress = hb?.progress || 0;
  const parentAgent = agent.parentAgentId ? agents.find(a => a.id === agent.parentAgentId) : null;
  const childAgents = agents.filter(a => a.parentAgentId === agentId);
  const agentTasks = tasks.filter(t => (t.agent_id || t.agentId) === agentId);

  // Load inbox + skills
  let inbox = [];
  let agentSkills = [];
  try {
    const [inboxRes, skillsRes] = await Promise.all([
      api.agents.inbox(agentId, 'all').catch(() => ({ messages: [] })),
      api.agents.skills(agentId).catch(() => ({ skills: [] })),
    ]);
    inbox = inboxRes.messages || [];
    agentSkills = skillsRes.skills || [];
  } catch {}

  panel.innerHTML = `
    <div class="pd-detail-header">
      <div class="pd-detail-name">${esc(agent.name)}</div>
      <div class="pd-detail-role">${esc(agent.role || '')}</div>
    </div>

    <div class="pd-detail-section">
      <div class="pd-detail-section-title">Informations</div>
      <div class="pd-detail-row">
        <span class="pd-detail-label">Statut</span>
        <span class="pd-detail-value"><span class="status-dot ${statusDotClass(status)}"></span> ${statusLabel(status)}</span>
      </div>
      <div class="pd-detail-row">
        <span class="pd-detail-label">Progression</span>
        <span class="pd-detail-value">${progress}%</span>
      </div>
      ${hb?.summary ? `<div class="pd-detail-row">
        <span class="pd-detail-label">Résumé</span>
        <span class="pd-detail-value">${esc(hb.summary)}</span>
      </div>` : ''}
      ${parentAgent ? `<div class="pd-detail-row">
        <span class="pd-detail-label">Supérieur</span>
        <span class="pd-detail-value" style="color: var(--accent-cyan); cursor: pointer;" data-select-agent="${parentAgent.id}">${esc(parentAgent.name)}</span>
      </div>` : ''}
      ${agent.isLead ? `<div class="pd-detail-row">
        <span class="pd-detail-label">Niveau</span>
        <span class="pd-detail-value" style="color: var(--accent-yellow);">Directeur</span>
      </div>` : ''}
      ${progress > 0 ? `<div class="progress-bar" style="margin-top: var(--space-xs);">
        <div class="progress-bar-fill ${progress >= 100 ? 'green' : ''}" style="width: ${progress}%;"></div>
      </div>` : ''}
    </div>

    ${childAgents.length > 0 ? `
    <div class="pd-detail-section">
      <div class="pd-detail-section-title">Équipe (${childAgents.length})</div>
      ${childAgents.map(c => {
        const cs = c.lastHeartbeat?.status || 'idle';
        return `<div class="pd-detail-row clickable" data-select-agent="${c.id}">
          <span class="pd-detail-label"><span class="status-dot ${statusDotClass(cs)}"></span> ${esc(c.name)}</span>
          <span class="pd-detail-value">${esc(c.role || '')}</span>
        </div>`;
      }).join('')}
    </div>` : ''}

    <div class="pd-detail-section">
      <div class="pd-detail-section-title">Tâches (${agentTasks.length})</div>
      ${agentTasks.length > 0 ? agentTasks.slice(0, 10).map(t => `
        <div class="pd-detail-task clickable" data-select-task="${t.id}">
          <div class="pd-detail-task-top">
            <span>${esc(truncate(t.title || t.id, 50))}</span>
            <span class="badge ${statusBadgeClass(t.status)}">${statusLabel(t.status)}</span>
          </div>
          ${t.elapsed ? `<div class="pd-detail-task-meta">${formatDuration(t.elapsed)}</div>` : ''}
        </div>
      `).join('') : '<div style="color: var(--text-disabled); font-size: var(--text-xs);">Aucune tâche</div>'}
    </div>

    <div class="pd-detail-section">
      <div class="pd-detail-section-title">Messages récents (${inbox.length})</div>
      ${inbox.length > 0 ? inbox.slice(0, 8).map(m => `
        <div class="pd-detail-msg">
          <div class="pd-detail-msg-header">
            <span style="color: var(--accent-cyan);">${esc(m.from_name || m.fromName || '?')}</span>
            <span class="badge ${msgTypeBadge(m.msg_type || m.msgType || 'msg')}">${(m.msg_type || m.msgType || 'msg').replace(/_/g, ' ')}</span>
          </div>
          <div class="pd-detail-msg-content">${esc(truncate(m.content, 200))}</div>
        </div>
      `).join('') : '<div style="color: var(--text-disabled); font-size: var(--text-xs);">Aucun message</div>'}
    </div>

    <div class="pd-detail-section">
      <div class="pd-detail-section-title">
        Skills (${agentSkills.length})
        <button class="btn-icon-tiny" id="pdAddSkillBtn" title="Ajouter un skill">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
        </button>
      </div>
      ${agentSkills.length > 0 ? `<div class="pd-skills-list">
        ${agentSkills.map(s => `
          <span class="pd-skill-pill" data-skill-id="${s.id || s.skill_id}">
            ${esc(s.name || s.skill_name || s.id)}
            <button class="pd-skill-remove" data-remove-skill="${s.id || s.skill_id}" title="Retirer">&times;</button>
          </span>
        `).join('')}
      </div>` : '<div style="color: var(--text-disabled); font-size: var(--text-xs);">Aucun skill assigné</div>'}
      <div class="pd-skill-picker" id="pdSkillPicker" style="display: none;">
        <select class="select" id="pdSkillSelect" style="font-size: var(--text-xs);">
          <option value="">Choisir un skill...</option>
        </select>
        <button class="btn btn-sm btn-primary" id="pdSkillConfirm">Ajouter</button>
        <button class="btn btn-sm" id="pdSkillCancel">Annuler</button>
      </div>
    </div>

    <div class="pd-detail-section">
      <div class="pd-detail-section-title">
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 4v4l2.5 1.5"/></svg>
        ${t('projectDetail.waitList')}
      </div>
      <div class="pd-queue-list" id="pdQueueList_${agentId}">
        <div style="color: var(--text-disabled); font-size: var(--text-2xs);">${t('projectDetail.queueLoading')}</div>
      </div>
    </div>

    <div class="pd-detail-actions">
      <button class="btn btn-sm btn-primary" id="pdDetailInstruct">Instruction</button>
      <button class="btn btn-sm btn-warning" id="pdDetailSuspend">${agent.status === 'suspended' ? 'Activer' : 'Suspendre'}</button>
      <button class="btn btn-sm btn-danger" id="pdDetailDelete">Supprimer</button>
    </div>
  `;

  // Bind skills management
  const addSkillBtn = panel.querySelector('#pdAddSkillBtn');
  const skillPicker = panel.querySelector('#pdSkillPicker');
  const skillSelect = panel.querySelector('#pdSkillSelect');

  addSkillBtn?.addEventListener('click', async () => {
    skillPicker.style.display = 'flex';
    addSkillBtn.style.display = 'none';
    // Load available skills
    try {
      const allSkills = await api.skills.list();
      const skillList = allSkills.skills || [];
      const existingIds = new Set(agentSkills.map(s => s.id || s.skill_id));
      skillSelect.innerHTML = '<option value="">Choisir un skill...</option>' +
        skillList.filter(s => !existingIds.has(s.id)).map(s =>
          `<option value="${s.id}">${esc(s.name)}${s.category ? ` (${esc(s.category)})` : ''}</option>`
        ).join('');
    } catch {}
  });

  panel.querySelector('#pdSkillCancel')?.addEventListener('click', () => {
    skillPicker.style.display = 'none';
    addSkillBtn.style.display = '';
  });

  panel.querySelector('#pdSkillConfirm')?.addEventListener('click', async () => {
    const skillId = skillSelect.value;
    if (!skillId) return;
    try {
      await api.agents.addSkill(agentId, skillId);
      showToast({ type: 'success', title: t('projectDetail.skillAdded'), message: skillSelect.options[skillSelect.selectedIndex].text });
      renderAgentDetail(agentId);
    } catch (err) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  });

  // Bind skill removal
  panel.querySelectorAll('[data-remove-skill]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const skillId = btn.dataset.removeSkill;
      try {
        await api.agents.removeSkill(agentId, skillId);
        showToast({ type: 'info', title: t('projectDetail.skillRemoved') });
        renderAgentDetail(agentId);
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
    });
  });

  // Bind detail actions
  panel.querySelector('#pdDetailInstruct')?.addEventListener('click', () => handleAgentAction('instruct', agentId));
  panel.querySelector('#pdDetailSuspend')?.addEventListener('click', () => handleAgentAction(agent.status === 'suspended' ? 'activate' : 'suspend', agentId));
  panel.querySelector('#pdDetailDelete')?.addEventListener('click', () => handleAgentAction('delete', agentId));

  // Bind agent/task navigation links
  panel.querySelectorAll('[data-select-agent]').forEach(el => {
    el.addEventListener('click', () => {
      selectedAgentId = el.dataset.selectAgent;
      selectedTaskId = null;
      renderAgentTree();
      renderAgentDetail(selectedAgentId);
    });
  });
  panel.querySelectorAll('[data-select-task]').forEach(el => {
    el.addEventListener('click', () => {
      selectedTaskId = el.dataset.selectTask;
      selectedAgentId = null;
      renderTaskDetail(selectedTaskId);
    });
  });

  // Load queue data async (don't block panel render)
  loadAgentQueue(agentId);
}

/**
 * Strip the technical CLI REMINDER preamble from a queue item's title or
 * instruction so the user sees the actual user-facing instruction, not the
 * server-side wrapper. The reminder is always the first line and starts with
 * `[CLI REMINDER`. Falls back to the original text when no reminder is
 * present.
 */
function cleanQueueTitle(item) {
  const raw = item?.title || item?.instruction || '';
  if (!raw) return '';
  let cleaned = String(raw);
  // Strip opening "[CLI REMINDER ...]" line and anything up to the first
  // "=== USER INSTRUCTION ===" sentinel that wrapWithCliReminder injects.
  const userMarker = cleaned.indexOf('=== USER INSTRUCTION ===');
  if (userMarker >= 0) {
    cleaned = cleaned.slice(userMarker + '=== USER INSTRUCTION ==='.length).trim();
  } else if (cleaned.startsWith('[CLI REMINDER')) {
    // No marker — strip just the first bracketed line
    const nl = cleaned.indexOf('\n');
    cleaned = nl >= 0 ? cleaned.slice(nl + 1).trim() : '';
  }
  // First non-empty line is the gist
  const firstLine = cleaned.split('\n').map(l => l.trim()).find(Boolean) || cleaned.trim();
  return firstLine.length > 100 ? firstLine.slice(0, 97) + '…' : firstLine;
}

async function loadAgentQueue(agentId) {
  const container = document.getElementById(`pdQueueList_${agentId}`);
  if (!container) return;
  try {
    const data = await getAgentQueue(agentId);
    const items = data?.queued_tasks || [];
    if (items.length === 0) {
      container.innerHTML = `<div style="color: var(--text-disabled); font-size: var(--text-2xs);">${esc(t('projectDetail.noQueue') || 'Aucune tâche en attente')}</div>`;
      return;
    }
    container.innerHTML = items.map((q, i) => {
      const title = esc(cleanQueueTitle(q) || `(${esc(q.source || 'task')})`);
      const created = q.created_at ? formatRelative(q.created_at) : '';
      const source = esc(q.source || '-');
      return `<div class="pd-queue-row" style="display:flex;align-items:center;gap:8px;padding:4px 0;border-top:1px solid var(--border-subtle);font-size:var(--text-xs)">
        <span style="color:var(--text-disabled);min-width:18px;text-align:right">${i + 1}</span>
        <span style="flex:1;color:var(--text-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${title}">${title}</span>
        <span class="badge badge-muted" style="font-size:var(--text-2xs)">${source}</span>
        <span style="color:var(--text-muted);font-size:var(--text-2xs)">${esc(created)}</span>
      </div>`;
    }).join('');
  } catch (err) {
    container.innerHTML = `<div style="color: var(--status-error); font-size: var(--text-2xs);">${esc(err.message || 'Failed to load queue')}</div>`;
  }
}

async function renderTaskDetail(taskId) {
  const panel = document.getElementById('pdDetailPanel');
  if (!panel) return;

  panel.innerHTML = '<div class="empty-state" style="padding: var(--space-lg);">Chargement...</div>';

  try {
    const task = await api.tasks.get(taskId);
    const status = task.status || 'unknown';
    const agentName = findAgentName(task.agent_id || task.agentId);

    // Try to load all log lines
    let logLines = [];
    try {
      const logRes = await api.tasks.getLog(taskId, 999999);
      logLines = logRes.lines || logRes.log || [];
    } catch {}

    panel.innerHTML = `
      <div class="pd-detail-header">
        <div class="pd-detail-name">${esc(truncate(task.title || task.id, 60))}</div>
        <div class="pd-detail-role">Tâche ${task.id.slice(0, 8)}</div>
      </div>

      <div class="pd-detail-section">
        <div class="pd-detail-section-title">Informations</div>
        <div class="pd-detail-row">
          <span class="pd-detail-label">Statut</span>
          <span class="pd-detail-value"><span class="badge ${statusBadgeClass(status)}">${statusLabel(status)}</span></span>
        </div>
        ${task.elapsed ? `<div class="pd-detail-row">
          <span class="pd-detail-label">Durée</span>
          <span class="pd-detail-value">${formatDuration(task.elapsed)}</span>
        </div>` : ''}
        ${agentName ? `<div class="pd-detail-row">
          <span class="pd-detail-label">Agent</span>
          <span class="pd-detail-value" style="color: var(--accent-cyan); cursor: pointer;" data-select-agent="${task.agent_id || task.agentId}">${esc(agentName)}</span>
        </div>` : ''}
      </div>

      ${task.result ? `<div class="pd-detail-section">
        <div class="pd-detail-section-title">Résultat</div>
        <div class="pd-detail-result">${esc(task.result)}</div>
      </div>` : ''}

      ${task.error ? `<div class="pd-detail-section">
        <div class="pd-detail-section-title">Erreur</div>
        <div class="pd-detail-result pd-detail-error">${esc(task.error)}</div>
      </div>` : ''}

      ${logLines.length > 0 ? `<div class="pd-detail-section">
        <div class="pd-detail-section-title">Logs (${logLines.length} lignes)</div>
        <div class="pd-detail-log">${logLines.map(l => esc(typeof l === 'string' ? l : l.text || JSON.stringify(l))).join('\n')}</div>
      </div>` : ''}

      <div class="pd-detail-actions">
        ${renderTaskActions(task)}
      </div>
    `;

    // Bind actions
    panel.querySelectorAll('[data-task-action]').forEach(btn => {
      btn.addEventListener('click', () => handleTaskAction(btn.dataset.taskAction, btn.dataset.tid));
    });

    // Bind agent link
    panel.querySelectorAll('[data-select-agent]').forEach(el => {
      el.addEventListener('click', () => {
        selectedAgentId = el.dataset.selectAgent;
        selectedTaskId = null;
        renderAgentTree();
        renderAgentDetail(selectedAgentId);
      });
    });
  } catch (err) {
    panel.innerHTML = `<div class="empty-state" style="padding: var(--space-lg);">Erreur: ${esc(err.message)}</div>`;
  }
}

// ═══════════════════════════════════════════════════
// Inline confirmation
// ═══════════════════════════════════════════════════

function requestInlineConfirm(agentId, onConfirm) {
  // Find delete button in either the tree or detail panel
  const deleteBtn = document.querySelector(`#pdDetailDelete`) ||
    document.querySelector(`[data-agent-id="${agentId}"] [data-action="delete"]`);
  if (!deleteBtn) { onConfirm(); return; }

  const parent = deleteBtn.parentElement;
  const original = deleteBtn.outerHTML;
  const confirmEl = document.createElement('span');
  confirmEl.className = 'inline-confirm';
  confirmEl.innerHTML = `Supprimer ? <button class="btn btn-sm btn-danger ic-yes">Oui</button> <button class="btn btn-sm ic-no">Non</button>`;
  deleteBtn.replaceWith(confirmEl);

  let resolved = false;
  const cleanup = () => {
    if (resolved) return;
    resolved = true;
    const temp = document.createElement('div');
    temp.innerHTML = original;
    confirmEl.replaceWith(temp.firstElementChild);
  };

  confirmEl.querySelector('.ic-yes').addEventListener('click', async (e) => {
    e.stopPropagation();
    resolved = true;
    try { await onConfirm(); } catch (err) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
      cleanup();
    }
  });

  confirmEl.querySelector('.ic-no').addEventListener('click', (e) => {
    e.stopPropagation();
    cleanup();
  });

  // Auto-revert after 3 seconds
  setTimeout(cleanup, 3000);
}

// ═══════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════

function findAgentName(agentId) {
  if (!agentId) return '';
  const agent = agents.find(a => a.id === agentId);
  return agent?.name || agentId.slice(0, 8);
}

