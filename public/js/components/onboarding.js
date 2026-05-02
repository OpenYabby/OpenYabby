/* ═══════════════════════════════════════════════════════
   YABBY — Onboarding Wizard
   ═══════════════════════════════════════════════════════
   7-step first-launch setup: name+lang, task runner, API keys,
   voice, environment, speaker enrollment, done. Full-screen
   overlay with glassmorphism card and animated step transitions.
*/

import { api } from '../api.js';
import { esc } from '../utils.js';
import { openModal, closeModal } from './modal.js';
import { t, setLocale, getLocale } from '../i18n.js';
import {
  RUNNERS_NEEDING_LLM_KEY,
  renderRunnerGrid,
  wireRunnerGrid,
  renderOpenAiKeySection,
  renderRunnerKeySection,
  wireApiKeyListeners,
} from './runner-selector.js';

const STEPS = [
  { id: 'welcome' },
  { id: 'sandbox' },
  { id: 'tasks' },
  { id: 'apikeys' },
  { id: 'connectors' },
  { id: 'voice' },
  { id: 'env' },
  { id: 'speaker' },
  { id: 'done' },
];

const STEP_LABEL_KEYS = {
  welcome: 'onboarding.welcome',
  sandbox: 'onboarding.workspace',
  tasks: 'onboarding.tasks',
  apikeys: 'onboarding.apiKeys',
  connectors: 'onboarding.connectors',
  voice: 'onboarding.voice',
  env: 'onboarding.environment',
  speaker: 'onboarding.verification',
  done: 'onboarding.done',
};

const LANGUAGES = [
  { code: 'fr', label: 'Fran\u00e7ais', flag: '\ud83c\uddeb\ud83c\uddf7' },
  { code: 'en', label: 'English',  flag: '\ud83c\uddec\ud83c\udde7' },
  { code: 'es', label: 'Espa\u00f1ol',  flag: '\ud83c\uddea\ud83c\uddf8' },
  { code: 'de', label: 'Deutsch',  flag: '\ud83c\udde9\ud83c\uddea' },
];

const VOICES = ['ash', 'ballad', 'coral', 'sage', 'verse', 'marin'];

let currentStep = 0;
let userName = '';
let selectedLang = 'fr';
let sandboxPath = null;
let selectedVoice = 'marin';
let selectedRunner = 'claude';
let runnersData = null;
let noiseReduction = 'near_field';
let turnDetection = 'semantic_vad';
let micEnabled = true;
let micPermission = 'unknown';
let connectorMode = 'hybrid';
let connectorSubStep = 0;
let speakerEnrolled = false;
let enrollSamples = [];
let overlay = null;
let resolveOnboarding = null;

export function showOnboarding() {
  return new Promise((resolve) => {
    resolveOnboarding = resolve;
    currentStep = 0;
    userName = '';
    const detectedLang = getLocale() || navigator.language?.slice(0, 2) || 'en';
    selectedLang = ['fr', 'en', 'es', 'de'].includes(detectedLang) ? detectedLang : 'en';
    selectedVoice = 'marin';
    selectedRunner = 'claude';
    runnersData = null;
    noiseReduction = 'near_field';
    turnDetection = 'semantic_vad';
    micEnabled = true;
    micPermission = 'unknown';
    connectorMode = 'hybrid';
    connectorSubStep = 0;
    cachedCatalog = null;
    activeConnectors = [];
    speakerEnrolled = false;
    enrollSamples = [];

    overlay = document.createElement('div');
    overlay.className = 'ob-overlay';
    overlay.innerHTML = `
      <div class="ob-card">
        <div class="ob-header">
          <svg class="ob-logo" viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 18c-1 0-2-.5-2.5-1.5L8 14c-.5-1-.3-2 .3-2.5"/>
            <path d="M12 18c1 0 2-.5 2.5-1.5L16 14c.5-1 .3-2-.3-2.5"/>
            <ellipse cx="12" cy="11" rx="2.5" ry="3.5"/>
            <path d="M7.5 8.5C6 7.5 4.5 7 3.5 7.5c-.5.3-.3 1 .5 1.5l2.5 1.5"/>
            <path d="M16.5 8.5C18 7.5 19.5 7 20.5 7.5c.5.3.3 1-.5 1.5L17.5 10.5"/>
            <path d="M10.5 8C9.5 6 8 4.5 7 4" opacity=".6"/>
            <path d="M13.5 8C14.5 6 16 4.5 17 4" opacity=".6"/>
          </svg>
          <h2 class="ob-title">${t('onboarding.welcomeTitle')}</h2>
        </div>
        <div class="ob-steps" id="obSteps"></div>
        <div class="ob-content" id="obContent"></div>
        <div class="ob-footer" id="obFooter"></div>
      </div>
    `;

    document.body.appendChild(overlay);
    requestAnimationFrame(() => { overlay.classList.add('visible'); });
    renderStep();
  });
}

function renderStep() {
  renderStepDots();
  renderContent();
  renderFooter();
}

function renderStepDots() {
  const el = document.getElementById('obSteps');
  if (!el) return;
  el.innerHTML = STEPS.map((s, i) => {
    const label = t(STEP_LABEL_KEYS[s.id]) || s.id;
    return `<div class="ob-dot ${i === currentStep ? 'active' : ''} ${i < currentStep ? 'done' : ''}" title="${esc(label)}">
      ${i < currentStep ? '<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 6l3 3 5-5"/></svg>' : ''}
    </div>`;
  }).join('');
}

function renderContent() {
  const el = document.getElementById('obContent');
  if (!el) return;
  el.classList.remove('ob-slide-in');
  el.offsetHeight;
  el.classList.add('ob-slide-in');

  switch (currentStep) {
    case 0: renderWelcome(el); break;
    case 1: renderSandboxStep(el); break;
    case 2: renderTaskRunnerStep(el); break;
    case 3: renderApiKeysStep(el); break;
    case 4: renderConnectorsStep(el); break;
    case 5: renderVoiceStep(el); break;
    case 6: renderEnvStep(el); break;
    case 7: renderSpeakerStep(el); break;
    case 8: renderDoneStep(el); break;
  }
}

function renderFooter() {
  const el = document.getElementById('obFooter');
  if (!el) return;
  if (currentStep === 8) { el.innerHTML = ''; return; }
  const canPrev = currentStep > 0;
  const isLastBeforeDone = currentStep === 7;
  el.innerHTML = `
    ${canPrev ? `<button class="btn btn-ghost ob-prev" id="obPrev">${t('onboarding.back')}</button>` : '<div></div>'}
    <button class="btn btn-primary ob-next" id="obNext">
      ${isLastBeforeDone ? t('onboarding.finish') : t('onboarding.next')}
      <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4l4 4-4 4"/></svg>
    </button>
  `;
  document.getElementById('obPrev')?.addEventListener('click', prevStep);
  document.getElementById('obNext')?.addEventListener('click', nextStep);
}

