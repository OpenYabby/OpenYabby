/* ═══════════════════════════════════════════════════════
   YABBY — Dashboard View (Phase 3)
   ═══════════════════════════════════════════════════════ */

import { state } from '../state.js';
import { api } from '../api.js';
import { esc, formatRelative, statusBadgeClass, statusLabel } from '../utils.js';
import { navigate } from '../router.js';
import { showToast } from './toast.js';
import { t, getLocale } from '../i18n.js';

// Activity filter state
let activeFilter = 'all';

export async function render(container, params) {
  container.innerHTML = `
    <div class="dashboard">
      <!-- Welcome row with crayfish watermark -->
      <div class="dash-welcome">
        <div class="dash-welcome-text">
          <h2 class="dash-title">${t('dashboard.title')}</h2>
          <p class="dash-subtitle" id="dashSubtitle">${t('common.loading')}</p>
        </div>
        <!-- Subtle crayfish watermark -->
        <svg class="dash-watermark" viewBox="0 0 120 100" fill="none" stroke="currentColor" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M60 80c-6 0-12-3-15-9l-6-12c-3-6-2-12 2-15"/>
          <path d="M60 80c6 0 12-3 15-9l6-12c3-6 2-12-2-15"/>
          <ellipse cx="60" cy="55" rx="14" ry="20"/>
          <path d="M42 42c-8-5-18-8-23-5-3 2-2 6 3 9l14 8"/>
          <path d="M78 42c8-5 18-8 23-5 3 2 2 6-3 9L84 54"/>
          <path d="M52 38c-5-10-12-18-18-22" opacity=".5"/>
          <path d="M68 38c5-10 12-18 18-22" opacity=".5"/>
          <path d="M52 82c-3 5-6 9-9 11" opacity=".4"/>
          <path d="M60 84c0 5 0 9 0 11" opacity=".4"/>
          <path d="M68 82c3 5 6 9 9 11" opacity=".4"/>
        </svg>
      </div>

      <!-- Tunnel code banner -->
      <div id="tunnelBanner" class="tunnel-banner" style="display:none;align-items:center;gap:10px;padding:12px 16px;margin-bottom:16px;background:rgba(126,200,227,0.08);border:1px solid rgba(126,200,227,0.2);border-radius:10px;font-size:0.9em;color:var(--text-secondary,#b0b0b0)"></div>

      <!-- Stats row -->
      <div class="dash-stats" id="dashStats">
        <div class="stat-card" data-stat="running">
          <div class="stat-card-icon stat-running-icon">
            <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/></svg>
          </div>
          <div class="stat-card-body">
            <span class="stat-value" id="statRunning">-</span>
            <span class="stat-label">${t('dashboard.statRunning')}</span>
          </div>
        </div>
        <div class="stat-card" data-stat="done">
          <div class="stat-card-icon stat-done-icon">
            <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7"/><path d="M7 10l2 2 4-4"/></svg>
          </div>
          <div class="stat-card-body">
            <span class="stat-value" id="statDone">-</span>
            <span class="stat-label">${t('dashboard.statDone')}</span>
          </div>
        </div>
        <div class="stat-card" data-stat="errors">
          <div class="stat-card-icon stat-error-icon">
            <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7"/><path d="M10 7v4"/><circle cx="10" cy="13" r=".5" fill="currentColor"/></svg>
          </div>
          <div class="stat-card-body">
            <span class="stat-value" id="statErrors">-</span>
            <span class="stat-label">${t('dashboard.statErrors')}</span>
          </div>
        </div>
        <div class="stat-card" data-stat="paused">
          <div class="stat-card-icon stat-paused-icon">
            <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="10" cy="10" r="7"/><path d="M8 7v6M12 7v6"/></svg>
          </div>
          <div class="stat-card-body">
            <span class="stat-value" id="statPaused">-</span>
            <span class="stat-label">${t('dashboard.statPaused')}</span>
          </div>
        </div>
      </div>

      <!-- Two-column: Projects + Activity -->
      <div class="dash-grid">
        <!-- Projects -->
        <div class="dash-section">
          <div class="dash-section-header">
            <span class="section-title">${t('dashboard.projects')}</span>
            <button class="btn btn-sm btn-primary" id="newProjectBtn">${t('dashboard.newProject')}</button>
          </div>
          <div class="card-grid" id="projectGrid">
            <div class="empty-state" style="padding: var(--space-xl);">${t('common.loading')}</div>
          </div>
        </div>

        <!-- Activity feed -->
        <div class="dash-section dash-activity-section">
          <div class="dash-section-header">
            <span class="section-title">${t('dashboard.activity')}</span>
            <a class="dash-see-all" data-navigate-activity>${t('common.seeAll') || 'See all'} <span class="dash-see-all-arrow">\u2192</span></a>
          </div>
          <div class="filter-pills" id="activityFilters">
            <span class="filter-pill active" data-filter="all">${t('dashboard.filterAll')}</span>
            <span class="filter-pill" data-filter="tool">${t('dashboard.filterTool')}</span>
            <span class="filter-pill" data-filter="claude">${t('dashboard.filterClaude')}</span>
            <span class="filter-pill" data-filter="status">${t('dashboard.filterStatus')}</span>
            <span class="filter-pill" data-filter="error">${t('dashboard.filterError')}</span>
            <span class="filter-pill" data-filter="notif">${t('dashboard.filterNotif')}</span>
            <span class="filter-pill" data-filter="preview">${t('dashboard.filterPreview')}</span>
          </div>
          <div id="activityFeed" class="activity-feed scrollable">
            <div class="empty-state" style="padding: var(--space-xl);">${t('dashboard.waitingActivity')}</div>
          </div>
        </div>
      </div>
    </div>
  `;

  // Bind "new project" button
  document.getElementById('newProjectBtn')?.addEventListener('click', async () => {
    const { openCreateProjectModal } = await import('./modal.js');
    openCreateProjectModal((result) => {
      showToast({ type: 'success', title: t('dashboard.projectCreated'), message: result.name });
      loadDashboard();
    });
  });

  // Bind stat card clicks → navigate to tasks with filter
  document.querySelectorAll('.stat-card[data-stat]').forEach(card => {
    card.addEventListener('click', () => {
      const statusMap = { running: 'running', done: 'done', errors: 'error', paused: 'paused' };
      const status = statusMap[card.dataset.stat];
      if (status) navigate(`/tasks?status=${status}`);
    });
  });

  // Bind "Voir tout" activity link
  container.querySelector('[data-navigate-activity]')?.addEventListener('click', (e) => {
    e.preventDefault();
    navigate('/activity');
  });

  // Bind activity filters
  document.getElementById('activityFilters')?.addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    activeFilter = pill.dataset.filter;
    document.querySelectorAll('#activityFilters .filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    renderActivities(state.get('activities'));
  });

  // Load initial data
  await loadDashboard();

  // Subscribe to SSE updates
  const unsub1 = state.on('activities', renderActivities);
  const unsubSSE = () => {
    state.removeEventListener('sse:task', onTaskEvent);
    state.removeEventListener('sse:heartbeat', onHeartbeatEvent);
  };
  state.addEventListener('sse:task', onTaskEvent);
  state.addEventListener('sse:heartbeat', onHeartbeatEvent);

  return () => { unsub1(); unsubSSE(); };
}

