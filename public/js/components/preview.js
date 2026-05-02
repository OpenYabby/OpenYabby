/* ═══════════════════════════════════════════════════════
   YABBY — Preview (Project-Scoped)
   ═══════════════════════════════════════════════════════
   Pick a project → spawn a review task to its director →
   see rich blocks (HTML, Code, Markdown) as they arrive.
*/

import { api } from '../api.js';
import { state } from '../state.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';
import { t } from '../i18n.js';

let selectedProjectId = null;
let activeTaskId = null;
let unsubs = [];

export async function render(container) {
  selectedProjectId = null;
  activeTaskId = null;
  unsubs = [];

  container.innerHTML = `
    <div class="settings">
      <div class="settings-header">
        <h2 class="settings-title">${t('preview.title')}</h2>
      </div>
      <div class="settings-content">
        <div class="settings-sections">

          <!-- Project selector -->
          <div class="settings-section">
            <div class="settings-section-header">
              <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3" width="14" height="12" rx="2"/><path d="M2 7h14"/></svg>
              <h3>${t('preview.projectSection')}</h3>
            </div>
            <div class="pv-project-picker">
              <select class="input" id="pvProject" style="flex:1;" aria-label="${t('preview.projectSection')}">
                <option value="">${t('preview.loadingProjects')}</option>
              </select>
              <button class="btn btn-primary btn-sm" id="pvGenerate" disabled>
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" style="margin-right:4px;vertical-align:-2px;"><path d="M4 8h8M8 4v8"/></svg>
                ${t('preview.generate')}
              </button>
            </div>
            <div id="pvStatus" class="pv-status" style="display:none;"></div>
            <div id="pvActions" class="pv-actions-bar" style="display:none;"></div>
          </div>

          <!-- Block gallery -->
          <div class="settings-section">
            <div class="settings-section-header">
              <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="2" width="14" height="14" rx="2"/><path d="M6 8l2 2-2 2"/><path d="M10 12h3"/></svg>
              <h3>${t('preview.results')}</h3>
              <div style="display:flex;gap:var(--space-xs);margin-left:auto;">
                <button class="btn btn-sm" id="pvRefresh" style="display:none;">${t('common.refresh')}</button>
                <button class="btn btn-sm" id="pvClear" style="display:none;">${t('common.clear')}</button>
              </div>
            </div>
            <div id="pvGallery" class="pv-gallery">
              <div class="empty-hint">
                <p>${t('preview.selectProjectHint')}</p>
                <p class="text-muted">${t('preview.directorHint')}</p>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  `;

  // Load projects into dropdown
  await loadProjects();

  // Project picker change
  document.getElementById('pvProject')?.addEventListener('change', (e) => {
    selectedProjectId = e.target.value || null;
    const btn = document.getElementById('pvGenerate');
    const refresh = document.getElementById('pvRefresh');
    const clear = document.getElementById('pvClear');
    if (btn) btn.disabled = !selectedProjectId;
    if (refresh) refresh.style.display = selectedProjectId ? '' : 'none';
    if (clear) clear.style.display = selectedProjectId ? '' : 'none';
    activeTaskId = null;
    updateStatus(null);
    if (selectedProjectId) {
      loadBlocks(selectedProjectId);
    } else {
      renderGallery([]);
    }
  });

  // Generate button — spawn task to director
  document.getElementById('pvGenerate')?.addEventListener('click', () => spawnDirectorTask());

  // Refresh button
  document.getElementById('pvRefresh')?.addEventListener('click', () => {
    if (selectedProjectId) loadBlocks(selectedProjectId);
  });

  // Clear button
  document.getElementById('pvClear')?.addEventListener('click', async () => {
    if (!selectedProjectId) return;
    try {
      await api.preview.reset(selectedProjectId);
      showToast({ type: 'success', title: t('preview.cleared') });
    } catch (err) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  });

  // Subscribe to live preview updates (filtered to selected project)
  const unsubPreview = subscribeToPreviewUpdates();
  unsubs.push(unsubPreview);

  // Subscribe to task status updates
  const unsubTask = subscribeToTaskStatus();
  unsubs.push(unsubTask);

  return () => { unsubs.forEach(u => u()); };
}

