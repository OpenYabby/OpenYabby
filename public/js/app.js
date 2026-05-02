/* ═══════════════════════════════════════════════════════
   YABBY — App Entry Point
   ═══════════════════════════════════════════════════════
   Initializes the SPA: router, SSE, voice panel (orb),
   sidebar, keyboard shortcuts, and global state subscriptions.
*/

import { state } from './state.js';
import { initRouter, navigate, refreshBreadcrumb } from './router.js';
import { initSSE } from './sse.js';
import { initToasts } from './components/toast.js';
import { initVoice } from './voice.js';
import { initVoicePanel } from './components/voice-panel.js';
import { initAgentChats } from './components/agent-chat.js';
import { api } from './api.js';
import { esc } from './utils.js';
import { initI18n, t, onLocaleChange } from './i18n.js';
import { initNotifications } from './notifications.js';
import { initSystemStats } from './components/system-stats.js';

// ═══ Sidebar toggle ═══
function initSidebar() {
  const app = document.getElementById('app');
  const toggle = document.getElementById('sidebarToggle');
  const saved = localStorage.getItem('yabby-sidebar');

  if (saved === 'expanded') {
    app.classList.add('sidebar-expanded');
    state.set('sidebarExpanded', true);
  }

  toggle?.addEventListener('click', () => {
    const expanded = app.classList.toggle('sidebar-expanded');
    state.set('sidebarExpanded', expanded);
    localStorage.setItem('yabby-sidebar', expanded ? 'expanded' : 'collapsed');
  });
}

// ═══ Keyboard shortcuts ═══
function initKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const isMod = e.metaKey || e.ctrlKey;
    if (!isMod) return;

    // Ctrl+/ — focus search
    if (e.key === '/') {
      e.preventDefault();
      document.getElementById('globalSearch')?.focus();
    }

    // Ctrl+1 — Dashboard
    if (e.key === '1') { e.preventDefault(); navigate('/'); }
    // Ctrl+2 — Tasks
    if (e.key === '2') { e.preventDefault(); navigate('/tasks'); }
    // Ctrl+3 — Agents
    if (e.key === '3') { e.preventDefault(); navigate('/agents'); }
  });
}

// ═══ Global search ═══
function initGlobalSearch() {
  const input = document.getElementById('globalSearch');
  if (!input) return;

  // Create dropdown
  const dropdown = document.createElement('div');
  dropdown.className = 'search-dropdown';
  dropdown.id = 'searchDropdown';
  input.parentElement.appendChild(dropdown);

  let debounce = null;
  let cachedProjects = [];
  let cachedAgents = [];

  // Preload data on focus
  input.addEventListener('focus', async () => {
    try {
      const [pRes, tRes] = await Promise.all([
        api.projects.list(),
        api.tasks.list(),
      ]);
      cachedProjects = (pRes.projects || []).filter(p => p.id !== 'default');
      state.set('tasks', tRes.tasks || []);

      // Load agents from heartbeats
      cachedAgents = [];
      const hbs = await Promise.all(
        cachedProjects.map(p => api.projects.heartbeat(p.id).catch(() => null))
      );
      for (let i = 0; i < cachedProjects.length; i++) {
        const hb = hbs[i];
        if (!hb) continue;
        for (const a of (hb.agentStatuses || [])) {
          cachedAgents.push({ ...a, projectId: cachedProjects[i].id, projectName: cachedProjects[i].name });
        }
      }
    } catch {}
  });

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => runSearch(input.value.trim().toLowerCase()), 150);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      dropdown.classList.remove('visible');
      input.blur();
    }
    if (e.key === 'Enter') {
      const first = dropdown.querySelector('.search-result-item');
      if (first) { first.click(); }
    }
  });

  // Close on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.topbar-center')) {
      dropdown.classList.remove('visible');
    }
  });

  function runSearch(q) {
    if (!q || q.length < 2) {
      dropdown.classList.remove('visible');
      return;
    }

    const results = [];

    // Search projects
    for (const p of cachedProjects) {
      const hay = `${p.name || ''} ${p.description || ''} ${p.projectType || ''}`.toLowerCase();
      if (hay.includes(q)) {
        results.push({ type: 'project', label: p.name, sub: p.projectType || 'projet', route: `/projects/${p.id}` });
      }
    }

    // Search tasks
    const tasks = state.get('tasks') || [];
    for (const t of tasks) {
      const hay = `${t.title || ''} ${t.id || ''} ${t.status || ''}`.toLowerCase();
      if (hay.includes(q)) {
        results.push({ type: 'task', label: t.title || t.id.slice(0, 12), sub: t.status, route: '/tasks' });
      }
    }

    // Search agents
    for (const a of cachedAgents) {
      const hay = `${a.name || ''} ${a.role || ''} ${a.projectName || ''}`.toLowerCase();
      if (hay.includes(q)) {
        results.push({ type: 'agent', label: a.name, sub: `${a.role || 'Agent'} · ${a.projectName || ''}`, route: `/projects/${a.projectId}` });
      }
    }

    if (results.length === 0) {
      dropdown.innerHTML = `<div class="search-empty">${t('topbar.noResults')}</div>`;
      dropdown.classList.add('visible');
      return;
    }

    const icons = {
      project: '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="1" y="3" width="12" height="9" rx="1.5"/><path d="M4 3V2a1 1 0 011-1h4a1 1 0 011 1v1"/></svg>',
      task: '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 7.5l2.5 2.5 5-5.5"/><rect x="1" y="1" width="12" height="12" rx="2.5"/></svg>',
      agent: '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="5" r="2.5"/><path d="M2.5 13c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"/></svg>',
    };

    dropdown.innerHTML = results.slice(0, 12).map(r => `
      <div class="search-result-item" data-route="${r.route}">
        <span class="search-result-icon">${icons[r.type] || ''}</span>
        <div class="search-result-text">
          <span class="search-result-label">${esc(r.label)}</span>
          <span class="search-result-sub">${esc(r.sub)}</span>
        </div>
        <span class="search-result-type">${r.type}</span>
      </div>
    `).join('');

    dropdown.classList.add('visible');

    // Bind clicks
    dropdown.querySelectorAll('.search-result-item').forEach(item => {
      item.addEventListener('click', () => {
        navigate(item.dataset.route);
        input.value = '';
        dropdown.classList.remove('visible');
        input.blur();
      });
    });
  }
}