async function loadDashboard() {
  try {
    const [projectsRes, tasksRes, healthRes] = await Promise.all([
      api.projects.list(),
      api.tasks.list(),
      api.health.basic(),
    ]);

    // Show tunnel code if connected to relay
    const tunnelBanner = document.getElementById('tunnelBanner');
    if (tunnelBanner && healthRes.tunnel) {
      tunnelBanner.style.display = 'flex';
      tunnelBanner.innerHTML = `
        <svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="var(--accent-cyan,#7ec8e3)" stroke-width="1.5" style="flex-shrink:0;opacity:0.7"><path d="M10 2a8 8 0 100 16 8 8 0 000-16z"/><path d="M10 6v4l2.5 1.5"/></svg>
        <span style="flex:1">${t('dashboard.mobileCode')}</span>
        <span id="tunnelCodeDisplay" style="cursor:pointer;letter-spacing:4px;font-size:1.15em;font-weight:700;color:var(--accent-cyan,#7ec8e3);padding:4px 12px;border-radius:6px;background:rgba(126,200,227,0.06);border:1px solid rgba(126,200,227,0.15);transition:all 0.2s" onclick="navigator.clipboard.writeText('${esc(healthRes.tunnel.code)}');this.textContent='Copié ✓';this.style.color='#4ade80';setTimeout(()=>{this.textContent='${esc(healthRes.tunnel.code)}';this.style.color=''},1500)" title="Cliquer pour copier">${esc(healthRes.tunnel.code)}</span>
      `;
    } else if (tunnelBanner) {
      tunnelBanner.style.display = 'none';
    }

    const projects = (projectsRes.projects || []).filter(p => p.id !== 'default');
    const tasks = tasksRes.tasks || [];
    state.set('projects', projects);
    state.set('tasks', tasks);

    const running = tasks.filter(t => t.status === 'running').length;
    const done = tasks.filter(t => t.status === 'done').length;
    const errors = tasks.filter(t => t.status === 'error').length;

    // Update subtitle
    const sub = document.getElementById('dashSubtitle');
    if (sub) {
      if (running > 0) {
        sub.textContent = t('dashboard.subtitleRunning', { n: running, s: running > 1 ? 's' : '', p: projects.length, ps: projects.length > 1 ? 's' : '' });
      } else {
        sub.textContent = t('dashboard.subtitleIdle', { p: projects.length, ps: projects.length > 1 ? 's' : '', d: done, ds: done > 1 ? 's' : '', dss: done > 1 ? 's' : '' });
      }
    }

    renderStats(tasks);
    renderProjects(projects);
    renderActivities(state.get('activities'));
  } catch (err) {
    console.error('[Dashboard] Load error:', err);
  }
}