// ── Project loading ──

async function loadProjects() {
  const select = document.getElementById('pvProject');
  if (!select) return;
  try {
    const res = await api.projects.list();
    const projects = (res.projects || res || []).filter(p => p.id !== 'default' && p.status !== 'archived');
    select.innerHTML = `<option value="">${t('preview.chooseProject')}</option>` +
      projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  } catch (err) {
    select.innerHTML = `<option value="">${t('common.error')}: ${esc(err.message)}</option>`;
  }
}

// ── Task spawning ──

async function spawnDirectorTask() {
  if (!selectedProjectId) return;

  const btn = document.getElementById('pvGenerate');
  if (btn) { btn.disabled = true; btn.textContent = t('preview.launching'); }

  try {
    // Find the project's lead agent
    const agents = await api.projects.agents(selectedProjectId);
    const agentList = agents.agents || agents || [];
    const director = agentList.find(a => a.isLead || a.is_lead);

    if (!director) {
      showToast({ type: 'error', title: t('preview.noDirector'), message: t('preview.noDirectorMsg') });
      resetButton();
      return;
    }

    // Get project info for context
    const project = await api.projects.get(selectedProjectId);
    const projectName = project?.name || project?.project?.name || selectedProjectId;
    const projectType = project?.projectType || '';
    const projectDesc = project?.description || project?.context || '';

    // Clear old blocks for this project before generating fresh ones
    await api.preview.reset(selectedProjectId);

    // Build smart prompt based on project type
    const taskPrompt = buildPreviewPrompt(projectName, projectType, projectDesc, selectedProjectId);

    const res = await api.tasks.start(taskPrompt, {
      agent_id: director.id,
      project_id: selectedProjectId,
    });

    activeTaskId = res.task_id;
    updateStatus('running', `${esc(director.name)} ${t('preview.analyzing')}`);
    showToast({ type: 'success', title: t('preview.launched'), message: `${director.name} ${t('preview.analyzing')}` });

  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
    updateStatus('error', err.message);
  }

  resetButton();
}

function buildPreviewPrompt(projectName, projectType, projectDesc, projectId) {
  const api = `curl -s -X POST http://localhost:3000/api/preview/push -H "Content-Type: application/json" -d`;

  const base = [
    `MISSION: Check the CURRENT state of project "${projectName}" and publish a preview.`,
    '',
    'IMPORTANT RULES:',
    '- Do NOT rebuild anything, do NOT restart anything, do NOT modify anything.',
    '- You OBSERVE only the current state: existing files, running services, containers, etc.',
    '- Be FAST: 2-3 blocks maximum, no exhaustive summary.',
    '',
    'To publish a block:',
    `${api} '{"type":"TYPE","content":"CONTENT","title":"TITLE","projectId":"${projectId}"}'`,
    'Types: "markdown" (text), "code" (source code), "html" (visual render).',
    '',
  ];

  // Smart instructions based on project type
  if (projectType === 'web' || /docker|web|site|blog|app/i.test(projectDesc)) {
    base.push(
      'STEPS:',
      '1. Check if a Docker container is running: docker ps | grep project name',
      '2. Check if a local server is running: lsof -i :8080 or curl -s localhost:PORT',
      '3. If a service is running:',
      `   - Publish a markdown block: "The service is running on http://localhost:PORT"`,
      '   - Try curl -s localhost:PORT and if it responds, publish the HTML as an "html" block',
      '4. If nothing is running:',
      '   - Look at project files (docker-compose.yml, Dockerfile, package.json...)',
      `   - Publish a markdown block explaining how to start: "docker compose up" or "npm start"`,
      '5. Publish a markdown block with status: what is done, what remains.',
      '',
    );
  } else if (/doc|readme|wiki/i.test(projectDesc)) {
    base.push(
      'STEPS:',
      '1. Find the documentation files (README, docs/, *.md)',
      '2. Publish the content of the README or main doc as a "markdown" block',
      '3. If a doc site is generated (mkdocs, docusaurus), check if it is running.',
      '',
    );
  } else {
    base.push(
      'STEPS:',
      '1. Explore the project files to understand the current state.',
      '2. Publish a markdown block with: global status, what exists, what is missing.',
      '3. If the project has interesting code, publish an excerpt as a "code" block.',
      '',
    );
  }

  base.push(`IMPORTANT: ALWAYS include "projectId":"${projectId}" in every push block.`);
  base.push('Be CONCISE. 2-3 blocks max. No filler.');

  return base.join('\n');
}

