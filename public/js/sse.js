/* ═══════════════════════════════════════════════════════
   YABBY — SSE (Server-Sent Events) Manager
   ═══════════════════════════════════════════════════════
   Single SSE connection shared across all views.
   Dispatches events to the state store and toast system.
*/

import { state } from './state.js';
import { handleSSETask, handleSSEHeartbeat, handleSSESpeakerNotify, handleSystemUpdate, handleSSEPlanReview, handleSSEProjectQuestion, handleSSEConversationUpdate } from './voice.js';

let evtSource = null;
let reconnectTimer = null;
const RUNNER_EVENT_ALIASES = {
  runner_tool_use: 'tool_use',
  runner_tool_result: 'tool_result',
  runner_text: 'claude_text',
  runner_result: 'result',
};
const DEDUPE_WINDOW_MS = 3000;
const recentNormalizedTaskEvents = new Map();

function taskEventFingerprint(taskId, type, detail = {}) {
  if (type === 'tool_use') return `${taskId || '-'}|${type}|${detail.tool || ''}|${(detail.detail || '').slice(0, 120)}`;
  if (type === 'tool_result') return `${taskId || '-'}|${type}|${(detail.output || '').slice(0, 120)}`;
  if (type === 'claude_text') return `${taskId || '-'}|${type}|${(detail.text || '').slice(0, 120)}`;
  if (type === 'result') return `${taskId || '-'}|${type}|${detail.cost ?? ''}|${detail.duration ?? ''}`;
  return `${taskId || '-'}|${type}|${JSON.stringify(detail || {}).slice(0, 120)}`;
}

function rememberNormalizedEvent(key) {
  const now = Date.now();
  recentNormalizedTaskEvents.set(key, now);
  for (const [k, ts] of recentNormalizedTaskEvents.entries()) {
    if (now - ts > DEDUPE_WINDOW_MS) recentNormalizedTaskEvents.delete(k);
  }
}