function renderStats(tasks) {
  const running = tasks.filter(t => t.status === 'running').length;
  const done = tasks.filter(t => t.status === 'done').length;
  const errors = tasks.filter(t => t.status === 'error').length;
  const paused = tasks.filter(t => t.status === 'paused').length;

  setVal('statRunning', running);
  setVal('statDone', done);
  setVal('statErrors', errors);
  setVal('statPaused', paused);
}

function setVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function renderProjects(projects) {
  const grid = document.getElementById('projectGrid');
  if (!grid) return;

  if (projects.length === 0) {
    grid.innerHTML = `
      <div class="card create-card" id="createProjectCard">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 5v14M5 12h14"/></svg>
        <span>${t('dashboard.newProjectCard')}</span>
      </div>
    `;
    bindCreateProject();
    return;
  }

  grid.innerHTML = projects.map(p => {
    const progress = p.status === 'completed' ? 100 : (p.overallProgress || 0);
    const r = 22;
    const circ = 2 * Math.PI * r;
    const offset = circ - (progress / 100) * circ;
    const progressColor = progress >= 100 ? 'var(--accent-green)' : progress > 0 ? 'var(--accent-blue)' : 'var(--glass-border)';

    return `
    <div class="card project-card clickable" data-project-id="${p.id}">
      <div class="project-card-top">
        <div class="project-card-info">
          <div class="project-card-name">${esc(p.name)}</div>
          <div class="project-card-type">${esc(p.projectType || 'projet')}</div>
        </div>
        ${progress > 0 ? `
        <svg class="project-ring" viewBox="0 0 50 50" width="40" height="40">
          <circle cx="25" cy="25" r="${r}" fill="none" stroke="rgba(255,255,255,0.04)" stroke-width="3"/>
          <circle cx="25" cy="25" r="${r}" fill="none" stroke="${progressColor}" stroke-width="3"
            stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
            stroke-linecap="round" transform="rotate(-90 25 25)"
            style="transition: stroke-dashoffset 0.8s ease"/>
          <text x="25" y="27" text-anchor="middle" font-size="10" fill="${progressColor}" font-weight="600">${progress}%</text>
        </svg>` : `
        <span class="badge ${statusBadgeClass(p.status || 'active')}">${statusLabel(p.status || 'active')}</span>`}
      </div>
      <div class="project-card-meta">
        <span>${p.agentCount || 0} ${t('projects.agents')}</span>
        <span>${p.taskCount || 0} ${t('projects.taskPlural')}</span>
        ${p.activeTaskCount ? `<span class="project-card-active">${p.activeTaskCount} ${t('status.runningLower')}</span>` : ''}
      </div>
    </div>`;
  }).join('') + `
    <div class="card create-card" id="createProjectCard">
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 5v14M5 12h14"/></svg>
      <span>${t('dashboard.newProjectCard')}</span>
    </div>
  `;

  // Bind project card clicks
  grid.querySelectorAll('[data-project-id]').forEach(card => {
    card.addEventListener('click', () => {
      import('../router.js').then(m => m.navigate(`/projects/${card.dataset.projectId}`));
    });
  });

  bindCreateProject();
}

