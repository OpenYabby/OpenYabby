/* ═══════════════════════════════════════════════════════
   YABBY — Activity Page (Full Event History)
   ═══════════════════════════════════════════════════════
   Full-page view of all SSE activity events with filters,
   pagination, and detailed timeline display.
   Live-updates: new events are prepended without full re-render.
*/

import { state } from '../state.js';
import { esc } from '../utils.js';
import { t, getLocale } from '../i18n.js';

let activeFilter = 'all';
let pageSize = 100;
let displayedCount = 0;
let lastSeenTime = 0;  // timestamp of newest rendered event
let bgRefreshTimer = null;

export async function render(container) {
  activeFilter = 'all';
  displayedCount = 0;
  lastSeenTime = 0;

  container.innerHTML = `
    <div class="activity-page activity-page-vsplit">

      <!-- ── TOP: CLI tasks ── -->
      <section class="activity-section activity-section-cli">
        <header class="activity-section-header">
          <div>
            <h2 class="activity-section-title">${t('activity.cliSectionTitle')}</h2>
            <p class="activity-section-subtitle">${t('activity.cliSectionSubtitle')}</p>
          </div>
          <div class="activity-section-meta">
            <div class="filter-pills" id="activityPageFilters">
              <span class="filter-pill active" data-filter="all">${t('activity.filterAll')}</span>
              <span class="filter-pill" data-filter="tool">${t('activity.filterTool')}</span>
              <span class="filter-pill" data-filter="tool_result">${t('activity.filterResults')}</span>
              <span class="filter-pill" data-filter="claude">${t('activity.filterClaude')}</span>
              <span class="filter-pill" data-filter="status">${t('activity.filterStatus')}</span>
              <span class="filter-pill" data-filter="error">${t('activity.filterError')}</span>
              <span class="filter-pill" data-filter="notif">${t('activity.filterNotif')}</span>
              <span class="filter-pill" data-filter="preview">${t('activity.filterPreview')}</span>
            </div>
            <div class="activity-page-count" id="activityPageCount"></div>
          </div>
        </header>

        <div class="activity-section-scroll" id="cliScrollContainer">
          <div class="activity-page-timeline" id="activityTimeline">
            <div class="empty-state" style="padding: var(--space-xl);">${t('activity.waitingEvents')}</div>
          </div>
          <div class="activity-page-load-more" id="activityLoadMore" style="display:none">
            <button class="btn btn-sm" id="activityLoadMoreBtn">${t('activity.loadMore')}</button>
          </div>
        </div>
      </section>

      <!-- ── BOTTOM: Background tasks ── -->
      <section class="activity-section activity-section-bg">
        <header class="activity-section-header">
          <div>
            <h2 class="activity-section-title">${t('activity.bgSectionTitle')}</h2>
            <p class="activity-section-subtitle">${t('activity.bgSectionSubtitle')}</p>
          </div>
          <div class="activity-section-meta">
            <div class="filter-pills" id="bgPanelFilters">
              <span class="filter-pill active" data-bg-filter="running">${t('activity.bgFilterRunning')}</span>
              <span class="filter-pill" data-bg-filter="all">${t('activity.bgFilterAll')}</span>
            </div>
            <div class="activity-page-count" id="bgPanelCount"></div>
          </div>
        </header>

        <div class="activity-section-scroll" id="bgScrollContainer">
          <div class="bg-panel-list" id="bgPanelList">
            <div class="empty-state" style="padding: var(--space-md); font-size: var(--text-2xs);">${t('activity.bgLoading')}</div>
          </div>
        </div>
      </section>
    </div>
  `;

  // Bind filters
  document.getElementById('activityPageFilters')?.addEventListener('click', (e) => {
    const pill = e.target.closest('.filter-pill');
    if (!pill) return;
    activeFilter = pill.dataset.filter;
    document.querySelectorAll('#activityPageFilters .filter-pill').forEach(p => p.classList.remove('active'));
    pill.classList.add('active');
    displayedCount = 0;
    lastSeenTime = 0;
    renderTimeline(state.get('activities'));
  });

  // Load more
  document.getElementById('activityLoadMoreBtn')?.addEventListener('click', () => {
    renderTimeline(state.get('activities'), true);
  });

  // Initial render
  renderTimeline(state.get('activities'));

  // Subscribe to live updates — incremental prepend, not full re-render
  const unsub = state.on('activities', onActivitiesChanged);

  // ── BG TASKS PANEL ──
  let bgFilter = 'running';
  document.querySelectorAll('#bgPanelFilters .filter-pill').forEach(p => {
    p.addEventListener('click', () => {
      bgFilter = p.dataset.bgFilter;
      document.querySelectorAll('#bgPanelFilters .filter-pill').forEach(o => o.classList.remove('active'));
      p.classList.add('active');
      refreshBgPanel(bgFilter);
    });
  });

  refreshBgPanel(bgFilter);
  bgRefreshTimer = setInterval(() => refreshBgPanel(bgFilter), 15000);

  // Refresh bg panel on relevant SSE events
  const onBgEvent = () => refreshBgPanel(bgFilter);
  state.addEventListener('sse:task', onBgEvent);

  return () => {
    unsub();
    state.removeEventListener('sse:task', onBgEvent);
    if (bgRefreshTimer) { clearInterval(bgRefreshTimer); bgRefreshTimer = null; }
  };
}