function resetButton() {
  const btn = document.getElementById('pvGenerate');
  if (btn) {
    btn.disabled = !selectedProjectId;
    btn.innerHTML = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" style="margin-right:4px;vertical-align:-2px;"><path d="M4 8h8M8 4v8"/></svg>${t('preview.generate')}`;
  }
}

// ── Status bar ──

function updateStatus(status, text) {
  const el = document.getElementById('pvStatus');
  if (!el) return;
  if (!status) {
    el.style.display = 'none';
    return;
  }
  el.style.display = '';
  const icons = { running: '\u23F3', done: '\u2705', error: '\u274C' };
  el.className = `pv-status pv-status-${status}`;
  el.innerHTML = `<span>${icons[status] || ''}</span> <span>${text || ''}</span>`;
}

// ── Block loading ──

async function loadBlocks(projectId) {
  const gallery = document.getElementById('pvGallery');
  if (!gallery) return;
  gallery.innerHTML = `<div class="settings-loading">${t('common.loading')}</div>`;
  try {
    const res = await api.preview.blocks({ projectId });
    renderGallery(res.blocks || []);
  } catch (err) {
    gallery.innerHTML = `<div class="settings-error">${t('common.error')}: ${esc(err.message)}</div>`;
  }
}

// ── Live subscriptions ──

function subscribeToPreviewUpdates() {
  const handler = (e) => {
    const data = e.detail;
    if (!selectedProjectId) return;

    if (data.event === 'push' && data.block && data.block.projectId === selectedProjectId) {
      // Re-render from state (SSE handler already updated previewBlocks)
      const all = state.get('previewBlocks') || [];
      renderGallery(all.filter(b => b.projectId === selectedProjectId));
    } else if (data.event === 'reset') {
      if (!data.projectId || data.projectId === selectedProjectId) {
        renderGallery([]);
      }
    } else if (data.event === 'remove') {
      const all = state.get('previewBlocks') || [];
      renderGallery(all.filter(b => b.projectId === selectedProjectId));
    }
  };
  state.addEventListener('sse:preview', handler);
  return () => state.removeEventListener('sse:preview', handler);
}

function subscribeToTaskStatus() {
  const handler = (e) => {
    const data = e.detail;
    if (!activeTaskId || data.taskId !== activeTaskId) return;
    if (data.type === 'status') {
      const st = data.detail?.status;
      if (st === 'done') {
        updateStatus('done', t('preview.finished'));
        activeTaskId = null;
      } else if (st === 'error') {
        updateStatus('error', `${t('common.error')}: ${(data.detail?.result || '').slice(0, 100)}`);
        activeTaskId = null;
      }
    }
  };
  state.addEventListener('sse:task', handler);
  return () => state.removeEventListener('sse:task', handler);
}

// ── Gallery rendering ──