function bindCreateProject() {
  const btn = document.getElementById('createProjectCard');
  if (btn) {
    btn.addEventListener('click', async () => {
      const { openCreateProjectModal } = await import('./modal.js');
      openCreateProjectModal((result) => {
        showToast({ type: 'success', title: t('dashboard.projectCreated'), message: result.name });
        loadDashboard();
      });
    });
  }
}

function renderActivities(activities) {
  const feed = document.getElementById('activityFeed');
  if (!feed || !activities) return;

  const filtered = activeFilter === 'all'
    ? activities
    : activities.filter(a => a.type === activeFilter);

  if (filtered.length === 0) {
    feed.innerHTML = `<div class="empty-state" style="padding: var(--space-xl);">
      ${activeFilter === 'all' ? t('dashboard.waitingActivity') : t('tasks.noFilterResults')}
    </div>`;
    return;
  }

  feed.innerHTML = filtered.slice(0, 80).map(a => {
    if (a.type === 'preview' && a.preview) {
      return renderPreviewBlock(a.preview, a.time);
    }

    const time = new Date(a.time).toLocaleTimeString(getLocale() === 'fr' ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const icon = a.type === 'tool' ? '&#x1F527;'
      : a.type === 'tool_result' ? '&#x1F4E4;'
      : a.type === 'claude' ? '&#x1F4AC;'
      : a.type === 'status' ? '&#x25CF;'
      : a.type === 'error' ? '&#x26A0;'
      : a.type === 'notif' ? '&#x1F514;'
      : '&#x2022;';

    const hasVerbose = a.verbose && a.verbose.length > 120;
    return `<div class="activity-item${hasVerbose ? ' has-verbose' : ''}">
      <span class="activity-time">${time}</span>
      <span class="activity-icon ${a.type || ''}">${icon}</span>
      <span class="activity-text ${a.type || ''}">${esc(a.text)}</span>
      ${hasVerbose ? `<div class="activity-verbose">${esc(a.verbose)}</div>` : ''}
    </div>`;
  }).join('');

  // Bind verbose expand/collapse
  feed.querySelectorAll('.activity-item.has-verbose').forEach(item => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.pv-block')) return; // Don't interfere with preview blocks
      item.classList.toggle('expanded');
    });
  });

  bindPreviewInteractions(feed);
  if (typeof Prism !== 'undefined') Prism.highlightAllUnder(feed);
}

// ── Preview block rendering ──

function escCode(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMdSafe(text) {
  if (!text) return '';
  try {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(marked.parse(text));
    }
  } catch {}
  return esc(text);
}

