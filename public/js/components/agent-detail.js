/* ═══════════════════════════════════════════════════════
   YABBY — Agent Detail View (Standalone Agents)
   ═══════════════════════════════════════════════════════
   Detail page for standalone agents (no project)
   Shows tasks, scheduled tasks, logs, and agent instructions
*/

import { state } from '../state.js';
import { api } from '../api.js';
import { esc, truncate, statusBadgeClass, statusDotClass, statusLabel, formatRelative, formatFutureTime, formatTime, formatDuration } from '../utils.js';
import { showToast } from './toast.js';
import { openSendInstructionModal } from './modal.js';
import { navigate } from '../router.js';
import { t } from '../i18n.js';

let agent = null;
let tasks = [];
let scheduledTasks = [];
let allLogs = [];
let activeTab = 'tasks';
let currentAgentId = null;

export async function render(container, params) {
  const agentId = params.id;

  // Reset all module state on each navigation (prevents stale data from previous agent)
  agent = null;
  tasks = [];
  scheduledTasks = [];
  allLogs = [];
  activeTab = 'tasks';
  currentAgentId = agentId;
  expandedTaskId = null;
  logsDisplayed = 0;

  container.innerHTML = `
    <div class="project-detail">
      <div class="pd-header">
        <div class="pd-breadcrumb">
          <a href="#/agents" class="pd-back-link">${t('sidebar.agents')}</a>
          <svg viewBox="0 0 6 10" width="6" height="10" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 1l4 4-4 4"/></svg>
          <span id="agentName">${t('common.loading')}</span>
        </div>
        <div class="pd-actions" id="agentActions"></div>
      </div>

      <div class="pd-info" id="agentInfo">
        <div class="empty-state">${t('common.loading')}</div>
      </div>

      <div class="pd-tabs">
        <button class="tab-btn active" data-tab="tasks">${t('projectDetail.tasks')}</button>
        <button class="tab-btn" data-tab="logs">${t('projectDetail.logs')}</button>
        <button class="tab-btn" data-tab="scheduled">${t('sidebar.scheduling')}</button>
        <button class="tab-btn" data-tab="instructions">${t('agentDetail.instructions')}</button>
      </div>

      <div class="tab-content active" data-tab-content="tasks" id="tasksList">
        <div class="empty-state">${t('common.loading')}</div>
      </div>

      <div class="tab-content" data-tab-content="logs" id="logsList">
        <div class="empty-state">${t('common.loading')}</div>
      </div>

      <div class="tab-content" data-tab-content="scheduled" id="scheduledList">
        <div class="empty-state">${t('common.loading')}</div>
      </div>

      <div class="tab-content" data-tab-content="instructions" id="instructionsView">
        <div class="empty-state">${t('common.loading')}</div>
      </div>
    </div>
  `;

  // Tab switching
  container.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      container.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      container.querySelector(`[data-tab-content="${btn.dataset.tab}"]`)?.classList.add('active');

      // Load data when switching to logs tab
      if (activeTab === 'logs' && allLogs.length === 0) {
        loadAllLogs(agentId);
      }
    });
  });

  // Load data
  await loadAgent(agentId);

  // SSE updates
  const onTask = () => {
    loadTasks(agentId);
    if (activeTab === 'logs') loadAllLogs(agentId);
  };
  const onActivity = () => {
    if (activeTab === 'logs') loadAllLogs(agentId);
  };

  state.addEventListener('sse:task', onTask);
  state.addEventListener('activities', onActivity);

  return () => {
    state.removeEventListener('sse:task', onTask);
    state.removeEventListener('activities', onActivity);
  };
}

