/* ═══════════════════════════════════════════════════════
   YABBY — Hash-based SPA Router
   ═══════════════════════════════════════════════════════
   Minimal router that lazy-loads view modules and renders
   them into the main content area. Supports route params.
*/

import { state } from './state.js';
import { t } from './i18n.js';

const routes = [
  { pattern: '/',               module: './components/dashboard.js',       titleKey: 'sidebar.dashboard' },
  { pattern: '/projects',       module: './components/project-list.js',    titleKey: 'sidebar.projects' },
  { pattern: '/projects/:id',   module: './components/project-detail.js',  titleKey: 'sidebar.projects' },
  { pattern: '/activity',        module: './components/activity.js',         titleKey: 'sidebar.activity' },
  { pattern: '/tasks',           module: './components/task-manager.js',     titleKey: 'sidebar.tasks' },
  { pattern: '/simple-tasks',   module: './components/simple-tasks.js',    titleKey: 'sidebar.simpleTasks' },
  { pattern: '/agents',          module: './components/agent-directory.js',  titleKey: 'sidebar.agents' },
  { pattern: '/agents/:id',      module: './components/agent-detail.js',     titleKey: 'sidebar.agents' },
  { pattern: '/scheduled-tasks', module: './components/scheduled-tasks.js', titleKey: 'sidebar.scheduling' },
  { pattern: '/channels',        module: './components/channels.js',        titleKey: 'sidebar.channels' },
  { pattern: '/connectors',      module: './components/connectors.js',      titleKey: 'sidebar.connectors' },
  { pattern: '/preview',         module: './components/preview.js',         titleKey: 'sidebar.preview' },
  { pattern: '/presentations',   module: './components/presentations.js',   titleKey: 'sidebar.presentations' },
  { pattern: '/settings',        module: './components/settings.js',        titleKey: 'sidebar.settings' },
  { pattern: '/login',           module: './components/login.js',           titleKey: 'login.loginTitle' },
];

const moduleCache = new Map();
let currentCleanup = null;

/** Match a hash path against a route pattern, return params or null */
function matchRoute(path, pattern) {
  const pathParts = path.split('/').filter(Boolean);
  const patternParts = pattern.split('/').filter(Boolean);

  if (pathParts.length !== patternParts.length) return null;

  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(':')) {
      params[patternParts[i].slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

/** Navigate to a route */
export function navigate(path) {
  window.location.hash = '#' + path;
}

/** Get current hash path (strips query params) */
function getHashPath() {
  const hash = window.location.hash.slice(1) || '/';
  const path = hash.split('?')[0];
  return path.startsWith('/') ? path : '/' + path;
}

/** Parse query params from hash (e.g. #/tasks?status=running) */
function getHashQuery() {
  const hash = window.location.hash.slice(1) || '/';
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return {};
  const query = {};
  new URLSearchParams(hash.slice(qIdx + 1)).forEach((v, k) => { query[k] = v; });
  return query;
}

/** Handle route change */
async function handleRoute() {
  let path = getHashPath();
  const container = document.getElementById('mainContent');
  if (!container) return;

  // Redirect removed routes
  if (path === '/mcp') { navigate('/connectors'); return; }

  // Find matching route
  let matched = null;
  let params = {};
  for (const route of routes) {
    const p = matchRoute(path, route.pattern);
    if (p !== null) {
      matched = route;
      params = p;
      break;
    }
  }

  // Fallback to dashboard
  if (!matched) {
    matched = routes[0];
    params = {};
  }

  // Merge query params into route params
  const query = getHashQuery();
  Object.assign(params, query);

  // Update state
  state.set('currentRoute', matched.pattern);
  state.set('routeParams', params);

  // Toggle login mode (hide sidebar, topbar, voice panel)
  const app = document.getElementById('app');
  if (app) {
    if (matched.pattern === '/login') {
      app.classList.add('login-mode');
    } else {
      app.classList.remove('login-mode');
    }
  }

  // Update sidebar active state
  document.querySelectorAll('.sidebar-item').forEach(item => {
    const route = item.dataset.route;
    if (route === matched.pattern || (matched.pattern === '/projects/:id' && route === '/projects')) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });

  // Update breadcrumb
  updateBreadcrumb(matched, params);

  // Cleanup previous view
  if (currentCleanup) {
    try { currentCleanup(); } catch {}
    currentCleanup = null;
  }

  // Transition out
  container.classList.remove('view-active');
  container.classList.add('view-enter');

  // Load module (cached)
  try {
    if (!moduleCache.has(matched.module)) {
      const mod = await import(matched.module);
      moduleCache.set(matched.module, mod);
    }
    const mod = moduleCache.get(matched.module);

    // Small delay for transition
    await new Promise(r => setTimeout(r, 50));

    // Render
    container.innerHTML = '';
    if (mod.render) {
      const cleanup = await mod.render(container, params);
      if (typeof cleanup === 'function') {
        currentCleanup = cleanup;
      }
    }

    // Transition in
    requestAnimationFrame(() => {
      container.classList.remove('view-enter');
      container.classList.add('view-active');
    });
  } catch (err) {
    console.error('[Router] Failed to load view:', err);
    container.innerHTML = `<div class="empty-state"><div class="icon">!</div><div>${t('common.loadError')}</div><div style="font-size:11px;color:var(--text-disabled)">${err.message}</div></div>`;
    container.classList.remove('view-enter');
    container.classList.add('view-active');
  }
}

/** Update breadcrumb based on current route */
function updateBreadcrumb(route, params) {
  const el = document.getElementById('breadcrumb');
  if (!el) return;

  const title = t(route.titleKey);
  if (route.pattern === '/') {
    el.innerHTML = `<span>${title}</span>`;
  } else if (route.pattern === '/projects/:id') {
    el.innerHTML = `<span class="sep">/</span><span>${t('sidebar.projects')}</span><span class="sep">/</span><span>${params.id || '...'}</span>`;
  } else {
    el.innerHTML = `<span class="sep">/</span><span>${title}</span>`;
  }
}

/** Refresh breadcrumb for current route (used on locale change) */
export function refreshBreadcrumb() {
  const hash = location.hash.replace(/^#/, '') || '/';
  for (const route of routes) {
    const params = matchRoute(hash, route.pattern);
    if (params !== null) {
      updateBreadcrumb(route, params);
      return;
    }
  }
}

/** Initialize router */
export function initRouter() {
  window.addEventListener('hashchange', handleRoute);

  // Handle sidebar navigation clicks
  document.querySelectorAll('[data-route]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      navigate(el.dataset.route);
    });
  });

  // Handle logo click
  document.querySelectorAll('[data-navigate]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.navigate));
  });

  // Initial route
  handleRoute();
}
