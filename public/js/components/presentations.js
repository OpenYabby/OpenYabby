/* ═══════════════════════════════════════════════════════
   YABBY — Presentations
   ═══════════════════════════════════════════════════════
   Lists project presentations and provides a viewer
   with markdown rendering and optional TTS narration.
*/

import { api } from '../api.js';
import { openModal } from './modal.js';
import { showToast } from './toast.js';
import { t } from '../i18n.js';
import { state } from '../state.js';

let container = null;

export async function render(el) {
  container = el;
  container.innerHTML = `<div class="connectors-loading">${t('common.loading')}</div>`;
  await refresh();
  return () => { container = null; };
}

async function refresh() {
  if (!container) return;

  const presentations = await api.presentations.list().catch(() => []);

  const ready = presentations.filter(p => p.status === 'ready');
  const presented = presentations.filter(p => p.status === 'presented');
  const drafts = presentations.filter(p => p.status === 'draft');

  container.innerHTML = `
    <div class="connectors-page">
      <div class="connectors-header">
        <div>
          <h2 class="connectors-title">${t('presentations.title')}</h2>
          <p class="connectors-subtitle">${t('presentations.subtitle')}</p>
        </div>
      </div>

      ${ready.length > 0 ? `
      <div class="connectors-section">
        <h3 class="connectors-section-title">
          <span class="conn-dot conn-dot-green"></span>
          ${t('presentations.ready')} (${ready.length})
        </h3>
        <div class="pres-grid">
          ${ready.map(p => renderCard(p, true)).join('')}
        </div>
      </div>
      ` : ''}

      ${presented.length > 0 ? `
      <div class="connectors-section">
        <h3 class="connectors-section-title">
          ${t('presentations.presented')} (${presented.length})
        </h3>
        <div class="pres-grid">
          ${presented.map(p => renderCard(p, false)).join('')}
        </div>
      </div>
      ` : ''}

      ${drafts.length > 0 ? `
      <div class="connectors-section">
        <h3 class="connectors-section-title">
          ${t('presentations.drafts')} (${drafts.length})
        </h3>
        <div class="pres-grid">
          ${drafts.map(p => renderCard(p, false)).join('')}
        </div>
      </div>
      ` : ''}

      ${presentations.length === 0 ? `
      <div class="connectors-section">
        <div class="notif-empty" style="padding: var(--space-xl);">
          <p style="font-size: 2rem; margin-bottom: var(--space-sm);">🎤</p>
          <p>${t('presentations.empty')}</p>
          <p style="font-size: 0.78rem; color: var(--text-muted); margin-top: var(--space-xs);">
            ${t('presentations.emptyHint')}
          </p>
        </div>
      </div>
      ` : ''}
    </div>
  `;

  wireEvents();
}

function renderCard(p, showPlay) {
  const date = p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '';
  const statusClass = p.status === 'ready' ? 'conn-dot-green'
    : p.status === 'presented' ? 'conn-dot-gray' : 'conn-dot-orange';

  return `
    <div class="pres-card">
      <div class="pres-card-header">
        <span class="pres-card-icon">🎤</span>
        <div class="pres-card-info">
          <span class="pres-card-title">${esc(p.title)}</span>
          <span class="pres-card-meta">
            <span class="conn-dot ${statusClass}"></span>
            ${esc(p.projectName || '')}
            ${date ? `<span class="conn-card-sep">·</span> ${date}` : ''}
          </span>
        </div>
      </div>
      ${p.summary ? `<p class="pres-card-summary">${esc(p.summary)}</p>` : ''}
      <div class="pres-card-actions">
        ${showPlay ? `<button class="btn btn-sm btn-primary" data-pres-play="${p.id}">${t('presentations.startPresentation')}</button>` : ''}
        <button class="btn btn-sm" data-pres-view="${p.id}">${t('presentations.view')}</button>
      </div>
    </div>
  `;
}

function wireEvents() {
  if (!container) return;

  // View presentation
  container.querySelectorAll('[data-pres-view]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.presView;
      const p = await api.presentations.get(id).catch(() => null);
      if (p) openPresentationViewer(p);
    });
  });

  // Lancer la présentation — same handler as view; the modal exposes the
  // "Run demo" button which triggers POST /api/presentations/:id/run.
  container.querySelectorAll('[data-pres-play]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.presPlay;
      const p = await api.presentations.get(id).catch(() => null);
      if (p) openPresentationViewer(p, true);
    });
  });
}

// Track active SSE listeners attached to a viewer modal so we can detach when it closes.
let _activeRunListeners = null;
function detachRunListeners() {
  if (_activeRunListeners) {
    for (const { eventType, handler } of _activeRunListeners) {
      state.removeEventListener(`sse:${eventType}`, handler);
    }
    _activeRunListeners = null;
  }
}

