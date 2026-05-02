/* ═══════════════════════════════════════════════════════
   YABBY — Utility Functions
   ═══════════════════════════════════════════════════════ */

import { t, getLocale } from './i18n.js';

/** Escape HTML to prevent XSS */
export function esc(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/** Format seconds into human-readable duration */
export function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '';
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** Format a Date or ISO string to HH:MM */
export function formatTime(dateOrStr) {
  if (!dateOrStr) return '';
  const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
  const localeMap = { fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE' };
  const locale = localeMap[getLocale()] || 'en-US';
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

/** Format a Date or ISO string to relative time (past) */
export function formatRelative(dateOrStr) {
  if (!dateOrStr) return '';
  const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
  const diff = Math.round((Date.now() - d.getTime()) / 1000);
  if (diff < 5) return t('utils.justNow');
  if (diff < 60) return t('utils.agoSeconds', { n: diff });
  if (diff < 3600) return t('utils.agoMinutes', { n: Math.floor(diff / 60) });
  if (diff < 86400) return t('utils.agoHours', { n: Math.floor(diff / 3600) });
  return formatTime(d);
}

/** Format a Date or ISO string to relative time (future) */
export function formatFutureTime(dateOrStr) {
  if (!dateOrStr) return '';
  const d = typeof dateOrStr === 'string' ? new Date(dateOrStr) : dateOrStr;
  const diff = Math.round((d.getTime() - Date.now()) / 1000);

  // If in the past, show as "overdue"
  if (diff < 0) return t('utils.overdue') || 'En retard';

  // Future time
  if (diff < 60) return t('utils.inSeconds', { n: diff }) || `dans ${diff}s`;
  if (diff < 3600) return t('utils.inMinutes', { n: Math.floor(diff / 60) }) || `dans ${Math.floor(diff / 60)}m`;
  if (diff < 86400) return t('utils.inHours', { n: Math.floor(diff / 3600) }) || `dans ${Math.floor(diff / 3600)}h`;

  // More than a day: show full date/time
  const localeMap = { fr: 'fr-FR', en: 'en-US', es: 'es-ES', de: 'de-DE' };
  const locale = localeMap[getLocale()] || 'fr-FR';
  return d.toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** Truncate string with ellipsis */
export function truncate(str, maxLen = 100) {
  if (!str || str.length <= maxLen) return str || '';
  return str.slice(0, maxLen) + '...';
}

/**
 * SINGLE SOURCE OF TRUTH — Status → Badge CSS class
 * Every page MUST use this function. No inline badge classes.
 */
export function statusBadgeClass(status) {
  const map = {
    // Running / En cours → Amber
    running: 'badge-running',
    // Done / Terminé → Green
    done: 'badge-done',
    completed: 'badge-done',
    success: 'badge-done',
    // Error / Erreur → Red
    error: 'badge-error',
    failed: 'badge-error',
    // Paused / En pause → Orange
    paused: 'badge-paused',
    suspended: 'badge-paused',
    // Active / Actif → Blue
    active: 'badge-active',
    // LLM Limit → Purple
    paused_llm_limit: 'badge-llm-limit',
    // Killed / Annulé → Dark gray
    killed: 'badge-killed',
    cancelled: 'badge-killed',
    archived: 'badge-killed',
    // Queued / En attente → Slate
    queued: 'badge-muted',
    pending: 'badge-muted',
    waiting: 'badge-muted',
    // Idle → Slate
    idle: 'badge-muted',
  };
  return map[status] || 'badge-muted';
}

/**
 * SINGLE SOURCE OF TRUTH — Status → localized label
 * Every page MUST use this function. No raw status strings displayed.
 */
export function statusLabel(status) {
  const keyMap = {
    running: 'status.running',
    active: 'status.active',
    done: 'status.done',
    completed: 'status.completed',
    success: 'status.completed',
    error: 'status.error',
    failed: 'status.error',
    paused: 'status.paused',
    suspended: 'status.suspended',
    killed: 'status.killed',
    cancelled: 'status.killed',
    archived: 'common.archive',
    paused_llm_limit: 'tasks.resumeLlmLimit',
    queued: 'tasks.queue',
    pending: 'tasks.queue',
    waiting: 'tasks.queue',
    idle: 'status.stopped',
    processing: 'status.running',
  };
  const key = keyMap[status];
  return key ? t(key) : status;
}

/** Get status dot class */
export function statusDotClass(status) {
  if (status === 'paused_llm_limit') return 'paused-llm-limit';
  return status || 'idle';
}

/**
 * SINGLE SOURCE OF TRUTH — Event type → Badge CSS class
 * For event_log entries (task_created, agent_started, etc.) — NOT task statuses.
 */
export function eventTypeBadge(type) {
  if (!type) return 'badge-muted';
  if (type.includes('error') || type.includes('fail')) return 'badge-error';
  if (type.includes('completed') || type.includes('done')) return 'badge-done';
  if (type.includes('created')) return 'badge-info';
  if (type.includes('started') || type.includes('running')) return 'badge-running';
  if (type.includes('speaker') || type.includes('notification')) return 'badge-info';
  if (type.includes('paused') || type.includes('suspend')) return 'badge-paused';
  return 'badge-muted';
}

/**
 * SINGLE SOURCE OF TRUTH — Message type → Badge CSS class
 * For inter-agent messages (task_complete, review, instruction, etc.)
 */
export function msgTypeBadge(type) {
  if (!type) return 'badge-muted';
  if (type.includes('complete') || type.includes('done')) return 'badge-done';
  if (type.includes('error') || type.includes('fail')) return 'badge-error';
  if (type.includes('review') || type.includes('running') || type.includes('task')) return 'badge-running';
  if (type.includes('instruction') || type.includes('question')) return 'badge-info';
  return 'badge-muted';
}

/** Generate a simple unique ID */
export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Debounce a function */
export function debounce(fn, delay = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/** Create a DOM element with attributes and children */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'className') node.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset' && typeof value === 'object') Object.assign(node.dataset, value);
    else if (key === 'innerHTML') node.innerHTML = value;
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (typeof child === 'string') node.appendChild(document.createTextNode(child));
    else if (child instanceof Node) node.appendChild(child);
  }
  return node;
}