// ═══ Auth check ═══
async function checkAuth() {
  try {
    const token = localStorage.getItem('yabby_token');
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
    const res = await fetch('/api/auth/me', { headers });
    const data = await res.json();

    if (data.enabled && !data.user) {
      // Auth is enabled but user is not authenticated — redirect to login
      if (window.location.hash !== '#/login') {
        window.location.hash = '#/login';
      }
      return false;
    }

    // Auth is enabled and user is authenticated — show logout button
    if (data.enabled && data.user) {
      showLogoutButton();
    }
  } catch {
    // Can't reach server — continue anyway
  }
  return true;
}

function showLogoutButton() {
  const topbarRight = document.querySelector('.topbar-right');
  if (!topbarRight || document.getElementById('logoutBtn')) return;

  const btn = document.createElement('button');
  btn.id = 'logoutBtn';
  btn.className = 'btn btn-sm btn-ghost';
  btn.title = t('topbar.logout');
  btn.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h3"/><path d="M10 11l3-3-3-3"/><path d="M13 8H6"/></svg>';
  btn.style.cssText = 'background:none;border:none;color:var(--text-muted);cursor:pointer;padding:4px;border-radius:4px;display:flex;align-items:center;transition:color 0.15s';
  btn.addEventListener('mouseenter', () => btn.style.color = 'var(--accent-red)');
  btn.addEventListener('mouseleave', () => btn.style.color = 'var(--text-muted)');
  btn.addEventListener('click', async () => {
    try {
      const token = localStorage.getItem('yabby_token');
      if (token) {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}` },
        });
      }
    } catch {}
    localStorage.removeItem('yabby_token');
    window.location.hash = '#/login';
    window.location.reload();
  });
  topbarRight.appendChild(btn);
}

// ═══ Update static HTML labels from i18n ═══
function updateStaticLabels() {
  // Sidebar labels
  const sidebarMap = {
    '/': 'sidebar.dashboard',
    '/activity': 'sidebar.activity',
    '/projects': 'sidebar.projects',
    '/tasks': 'sidebar.tasks',
    '/simple-tasks': 'sidebar.simpleTasks',
    '/agents': 'sidebar.agents',
    '/scheduled-tasks': 'sidebar.scheduling',
    '/channels': 'sidebar.channels',
    '/connectors': 'sidebar.connectors',
    '/preview': 'sidebar.preview',
    '/presentations': 'sidebar.presentations',
    '/settings': 'sidebar.settings',
  };
  document.querySelectorAll('.sidebar-item[data-route]').forEach(item => {
    const route = item.dataset.route;
    const key = sidebarMap[route];
    if (key) {
      const label = item.querySelector('.label');
      if (label) label.textContent = t(key);
      item.title = t(key);
    }
  });

  // Search placeholder
  const search = document.getElementById('globalSearch');
  if (search) search.placeholder = t('topbar.searchPlaceholder');

  // Notification bell
  const bell = document.getElementById('notifBell');
  if (bell) bell.title = t('topbar.notifications');

  const notifTitle = document.getElementById('notifDropdownTitle');
  if (notifTitle) notifTitle.textContent = t('notifications.title');

  const sidebarToggle = document.getElementById('sidebarToggle');
  if (sidebarToggle) sidebarToggle.title = t('topbar.toggleSidebar');
}

// ═══ Init ═══
async function init() {
  // Check auth before initializing the full app
  const authOk = await checkAuth();

  // Load i18n before UI renders
  let configLocale = null;
  let needsOnboarding = false;
  try {
    const config = await api.config.getAll();
    configLocale = config.general?.uiLocale || config.general?.language;
    needsOnboarding = !config.onboarding?.completed;
  } catch {}

  // Load locale BEFORE onboarding so t() resolves properly
  await initI18n(configLocale);
  updateStaticLabels();

  if (needsOnboarding) {
    try {
      const { showOnboarding } = await import('./components/onboarding.js');
      await showOnboarding();
    } catch {}
  }

  // Re-translate static labels and breadcrumb when locale changes
  onLocaleChange(() => {
    updateStaticLabels();
    refreshBreadcrumb();
  });

  initSidebar();
  initKeyboardShortcuts();
  initGlobalSearch();
  initSSE();
  initToasts();
  initVoice();        // WebRTC, wake word, tool dispatch
  initVoicePanel();   // Orb UI, chat panel, state subscriptions
  initNotifications(); // Bell badge + dropdown
  initSystemStats();   // CPU + task counters widget
  initAgentChats();   // Multi-agent chat windows
  initRouter();

  // Check for pending plan reviews (in case SSE event was missed)
  try {
    const reviews = await api.planReviews.list();
    if (reviews?.length > 0) {
      const pending = reviews[0]; // Most recent pending review
      const { openPlanReviewModal } = await import('./components/plan-review.js');
      openPlanReviewModal({ ...pending, reviewId: pending.id });
    }
  } catch {}

  // Check for pending project questions (in case SSE event was missed)
  // ALL questions are handled through voice session only (no modal popups)
  try {
    const questions = await api.projectQuestions.list();
    if (questions?.length > 0) {
      const pending = questions[0];
      // Modal popup removed — all questions delivered via voice only
      // Questions will be announced when voice session connects and processes queue
      console.log('[App] Pending question detected, will be handled via voice:', pending.id);
    }
  } catch {}

  console.log('[Yabby] App initialized');
}

// Wait for DOM
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

// ═══ Disable browser autocomplete on all inputs except login/password ═══
function disableAutocomplete(el) {
  if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA') return;
  if (el.autocomplete === 'username' || el.autocomplete === 'current-password') return;
  if (el.type === 'checkbox') return;
  if (!el.hasAttribute('autocomplete') || el.getAttribute('autocomplete') === 'off') el.setAttribute('autocomplete', 'nope');
  if (!el.hasAttribute('autocorrect')) el.setAttribute('autocorrect', 'off');
  if (!el.hasAttribute('autocapitalize')) el.setAttribute('autocapitalize', 'off');
  if (!el.hasAttribute('spellcheck')) el.setAttribute('spellcheck', 'false');
}
new MutationObserver(mutations => {
  for (const m of mutations) for (const n of m.addedNodes) {
    if (n.nodeType !== 1) continue;
    disableAutocomplete(n);
    n.querySelectorAll?.('input, textarea').forEach(disableAutocomplete);
  }
}).observe(document.body, { childList: true, subtree: true });
document.querySelectorAll('input, textarea').forEach(disableAutocomplete);
