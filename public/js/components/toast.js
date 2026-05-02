/* ═══════════════════════════════════════════════════════
   YABBY — Toast Notification System
   ═══════════════════════════════════════════════════════
   Usage:
     import { showToast } from './components/toast.js';
     showToast({ type: 'success', title: 'Done', message: '...', route: '/#/tasks' });
*/

import { state } from '../state.js';
import { uid } from '../utils.js';
import { navigate } from '../router.js';
import { t } from '../i18n.js';

const ICONS = {
  success: '\u2713',
  error: '\u2717',
  warning: '\u26A0',
  info: '\u2139',
};

const DEFAULT_TIMEOUT = 5000;

/** Show a toast notification */
export function showToast({ type = 'info', title, message, route, timeout = DEFAULT_TIMEOUT }) {
  const id = uid();
  const toast = { id, type, title, message, route, timeout };

  state.push('toasts', toast);
  renderToast(toast);

  if (timeout > 0) {
    setTimeout(() => dismissToast(id), timeout);
  }

  return id;
}

/** Dismiss a toast by ID */
export function dismissToast(id) {
  const el = document.querySelector(`[data-toast-id="${id}"]`);
  if (el) {
    el.classList.add('removing');
    setTimeout(() => {
      el.remove();
      state.removeFrom('toasts', t => t.id === id);
    }, 200);
  } else {
    state.removeFrom('toasts', t => t.id === id);
  }
}

/** Render a single toast into the container */
function renderToast(toast) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const div = document.createElement('div');
  div.className = `toast ${toast.type}`;
  div.dataset.toastId = toast.id;

  div.innerHTML = `
    <span class="toast-icon">${ICONS[toast.type] || ICONS.info}</span>
    <div class="toast-body">
      ${toast.title ? `<div class="toast-title">${escToast(toast.title)}</div>` : ''}
      ${toast.message ? `<div class="toast-message">${escToast(toast.message)}</div>` : ''}
    </div>
    <button class="toast-dismiss">&times;</button>
  `;

  // Click toast body → navigate if route provided
  div.addEventListener('click', (e) => {
    if (e.target.closest('.toast-dismiss')) return;
    if (toast.route) {
      navigate(toast.route);
    }
    dismissToast(toast.id);
  });

  // Dismiss button
  div.querySelector('.toast-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    dismissToast(toast.id);
  });

  container.appendChild(div);
}

function escToast(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/** Initialize toast system — listen to SSE events for auto-toasts */
export function initToasts() {
  // Task completion toasts
  state.addEventListener('sse:task', (e) => {
    const { taskId, type, detail } = e.detail;
    if (type !== 'status') return;

    if (detail.status === 'done') {
      showToast({
        type: 'success',
        title: t('toast.taskCompleted'),
        message: `${taskId?.slice(0, 8)} — ${detail.elapsed}s`,
        route: '/tasks',
      });
    } else if (detail.status === 'error') {
      showToast({
        type: 'error',
        title: t('toast.taskError'),
        message: taskId?.slice(0, 8),
        route: '/tasks',
        timeout: 8000,
      });
    }
  });

  // Speaker notification toasts
  state.addEventListener('sse:speaker_notify', (e) => {
    const { agentName, message, type: notifType, projectId } = e.detail;
    const toastType = notifType === 'complete' ? 'success'
      : notifType === 'blocker' ? 'error'
      : notifType === 'milestone' ? 'info'
      : 'info';

    showToast({
      type: toastType,
      title: agentName || t('toast.defaultAgent'),
      message: (message || '').slice(0, 120),
      route: projectId ? `/projects/${projectId}` : undefined,
      timeout: 7000,
    });
  });
}