async function loadAgent(agentId) {
  try {
    const res = await api.agents.get(agentId);
    if (res.error) throw new Error(res.error);

    agent = res;

    // Update breadcrumb
    document.getElementById('agentName').textContent = agent.name;

    // Render agent info
    renderAgentInfo();

    // Render actions
    renderActions();

    // Render instructions
    renderInstructions();

    // Load tasks
    await Promise.all([
      loadTasks(agentId),
      loadScheduledTasks(agentId)
    ]);
  } catch (err) {
    console.error('[AgentDetail] Load error:', err);
    document.getElementById('agentInfo').innerHTML = `
      <div class="empty-state" style="color: var(--danger);">
        ${t('common.error')}: ${esc(err.message)}
      </div>
    `;
  }
}

function renderAgentInfo() {
  const el = document.getElementById('agentInfo');
  const isSuspended = agent.status === 'suspended';

  el.innerHTML = `
    <div class="pd-info-row">
      <div class="pd-info-item">
        <div class="pd-info-label">${t('projectDetail.name')}</div>
        <div class="pd-info-value">
          <span class="status-dot ${statusDotClass(isSuspended ? 'suspended' : 'idle')}"></span>
          ${esc(agent.name)}
        </div>
      </div>
      <div class="pd-info-item">
        <div class="pd-info-label">${t('projectDetail.role')}</div>
        <div class="pd-info-value">${esc(agent.role)}</div>
      </div>
      <div class="pd-info-item">
        <div class="pd-info-label">Status</div>
        <div class="pd-info-value">
          <span class="badge ${statusBadgeClass(agent.status)}">${statusLabel(agent.status)}</span>
        </div>
      </div>
      <div class="pd-info-item">
        <div class="pd-info-label">Type</div>
        <div class="pd-info-value">${agent.projectId ? 'Project' : 'Standalone'}</div>
      </div>
    </div>
  `;
}

function renderActions() {
  const el = document.getElementById('agentActions');
  const isRunning = agent.taskStatus === 'running' && !!agent.activeTaskId;

  el.innerHTML = `
    <button class="btn btn-primary" id="btnInstruct">
      <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M1 10l2-2h7a1 1 0 001-1V3a1 1 0 00-1-1H3a1 1 0 00-1 1v4"/>
      </svg>
      ${t('projectDetail.instruction')}
    </button>
    ${isRunning ? `
    <button class="btn btn-warning" id="btnPauseTask">
      ${t('projectDetail.suspend')}
    </button>` : ''}
    <button class="btn btn-danger" id="btnDelete">
      <svg viewBox="0 0 14 14" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M2 4h10M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M4 4v8a1 1 0 001 1h4a1 1 0 001-1V4"/>
      </svg>
      ${t('common.delete')}
    </button>
  `;

  // Bind actions
  document.getElementById('btnInstruct')?.addEventListener('click', () => {
    openSendInstructionModal(agent.id, agent.name, async (result) => {
      showToast({ type: 'success', title: t('projectDetail.instructionSent'), message: agent.name });
      await loadTasks(agent.id);
    });
  });

  document.getElementById('btnPauseTask')?.addEventListener('click', async () => {
    try {
      if (!agent.activeTaskId) return;
      await api.tasks.pause(agent.activeTaskId);
      showToast({ type: 'warning', title: t('projectDetail.taskPaused') || t('projectDetail.agentSuspended'), message: agent.name });
      await loadAgent(agent.id);
    } catch (err) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  });

  document.getElementById('btnDelete')?.addEventListener('click', async () => {
    const confirmed = confirm(t('agentDirectory.deleteConfirm') + ' ' + agent.name);
    if (!confirmed) return;

    try {
      await api.agents.delete(agent.id);
      showToast({ type: 'info', title: t('projectDetail.agentDeleted'), message: agent.name });
      navigate('/agents');
    } catch (err) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  });
}

