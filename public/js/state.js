/* ═══════════════════════════════════════════════════════
   YABBY — Reactive State Store
   ═══════════════════════════════════════════════════════
   Minimal EventTarget-based store. Components subscribe
   to key changes and re-render when data updates.

   Usage:
     import { state } from './state.js';
     state.set('projects', [...]);
     state.on('projects', (value) => renderProjects(value));
*/

class Store extends EventTarget {
  #data = {
    // Navigation
    currentRoute: '/',
    routeParams: {},

    // Voice
    voiceStatus: 'idle',          // idle | connecting | connected | suspended
    voiceStatusText: '',
    currentAgent: null,           // { id, name, role, projectId } or null = Yabby
    chatMessages: [],             // [{ role, text, streaming?, timestamp }]

    // Data
    projects: [],
    tasks: [],
    agents: [],
    activities: [],               // last 200 SSE events [{text, type, taskId, time}]
    previewBlocks: [],            // [{ id, type, content, title, language, taskId, agentId, timestamp }]

    // UI
    voicePanelOpen: false,
    sidebarExpanded: false,
    toasts: [],                   // [{ id, type, title, message, route?, timeout? }]
    planReviewActive: false,      // true when plan modal is open
    activePlanReviewId: null,     // ID of current plan under review

    // Selections
    selectedProjectId: null,
    selectedAgentId: null,
    selectedTaskId: null,

    // Live tracking
    activeTaskIds: [],            // array of running task IDs
    heartbeats: {},               // { agentId: { status, progress, summary } }

    // Agent chats
    agentChats: {},               // { [agentId]: { agentId, agentName, windowState, unread, messages[], ... } }
  };

  get(key) {
    return this.#data[key];
  }

  set(key, value) {
    const old = this.#data[key];
    this.#data[key] = value;
    this.dispatchEvent(new CustomEvent('change', {
      detail: { key, value, old }
    }));
    this.dispatchEvent(new CustomEvent(`change:${key}`, {
      detail: { value, old }
    }));
  }

  /** Subscribe to changes on a specific key */
  on(key, callback) {
    const handler = (e) => callback(e.detail.value, e.detail.old);
    this.addEventListener(`change:${key}`, handler);
    return () => this.removeEventListener(`change:${key}`, handler);
  }

  /** Subscribe to any change */
  onAny(callback) {
    const handler = (e) => callback(e.detail.key, e.detail.value, e.detail.old);
    this.addEventListener('change', handler);
    return () => this.removeEventListener('change', handler);
  }

  /** Append to an array key (convenience) */
  push(key, item) {
    const arr = [...(this.#data[key] || []), item];
    this.set(key, arr);
    return arr;
  }

  /** Prepend to an array key with max length (for activities) */
  prepend(key, item, maxLength = 200) {
    const arr = [item, ...(this.#data[key] || [])].slice(0, maxLength);
    this.set(key, arr);
    return arr;
  }

  /** Update a specific item in an array by predicate */
  updateIn(key, predicate, updater) {
    const arr = this.#data[key] || [];
    const idx = arr.findIndex(predicate);
    if (idx === -1) return false;
    const updated = [...arr];
    updated[idx] = typeof updater === 'function' ? updater(updated[idx]) : { ...updated[idx], ...updater };
    this.set(key, updated);
    return true;
  }

  /** Remove from an array by predicate */
  removeFrom(key, predicate) {
    const arr = this.#data[key] || [];
    this.set(key, arr.filter((item, i) => !predicate(item, i)));
  }

  /** Get a snapshot of all state (for debugging) */
  snapshot() {
    return { ...this.#data };
  }
}

export const state = new Store();