function renderPreviewBlock(block, time) {
  const timeStr = new Date(time).toLocaleTimeString(getLocale() === 'fr' ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const lines = (block.content || '').split('\n').length;
  const collapsed = lines > 5 ? 'collapsed' : '';

  const typeIcons = { html: '&#x1F310;', code: '&#x1F4BB;', markdown: '&#x1F4DD;' };
  const typeLabels = { html: 'HTML', code: block.language || 'Code', markdown: 'Markdown' };

  let contentHtml;
  if (block.type === 'html') {
    contentHtml = `<div class="pv-iframe-wrap"><iframe class="pv-iframe" sandbox="allow-scripts" srcdoc="${escAttr(block.content)}"></iframe></div>`;
  } else if (block.type === 'code') {
    const langClass = block.language ? `language-${esc(block.language)}` : '';
    contentHtml = `<div class="pv-code-wrap">
      <div class="pv-code-header">
        <span class="pv-code-lang">${esc(block.language || 'text')}</span>
        <button class="pv-copy-btn" data-block-id="${block.id}" title="Copier">&#x1F4CB;</button>
      </div>
      <pre class="pv-code"><code class="${langClass}">${escCode(block.content)}</code></pre>
    </div>`;
  } else {
    contentHtml = `<div class="pv-markdown">${renderMdSafe(block.content)}</div>`;
  }

  return `<div class="pv-block ${collapsed}" data-block-id="${block.id}" data-type="${block.type}">
    <div class="pv-header">
      <span class="activity-time">${timeStr}</span>
      <span class="pv-type-icon">${typeIcons[block.type] || ''}</span>
      <span class="pv-title">${esc(block.title || typeLabels[block.type])}</span>
      <div class="pv-actions">
        <button class="pv-btn pv-toggle" title="Expand/Collapse">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>
        </button>
        <button class="pv-btn pv-fullscreen" title="Plein \u00e9cran">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4"/></svg>
        </button>
      </div>
    </div>
    <div class="pv-content">${contentHtml}</div>
  </div>`;
}

function bindPreviewInteractions(container) {
  // Toggle expand/collapse
  container.querySelectorAll('.pv-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const block = btn.closest('.pv-block');
      if (block) block.classList.toggle('collapsed');
    });
  });

  // Header click also toggles
  container.querySelectorAll('.pv-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.pv-btn')) return;
      const block = header.closest('.pv-block');
      if (block) block.classList.toggle('collapsed');
    });
  });

  // Copy button
  container.querySelectorAll('.pv-copy-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const blockId = btn.dataset.blockId;
      const blocks = state.get('previewBlocks') || [];
      const block = blocks.find(b => b.id === blockId);
      if (block) {
        try {
          await navigator.clipboard.writeText(block.content);
          btn.innerHTML = '&#x2713;';
          setTimeout(() => { btn.innerHTML = '&#x1F4CB;'; }, 1500);
        } catch {}
      }
    });
  });

  // Fullscreen
  container.querySelectorAll('.pv-fullscreen').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const blockEl = btn.closest('.pv-block');
      const blockId = blockEl?.dataset.blockId;
      const blocks = state.get('previewBlocks') || [];
      const block = blocks.find(b => b.id === blockId);
      if (block) openPreviewFullscreen(block);
    });
  });
}

async function openPreviewFullscreen(block) {
  const { openModal } = await import('./modal.js');

  let bodyHtml;
  if (block.type === 'html') {
    bodyHtml = `<div class="pv-fullscreen-content"><iframe class="pv-iframe-full" sandbox="allow-scripts" srcdoc="${escAttr(block.content)}"></iframe></div>`;
  } else if (block.type === 'code') {
    const langClass = block.language ? `language-${esc(block.language)}` : '';
    bodyHtml = `<div class="pv-fullscreen-content"><pre class="pv-code-full"><code class="${langClass}">${escCode(block.content)}</code></pre></div>`;
  } else {
    bodyHtml = `<div class="pv-fullscreen-content pv-markdown-full">${renderMdSafe(block.content)}</div>`;
  }

  openModal({
    title: block.title || `Preview (${block.type})`,
    body: bodyHtml,
    submitLabel: t('common.close'),
    cancelLabel: '',
    onSubmit: () => {},
  });

  // Highlight code in modal
  setTimeout(() => {
    const modal = document.getElementById('modalContent');
    if (modal && typeof Prism !== 'undefined') Prism.highlightAllUnder(modal);
  }, 100);
}

function onTaskEvent() {
  api.tasks.list().then(res => {
    state.set('tasks', res.tasks || []);
    renderStats(res.tasks || []);
  }).catch(() => {});
}

function onHeartbeatEvent() {
  api.projects.list().then(res => {
    const projects = (res.projects || []).filter(p => p.id !== 'default');
    state.set('projects', projects);
    renderProjects(projects);
  }).catch(() => {});
}