function renderInstructions() {
  const el = document.getElementById('instructionsView');

  if (!agent.systemPrompt) {
    el.innerHTML = `
      <div class="empty-state">
        <div style="font-size: var(--text-md); color: var(--text-muted);">${t('agentDetail.noInstructions')}</div>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="agent-instructions">
      <div class="instructions-header">
        <span class="section-title">${t('agentDetail.systemPrompt')}</span>
        <button class="btn btn-sm" id="btnCopyPrompt">
          <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="4" y="4" width="7" height="7" rx="1"/>
            <path d="M3 10V3a1 1 0 011-1h7"/>
          </svg>
          ${t('common.copy')}
        </button>
      </div>
      <pre class="instructions-content">${esc(agent.systemPrompt)}</pre>
    </div>
  `;

  document.getElementById('btnCopyPrompt')?.addEventListener('click', () => {
    navigator.clipboard.writeText(agent.systemPrompt);
    showToast({ type: 'success', title: t('common.copy'), message: t('agentDetail.promptCopied') });
  });
}

async function loadTasks(agentId) {
  try {
    const res = await api.tasks.search('*', { agent_id: agentId, limit: 100 });
    tasks = res.tasks || [];
    renderTasks();
  } catch (err) {
    console.error('[AgentDetail] Load tasks error:', err);
    document.getElementById('tasksList').innerHTML = `
      <div class="empty-state" style="color: var(--danger);">
        ${t('common.error')}: ${esc(err.message)}
      </div>
    `;
  }
}

let expandedTaskId = null;

function formatDateTime(dateStr) {
  if (!dateStr) return { date: '-', time: '' };
  const d = new Date(dateStr);
  return {
    date: d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }),
    time: d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
  };
}