function attachRunListeners(presentationId, statusEl) {
  detachRunListeners();
  const listeners = [];
  const make = (eventType, render) => {
    const handler = (ev) => {
      const data = ev.detail || {};
      if (data.presentationId !== presentationId) return;
      render(data);
    };
    state.addEventListener(`sse:${eventType}`, handler);
    listeners.push({ eventType, handler });
  };

  make("presentation_run_completed", (data) => {
    statusEl.className = "pres-run-status pres-run-status-passed";
    statusEl.innerHTML = `✅ <strong>${t('presentations.demoRunning')}</strong> ${data.lastRunLog ? `<details><summary>Last log lines</summary><pre>${esc(data.lastRunLog)}</pre></details>` : ''}`;
  });
  make("presentation_run_failed", (data) => {
    statusEl.className = "pres-run-status pres-run-status-failed";
    statusEl.innerHTML = `❌ <strong>${t('presentations.runFailed')}</strong> ${data.lastRunLog ? `<details open><summary>Error log</summary><pre>${esc(data.lastRunLog)}</pre></details>` : ''}`;
  });

  _activeRunListeners = listeners;
}

function renderTestAccesses(testAccesses) {
  if (!Array.isArray(testAccesses) || testAccesses.length === 0) return '';

  const accessCard = (a, i) => {
    const fields = [];
    if (a.username) fields.push({ key: `user-${i}`, label: 'User', value: a.username });
    if (a.password) fields.push({ key: `pwd-${i}`, label: 'Password', value: a.password });

    return `
      <div class="pres-access-card">
        <div class="pres-access-card-head">
          <div class="pres-access-card-title">
            <span class="pres-access-icon">🔑</span>
            <span class="pres-access-label">${esc(a.label || `Access ${i + 1}`)}</span>
          </div>
          ${a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener" class="pres-access-url">${esc(a.url)} <span class="pres-access-url-arrow">↗</span></a>` : ''}
        </div>

        ${fields.length > 0 ? `
        <div class="pres-access-creds">
          ${fields.map(f => `
            <div class="pres-access-field">
              <span class="pres-access-field-label">${f.label}</span>
              <code class="pres-access-field-value" data-pres-credval="${f.key}">${esc(f.value)}</code>
              <button class="pres-access-copy" data-pres-copy="${f.key}" title="Copy ${f.label}" aria-label="Copy ${f.label}">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
              </button>
            </div>
          `).join('')}
        </div>
        ` : ''}

        ${a.notes ? `<div class="pres-access-notes">${esc(a.notes)}</div>` : ''}
      </div>
    `;
  };

  return `
    <section class="pres-section">
      <div class="pres-section-head">
        <h3 class="pres-section-title">
          <span class="pres-section-icon">🧪</span>
          ${t('presentations.testAccesses') || 'Test accesses'}
        </h3>
        <span class="pres-section-meta">${testAccesses.length} ${testAccesses.length > 1 ? 'entries' : 'entry'}</span>
      </div>
      <div class="pres-access-grid">
        ${testAccesses.map(accessCard).join('')}
      </div>
    </section>
  `;
}

function openPresentationViewer(p, live = false) {
  // Render markdown
  let renderedContent;
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    renderedContent = DOMPurify.sanitize(marked.parse(p.content || ''));
  } else {
    const d = document.createElement('div');
    d.textContent = p.content || '';
    renderedContent = `<pre style="white-space: pre-wrap;">${d.innerHTML}</pre>`;
  }

  const demoSteps = p.demoSteps || [];
  const testAccesses = p.testAccesses || [];
  const hasScript = !!p.scriptPath;

  // Compact short script path: keep only the filename + immediate parent dir.
  const shortScriptPath = p.scriptPath
    ? p.scriptPath.split('/').slice(-2).join('/')
    : '';

  const runStatusBadge = p.lastRunStatus === 'passed'
    ? `<span class="pres-status-pill pres-status-pill-passed">
         <span class="pres-status-dot"></span>
         ${t('presentations.lastRunPassed') || 'Demo verified'}
         ${p.lastRunAt ? `<span class="pres-status-time">· ${new Date(p.lastRunAt).toLocaleString()}</span>` : ''}
       </span>`
    : p.lastRunStatus === 'failed'
      ? `<span class="pres-status-pill pres-status-pill-failed">
           <span class="pres-status-dot"></span>
           ${t('presentations.lastRunFailed') || 'Last run failed'}
           ${p.lastRunAt ? `<span class="pres-status-time">· ${new Date(p.lastRunAt).toLocaleString()}</span>` : ''}
         </span>`
      : p.lastRunStatus === 'requested'
        ? `<span class="pres-status-pill pres-status-pill-running">
             <span class="pres-status-dot pres-status-dot-pulse"></span>
             ${t('presentations.lastRunRunning') || 'Demo starting…'}
           </span>`
        : '';

  const heroCard = hasScript
    ? `<section class="pres-hero">
         <div class="pres-hero-main">
           <div class="pres-hero-text">
             <div class="pres-hero-eyebrow">${t('presentations.demoRunner') || 'Live demo'}</div>
             <h2 class="pres-hero-title">${t('presentations.runProject') || 'Run the project'}</h2>
             <p class="pres-hero-sub">${t('presentations.runProjectDesc') || 'The lead agent will execute the start script and verify every service comes up cleanly.'}</p>
           </div>
           <button class="pres-hero-cta" data-pres-run="${p.id}" ${p.lastRunStatus === 'requested' ? 'disabled' : ''}>
             <span class="pres-hero-cta-icon">🚀</span>
             <span class="pres-hero-cta-label">${t('presentations.startPresentation') || 'Launch demo'}</span>
           </button>
         </div>
         <div class="pres-hero-meta">
           <code class="pres-hero-script" title="${esc(p.scriptPath)}">📄 ${esc(shortScriptPath)}</code>
           ${runStatusBadge}
         </div>
         <div class="pres-run-status-slot"></div>
       </section>`
    : `<section class="pres-hero pres-hero-empty">
         <div class="pres-hero-empty-icon">⚠️</div>
         <div>
           <div class="pres-hero-eyebrow">${t('presentations.demoUnavailable') || 'Demo unavailable'}</div>
           <p class="pres-hero-empty-text">${t('presentations.noScript') || 'No start.sh attached — the lead agent did not ship one.'}</p>
         </div>
       </section>`;

  const recapSection = `
    <section class="pres-section">
      <div class="pres-section-head">
        <h3 class="pres-section-title">
          <span class="pres-section-icon">📋</span>
          ${t('presentations.recap') || 'Project recap'}
        </h3>
      </div>
      <div class="pres-recap markdown-body">
        ${renderedContent}
      </div>
    </section>
  `;

  const demoSection = demoSteps.length > 0 ? `
    <section class="pres-section">
      <div class="pres-section-head">
        <h3 class="pres-section-title">
          <span class="pres-section-icon">📐</span>
          ${t('presentations.demoSteps') || 'Demo steps'}
        </h3>
      </div>
      <ol class="pres-demo-steps">
        ${demoSteps.map(s => `<li>${esc(s)}</li>`).join('')}
      </ol>
    </section>
  ` : '';

  const sandboxFooter = p.sandboxPath ? `
    <div class="pres-sandbox-footer" title="${esc(p.sandboxPath)}">
      <span class="pres-sandbox-icon">📁</span>
      <code>${esc(p.sandboxPath)}</code>
    </div>
  ` : '';

  const body = `
    <div class="pres-viewer">
      ${p.summary ? `<p class="pres-viewer-summary">${esc(p.summary)}</p>` : ''}
      ${heroCard}
      ${renderTestAccesses(testAccesses)}
      ${recapSection}
      ${demoSection}
      ${sandboxFooter}
    </div>
  `;

  openModal({
    title: `🎤 ${p.title}`,
    body,
    wide: true,
    submitLabel: live ? (t('presentations.markPresented') || 'Mark presented') : null,
    hideSubmit: !live,
    onSubmit: live ? async () => {
      await api.presentations.presented(p.id);
      showToast({ type: 'success', title: t('presentations.presented') || 'Presented', message: p.title });
      detachRunListeners();
      refresh();
    } : undefined,
  });

  // After the modal is in the DOM, wire the dynamic bits.
  setTimeout(() => {
    const modalRoot = document.querySelector('.modal-overlay') || document;

    // Run button → POST /api/presentations/:id/run, listen for SSE result.
    const runBtn = modalRoot.querySelector('[data-pres-run]');
    const statusSlot = modalRoot.querySelector('.pres-run-status-slot');
    if (runBtn && statusSlot) {
      runBtn.addEventListener('click', async () => {
        runBtn.disabled = true;
        runBtn.innerHTML = `<span class="pres-hero-cta-icon">⏳</span><span class="pres-hero-cta-label">${t('presentations.starting') || 'Starting…'}</span>`;
        statusSlot.innerHTML = `<div class="pres-run-status pres-run-status-running">${t('presentations.runRequested') || '⏳ Run requested — the lead agent is starting the demo…'}</div>`;
        attachRunListeners(p.id, statusSlot.querySelector('.pres-run-status'));
        try {
          await api.presentations.run(p.id);
          showToast({ type: 'info', title: t('presentations.runRequestedTitle') || 'Run requested', message: t('presentations.runRequestedMsg') || 'The lead agent is launching the demo.' });
        } catch (err) {
          showToast({ type: 'error', title: t('presentations.runFailed') || 'Run failed', message: err.message || String(err) });
          runBtn.disabled = false;
          runBtn.innerHTML = `<span class="pres-hero-cta-icon">🚀</span><span class="pres-hero-cta-label">${t('presentations.startPresentation') || 'Launch demo'}</span>`;
        }
      });
    }

    // Copy buttons (one per credential field)
    modalRoot.querySelectorAll('[data-pres-copy]').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.presCopy;
        const cell = modalRoot.querySelector(`[data-pres-credval="${key}"]`);
        if (!cell) return;
        navigator.clipboard.writeText(cell.textContent).then(() => {
          // Brief visual feedback
          btn.classList.add('pres-access-copy-ok');
          setTimeout(() => btn.classList.remove('pres-access-copy-ok'), 800);
          showToast({ type: 'success', title: t('common.copied') || 'Copied' });
        });
      });
    });
  }, 50);
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