function escCode(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escAttr(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMd(text) {
  if (!text) return '';
  try {
    if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
      return DOMPurify.sanitize(marked.parse(text));
    }
  } catch {}
  return esc(text);
}

function renderGallery(blocks) {
  const gallery = document.getElementById('pvGallery');
  if (!gallery) return;

  if (!blocks || blocks.length === 0) {
    if (selectedProjectId) {
      gallery.innerHTML = `<div class="empty-hint"><p>${t('preview.noPreview')}</p><p class="text-muted">${t('preview.generateHint')}</p></div>`;
    } else {
      gallery.innerHTML = `<div class="empty-hint"><p>${t('preview.selectProjectHint')}</p><p class="text-muted">${t('preview.directorHint')}</p></div>`;
    }
    return;
  }

  gallery.innerHTML = blocks.map(block => {
    const typeIcons = { html: '&#x1F310;', code: '&#x1F4BB;', markdown: '&#x1F4DD;' };
    const typeLabels = { html: 'HTML', code: block.language || 'Code', markdown: 'Markdown' };
    const lines = (block.content || '').split('\n').length;
    const collapsed = lines > 12 ? 'collapsed' : '';
    const time = new Date(block.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

    let contentHtml;
    if (block.type === 'html') {
      contentHtml = `<div class="pv-iframe-wrap"><iframe class="pv-iframe" sandbox="allow-scripts" srcdoc="${escAttr(block.content)}"></iframe></div>`;
    } else if (block.type === 'code') {
      const langClass = block.language ? `language-${esc(block.language)}` : '';
      contentHtml = `<div class="pv-code-wrap">
        <div class="pv-code-header">
          <span class="pv-code-lang">${esc(block.language || 'text')}</span>
          <button class="pv-copy-btn" data-block-id="${block.id}" title="${t('common.copy')}">&#x1F4CB;</button>
        </div>
        <pre class="pv-code"><code class="${langClass}">${escCode(block.content)}</code></pre>
      </div>`;
    } else {
      contentHtml = `<div class="pv-markdown">${renderMd(block.content)}</div>`;
    }

    return `<div class="pv-block ${collapsed}" data-block-id="${block.id}" data-type="${block.type}">
      <div class="pv-header">
        <span class="activity-time">${time}</span>
        <span class="pv-type-icon">${typeIcons[block.type] || ''}</span>
        <span class="pv-title">${esc(block.title || typeLabels[block.type])}</span>
        <div class="pv-actions">
          <button class="pv-btn pv-toggle" title="${t('preview.expandCollapse')}">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 6l4 4 4-4"/></svg>
          </button>
          <button class="pv-btn pv-delete" data-block-id="${block.id}" title="${t('common.delete')}">
            <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        </div>
      </div>
      <div class="pv-content">${contentHtml}</div>
    </div>`;
  }).join('');

  bindGalleryInteractions(gallery);
  if (typeof Prism !== 'undefined') Prism.highlightAllUnder(gallery);
  updateQuickActions(blocks);
}

function bindGalleryInteractions(container) {
  // Toggle
  container.querySelectorAll('.pv-toggle').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const block = btn.closest('.pv-block');
      if (block) block.classList.toggle('collapsed');
    });
  });

  container.querySelectorAll('.pv-header').forEach(header => {
    header.addEventListener('click', (e) => {
      if (e.target.closest('.pv-btn')) return;
      const block = header.closest('.pv-block');
      if (block) block.classList.toggle('collapsed');
    });
  });

  // Copy
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

  // Delete
  container.querySelectorAll('.pv-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const blockId = btn.dataset.blockId;
      try {
        await api.preview.remove(blockId);
        showToast({ type: 'success', title: t('common.delete') });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
    });
  });
}

// ── Quick actions ──

function updateQuickActions(blocks) {
  const bar = document.getElementById('pvActions');
  if (!bar) return;

  // Scan all block content for localhost URLs and file paths
  const allContent = blocks.map(b => b.content || '').join('\n');
  const urls = new Set();
  const urlRe = /https?:\/\/localhost[:\d]*/g;
  let m;
  while ((m = urlRe.exec(allContent)) !== null) {
    urls.add(m[0]);
  }

  // Detect docker commands
  const hasDocker = /docker\s+(compose\s+up|run|start)/i.test(allContent);
  const hasNpm = /npm\s+(start|run\s+dev)/i.test(allContent);

  if (urls.size === 0 && !hasDocker && !hasNpm) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = '';
  const actions = [];

  for (const url of urls) {
    actions.push(`<a href="${esc(url)}" target="_blank" rel="noopener" class="btn btn-sm pv-action-btn">
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-right:4px;vertical-align:-2px;"><path d="M5 11L11 5M11 5H6M11 5v5"/></svg>
      ${t('common.open')} ${esc(url.replace('http://', ''))}
    </a>`);
  }

  if (hasDocker && urls.size === 0) {
    actions.push(`<span class="pv-action-hint">Docker detected — start the container to see the result</span>`);
  }

  bar.innerHTML = actions.join('');
}