async function refreshBgPanel(filter) {
  const listEl = document.getElementById('bgPanelList');
  const countEl = document.getElementById('bgPanelCount');
  if (!listEl) return;
  try {
    const params = filter === 'running' ? '?status=running' : '?limit=50';
    const res = await fetch(`/api/bg-tasks${params}`);
    const data = await res.json();
    const rows = data.bg_tasks || [];
    if (countEl) {
      const n = rows.length;
      const plural = n !== 1 ? 's' : '';
      countEl.textContent = t('activity.eventCount', { n, s: plural });
    }
    if (rows.length === 0) {
      const emptyKey = filter === 'running' ? 'activity.bgEmptyRunning' : 'activity.bgEmpty';
      listEl.innerHTML = `<div class="empty-state" style="padding: var(--space-md); font-size: var(--text-2xs);">${t(emptyKey)}</div>`;
      return;
    }
    const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
    listEl.innerHTML = rows.map(r => renderBgRow(r, locale)).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state" style="padding: var(--space-md); color: var(--danger); font-size: var(--text-2xs);">${esc(err.message)}</div>`;
  }
}

function renderBgRow(row, locale) {
  const started = new Date(row.started_at);
  const ended = row.ended_at ? new Date(row.ended_at) : null;
  const now = Date.now();
  const elapsedMs = (ended ? ended.getTime() : now) - started.getTime();
  const elapsed = formatBgDuration(elapsedMs);
  const startedStr = started.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const statusClass = bgStatusClass(row.status);
  const statusLabel = bgStatusLabel(row.status);
  const serviceBadge = row.is_service ? `<span class="bg-row-badge bg-row-badge-service">${t('activity.bgBadgeService')}</span>` : '';
  const agentName = row.agent_name || (row.agent_id ? row.agent_id.slice(0, 8) : '—');
  const desc = row.description || row.cli_task_id;
  const exitInfo = row.exit_code !== null && row.exit_code !== undefined
    ? `<span class="bg-row-exit">exit ${row.exit_code}</span>` : '';
  const pidInfo = row.pid ? `<span class="bg-row-pid">pid ${row.pid}</span>` : '';

  return `<div class="bg-row bg-row-${statusClass}">
    <div class="bg-row-top">
      <span class="bg-row-status badge badge-${statusClass}">${statusLabel}</span>
      ${serviceBadge}
      <span class="bg-row-elapsed">${elapsed}</span>
    </div>
    <div class="bg-row-desc" title="${esc(desc)}">${esc(desc.slice(0, 90))}</div>
    <div class="bg-row-meta">
      <span class="bg-row-agent">${esc(agentName)}</span>
      ${pidInfo}
      ${exitInfo}
      <span class="bg-row-started">${startedStr}</span>
    </div>
  </div>`;
}

function formatBgDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ' ' + (s % 60) + 's' : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ' ' + (m % 60) + 'm' : ''}`;
}

function bgStatusClass(s) {
  switch (s) {
    case 'running':      return 'running';
    case 'completed':    return 'done';
    case 'failed':       return 'error';
    case 'service_died': return 'llm-limit';
    case 'orphaned':     return 'muted';
    case 'stopped':      return 'muted';
    default:             return 'info';
  }
}

function bgStatusLabel(s) {
  switch (s) {
    case 'running':      return t('activity.bgStatusRunning');
    case 'completed':    return t('activity.bgStatusCompleted');
    case 'failed':       return t('activity.bgStatusFailed');
    case 'service_died': return t('activity.bgStatusServiceDied');
    case 'orphaned':     return t('activity.bgStatusOrphaned');
    case 'stopped':      return t('activity.bgStatusStopped');
    default:             return s || '—';
  }
}

function onActivitiesChanged(activities) {
  if (!activities || activities.length === 0) return;

  const timeline = document.getElementById('activityTimeline');
  if (!timeline) return;

  // Find new events (prepended to the array, newer than what we've rendered)
  const newItems = [];
  for (const a of activities) {
    if (a.time <= lastSeenTime) break;
    if (activeFilter !== 'all' && a.type !== activeFilter) continue;
    newItems.push(a);
  }

  // Update counter
  updateCount(activities);

  if (newItems.length === 0) return;

  // Render new items and prepend to DOM
  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  const html = newItems.map(a => renderItem(a, locale)).join('');

  // If timeline shows empty state, replace it
  const emptyState = timeline.querySelector('.empty-state');
  if (emptyState) {
    timeline.innerHTML = html;
  } else {
    timeline.insertAdjacentHTML('afterbegin', html);
  }

  // Update lastSeenTime
  lastSeenTime = activities[0].time;
  displayedCount += newItems.length;

  // Bind verbose toggles on new items
  bindVerbose(timeline);
}

function renderTimeline(activities, append = false) {
  const timeline = document.getElementById('activityTimeline');
  const loadMoreEl = document.getElementById('activityLoadMore');
  if (!timeline || !activities) return;

  const filtered = activeFilter === 'all'
    ? activities
    : activities.filter(a => a.type === activeFilter);

  updateCount(activities);

  if (filtered.length === 0) {
    timeline.innerHTML = `<div class="empty-state" style="padding: var(--space-xl);">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.3"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></svg>
      <div style="margin-top: var(--space-sm)">${activeFilter === 'all' ? (t('activity.noEventsSession')) : (t('activity.noEventsType'))}</div>
    </div>`;
    if (loadMoreEl) loadMoreEl.style.display = 'none';
    lastSeenTime = 0;
    displayedCount = 0;
    return;
  }

  const startIdx = append ? displayedCount : 0;
  const endIdx = startIdx + pageSize;
  const slice = filtered.slice(startIdx, endIdx);
  displayedCount = endIdx;

  const locale = getLocale() === 'fr' ? 'fr-FR' : 'en-US';
  const html = slice.map(a => renderItem(a, locale)).join('');

  if (append) {
    timeline.insertAdjacentHTML('beforeend', html);
  } else {
    timeline.innerHTML = html;
  }

  // Track newest rendered event
  if (filtered.length > 0) {
    lastSeenTime = filtered[0].time;
  }

  if (loadMoreEl) {
    loadMoreEl.style.display = displayedCount < filtered.length ? 'flex' : 'none';
  }

  bindVerbose(timeline);
}

function renderItem(a, locale) {
  const time = new Date(a.time);
  const timeStr = time.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const dateStr = time.toLocaleDateString(locale, { day: '2-digit', month: 'short' });
  const icon = getIcon(a.type);
  const typeLabel = getTypeLabel(a.type);
  const typeClass = a.type || 'default';
  const taskRef = a.taskId ? `<span class="atp-task-ref">${a.taskId.slice(0, 8)}</span>` : '';
  const hasVerbose = a.verbose && a.verbose.length > 120;

  return `<div class="atp-item${hasVerbose ? ' atp-has-verbose' : ''}" data-type="${typeClass}">
    <div class="atp-dot-col">
      <div class="atp-dot atp-dot-${typeClass}"></div>
      <div class="atp-line"></div>
    </div>
    <div class="atp-content">
      <div class="atp-header">
        <span class="atp-icon ${typeClass}">${icon}</span>
        <span class="atp-type-badge badge badge-${getBadgeClass(a.type)}">${typeLabel}</span>
        ${taskRef}
        <span class="atp-time">${timeStr}</span>
        <span class="atp-date">${dateStr}</span>
      </div>
      <div class="atp-text ${typeClass}">${esc(a.text)}</div>
      ${hasVerbose ? `<div class="atp-verbose">${esc(a.verbose)}</div>` : ''}
    </div>
  </div>`;
}

function updateCount(activities) {
  const countEl = document.getElementById('activityPageCount');
  if (!countEl || !activities) return;
  const filtered = activeFilter === 'all' ? activities : activities.filter(a => a.type === activeFilter);
  const n = filtered.length;
  const plural = n !== 1 ? 's' : '';
  countEl.textContent = t('activity.eventCount', { n, s: plural });
}

function bindVerbose(container) {
  container.querySelectorAll('.atp-has-verbose').forEach(item => {
    if (item.dataset.bound) return;
    item.dataset.bound = 'true';
    item.addEventListener('click', () => item.classList.toggle('atp-expanded'));
  });
}

function getIcon(type) {
  switch (type) {
    case 'tool':        return '\uD83D\uDD27';
    case 'tool_result': return '\uD83D\uDCE4';
    case 'claude':      return '\uD83D\uDCAC';
    case 'status':      return '\u25CF';
    case 'error':       return '\u26A0';
    case 'notif':       return '\uD83D\uDD14';
    case 'preview':     return '\uD83D\uDCBB';
    default:            return '\u2022';
  }
}

function getTypeLabel(type) {
  switch (type) {
    case 'tool':        return t('activity.typeTool') || 'Outil';
    case 'tool_result': return t('activity.typeResult');
    case 'claude':      return t('activity.typeClaude');
    case 'status':      return t('activity.typeStatus');
    case 'error':       return t('activity.typeError') || 'Erreur';
    case 'notif':       return t('activity.typeNotif') || 'Notif';
    case 'preview':     return t('activity.typePreview') || 'Preview';
    default:            return 'Event';
  }
}

function getBadgeClass(type) {
  switch (type) {
    case 'tool':        return 'running';
    case 'tool_result': return 'info';
    case 'claude':      return 'done';
    case 'status':      return 'active';
    case 'error':       return 'error';
    case 'notif':       return 'llm-limit';
    case 'preview':     return 'info';
    default:            return 'muted';
  }
}