function renderWelcome(el) {
  const labels = {
    fr: { name: 'Comment vous appelez-vous ?', placeholder: 'Votre pr\u00e9nom...', lang: 'Langue', welcome: 'Bienvenue sur Yabby' },
    en: { name: 'What is your name?', placeholder: 'Your first name...', lang: 'Language', welcome: 'Welcome to Yabby' },
    es: { name: '\u00bfC\u00f3mo te llamas?', placeholder: 'Tu nombre...', lang: 'Idioma', welcome: 'Bienvenido a Yabby' },
    de: { name: 'Wie hei\u00dfen Sie?', placeholder: 'Ihr Vorname...', lang: 'Sprache', welcome: 'Willkommen bei Yabby' },
  };
  const l = labels[selectedLang] || labels.en;
  el.innerHTML = `
    <div class="ob-section">
      <h3 class="ob-label">${l.lang}</h3>
      <div class="ob-lang-grid">
        ${LANGUAGES.map(lang => `
          <div class="ob-lang-card ${selectedLang === lang.code ? 'selected' : ''}" data-lang="${lang.code}">
            <span class="ob-lang-flag">${lang.flag}</span>
            <span class="ob-lang-name">${lang.label}</span>
          </div>
        `).join('')}
      </div>
    </div>
    <div class="ob-section">
      <h3 class="ob-label">${l.name}</h3>
      <input class="input ob-name-input" id="obName" placeholder="${l.placeholder}" value="${esc(userName)}" autofocus />
    </div>
  `;
  const titleEl = document.querySelector('.ob-title');
  if (titleEl) titleEl.textContent = l.welcome;
  const nameInput = document.getElementById('obName');
  nameInput?.addEventListener('input', () => { userName = nameInput.value.trim(); });
  nameInput?.focus();
  el.querySelectorAll('.ob-lang-card').forEach(card => {
    card.addEventListener('click', async () => {
      selectedLang = card.dataset.lang;
      el.querySelectorAll('.ob-lang-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      await setLocale(selectedLang);
      renderWelcome(el);
    });
  });
}

/**
 * Reusable folder browser widget.
 * @param {HTMLElement} container - DOM element to render into
 * @param {string} startPath - initial path to browse
 * @param {(path: string) => void} onSelect - called when user confirms selection
 * @param {(path: string) => void} [onNavigate] - called on every navigation (live preview)
 */
async function renderFolderBrowser(container, startPath, onSelect, onNavigate) {
  if (!container) return;
  async function loadDir(dirPath) {
    // Fade transition
    container.style.opacity = '0.5';
    container.style.pointerEvents = 'none';
    try {
      const resp = await fetch(`/api/workspace/browse?path=${encodeURIComponent(dirPath)}`);
      const data = await resp.json();
      if (!resp.ok) { container.innerHTML = `<div style="color:var(--accent-red);padding:12px">${esc(data.error)}</div>`; return; }

      if (onNavigate) onNavigate(data.path);

      const parts = data.path.split('/').filter(Boolean);

      // Compact breadcrumb — show only last 3 segments, collapse the rest
      let breadcrumb = '<div style="display:flex;align-items:center;gap:2px;padding:0 4px 10px;font-size:0.8rem;border-bottom:1px solid var(--border);margin-bottom:8px">';
      const crumbs = [{ label: '~', path: '~' }];
      for (let i = 0; i < parts.length; i++) {
        crumbs.push({ label: parts[i], path: '/' + parts.slice(0, i + 1).join('/') });
      }
      const showFrom = Math.max(0, crumbs.length - 4);
      if (showFrom > 0) {
        breadcrumb += `<span style="color:var(--text-muted);padding:2px 4px">...</span>`;
        breadcrumb += `<span style="color:var(--text-muted)">/</span>`;
      }
      for (let i = showFrom; i < crumbs.length; i++) {
        if (i > showFrom) breadcrumb += `<span style="color:var(--text-muted);opacity:0.4">/</span>`;
        const isLast = i === crumbs.length - 1;
        breadcrumb += `<span class="fb-crumb" data-path="${esc(crumbs[i].path)}" style="cursor:pointer;padding:2px 6px;border-radius:4px;${isLast ? 'color:var(--text);font-weight:600' : 'color:var(--accent-blue)'};transition:background 0.15s">${esc(crumbs[i].label)}</span>`;
      }
      breadcrumb += '</div>';

      // Folder list
      let list = '<div style="display:flex;flex-direction:column;gap:1px">';
      if (parts.length > 0) {
        const parentPath = '/' + parts.slice(0, -1).join('/') || '/';
        list += `<div class="fb-item" data-path="${esc(parentPath)}" style="cursor:pointer;padding:7px 10px;border-radius:6px;display:flex;align-items:center;gap:10px;color:var(--text-muted);font-size:0.85rem;transition:background 0.12s">
          <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8" style="flex-shrink:0"><path d="M10 3L5 8l5 5"/></svg>
          <span>Parent folder</span>
        </div>`;
      }
      for (const dir of data.dirs) {
        const fullPath = data.path === '/' ? '/' + dir : data.path + '/' + dir;
        list += `<div class="fb-item" data-path="${esc(fullPath)}" style="cursor:pointer;padding:7px 10px;border-radius:6px;display:flex;align-items:center;gap:10px;font-size:0.9rem;transition:background 0.12s">
          <svg viewBox="0 0 16 16" width="15" height="15" fill="var(--accent-blue)" fill-opacity="0.15" stroke="var(--accent-blue)" stroke-width="1.2" style="flex-shrink:0"><path d="M2 4.5v7.5a1 1 0 001 1h10a1 1 0 001-1V6.5a1 1 0 00-1-1H8.2l-1.2-1.5H3a1 1 0 00-1 1z"/></svg>
          <span>${esc(dir)}</span>
        </div>`;
      }
      if (data.dirs.length === 0) {
        list += '<div style="padding:12px;color:var(--text-muted);font-size:0.85rem;text-align:center">No subfolders</div>';
      }
      list += '</div>';

      // Footer with current path + select button
      const footer = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span style="font-size:0.78rem;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${esc(data.path)}">${esc(data.path)}</span>
        <button class="btn btn-primary fb-select" type="button" style="font-size:0.82rem;padding:5px 16px;white-space:nowrap;border-radius:6px">
          Select
        </button>
      </div>`;

      container.innerHTML = breadcrumb + list + footer;

      // Wire events
      container.querySelectorAll('.fb-item, .fb-crumb').forEach(el => {
        el.addEventListener('click', () => loadDir(el.dataset.path));
        el.addEventListener('mouseenter', () => { el.style.background = 'var(--bg-hover, rgba(255,255,255,0.06))'; });
        el.addEventListener('mouseleave', () => { el.style.background = ''; });
      });

      container.querySelector('.fb-select')?.addEventListener('click', () => onSelect(data.path));
    } catch (err) {
      container.innerHTML = `<div style="color:var(--accent-red);padding:12px">${esc(err.message)}</div>`;
    } finally {
      container.style.opacity = '1';
      container.style.pointerEvents = '';
    }
  }

  await loadDir(startPath);
}

async function openFolderBrowser(startPath) {
  const container = document.getElementById('obFolderBrowser');
  await renderFolderBrowser(
    container,
    startPath || '~',
    (path) => {
      sandboxPath = path;
      document.getElementById('obSandboxPath').textContent = path;
      document.getElementById('obSandboxCustomInput').style.display = 'none';
    },
    (path) => {
      sandboxPath = path;
      document.getElementById('obSandboxPath').textContent = path;
      const input = document.getElementById('obSandboxInput');
      if (input) input.value = path;
    }
  );
}

async function renderSandboxStep(el) {
  if (!sandboxPath) {
    try { const config = await api.config.getAll(); sandboxPath = config.projects?.sandboxRoot || null; } catch { sandboxPath = null; }
  }
  let defaultPath = null;
  let currentPath = sandboxPath;
  try {
    const response = await api.config.get('projects');
    defaultPath = response.sandboxRoot || `${window.navigator.userAgent.includes('Mac') ? '~/Documents' : '~\\Documents'}/Yabby Workspace`;
    if (!currentPath) currentPath = defaultPath;
  } catch {
    defaultPath = `${window.navigator.userAgent.includes('Mac') ? '~/Documents' : '~\\Documents'}/Yabby Workspace`;
    if (!currentPath) currentPath = defaultPath;
  }

  el.innerHTML = `
    <div class="ob-section">
      <h3 class="ob-label">${t('onboarding.sandboxTitle')}</h3>
      <p class="ob-hint">${t('onboarding.sandboxHint')}</p>
      <div class="ob-sandbox-preview">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"/></svg>
        <div style="flex:1">
          <span class="ob-sandbox-path" id="obSandboxPath">${esc(currentPath)}</span>
          <span class="ob-sandbox-hint">${t('onboarding.sandboxStoredHint')}</span>
        </div>
      </div>
      <div class="ob-sandbox-buttons">
        <button class="btn" id="obSandboxDefault" type="button">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M8 3v10M3 8h10"/></svg>
          ${t('onboarding.sandboxUseDefault')}
        </button>
        <button class="btn btn-primary" id="obSandboxCustom" type="button">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9"/><path d="M10 2h5M12.5 0v4"/></svg>
          ${t('onboarding.sandboxChooseOther')}
        </button>
      </div>
      <div class="ob-sandbox-custom-input" id="obSandboxCustomInput" style="display:none">
        <div id="obFolderBrowser" style="border:1px solid var(--border);border-radius:10px;padding:12px;margin-bottom:8px;max-height:300px;overflow-y:auto;background:var(--bg-secondary);transition:opacity 0.15s"></div>
        <input class="input" id="obSandboxInput" placeholder="${esc(currentPath)}" value="${esc(currentPath)}" style="margin-top:8px" />
      </div>
      <div class="ob-sandbox-info">
        <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--accent-blue)" stroke-width="1.5" style="flex-shrink:0"><circle cx="8" cy="8" r="6"/><path d="M8 7v5M8 4v1"/></svg>
        <span style="font-size:0.85rem;color:var(--text-muted)">${t('onboarding.sandboxGitHint')}</span>
      </div>
    </div>
  `;
  document.getElementById('obSandboxDefault')?.addEventListener('click', () => {
    sandboxPath = defaultPath;
    document.getElementById('obSandboxPath').textContent = defaultPath;
    document.getElementById('obSandboxCustomInput').style.display = 'none';
  });
  document.getElementById('obSandboxCustom')?.addEventListener('click', () => {
    document.getElementById('obSandboxCustomInput').style.display = '';
    openFolderBrowser(currentPath || defaultPath);
  });
  document.getElementById('obSandboxInput')?.addEventListener('input', (e) => {
    const val = e.target.value.trim();
    if (val) { sandboxPath = val; document.getElementById('obSandboxPath').textContent = val; }
  });
}

async function renderTaskRunnerStep(el) {
  if (!runnersData) {
    el.innerHTML = `<div class="ob-section"><p class="ob-hint">${t('onboarding.runnerDetecting')}</p></div>`;
    try { runnersData = await api.tasks.runners(); } catch { runnersData = { runners: [], current: 'claude' }; }
    const firstFound = runnersData.runners.find(r => r.found);
    if (firstFound) selectedRunner = firstFound.id;
  }
  const runners = runnersData.runners || [];
  el.innerHTML = `
    <div class="ob-section">
      <h3 class="ob-label">${t('onboarding.runnerTitle')}</h3>
      <p class="ob-hint">${t('onboarding.runnerHint')}</p>
      ${renderRunnerGrid(runners, selectedRunner)}
    </div>
  `;
  wireRunnerGrid(el, (id) => { selectedRunner = id; });
}

let apiKeysStatus = null;

async function renderApiKeysStep(el) {
  if (!apiKeysStatus) { try { apiKeysStatus = await api.config.apiKeysStatus(); } catch { apiKeysStatus = {}; } }
  const runnerNeedsKey = RUNNERS_NEEDING_LLM_KEY.has(selectedRunner);
  const runnerName = runnersData?.runners?.find(r => r.id === selectedRunner)?.name || selectedRunner;
  const isCodex = selectedRunner === 'codex';
  let featureListHtml = `
    <li><span class="ob-feature-tag">${t('onboarding.featureVoice')}</span> ${t('onboarding.featureVoiceDesc')}</li>
    <li><span class="ob-feature-tag">${t('onboarding.featureDetection')}</span> ${t('onboarding.featureDetectionDesc')}</li>
    <li><span class="ob-feature-tag">${t('onboarding.featurePreviews')}</span> ${t('onboarding.featurePreviewsDesc')}</li>
    <li><span class="ob-feature-tag">${t('onboarding.featureMemory')}</span> ${t('onboarding.featureMemoryDesc')}</li>
    <li><span class="ob-feature-tag">${t('onboarding.featureSearch')}</span> ${t('onboarding.featureSearchDesc')}</li>`;
  if (isCodex) featureListHtml += `<li><span class="ob-feature-tag">${t('onboarding.featureTasks')}</span> ${t('onboarding.featureTasksDesc')}</li>`;
  el.innerHTML = `
    <div class="ob-section">
      <h3 class="ob-label">${t('onboarding.apiKeysTitle')}</h3>
      <p class="ob-hint" style="margin-bottom:var(--space-xs)">${t('onboarding.apiKeysHint')}</p>
      <ul class="ob-feature-list">${featureListHtml}</ul>
      ${renderOpenAiKeySection(apiKeysStatus)}
      ${runnerNeedsKey ? renderRunnerKeySection(selectedRunner, runnerName, apiKeysStatus) : ''}
      <div id="obApiKeyStatus" style="margin-top:var(--space-sm)"></div>
    </div>`;
  wireApiKeyListeners(el, apiKeysStatus, (provider) => {
    if (provider === 'openai' && RUNNERS_NEEDING_LLM_KEY.has(selectedRunner)) {
      renderApiKeysStep(document.getElementById('obContent'));
    }
  });
}

let cachedCatalog = null;
let activeConnectors = [];

async function renderConnectorsStep(el) {
  if (!cachedCatalog) { try { const data = await api.connectors.catalog(); cachedCatalog = data.catalog || []; } catch { cachedCatalog = []; } }
  if (connectorSubStep === 0) renderModeSelection(el); else renderActiveConnectorsList(el);
}

function renderModeSelection(el) {
  el.innerHTML = `
    <div class="ob-section">
      <h3 class="ob-label">${t('onboarding.connectorModeTitle')}</h3>
      <p class="ob-hint">${t('onboarding.connectorModeHint')}</p>
      <div class="ob-mode-grid">
        <div class="ob-mode-card ${connectorMode === 'mcp' ? 'selected' : ''}" data-mode="mcp">
          <div class="ob-mode-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 9h6M9 12h6M9 15h3"/></svg></div>
          <div class="ob-mode-title">MCP Server</div>
          <div class="ob-mode-desc">${t('onboarding.connectorModeMcpDesc')}</div>
        </div>
        <div class="ob-mode-card ${connectorMode === 'builtin' ? 'selected' : ''}" data-mode="builtin">
          <div class="ob-mode-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg></div>
          <div class="ob-mode-title">${t('onboarding.connectorModeBuiltinTitle')}</div>
          <div class="ob-mode-desc">${t('onboarding.connectorModeBuiltinDesc')}</div>
        </div>
        <div class="ob-mode-card ${connectorMode === 'hybrid' ? 'selected' : ''}" data-mode="hybrid">
          <div class="ob-mode-icon"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg></div>
          <div class="ob-mode-title">${t('onboarding.connectorModeHybridTitle')}</div>
          <div class="ob-mode-desc">${t('onboarding.connectorModeHybridDesc')}</div>
          <span class="ob-mode-badge">${t('onboarding.connectorModeRecommended')}</span>
        </div>
      </div>
    </div>`;
  el.querySelectorAll('.ob-mode-card').forEach(card => { card.addEventListener('click', () => { connectorMode = card.dataset.mode; el.querySelectorAll('.ob-mode-card').forEach(c => c.classList.remove('selected')); card.classList.add('selected'); }); });
}

function renderActiveConnectorsList(el) {
  const catalog = cachedCatalog || [];
  const connRows = activeConnectors.map((conn, idx) => {
    const cat = catalog.find(c => c.id === conn.catalogId); const icon = cat?.icon || '\ud83d\udd0c';
    const statusClass = conn.status === 'connected' ? 'ob-conn-status-ok' : conn.status === 'connecting' ? 'ob-conn-status-pending' : conn.status === 'error' ? 'ob-conn-status-err' : 'ob-conn-status-pending';
    const statusIcon = conn.status === 'connected' ? '\u2713' : conn.status === 'connecting' ? '\u23f3' : conn.status === 'error' ? '\u2717' : '\u2014';
    const toolLabel = conn.toolCount !== 1 ? t('onboarding.connectorsTools') : t('onboarding.connectorsTool');
    return `<div class="ob-active-conn-row"><span class="ob-active-conn-icon">${icon}</span><div class="ob-active-conn-info"><span class="ob-active-conn-label">${esc(conn.label)}</span><span class="ob-active-conn-meta">${esc(conn.backend)}${conn.toolCount > 0 ? ` \u00b7 ${conn.toolCount} ${toolLabel}` : ''}</span></div><span class="${statusClass}">${statusIcon}</span><button class="btn btn-sm btn-icon ob-conn-remove" data-remove-idx="${idx}" title="${t('onboarding.connectorsRemove')}">\u2715</button></div>`;
  }).join('');
  const modeLabel = connectorMode === 'hybrid' ? t('onboarding.connectorModeHybridLabel') : connectorMode === 'mcp' ? t('onboarding.connectorModeMcpLabel') : t('onboarding.connectorModeBuiltinLabel');
  el.innerHTML = `
    <div class="ob-section">
      <div style="display:flex;align-items:center;gap:var(--space-sm);margin-bottom:var(--space-sm)">
        <h3 class="ob-label" style="margin:0">${t('onboarding.connectorsTitle')}</h3>
        <span class="ob-hint" style="margin:0;margin-left:auto">${t('onboarding.connectorsModeLabel')} ${modeLabel}</span>
      </div>
      <p class="ob-hint">${t('onboarding.connectorsHint')}</p>
      <div class="ob-active-connectors" id="obActiveList">${activeConnectors.length === 0 ? `<div class="ob-empty-hint">${t('onboarding.connectorsNone')}</div>` : connRows}</div>
      <button class="btn btn-primary" id="obAddConnBtn" style="margin-top:var(--space-md);width:100%">${t('onboarding.connectorsAdd')}</button>
    </div>`;
  document.getElementById('obAddConnBtn')?.addEventListener('click', () => { openCatalogModal(catalog, el); });
  el.querySelectorAll('[data-remove-idx]').forEach(btn => { btn.addEventListener('click', async () => { const idx = parseInt(btn.dataset.removeIdx); const conn = activeConnectors[idx]; if (!conn) return; try { await api.connectors.remove(conn.id); } catch {} activeConnectors.splice(idx, 1); renderActiveConnectorsList(el); }); });
}

function openCatalogModal(catalog, parentEl) {
  const CAT_ORDER = ['dev','project','productivity','design','data','search','communication','business','devops','google'];
  const CAT_KEYS = { dev:'onboarding.catalogCategoryDev',project:'onboarding.catalogCategoryProject',productivity:'onboarding.catalogCategoryProductivity',design:'onboarding.catalogCategoryDesign',data:'onboarding.catalogCategoryData',search:'onboarding.catalogCategorySearch',communication:'onboarding.catalogCategoryCommunication',business:'onboarding.catalogCategoryBusiness',devops:'onboarding.catalogCategoryDevops',google:'onboarding.catalogCategoryGoogle' };
  function buildBody(filter='') {
    const lf = filter.toLowerCase();
    let html = `<input class="input catalog-modal-search" id="obCatalogSearch" placeholder="${t('onboarding.catalogSearch')}" value="${esc(filter)}" /><div class="catalog-modal-grid">`;
    for (const cat of CAT_ORDER) {
      const items = catalog.filter(c => c.category === cat && (!lf || c.name.toLowerCase().includes(lf) || (c.description||'').toLowerCase().includes(lf)));
      if (!items.length) continue;
      html += `<div class="catalog-category"><div class="catalog-category-title">${esc(t(CAT_KEYS[cat])||cat)}</div><div class="catalog-items">`;
      for (const item of items) {
        const isSoon = item.comingSoon; const sB = item.backends.includes('builtin') && connectorMode !== 'mcp'; const sM = item.backends.includes('mcp') && connectorMode !== 'builtin';
        let a; if (isSoon) a = `<span class="badge-coming-soon">${t('onboarding.catalogComingSoon')}</span>`; else if (sB && sM) a = `<button class="btn btn-sm" data-add-catalog="${item.id}" data-add-backend="builtin">${t('onboarding.connectorModeBuiltinTitle')}</button><button class="btn btn-sm" data-add-catalog="${item.id}" data-add-backend="mcp">MCP</button>`; else if (sB) a = `<button class="btn btn-sm btn-primary" data-add-catalog="${item.id}" data-add-backend="builtin">${t('onboarding.catalogAdd')}</button>`; else if (sM) a = `<button class="btn btn-sm btn-primary" data-add-catalog="${item.id}" data-add-backend="mcp">${t('onboarding.catalogAdd')}</button>`; else a = `<span class="badge-coming-soon">${t('onboarding.catalogNotAvailable')}</span>`;
        html += `<div class="catalog-item ${isSoon?'catalog-coming-soon':''}"><div class="catalog-item-header"><span class="catalog-item-icon">${item.icon}</span><div class="catalog-item-info"><span class="catalog-item-name">${esc(item.name)}</span><span class="catalog-item-desc">${esc(item.description)}</span></div></div><div class="catalog-item-actions">${a}</div></div>`;
      }
      html += '</div></div>';
    }
    html += '</div>'; return html;
  }
  openModal({ title: t('onboarding.catalogTitle'), body: buildBody(), wide: true, hideSubmit: true });
  setTimeout(() => {
    const searchInput = document.getElementById('obCatalogSearch');
    if (searchInput) { searchInput.addEventListener('input', () => { const grid = document.querySelector('.catalog-modal-grid'); if (!grid) return; grid.innerHTML = buildBody(searchInput.value).replace(/^.*?<div class="catalog-modal-grid">/, '').replace(/<\/div>$/, ''); wireAddButtons(catalog, parentEl); }); searchInput.focus(); }
    wireAddButtons(catalog, parentEl);
  }, 50);
}

function wireAddButtons(catalog, parentEl) {
  document.querySelectorAll('[data-add-catalog]').forEach(btn => { btn.addEventListener('click', () => { const catalogId = btn.dataset.addCatalog; const backend = btn.dataset.addBackend; const item = catalog.find(c => c.id === catalogId); if (!item) return; closeModal(); setTimeout(() => openConnectorSetupModal(item, backend, catalog, parentEl), 200); }); });
}

function openConnectorSetupModal(item, backend, catalog, parentEl) {
  const fields = item.authFields || [];
  const needsAuth = item.authType !== 'none' && fields.length > 0;
  if (!needsAuth) {
    const tempIdx = activeConnectors.length;
    activeConnectors.push({ id: null, catalogId: item.id, label: item.name, backend, status: 'connecting', toolCount: 0 });
    renderActiveConnectorsList(parentEl);
    (async () => { try { const result = await api.connectors.create({ catalogId: item.id, label: item.name, backend, credentials: {}, isGlobal: true, autoConnect: true }); activeConnectors[tempIdx] = { id: result.id, catalogId: item.id, label: item.name, backend, status: result.status || 'connected', toolCount: result.toolCount || 0 }; } catch { activeConnectors[tempIdx].status = 'error'; } renderActiveConnectorsList(parentEl); })();
    return;
  }
  let bodyHtml = `<div class="form-group"><label class="form-label">${t('onboarding.setupDisplayName')}</label><input class="input" data-field="connLabel" value="${esc(item.name)}" placeholder="${esc(item.name)}" /></div>`;
  if (item.helpSteps?.length > 0) {
    bodyHtml += `<div class="conn-setup-guide" style="margin-bottom:var(--space-md)"><h5 style="margin:0 0 var(--space-xs)">${t('onboarding.setupCredentials')}</h5><ol class="conn-steps-list" style="margin:0;padding-left:var(--space-md)">${item.helpSteps.map(s => `<li style="font-size:0.82rem;color:var(--text-muted)">${esc(s)}</li>`).join('')}</ol>${item.helpUrl ? `<button class="btn btn-sm" id="setupOpenProvider" type="button" style="margin-top:var(--space-xs)"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2H3a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-3"/><path d="M9 2h5v5"/><path d="M14 2L7 9"/></svg> ${t('onboarding.setupOpenProvider').replace('{{name}}', esc(item.name))}</button>` : ''}</div>`;
  }
  for (const field of fields) { bodyHtml += `<div class="form-group"><label class="form-label">${esc(field.label)}</label><div style="display:flex;gap:var(--space-sm);align-items:center"><input class="input" type="${field.type||'text'}" data-field="${field.key}" placeholder="${esc(field.placeholder||'')}" style="flex:1" />${field.type==='password'?`<button class="btn btn-sm btn-icon" id="setupToggle_${field.key}" type="button" title="${t('onboarding.showHide')}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg></button>`:''}</div></div>`; }
  bodyHtml += `<div style="display:flex;gap:var(--space-sm);align-items:center"><button class="btn btn-sm" id="setupTestBtn" type="button"><svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8l4 4 6-6"/></svg> ${t('onboarding.setupTest')}</button>${item.testDescription?`<span class="form-hint" style="font-size:0.75rem">${esc(item.testDescription)}</span>`:''}</div><div id="setupTestResult" style="min-height:1.2em;font-size:0.85rem;margin-top:var(--space-xs)"></div>`;
  openModal({ title: `${item.icon} ${item.name} (${backend})`, body: bodyHtml, submitLabel: t('onboarding.setupConnect'), onSubmit: async (formData) => {
    const credentials = {}; for (const field of fields) { const val = formData[field.key]; if (val) credentials[field.key] = val; }
    const label = (formData.connLabel||'').trim() || item.name;
    const result = await api.connectors.create({ catalogId: item.id, label, backend, credentials, isGlobal: true, autoConnect: true });
    if (result.status === 'error') throw new Error(result.errorMessage || t('onboarding.setupConnectionFailed'));
    activeConnectors.push({ id: result.id, catalogId: item.id, label, backend, status: result.status || 'connected', toolCount: result.toolCount || 0 });
    renderActiveConnectorsList(parentEl);
  }});
  setTimeout(() => {
    document.getElementById('setupOpenProvider')?.addEventListener('click', () => { window.open(item.helpUrl, '_blank'); });
    for (const field of fields) { if (field.type === 'password') { document.getElementById(`setupToggle_${field.key}`)?.addEventListener('click', () => { const input = document.querySelector(`[data-field="${field.key}"]`); if (input) input.type = input.type === 'password' ? 'text' : 'password'; }); } }
    const testBtn = document.getElementById('setupTestBtn'); const testResult = document.getElementById('setupTestResult');
    if (testBtn && testResult) { testBtn.addEventListener('click', async () => {
      testBtn.disabled = true; testBtn.innerHTML = `<span class="text-muted">${t('onboarding.setupValidating')}</span>`; testResult.innerHTML = '';
      const credentials = {}; for (const field of fields) { const input = document.querySelector(`[data-field="${field.key}"]`); if (input?.value) credentials[field.key] = input.value.trim(); }
      try { const res = await api.connectors.test('_new', { catalogId: item.id, credentials, backend }); testResult.innerHTML = res.valid ? `<span style="color:var(--accent-green)">\u2713 ${t('onboarding.setupCredentialsValid')}</span>` : `<span style="color:var(--accent-red)">\u2717 ${esc(res.error || t('onboarding.setupInvalid'))}</span>`; } catch (err) { testResult.innerHTML = `<span style="color:var(--accent-red)">\u2717 ${esc(err.message)}</span>`; }
      testBtn.disabled = false; testBtn.innerHTML = `<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8l4 4 6-6"/></svg> ${t('onboarding.setupTest')}`;
    }); }
  }, 100);
}

async function renderVoiceStep(el) {
  if (micPermission === 'unknown') { try { const perm = await navigator.permissions.query({ name: 'microphone' }); micPermission = perm.state; } catch { micPermission = 'prompt'; } }
  let micStatusHtml;
  if (!micEnabled) micStatusHtml = `<div class="ob-mic-status ob-mic-status-off"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 1l14 14"/><path d="M8 1a3 3 0 013 3v2.5M5 5v3a3 3 0 005.7 1.3"/><path d="M3 7v1a5 5 0 008.5 3.5"/><path d="M13 7v1"/><path d="M8 14v2M6 16h4"/></svg><span>${t('onboarding.voiceMicDisabled')}</span></div>`;
  else if (micPermission === 'granted') micStatusHtml = `<div class="ob-mic-status ob-mic-status-ok"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--accent-green)" stroke-width="2"><path d="M3 8l4 4 6-6"/></svg><span>${t('onboarding.voiceMicGranted')}</span></div>`;
  else if (micPermission === 'denied') micStatusHtml = `<div class="ob-mic-status ob-mic-status-denied"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--accent-red)" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M5 5l6 6"/></svg><span>${t('onboarding.voiceMicDenied')}</span></div>`;
  else micStatusHtml = `<div class="ob-mic-status ob-mic-status-prompt"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--accent-blue)" stroke-width="1.5"><circle cx="8" cy="8" r="6"/><path d="M8 5v4M8 11v1"/></svg><span>${t('onboarding.voiceMicPrompt')}</span><button class="btn btn-sm" id="obMicTest" type="button">${t('onboarding.voiceMicTestNow')}</button></div>`;
  el.innerHTML = `
    <div class="ob-section"><h3 class="ob-label">${t('onboarding.voiceMicTitle')}</h3><p class="ob-hint">${t('onboarding.voiceMicHint')}</p>
      <div class="ob-toggle-row" style="margin-bottom:var(--space-md)"><label class="toggle"><input type="checkbox" id="obMicEnabled" ${micEnabled?'checked':''} /><span class="toggle-track"></span>${t('onboarding.voiceEnableMic')}</label></div>${micStatusHtml}</div>
    <div class="ob-section" ${!micEnabled?'style="opacity:0.5;pointer-events:none"':''} id="obVoiceSection"><h3 class="ob-label">${t('onboarding.voiceChooseTitle')}</h3><p class="ob-hint">${t('onboarding.voiceClickPreview')}</p>
      <div class="ob-voice-grid">${VOICES.map(v=>`<div class="ob-voice-card ${selectedVoice===v?'selected':''}" data-voice="${v}"><span class="ob-voice-name">${v}</span><button class="ob-voice-play" data-preview="${v}" title="${t('onboarding.featurePreviews')}"><svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M4 2l10 6-10 6z"/></svg></button></div>`).join('')}</div>
      <div class="ob-voice-status" id="obVoiceStatus"></div></div>`;
  document.getElementById('obMicEnabled')?.addEventListener('change', (e) => { micEnabled = e.target.checked; renderVoiceStep(el); });
  document.getElementById('obMicTest')?.addEventListener('click', async () => { const s = document.getElementById('obMicTest'); if (s) s.textContent = t('onboarding.voiceMicRequesting'); try { const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); stream.getTracks().forEach(t=>t.stop()); micPermission = 'granted'; renderVoiceStep(el); } catch (err) { if (err.name==='NotAllowedError'||err.name==='PermissionDeniedError') micPermission='denied'; renderVoiceStep(el); } });
  el.querySelectorAll('.ob-voice-card').forEach(card => { card.addEventListener('click', (e) => { if (e.target.closest('.ob-voice-play')) return; selectedVoice = card.dataset.voice; el.querySelectorAll('.ob-voice-card').forEach(c=>c.classList.remove('selected')); card.classList.add('selected'); }); });
  el.querySelectorAll('.ob-voice-play').forEach(btn => { btn.addEventListener('click', async (e) => {
    e.stopPropagation(); const voice = btn.dataset.preview; const status = document.getElementById('obVoiceStatus');
    if (status) status.textContent = t('onboarding.voiceLoading').replace('{{voice}}', voice);
    try { const sampleText = userName ? t('onboarding.voiceSampleHello').replace('{{name}}', userName) : t('onboarding.voiceSampleHelloAnon');
      const res = await fetch('/api/tts/speak', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: sampleText, voice, provider: 'openai' }) });
      if (res.ok) { const blob = await res.blob(); const audio = new Audio(URL.createObjectURL(blob)); audio.play(); if (status) status.textContent = ''; } else { if (status) status.textContent = t('onboarding.voicePreviewUnavailable'); }
    } catch { if (status) status.textContent = t('onboarding.voicePreviewUnavailable'); }
  }); });
}

function renderEnvStep(el) {
  if (!micEnabled) { el.innerHTML = `<div class="ob-section"><h3 class="ob-label">${t('onboarding.envTitle')}</h3><div class="ob-mic-status ob-mic-status-off" style="margin-top:var(--space-md)"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 1l14 14"/><path d="M8 1a3 3 0 013 3v2.5M5 5v3a3 3 0 005.7 1.3"/><path d="M3 7v1a5 5 0 008.5 3.5"/><path d="M13 7v1"/><path d="M8 14v2M6 16h4"/></svg><span>${t('onboarding.envMicDisabledSkip')}</span></div></div>`; return; }
  el.innerHTML = `
    <div class="ob-section"><h3 class="ob-label">${t('onboarding.envTitle')}</h3><p class="ob-hint">${t('onboarding.envNoiseHint')}</p>
      <div class="ob-env-cards">
        <div class="ob-env-card ${noiseReduction==='near_field'?'selected':''}" data-type="near_field"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8"/><path d="M12 16v4"/></svg><span class="ob-env-title">${t('onboarding.envDeskHeadset')}</span><small class="ob-env-desc">${t('onboarding.envDeskHeadsetDesc')}</small></div>
        <div class="ob-env-card ${noiseReduction==='far_field'?'selected':''}" data-type="far_field"><svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M6 21h12"/><path d="M9 17v4"/><path d="M15 17v4"/></svg><span class="ob-env-title">${t('onboarding.envRoomSalon')}</span><small class="ob-env-desc">${t('onboarding.envRoomSalonDesc')}</small></div>
      </div></div>
    <div class="ob-section"><h3 class="ob-label">${t('onboarding.envTurnDetection')}</h3>
      <div class="ob-toggle-row"><label class="toggle"><input type="checkbox" id="obSemanticVad" ${turnDetection==='semantic_vad'?'checked':''} /><span class="toggle-track"></span>${t('onboarding.envSemanticVad')} <span style="color:var(--accent-green);font-weight:600;font-size:0.85em">${t('onboarding.envSemanticVadRecommended')}</span></label><small class="ob-hint">${t('onboarding.envSemanticVadHint')}</small></div></div>`;
  el.querySelectorAll('.ob-env-card').forEach(card => { card.addEventListener('click', () => { noiseReduction = card.dataset.type; el.querySelectorAll('.ob-env-card').forEach(c=>c.classList.remove('selected')); card.classList.add('selected'); }); });
  document.getElementById('obSemanticVad')?.addEventListener('change', (e) => { turnDetection = e.target.checked ? 'semantic_vad' : 'server_vad'; });
}

function renderSpeakerStep(el) {
  if (!micEnabled) { el.innerHTML = `<div class="ob-section"><h3 class="ob-label">${t('onboarding.speakerTitle')}</h3><div class="ob-mic-status ob-mic-status-off" style="margin-top:var(--space-md)"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 1l14 14"/><path d="M8 1a3 3 0 013 3v2.5M5 5v3a3 3 0 005.7 1.3"/><path d="M3 7v1a5 5 0 008.5 3.5"/><path d="M13 7v1"/><path d="M8 14v2M6 16h4"/></svg><span>${t('onboarding.speakerMicDisabledSkip')}</span></div></div>`; return; }
  const isEnrolled = obCalibrationSession && obCalibrationSession.state.consecutiveSuccess >= 3;
  el.innerHTML = `
    <div class="ob-section"><h3 class="ob-label">${t('onboarding.speakerTitle')}</h3><p class="ob-hint">${t('onboarding.speakerHint')}</p>
      ${isEnrolled ? `<div class="ob-enroll-success"><svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="var(--accent-green)" stroke-width="2"><circle cx="10" cy="10" r="8"/><path d="M6 10l3 3 5-5"/></svg><span>${t('onboarding.speakerCalibrated')}</span></div>` : `
        <div class="speaker-calibration"><div class="calibration-progress"><div class="calibration-counter"><span class="calibration-counter-label">${t('onboarding.speakerConsecutive')}</span><div class="calibration-counter-display"><span class="calibration-counter-value" id="obCalCounter">0</span><span class="calibration-counter-total">/ 3</span></div></div><div class="calibration-attempts"><span class="form-hint">${t('onboarding.speakerAttempts')} <strong id="obCalAttempts">0</strong></span></div></div>
          <div class="calibration-samples-visual">${[1,2,3].map(n=>`<div class="calibration-sample" data-sample="${n}"><div class="calibration-sample-ring" id="obCalSample${n}"><span class="calibration-sample-number">${n}</span></div><span class="calibration-sample-label">${t('onboarding.speakerSayYabby')}</span></div>`).join('')}</div>
          <div id="obCalMonitor" class="calibration-monitor-container"></div><div class="calibration-status" id="obCalStatus"></div>
          <button class="btn btn-primary" id="obCalStartBtn"><svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="var(--accent-red)"/></svg> ${t('onboarding.speakerStartCalibration')}</button></div>`}
    </div>`;
  if (!isEnrolled) setupOnboardingCalibration();
}

let obCalibrationSession = null;
async function setupOnboardingCalibration() {
  const btn = document.getElementById('obCalStartBtn'); if (!btn) return;
  const { CalibrationSession } = await import('../calibration-core.js');
  obCalibrationSession = new CalibrationSession({ btnId: 'obCalStartBtn', statusId: 'obCalStatus', counterId: 'obCalCounter', attemptsId: 'obCalAttempts', samplePrefix: 'obCalSample', monitorId: 'obCalMonitor', onComplete: async () => { speakerEnrolled = true; const speakerEl = document.querySelector('[data-step="speaker"]') || document.getElementById('obContent'); if (speakerEl) renderSpeakerStep(speakerEl); } });
  btn.addEventListener('click', () => obCalibrationSession.start(t));
}

async function recordSample() {
  const status = document.getElementById('obRecordStatus'); const btn = document.getElementById('obRecordBtn'); if (!btn || !status) return;
  if (!window.vad?.MicVAD) { status.textContent = t('onboarding.recordVadNotLoaded'); return; }
  btn.disabled = true; status.textContent = t('onboarding.recordSpeakNow');
  const currentSample = document.querySelector('.ob-sample.current'); if (currentSample) currentSample.classList.add('recording');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    const micVAD = await window.vad.MicVAD.new({ stream, ortConfig: (ort) => { ort.env.wasm.wasmPaths = "/vendor/"; }, baseAssetPath: "/vendor/", onSpeechEnd: async (audio) => {
      micVAD.destroy(); stream.getTracks().forEach(t => t.stop());
      if (audio.length < 3200) { status.textContent = t('onboarding.recordTooShort'); btn.disabled = false; if (currentSample) currentSample.classList.remove('recording'); return; }
      const wavBlob = float32ToWav(audio, 16000); enrollSamples.push(wavBlob); status.textContent = '';
      if (enrollSamples.length >= 3) { status.textContent = t('onboarding.recordEnrolling'); try { const formData = new FormData(); enrollSamples.forEach((blob, i) => { formData.append('files', blob, `sample_${i}.wav`); }); const res = await fetch('/api/speaker/enroll', { method: 'POST', body: formData }); const data = await res.json(); if (data.enrolled) speakerEnrolled = true; } catch { status.textContent = t('onboarding.recordServiceUnavailable'); } }
      renderSpeakerStep(document.getElementById('obContent'));
    }});
    micVAD.start();
    setTimeout(() => { try { micVAD.destroy(); } catch {} stream.getTracks().forEach(t => t.stop()); if (status) status.textContent = t('onboarding.recordNoSpeech'); if (btn) btn.disabled = false; if (currentSample) currentSample.classList.remove('recording'); }, 10000);
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') status.textContent = t('onboarding.recordMicDenied');
    else if (!window.vad) status.textContent = t('onboarding.recordVadNotLoaded');
    else status.textContent = `${t('onboarding.errorPrefix')} ${err.message || 'init failure'}`;
    btn.disabled = false; if (currentSample) currentSample.classList.remove('recording');
  }
}

function renderDoneStep(el) {
  const langLabel = LANGUAGES.find(l => l.code === selectedLang)?.label || selectedLang;
  const envLabel = noiseReduction === 'near_field' ? t('onboarding.doneEnvDesk') : t('onboarding.doneEnvRoom');
  const vadLabel = turnDetection === 'semantic_vad' ? t('onboarding.doneVadSemantic') : t('onboarding.doneVadStandard');
  const runnerLabel = runnersData?.runners?.find(r => r.id === selectedRunner)?.name || selectedRunner;
  const openaiOk = apiKeysStatus?.openai?.configured;
  const nameStr = userName ? ', ' + esc(userName) : '';
  el.innerHTML = `
    <div class="ob-done"><div class="ob-done-check"><svg viewBox="0 0 48 48" width="48" height="48" fill="none" stroke="var(--accent-green)" stroke-width="3" stroke-linecap="round"><circle cx="24" cy="24" r="20" opacity="0.2"/><path d="M14 24l7 7 13-13"/></svg></div>
      <h2 class="ob-done-title">${t('onboarding.doneReady').replace('{{name}}', nameStr)}</h2>
      <div class="ob-summary">
        <div class="ob-summary-row"><span class="ob-summary-label">${t('onboarding.doneCliAgent')}</span><span class="ob-summary-value">${esc(runnerLabel)}</span></div>
        <div class="ob-summary-row"><span class="ob-summary-label">${t('onboarding.doneOpenai')}</span><span class="ob-summary-value" style="${openaiOk?'color:var(--accent-green)':'color:var(--accent-red)'}">${openaiOk ? t('onboarding.doneOpenaiConfigured') : t('onboarding.doneOpenaiNotConfigured')}</span></div>
        <div class="ob-summary-row"><span class="ob-summary-label">${t('onboarding.doneMicLabel')}</span><span class="ob-summary-value" style="${micEnabled?'color:var(--accent-green)':'color:var(--text-muted)'}">${micEnabled ? t('onboarding.doneMicEnabled') : t('onboarding.doneMicDisabled')}</span></div>
        ${micEnabled ? `
        <div class="ob-summary-row"><span class="ob-summary-label">${t('onboarding.doneLangLabel')}</span><span class="ob-summary-value">${esc(langLabel)}</span></div>
        <div class="ob-summary-row"><span class="ob-summary-label">${t('onboarding.doneVoiceLabel')}</span><span class="ob-summary-value">${esc(selectedVoice)}</span></div>
        <div class="ob-summary-row"><span class="ob-summary-label">${t('onboarding.doneEnvLabel')}</span><span class="ob-summary-value">${esc(envLabel)}</span></div>
        <div class="ob-summary-row"><span class="ob-summary-label">${t('onboarding.doneVadLabel')}</span><span class="ob-summary-value">${esc(vadLabel)}</span></div>
        <div class="ob-summary-row"><span class="ob-summary-label">${t('onboarding.doneSpeakerLabel')}</span><span class="ob-summary-value">${speakerEnrolled ? t('onboarding.doneSpeakerEnabled') : t('onboarding.doneSpeakerNotConfigured')}</span></div>` : ''}
      </div>
      <button class="btn btn-primary btn-lg ob-launch-btn" id="obLaunch">${t('onboarding.doneLaunch')}<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 8h10M9 4l4 4-4 4"/></svg></button>
    </div>`;
  document.getElementById('obLaunch')?.addEventListener('click', finishOnboarding);
}

async function nextStep() {
  if (currentStep === 0 && !userName) { document.getElementById('obName')?.focus(); document.getElementById('obName')?.classList.add('ob-shake'); setTimeout(() => document.getElementById('obName')?.classList.remove('ob-shake'), 600); return; }
  if (currentStep === 0) { await saveStepConfig('voice', { language: selectedLang }); await saveStepConfig('general', { language: selectedLang, uiLocale: selectedLang }); await saveStepConfig('onboarding', { userName, completed: false }); }
  else if (currentStep === 1) { if (sandboxPath) await saveStepConfig('projects', { sandboxRoot: sandboxPath }); }
  else if (currentStep === 2) { await saveStepConfig('tasks', { runner: selectedRunner }); }
  else if (currentStep === 4) { if (connectorSubStep === 0) { connectorSubStep = 1; renderContent(); return; } }
  else if (currentStep === 5) { await saveStepConfig('voice', { voice: selectedVoice, language: selectedLang, micEnabled }); }
  else if (currentStep === 6) { await saveStepConfig('voice', { voice: selectedVoice, language: selectedLang, noiseReduction, turnDetection }); }
  currentStep = Math.min(currentStep + 1, STEPS.length - 1);
  renderStep();
}

function prevStep() {
  if (currentStep === 4 && connectorSubStep === 1) { connectorSubStep = 0; renderContent(); return; }
  if (currentStep === 5) connectorSubStep = 1;
  currentStep = Math.max(currentStep - 1, 0);
  renderStep();
}

async function finishOnboarding() {
  try {
    const current = await api.config.getAll().catch(() => ({}));
    const currentTasks = current.tasks || {};
    await api.config.set('voice', { model: 'gpt-realtime', voice: selectedVoice, language: selectedLang, noiseReduction, turnDetection, micEnabled });
    await api.config.set('tasks', {
      runner: selectedRunner,
      runnerPath: null,
      verbose: true,
      forwardUrl: null,
      enableRunnerParityV2: currentTasks.enableRunnerParityV2 !== false,
    });
    if (sandboxPath) await api.config.set('projects', { sandboxRoot: sandboxPath, cleanOnArchive: false });
    await api.config.set('general', { language: selectedLang, uiLocale: selectedLang });
    await api.config.set('onboarding', { completed: true, userName, completedAt: new Date().toISOString() });
  } catch (err) { console.error('[Onboarding] Save error:', err); }
  overlay.classList.remove('visible');
  setTimeout(() => { overlay.remove(); overlay = null; if (resolveOnboarding) resolveOnboarding(); }, 400);
}

async function saveStepConfig(key, value) {
  try { const current = await api.config.getAll().catch(() => ({})); const merged = { ...(current[key] || {}), ...value }; await api.config.set(key, merged); } catch (err) { console.error(`[Onboarding] Failed to save ${key}:`, err.message); }
}

function float32ToWav(samples, sampleRate) {
  const numChannels = 1, bitsPerSample = 16, byteRate = sampleRate * 1 * 16 / 8, blockAlign = 1 * 16 / 8, dataSize = samples.length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize), view = new DataView(buffer);
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF'); view.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE'); writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true); view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data'); view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) { const s = Math.max(-1, Math.min(1, samples[i])); view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true); offset += 2; }
  return new Blob([buffer], { type: 'audio/wav' });
}