function renderTasks() {
  const el = document.getElementById('tasksList');

  if (tasks.length === 0) {
    el.innerHTML = `<div class="empty-state"><div style="color: var(--text-muted);">${t('taskManager.noTasks')}</div></div>`;
    return;
  }

  el.innerHTML = `
    <div class="table-wrap">
      <table class="table tm-table">
        <thead>
          <tr>
            <th>${t('tasks.task')}</th>
            <th>Created</th>
            <th>Updated</th>
            <th>${t('common.status')}</th>
            <th>${t('tasks.duration')}</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map(task => {
            const label = (task.title || task.task || task.id).replace(/^\[.*?\]\s*/, '');
            const elapsed = task.elapsed ? formatDuration(task.elapsed) : '-';
            const created = formatDateTime(task.created_at || task.createdAt);
            const updated = formatDateTime(task.last_log_time || task.updated_at || task.created_at || task.createdAt);
            const isExpanded = task.id === expandedTaskId;
            return `<tr class="tm-row ${isExpanded ? 'expanded' : ''}" data-task-id="${task.id}">
              <td class="tm-cell-title">
                <span class="tm-task-title">${esc(truncate(label, 60))}</span>
                <span class="tm-task-id">${task.id.slice(0, 8)}</span>
              </td>
              <td class="tm-cell-date">
                <span class="tm-date">${created.date}</span>
                <span class="tm-time">${created.time}</span>
              </td>
              <td class="tm-cell-date">
                <span class="tm-date">${updated.date}</span>
                <span class="tm-time">${updated.time}</span>
              </td>
              <td><span class="badge ${statusBadgeClass(task.status)}">${statusLabel(task.status)}</span></td>
              <td class="tm-cell-elapsed">${elapsed}</td>
            </tr>
            ${isExpanded ? `<tr class="tm-expanded-row"><td colspan="5">
              <div class="tm-expanded-content" id="adExpanded_${task.id}">${t('common.loading')}</div>
            </td></tr>` : ''}`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;

  el.querySelectorAll('.tm-row').forEach(row => {
    row.addEventListener('click', async () => {
      const tid = row.dataset.taskId;
      expandedTaskId = expandedTaskId === tid ? null : tid;
      renderTasks();
      if (expandedTaskId) {
        const contentEl = document.getElementById(`adExpanded_${expandedTaskId}`);
        if (contentEl) await loadTaskDetails(expandedTaskId, contentEl);
      }
    });
  });
}

// Log type detection + styling (mirrors activity page colors)
/** Format a single claude log line — returns HTML or null to skip the entry */
function formatClaudeLine(text) {
  const t = text.trim();
  // Table separator → skip entirely
  if (/^\|[-\s:|]+\|$/.test(t)) return null;
  // Empty table row like "| | |" → skip
  if (/^\|(\s*\|)+\s*$/.test(t)) return null;
  // Table data row: | key | value | → "key: value"
  if (t.startsWith('|') && t.endsWith('|')) {
    const cells = t.split('|').slice(1, -1).map(c => c.trim()).filter(c => c);
    if (cells.length >= 2) {
      const key = cells[0].replace(/\*\*/g, '');
      const val = cells[1].replace(/\*\*/g, '');
      let s = `<strong>${esc(key)}</strong> ${esc(val)}`;
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      return s;
    }
    return null; // table row with no useful data
  }
  // List item: "- text" → "• text"
  const listMatch = t.match(/^-\s+(.+)$/);
  if (listMatch) {
    let s = esc(listMatch[1]);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return `<span style="padding-left:8px">• ${s}</span>`;
  }
  // Bullet "• text" already formatted
  const bulletMatch = t.match(/^•\s+(.+)$/);
  if (bulletMatch) {
    let s = esc(bulletMatch[1]);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    return `<span style="padding-left:8px">• ${s}</span>`;
  }
  // Arrow "→ text"
  if (t.startsWith('→')) {
    let s = esc(t);
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    return s;
  }
  // Default: bold + inline code
  let s = esc(t);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  return s;
}

function detectLogType(line) {
  if (/TASK STARTED/i.test(line)) return 'status';
  if (/TOOL:/i.test(line)) return 'tool';
  if (/TOOL_RESULT:|RESULT:/i.test(line)) return 'tool_result';
  if (/RUNNER:/i.test(line)) return 'claude';
  if (/FINAL_OUTPUT:/i.test(line)) return 'claude';
  if (/EXITED:/i.test(line)) return 'status';
  if (/AGENT:/i.test(line)) return 'status';
  if (/STDERR:|Error:|FAILED/i.test(line)) return 'error';
  if (/NOTIFY|NOTIF|speaker/i.test(line)) return 'notif';
  return 'info';
}

function logTypeBadge(type) {
  const labels = { tool: 'Tool', tool_result: 'Result', claude: 'Runner', status: 'Status', error: 'Error', notif: 'Notif', info: 'Info' };
  const colors = { tool: 'badge-warning', tool_result: 'badge-info', claude: 'badge-success', status: 'badge-primary', error: 'badge-danger', notif: 'badge-purple', info: '' };
  return `<span class="badge ${colors[type] || ''}" style="font-size:10px;">${labels[type] || type}</span>`;
}

// Lazy loading state for logs
const LOG_PAGE_SIZE = 50;
let logsDisplayed = 0;
let taskTitlesMap = {};

async function loadAllLogs(agentId) {
  const el = document.getElementById('logsList');
  el.innerHTML = `<div class="empty-state">${t('common.loading')}</div>`;

  try {
    const tasksRes = await api.tasks.search('*', { agent_id: agentId, limit: 100 });
    const tasksList = tasksRes.tasks || [];
    const taskIds = tasksList.map(t => t.id);

    // Build title map for display in log entries
    taskTitlesMap = {};
    tasksList.forEach(t => {
      const title = (t.title || t.id).replace(/^\[.*?\]\s*/, '');
      taskTitlesMap[t.id] = truncate(title, 30);
    });

    if (taskIds.length === 0) {
      el.innerHTML = `
        <div class="empty-state">
          <div style="font-size: var(--text-md); color: var(--text-muted);">${t('agentDetail.noLogs')}</div>
          <div style="font-size: var(--text-xs); color: var(--text-disabled);">${t('agentDetail.logsHint')}</div>
        </div>
      `;
      return;
    }

    // Load logs — use tail mode (most recent lines)
    const logsPromises = taskIds.map(id =>
      api.tasks.getLog(id, 500).catch(() => ({ lines: [] }))
    );
    const logsResults = await Promise.all(logsPromises);

    allLogs = [];
    logsResults.forEach((res, idx) => {
      const taskId = taskIds[idx];
      const lines = Array.isArray(res) ? res : (res?.lines || []);
      lines.forEach(line => {
        const raw = typeof line === 'string' ? line : (line?.content || JSON.stringify(line));
        const tsMatch = raw.match(/^\[(.*?)\]/);
        const type = detectLogType(raw);
        allLogs.push({
          content: raw,
          timestamp: tsMatch ? tsMatch[1] : (line?.timestamp || new Date().toISOString()),
          type,
          taskId,
        });
      });
    });

    // Sort most recent first
    allLogs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    logsDisplayed = 0;
    renderLogs(false);
  } catch (err) {
    console.error('[AgentDetail] Load logs error:', err);
    el.innerHTML = `<div class="empty-state" style="color: var(--danger);">${t('common.error')}: ${esc(err.message)}</div>`;
  }
}

function renderLogs(append = false) {
  const el = document.getElementById('logsList');

  if (allLogs.length === 0) {
    el.innerHTML = `<div class="empty-state"><div style="font-size: var(--text-md); color: var(--text-muted);">${t('agentDetail.noLogs')}</div></div>`;
    return;
  }

  const batch = allLogs.slice(logsDisplayed, logsDisplayed + LOG_PAGE_SIZE);
  logsDisplayed += batch.length;

  const typeLabels = { tool: 'Tool', tool_result: 'Result', claude: 'Runner', status: 'Status', error: 'Error', notif: 'Notif', info: 'Log' };

  const batchHtml = batch.map(log => {
    const type = log.type || 'info';
    let raw = log.content.replace(/^\[.*?\]\s*/, '');
    const label = typeLabels[type] || type;
    const taskTitle = taskTitlesMap[log.taskId] || log.taskId.slice(0, 8);

    let contentHtml = '';

    if (type === 'tool') {
      // Parse TOOL: ToolName → {"command":"...","description":"..."}
      const m = raw.match(/^TOOL:\s*(\w+)\s*→\s*(.*)/s);
      if (m) {
        const toolName = m[1];
        try {
          const parsed = JSON.parse(m[2]);
          const desc = parsed.description || '';
          const cmd = parsed.command || parsed.file_path || parsed.pattern || '';
          contentHtml = `<div class="log-content"><span class="log-tool-name">${esc(toolName)}</span>` +
            (desc ? ` <span class="log-tool-desc">— ${esc(desc)}</span>` : '') +
            (cmd ? `<pre class="log-tool-cmd">${esc(cmd)}</pre>` : '') +
            `</div>`;
        } catch {
          // JSON truncated — extract what we can via regex
          const descMatch = m[2].match(/"description"\s*:\s*"([^"]+)"/);
          const cmdMatch = m[2].match(/"command"\s*:\s*"([\s\S]*?)(?:"\s*[,}]|$)/);
          const fileMatch = !cmdMatch && m[2].match(/"file_path"\s*:\s*"([^"]+)"/);
          const patMatch = !cmdMatch && !fileMatch && m[2].match(/"pattern"\s*:\s*"([^"]+)"/);
          const desc = descMatch ? descMatch[1] : '';
          const cmdRaw = cmdMatch ? cmdMatch[1] : (fileMatch ? fileMatch[1] : (patMatch ? patMatch[1] : m[2]));
          const cmd = cmdRaw.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
          contentHtml = `<div class="log-content"><span class="log-tool-name">${esc(toolName)}</span>` +
            (desc ? ` <span class="log-tool-desc">— ${esc(desc)}</span>` : '') +
            `<pre class="log-tool-cmd">${esc(cmd)}</pre></div>`;
        }
      }
    } else if (type === 'claude') {
      raw = raw.replace(/^(RUNNER:|FINAL_OUTPUT:)\s*/, '');
      const formatted = formatClaudeLine(raw);
      if (formatted === null) return null; // skip separator/empty table rows
      contentHtml = `<div class="log-content">${formatted}</div>`;
    } else if (type === 'status') {
      raw = raw.replace(/^(TASK STARTED:|EXITED:|AGENT:|RESULT:)\s*/, '');
      if (raw.length > 200) raw = raw.slice(0, 200) + '...';
      contentHtml = `<div class="log-content">${esc(raw)}</div>`;
    }

    if (!contentHtml) {
      // Unprefixed continuation lines (tables, lists, text) — format like claude
      const formatted = formatClaudeLine(raw);
      if (formatted === null) return null;
      contentHtml = `<div class="log-content">${formatted}</div>`;
    }

    return `
    <div class="log-entry log-${type}">
      <div class="log-header">
        <span class="log-type-label log-label-${type}">${label}</span>
        <span class="log-task-ref">${esc(taskTitle)} <span class="log-task-id-inline">#${log.taskId.slice(0, 8)}</span></span>
        <span class="log-time">${formatTime(log.timestamp)}</span>
      </div>
      ${contentHtml}
    </div>`;
  }).filter(x => x !== null).join('');

  // Remove old sentinel before adding content
  const oldSentinel = el.querySelector('.logs-load-sentinel');
  if (oldSentinel) oldSentinel.remove();

  if (append) {
    const container = el.querySelector('.logs-container');
    if (container) container.insertAdjacentHTML('beforeend', batchHtml);
  } else {
    el.innerHTML = `
      <div style="font-size:var(--text-xs);color:var(--text-muted);padding:var(--space-xs) 0;">${allLogs.length} log lines</div>
      <div class="logs-container">${batchHtml}</div>
    `;
  }

  // Add sentinel + observer if more data remains
  if (logsDisplayed < allLogs.length) {
    const container = el.querySelector('.logs-container');
    if (container) {
      const sentinel = document.createElement('div');
      sentinel.className = 'logs-load-sentinel';
      sentinel.style.height = '1px';
      container.after(sentinel);

      const observer = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && logsDisplayed < allLogs.length) {
          observer.disconnect();
          renderLogs(true);
        }
      }, { threshold: 0 });
      observer.observe(sentinel);
    }
  }
}

async function loadScheduledTasks(agentId) {
  try {
    const res = await fetch(`/api/scheduled-tasks?agent_id=${agentId}`).then(r => r.json());
    scheduledTasks = res.tasks || [];
    renderScheduledTasks();
  } catch (err) {
    console.error('[AgentDetail] Load scheduled tasks error:', err);
    document.getElementById('scheduledList').innerHTML = `
      <div class="empty-state" style="color: var(--danger);">
        ${t('common.error')}: ${esc(err.message)}
      </div>
    `;
  }
}

function renderScheduledTasks() {
  const el = document.getElementById('scheduledList');

  if (scheduledTasks.length === 0) {
    el.innerHTML = `
      <div class="empty-state">
        <div style="font-size: var(--text-md); color: var(--text-muted);">${t('scheduledTasks.noScheduled')}</div>
        <div style="font-size: var(--text-xs); color: var(--text-disabled);">${t('scheduledTasks.createHint')}</div>
      </div>
    `;
    return;
  }

  el.innerHTML = `
    <div class="task-list">
      ${scheduledTasks.map(st => {
        const isActive = st.status === 'active';
        const intervalMs = st.scheduleConfig?.interval_ms;
        const intervalHours = intervalMs ? Math.round(intervalMs / 3600000) : null;

        return `
        <div class="task-item scheduled-task-item">
          <div class="task-item-header">
            <div class="task-item-title">
              <span class="status-dot ${isActive ? 'active' : 'suspended'}"></span>
              <span class="task-item-text">${esc(st.name || truncate(st.taskTemplate, 80))}</span>
            </div>
            <div class="task-item-meta">
              <span class="badge ${isActive ? 'badge-success' : 'badge-muted'}">${st.scheduleType}</span>
              ${st.nextRunAt ? `<span class="task-item-time">${t('scheduledTasks.next')}: ${formatFutureTime(st.nextRunAt)}</span>` : ''}
            </div>
          </div>
          <div class="scheduled-task-details">
            ${st.scheduleConfig ? `
              <div class="scheduled-detail">
                ${st.scheduleType === 'interval' && intervalMs
                  ? intervalHours >= 1
                    ? `Toutes les ${intervalHours} heure${intervalHours > 1 ? 's' : ''}`
                    : `Toutes les ${Math.round(intervalMs / 60000)} min`
                  : st.scheduleType === 'cron'
                  ? `Cron: ${st.scheduleConfig.cron}`
                  : ''}
              </div>
            ` : ''}
            ${st.lastRunAt ? `<div class="scheduled-detail">${t('scheduledTasks.lastRun')}: ${formatRelative(st.lastRunAt)}</div>` : ''}
            ${st.runCount ? `<div class="scheduled-detail">${st.runCount} exécution${st.runCount > 1 ? 's' : ''}</div>` : ''}
          </div>
        </div>
        `;
      }).join('')}
    </div>
  `;
}

async function loadTaskDetails(taskId, contentEl) {
  try {
    const task = await api.tasks.get(taskId);

    let logLines = [];
    try {
      const logRes = await api.tasks.getLog(taskId, 50);
      logLines = logRes.lines || logRes.log || [];
    } catch {}

    // Render markdown-like result
    function renderResult(text) {
      if (!text) return '';
      let html = esc(text);
      html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" style="color:var(--accent-cyan);">$1</a>');
      html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
      return html;
    }

    // Reuse task-manager's expanded content layout (tm-expanded-content)
    contentEl.innerHTML = `
      <div class="tm-detail-grid">
        <div class="tm-detail-info">
          <div class="tm-detail-row">
            <span class="tm-detail-label">ID</span>
            <span class="tm-detail-value"><code>${task.id}</code></span>
          </div>
          ${task.elapsed ? `<div class="tm-detail-row">
            <span class="tm-detail-label">${t('tasks.duration')}</span>
            <span class="tm-detail-value">${formatDuration(task.elapsed)}</span>
          </div>` : ''}
          <div class="tm-detail-row">
            <span class="tm-detail-label">${t('common.status')}</span>
            <span class="tm-detail-value"><span class="badge ${statusBadgeClass(task.status)}">${statusLabel(task.status)}</span></span>
          </div>
        </div>
        <div class="tm-detail-result">
          ${task.result ? `
            <div class="tm-detail-section-title">${t('common.result')}</div>
            <div class="pd-detail-result" style="white-space:pre-wrap;line-height:1.6;">${renderResult(task.result)}</div>
          ` : ''}
          ${task.error ? `
            <div class="tm-detail-section-title" style="color:var(--accent-red);">${t('common.error')}</div>
            <div class="pd-detail-result pd-detail-error">${esc(typeof task.error === 'string' ? task.error.slice(0, 800) : JSON.stringify(task.error).slice(0, 800))}</div>
          ` : ''}
          ${logLines.length > 0 ? `
            <div class="tm-detail-section-title">Logs (${logLines.length})</div>
            <div class="pd-detail-log">${logLines.map(l => esc(typeof l === 'string' ? l : l.text || JSON.stringify(l))).join('\n')}</div>
          ` : ''}
          ${!task.result && !task.error && logLines.length === 0 ? `<div style="color:var(--text-disabled);font-size:var(--text-xs);">${t('tasks.noDetail')}</div>` : ''}
        </div>
      </div>
    `;
  } catch (err) {
    console.error('[AgentDetail] Load task details error:', err);
    contentEl.innerHTML = `<div style="color:var(--accent-red);font-size:var(--text-xs);">${t('common.error')}: ${esc(err.message)}</div>`;
  }
}