/** Initialize SSE connection */
export function initSSE() {
  if (evtSource) return;

  const url = window.location.origin + '/api/logs/stream';
  evtSource = new EventSource(url);

  // ── Task events ──
  evtSource.addEventListener('task', (e) => {
    try {
      const data = JSON.parse(e.data);
      const rawType = data.type;
      const normalizedType = RUNNER_EVENT_ALIASES[rawType] || rawType;
      const normalizedData = rawType === normalizedType
        ? data
        : { ...data, type: normalizedType, rawType };
      const { taskId, type, detail } = normalizedData;
      const dedupeKey = taskEventFingerprint(taskId, type, detail);

      if (rawType?.startsWith('runner_')) {
        rememberNormalizedEvent(dedupeKey);
      } else if (recentNormalizedTaskEvents.has(dedupeKey)) {
        // Ignore legacy alias when we already processed its runner_* normalized event.
        return;
      }

      const id = taskId?.slice(0, 6) || '?';

      if (type === 'tool_use') {
        state.prepend('activities', {
          text: `[${id}] ${detail.tool}: ${(detail.detail || '').slice(0, 120)}`,
          type: 'tool',
          taskId,
          time: Date.now(),
          verbose: detail.fullInput || null,
        });
      } else if (type === 'tool_result') {
        state.prepend('activities', {
          text: `[${id}] ← ${(detail.output || '').slice(0, 120)}`,
          type: 'tool_result',
          taskId,
          time: Date.now(),
          verbose: detail.output || null,
        });
      } else if (type === 'claude_text') {
        state.prepend('activities', {
          text: `[${id}] ${(detail.text || '').slice(0, 200)}`,
          type: 'claude',
          taskId,
          time: Date.now(),
          verbose: detail.text?.length > 200 ? detail.text : null,
        });
      } else if (type === 'status') {
        state.prepend('activities', {
          text: `[${id}] ${detail.status} (${detail.elapsed}s)`,
          type: 'status',
          taskId,
          time: Date.now(),
        });

        // Update activeTaskIds
        const active = [...state.get('activeTaskIds')];
        if (detail.status === 'done' || detail.status === 'error' || detail.status === 'killed' || detail.status === 'paused') {
          state.set('activeTaskIds', active.filter(id => id !== taskId));
        }
      } else if (type === 'stderr') {
        state.prepend('activities', {
          text: `[${id}] ${(detail.text || '').slice(0, 120)}`,
          type: 'error',
          taskId,
          time: Date.now(),
        });
      }

      // Notify voice module (injects into WebRTC DataChannel if connected)
      handleSSETask(normalizedData);

      // Emit a custom event for views that need fine-grained updates
      state.dispatchEvent(new CustomEvent('sse:task', { detail: normalizedData }));
    } catch {}
  });

  // ── Heartbeat events ──
  evtSource.addEventListener('heartbeat', (e) => {
    try {
      const data = JSON.parse(e.data);
      state.prepend('activities', {
        text: `[${data.agentId?.slice(0, 6) || '?'}] ${data.status} ${data.progress}% — ${(data.summary || '').slice(0, 80)}`,
        type: 'status',
        time: Date.now(),
      });

      // Update heartbeats map
      const hb = { ...state.get('heartbeats') };
      hb[data.agentId] = {
        status: data.status,
        progress: data.progress,
        summary: data.summary,
        time: Date.now(),
      };
      state.set('heartbeats', hb);

      // Notify voice module
      handleSSEHeartbeat(data);

      state.dispatchEvent(new CustomEvent('sse:heartbeat', { detail: data }));
    } catch {}
  });

  // ── Speaker notifications ──
  evtSource.addEventListener('speaker_notify', (e) => {
    try {
      const data = JSON.parse(e.data);
      state.prepend('activities', {
        text: `[NOTIF] ${data.agentName || 'Agent'}: ${(data.message || '').slice(0, 120)}`,
        type: 'notif',
        time: Date.now(),
      });

      // Notify voice module
      handleSSESpeakerNotify(data);

      state.dispatchEvent(new CustomEvent('sse:speaker_notify', { detail: data }));
    } catch {}
  });

  // ── System update events ──
  evtSource.addEventListener('system_update', (e) => {
    try {
      const data = JSON.parse(e.data);

      // Notify voice module
      handleSystemUpdate(data);

      state.dispatchEvent(new CustomEvent('sse:system_update', { detail: data }));
    } catch {}
  });

  // ── Plan review events ──
  evtSource.addEventListener('plan_review', (e) => {
    try {
      const data = JSON.parse(e.data);

      // "resolved" sub-events just dispatch for listeners (e.g. close modal)
      if (data.event === 'resolved') {
        state.dispatchEvent(new CustomEvent('sse:plan_review_resolved', { detail: data }));
        return;
      }

      state.prepend('activities', {
        text: `[PLAN] ${data.projectName || 'Project'}: Plan submitted for review`,
        type: 'notif',
        time: Date.now(),
      });

      // Open modal + voice announcement
      handleSSEPlanReview(data);

      state.dispatchEvent(new CustomEvent('sse:plan_review', { detail: data }));
    } catch {}
  });

  // ── Presentation lifecycle events ──
  // The backend emits one named event per lifecycle step; we forward each
  // to a dedicated `sse:presentation_*` CustomEvent so components can
  // subscribe individually (the modal listens to run_completed / run_failed).
  for (const presoEvent of [
    "presentation_ready",
    "presentation_updated",
    "presentation_run_requested",
    "presentation_run_completed",
    "presentation_run_failed",
  ]) {
    evtSource.addEventListener(presoEvent, (e) => {
      try {
        const data = JSON.parse(e.data);
        state.dispatchEvent(new CustomEvent(`sse:${presoEvent}`, { detail: data }));
      } catch {}
    });
  }

  // ── Project question events ──
  evtSource.addEventListener('project_question', (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.event === 'resolved') {
        state.dispatchEvent(new CustomEvent('sse:project_question_resolved', { detail: data }));
        return;
      }

      state.prepend('activities', {
        text: `[QUESTION] ${data.projectName || 'Project'}: ${(data.question || '').slice(0, 80)}`,
        type: 'notif',
        time: Date.now(),
      });

      handleSSEProjectQuestion(data);

      state.dispatchEvent(new CustomEvent('sse:project_question', { detail: data }));
    } catch {}
  });

  // ── Preview events ──
  evtSource.addEventListener('preview', (e) => {
    try {
      const data = JSON.parse(e.data);

      if (data.event === 'push' && data.block) {
        state.prepend('activities', {
          text: data.block.title || `Preview (${data.block.type})`,
          type: 'preview',
          taskId: data.block.taskId || null,
          time: Date.now(),
          preview: data.block,
        });
        const blocks = [...(state.get('previewBlocks') || [])];
        blocks.unshift(data.block);
        if (blocks.length > 200) blocks.length = 200;
        state.set('previewBlocks', blocks);
      } else if (data.event === 'reset') {
        state.set('previewBlocks', []);
      } else if (data.event === 'remove' && data.blockId) {
        state.set('previewBlocks',
          (state.get('previewBlocks') || []).filter(b => b.id !== data.blockId)
        );
      }

      state.dispatchEvent(new CustomEvent('sse:preview', { detail: data }));
    } catch {}
  });

  // ── Conversation update events ──
  evtSource.addEventListener('conversation_update', (e) => {
    try {
      const data = JSON.parse(e.data);
      // Handle in voice.js to reload conversation
      handleSSEConversationUpdate(data);
      // Also dispatch for other listeners
      state.dispatchEvent(new CustomEvent('sse:conversation_update', { detail: data }));
    } catch {}
  });

  // ── Reconnect on error ──
  evtSource.onerror = () => {
    evtSource.close();
    evtSource = null;
    if (!reconnectTimer) {
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        initSSE();
      }, 5000);
    }
  };
}

/** Close SSE connection */
export function closeSSE() {
  if (evtSource) {
    evtSource.close();
    evtSource = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}
