/* ═══════════════════════════════════════════════════════
   YABBY — Settings View
   ═══════════════════════════════════════════════════════
   Tabs: Général, Voix (speaker), Projets, Authentification, Utilisation
*/

import { api } from '../api.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';
import { t, setLocale, getLocale } from '../i18n.js';
import {
  RUNNERS_NEEDING_LLM_KEY,
  renderRunnerGrid,
  wireRunnerGrid,
  renderOpenAiKeySection,
  renderRunnerKeySection,
  wireApiKeyListeners,
} from './runner-selector.js';

let activeTab = 'general';

export async function render(container) {
  container.innerHTML = `
    <div class="settings">
      <div class="settings-header">
        <h2 class="settings-title">${t('settings.title')}</h2>
      </div>

      <div class="tabs" id="settingsTabs">
        <span class="tab active" data-tab="general">${t('settings.general')}</span>
        <span class="tab" data-tab="speaker">${t('settings.speakerVerification')}</span>
        <span class="tab" data-tab="projects">${t('settings.projectsTab')}</span>
        <span class="tab" data-tab="auth">${t('settings.auth')}</span>
        <span class="tab" data-tab="usage">${t('settings.usage')}</span>
      </div>

      <div id="settingsContent" class="settings-content">
        <div class="settings-loading">${t('common.loading')}</div>
      </div>
    </div>
  `;

  // Tab switching
  document.getElementById('settingsTabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab');
    if (!tab) return;
    activeTab = tab.dataset.tab;
    document.querySelectorAll('#settingsTabs .tab').forEach(tb => tb.classList.remove('active'));
    tab.classList.add('active');
    renderTab();
  });

  await renderTab();
}

async function renderTab() {
  const el = document.getElementById('settingsContent');
  if (!el) return;

  el.innerHTML = `<div class="settings-loading">${t('common.loading')}</div>`;

  try {
    switch (activeTab) {
      case 'general': await renderGeneral(el); break;
      case 'projects': await renderProjects(el); break;
      case 'speaker': await renderSpeaker(el); break;
      case 'auth': await renderAuth(el); break;
      case 'usage': await renderUsage(el); break;
    }
  } catch (err) {
    el.innerHTML = `<div class="settings-error">${t('common.error')}: ${esc(err.message)}</div>`;
  }
}

// ═══════════════════════════════════════════
// General Config Tab
// ═══════════════════════════════════════════

async function renderGeneral(el) {
  const [config, runnersInfo, apiKeysStatus] = await Promise.all([
    api.config.getAll(),
    api.tasks.runners().catch(() => ({ runners: [], current: 'claude' })),
    api.config.apiKeysStatus().catch(() => ({})),
  ]);
  const uiLocale = config.general?.uiLocale || config.general?.language || getLocale();
  const speechLocale = config.voice?.language || uiLocale;
  let selectedRunner = config.tasks?.runner || runnersInfo.current || 'claude';

  el.innerHTML = `
    <div class="settings-sections">
      <!-- Language -->
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="9" cy="9" r="7"/><path d="M2 9h14"/><ellipse cx="9" cy="9" rx="3.5" ry="7"/></svg>
          <h3>${t('settings.language')}</h3>
        </div>

        <div class="settings-grid">
          <div class="form-group">
            <label class="form-label" for="cfgUiLanguage">${t('settings.uiLanguage')}</label>
            <select class="select" id="cfgUiLanguage">
              ${[['fr','Français'],['en','English'],['es','Español'],['de','Deutsch']].map(([v,l]) =>
                `<option value="${v}" ${uiLocale === v ? 'selected' : ''}>${l}</option>`
              ).join('')}
            </select>
            <span class="form-hint">${t('settings.uiLanguageHint')}</span>
          </div>
          <div class="form-group">
            <label class="form-label" for="cfgSpeechLanguage">${t('settings.speechLanguage')}</label>
            <select class="select" id="cfgSpeechLanguage">
              ${[['fr','Français'],['en','English'],['es','Español'],['de','Deutsch']].map(([v,l]) =>
                `<option value="${v}" ${speechLocale === v ? 'selected' : ''}>${l}</option>`
              ).join('')}
            </select>
            <span class="form-hint">${t('settings.speechLanguageHint')}</span>
          </div>
        </div>
        <button class="btn btn-primary btn-sm settings-save" id="saveLanguageSettings">${t('common.save')}</button>
      </div>

      <!-- Voice -->
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 2v14"/><path d="M5 5v8"/><path d="M13 4v10"/><path d="M3 8v2"/><path d="M15 7v4"/></svg>
          <h3>${t('settings.voice')}</h3>
        </div>

        <div class="form-group" style="margin-bottom:var(--space-lg)">
          <label class="toggle">
            <input type="checkbox" id="cfgMicEnabled" ${config.voice?.micEnabled !== false ? 'checked' : ''} />
            <span class="toggle-track"></span>
            ${t('settings.enableMic')}
          </label>
          <span class="form-hint">${t('settings.micHint')}</span>
        </div>

        <div id="cfgVoiceFields" ${config.voice?.micEnabled === false ? 'style="opacity:0.5;pointer-events:none"' : ''}>
          <div class="settings-grid">
            <div class="form-group">
              <label class="form-label" for="cfgVoiceModel">${t('settings.model')}</label>
              <input class="input" id="cfgVoiceModel" value="${esc(config.voice?.model || 'gpt-realtime')}" />
            </div>
            <div class="form-group">
              <label class="form-label" for="cfgVoiceVoice">${t('settings.voiceLabel')}</label>
              <select class="select" id="cfgVoiceVoice">
                ${['ash','ballad','coral','sage','verse','marin'].map(v =>
                  `<option value="${v}" ${config.voice?.voice === v ? 'selected' : ''}>${v}</option>`
                ).join('')}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="cfgNoiseReduction">${t('settings.noiseReduction')}</label>
              <select class="select" id="cfgNoiseReduction">
                <option value="near_field" ${config.voice?.noiseReduction === 'near_field' || !config.voice?.noiseReduction ? 'selected' : ''}>${t('settings.noiseNearField')}</option>
                <option value="far_field" ${config.voice?.noiseReduction === 'far_field' ? 'selected' : ''}>${t('settings.noiseFarField')}</option>
                <option value="off" ${config.voice?.noiseReduction === 'off' ? 'selected' : ''}>${t('settings.noiseOff')}</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="cfgTurnDetection">${t('settings.turnDetection')}</label>
              <select class="select" id="cfgTurnDetection">
                <option value="server_vad" ${config.voice?.turnDetection === 'server_vad' || !config.voice?.turnDetection ? 'selected' : ''}>${t('settings.vadStandard')}</option>
                <option value="semantic_vad" ${config.voice?.turnDetection === 'semantic_vad' ? 'selected' : ''}>${t('settings.vadSemantic')}</option>
              </select>
              <span class="form-hint">${t('settings.vadHint')}</span>
            </div>
          </div>
        </div>
        <button class="btn btn-primary btn-sm settings-save" id="saveVoice">${t('common.save')}</button>
      </div>

      <!-- Memory -->
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="9" cy="9" r="7"/><path d="M9 6v3l2 1.5"/></svg>
          <h3>${t('settings.memory')}</h3>
          <span class="settings-badge settings-badge-warn">${t('settings.memoryModelWarning')}</span>
        </div>
        <div class="settings-grid">
          <div class="form-group">
            <label class="form-label" for="cfgMemoryModel">${t('settings.llmModel')}</label>
            <input class="input" id="cfgMemoryModel" value="${esc(config.memory?.model || 'gpt-5-mini')}" />
            <span class="form-hint">${t('settings.memoryModelHint')}</span>
          </div>
          <div class="form-group">
            <label class="form-label" for="cfgMemoryEmbedder">${t('settings.embedder')}</label>
            <input class="input" id="cfgMemoryEmbedder" value="${esc(config.memory?.embedder || 'text-embedding-3-small')}" />
          </div>
          <div class="form-group">
            <label class="form-label" for="cfgMemoryTurns">${t('settings.extractionTurns')}</label>
            <input class="input" type="number" id="cfgMemoryTurns" value="${config.memory?.extractEveryNTurns || 6}" min="2" max="20" />
          </div>
        </div>
        <button class="btn btn-primary btn-sm settings-save" id="saveMemory">${t('common.save')}</button>
      </div>

      <!-- TTS -->
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M3 7v4h3l4 3V4L6 7H3z"/><path d="M13 6.5c.8.8 1.2 1.8 1.2 2.5s-.4 1.7-1.2 2.5"/></svg>
          <h3>${t('settings.tts')}</h3>
        </div>
        <div class="settings-grid">
          <div class="form-group">
            <label class="form-label" for="cfgTTSProvider">${t('settings.ttsProvider')}</label>
            <select class="select" id="cfgTTSProvider">
              ${['edge-tts','elevenlabs','system'].map(p =>
                `<option value="${p}" ${config.tts?.defaultProvider === p ? 'selected' : ''}>${p}</option>`
              ).join('')}
            </select>
          </div>
        </div>
        <button class="btn btn-primary btn-sm settings-save" id="saveTTS">${t('common.save')}</button>
      </div>

      <!-- Task Execution — reuses onboarding runner-card UI -->
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M4 5h10M4 9h6"/><path d="M2 2h14v14H2z" rx="2"/></svg>
          <h3>${t('settings.taskExecution')}</h3>
        </div>

        <p class="ob-hint" style="margin-bottom:var(--space-sm)">${t('onboarding.runnerHint')}</p>
        <div id="settingsRunnerGridWrap">
          ${renderRunnerGrid(runnersInfo.runners || [], selectedRunner)}
        </div>

        <div id="settingsRunnerKeys" style="margin-top:var(--space-md)"></div>

        <details style="margin:var(--space-md) 0">
          <summary class="form-label" style="cursor:pointer; color: var(--text-muted)">${t('common.advanced')}</summary>
          <div class="form-group" style="margin-top: var(--space-md)">
            <label class="form-label" for="cfgTasksRunnerPath">${t('settings.binaryPath')}</label>
            <input class="input" id="cfgTasksRunnerPath" value="${esc(config.tasks?.runnerPath || '')}" placeholder="/usr/local/bin/claude" />
            <span class="form-hint">${t('settings.binaryPathHint')}</span>
          </div>
          <div class="form-group" style="margin-top: var(--space-md)">
            <label class="toggle">
              <input type="checkbox" id="cfgTasksVerbose" ${config.tasks?.verbose !== false ? 'checked' : ''} />
              <span class="toggle-track"></span>
              ${t('settings.verboseMode')}
            </label>
            <span class="form-hint">${t('settings.verboseHint')}</span>
          </div>
          <div class="form-group" style="margin-top: var(--space-md)">
            <label class="form-label" for="cfgTasksForwardUrl">${t('settings.forwardUrl')}</label>
            <input class="input" id="cfgTasksForwardUrl" value="${esc(config.tasks?.forwardUrl || '')}" placeholder="http://host.docker.internal:3001/task/spawn" />
            <span class="form-hint">${t('settings.forwardUrlHint')}</span>
          </div>
        </details>

        <button class="btn btn-primary btn-sm settings-save" id="saveTasks">${t('common.save')}</button>
      </div>

      <!-- Interface -->
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="3" width="14" height="12" rx="1.5"/><path d="M2 7h14"/></svg>
          <h3>${t('settings.interface')}</h3>
        </div>
        <div class="form-group">
          <label class="toggle">
            <input type="checkbox" id="cfgShowLlmResumeBtn" ${localStorage.getItem('yabby-show-llm-resume-btn') !== 'false' ? 'checked' : ''} />
            <span class="toggle-track"></span>
            ${t('settings.showLlmResumeBtn')}
          </label>
          <span class="form-hint">${t('settings.showLlmResumeBtnHint')}</span>
        </div>
      </div>

      <!-- Onboarding -->
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="9" cy="9" r="7"/><path d="M9 6v4M9 12.5v.5"/></svg>
          <h3>${t('settings.initialSetup')}</h3>
        </div>
        <p class="form-hint" style="margin-bottom: var(--space-md)">${t('settings.rerunOnboardingHint')}</p>
        <button class="btn btn-sm" id="rerunOnboarding">${t('settings.rerunOnboarding')}</button>
      </div>
    </div>
  `;

  // Mic toggle — dim voice fields when disabled
  document.getElementById('cfgMicEnabled')?.addEventListener('change', (e) => {
    const fields = document.getElementById('cfgVoiceFields');
    if (fields) {
      fields.style.opacity = e.target.checked ? '' : '0.5';
      fields.style.pointerEvents = e.target.checked ? '' : 'none';
    }
  });

  // Save handlers
  document.getElementById('saveVoice')?.addEventListener('click', async () => {
    await saveConfig('voice', {
      model: document.getElementById('cfgVoiceModel').value,
      voice: document.getElementById('cfgVoiceVoice').value,
      noiseReduction: document.getElementById('cfgNoiseReduction').value,
      turnDetection: document.getElementById('cfgTurnDetection').value,
      micEnabled: document.getElementById('cfgMicEnabled').checked,
    });
  });

  document.getElementById('saveLanguageSettings')?.addEventListener('click', async () => {
    const uiLanguage = document.getElementById('cfgUiLanguage').value;
    const speechLanguage = document.getElementById('cfgSpeechLanguage').value;
    await Promise.all([
      saveConfig('general', { ...(config.general || {}), uiLocale: uiLanguage, language: uiLanguage }, false),
      saveConfig('voice', { ...(config.voice || {}), language: speechLanguage }, false),
    ]);
    await setLocale(uiLanguage);
    render(document.querySelector('.settings')?.parentElement || el.closest('.main-content') || el);
    showToast({ type: 'success', title: t('settings.saved'), message: t('settings.configUpdated', { key: 'language' }) });
  });

  document.getElementById('saveMemory')?.addEventListener('click', async () => {
    await saveConfig('memory', {
      model: document.getElementById('cfgMemoryModel').value,
      embedder: document.getElementById('cfgMemoryEmbedder').value,
      extractEveryNTurns: parseInt(document.getElementById('cfgMemoryTurns').value) || 6,
    });
  });

  document.getElementById('saveTTS')?.addEventListener('click', async () => {
    await saveConfig('tts', {
      defaultProvider: document.getElementById('cfgTTSProvider').value,
    });
  });

  // ── Runner selector + LLM key section (same UX as onboarding) ──
  const runnerKeysEl = document.getElementById('settingsRunnerKeys');
  const runners = runnersInfo.runners || [];

  function renderRunnerKeysSection() {
    if (!runnerKeysEl) return;
    const runnerNeedsKey = RUNNERS_NEEDING_LLM_KEY.has(selectedRunner);
    const runnerName = runners.find(r => r.id === selectedRunner)?.name || selectedRunner;
    const isCodex = selectedRunner === 'codex';
    const isClaude = selectedRunner === 'claude';
    let intro = '';
    if (isClaude) intro = `<p class="form-hint" style="margin-bottom:var(--space-sm)">${t('settings.claudeAuthHint')}</p>`;
    else if (isCodex) intro = `<p class="form-hint" style="margin-bottom:var(--space-sm)">${t('settings.codexKeyHint')}</p>`;
    runnerKeysEl.innerHTML = `
      ${intro}
      ${renderOpenAiKeySection(apiKeysStatus)}
      ${runnerNeedsKey ? renderRunnerKeySection(selectedRunner, runnerName, apiKeysStatus) : ''}
    `;
    wireApiKeyListeners(runnerKeysEl, apiKeysStatus, (provider) => {
      if (provider === 'openai' && RUNNERS_NEEDING_LLM_KEY.has(selectedRunner)) {
        renderRunnerKeysSection();
      }
    });
  }

  const gridWrap = document.getElementById('settingsRunnerGridWrap');
  if (gridWrap) {
    wireRunnerGrid(gridWrap, (id) => {
      selectedRunner = id;
      renderRunnerKeysSection();
    });
  }
  renderRunnerKeysSection();

  document.getElementById('saveTasks')?.addEventListener('click', async () => {
    const url = document.getElementById('cfgTasksForwardUrl')?.value.trim();
    const runnerPath = document.getElementById('cfgTasksRunnerPath')?.value.trim();
    await saveConfig('tasks', {
      runner: selectedRunner,
      runnerPath: runnerPath || null,
      verbose: document.getElementById('cfgTasksVerbose').checked,
      forwardUrl: url || null,
      enableRunnerParityV2: config.tasks?.enableRunnerParityV2 !== false,
    });
  });

  document.getElementById('rerunOnboarding')?.addEventListener('click', async () => {
    try {
      await api.config.set('onboarding', { completed: false, userName: null, completedAt: null });
      showToast({ type: 'success', title: 'Onboarding', message: t('common.loading') });
      setTimeout(() => location.reload(), 500);
    } catch (err) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  });

  // LLM resume button visibility toggle
  document.getElementById('cfgShowLlmResumeBtn')?.addEventListener('change', (e) => {
    localStorage.setItem('yabby-show-llm-resume-btn', e.target.checked ? 'true' : 'false');
    if (typeof window.refreshLlmLimitButton === 'function') {
      window.refreshLlmLimitButton();
    }
    showToast({ type: 'success', title: t('settings.saved'), message: t('settings.configUpdated', { key: 'interface' }) });
  });
}

async function saveConfig(key, value, showSuccess = true) {
  try {
    await api.config.set(key, value);
    if (showSuccess) {
      showToast({ type: 'success', title: t('settings.saved'), message: t('settings.configUpdated', { key }) });
    }
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
  }
}

// ═══════════════════════════════════════════
// Speaker Verification Tab
// ═══════════════════════════════════════════

async function renderSpeaker(el) {
  let status = { enrolled: false };
  let serviceUp = true;
  try {
    const res = await fetch('/api/speaker/status');
    if (res.ok) status = await res.json();
    else serviceUp = false;
  } catch { serviceUp = false; }

  el.innerHTML = `
    <div class="settings-sections">
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="9" cy="6" r="3"/><path d="M3 16c0-3.3 2.7-6 6-6s6 2.7 6 6"/></svg>
          <h3>${t('settings.speakerTitle')}</h3>
          <span class="settings-badge ${status.enrolled ? 'settings-badge-ok' : 'settings-badge-warn'}">${status.enrolled ? t('settings.enrolled') : t('settings.notEnrolled')}</span>
        </div>

        ${!serviceUp ? `
          <div class="settings-alert settings-alert-warn">
            <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 2l7 13H2L9 2z"/><path d="M9 7v3M9 12.5v.5"/></svg>
            <div>
              <strong>${t('settings.serviceUnavailable')}</strong>
              <p class="form-hint">${t('settings.serviceUnavailableHint')}</p>
              <code>cd speaker && pip install -r requirements.txt && uvicorn app:app --port 3001</code>
            </div>
          </div>
        ` : ''}

        ${status.enrolled ? `
          <div class="speaker-enrolled">
            <div class="speaker-status-ok">
              <svg viewBox="0 0 18 18" width="24" height="24" fill="none" stroke="var(--accent-green)" stroke-width="1.5"><circle cx="9" cy="9" r="7"/><path d="M6 9l2 2 4-4"/></svg>
              <div>
                <div class="speaker-status-label">${t('settings.profileRecorded')}</div>
                <div class="form-hint">${t('settings.speakerHint')}</div>
              </div>
            </div>
          </div>
          <div class="speaker-danger-zone">
            <div class="speaker-danger-label">${t('settings.clearEnrollment')}</div>
            <p class="form-hint">${t('settings.clearEnrollmentHint')}</p>
            <button class="btn btn-sm btn-danger" id="clearEnrollment">${t('settings.clearEnrollment')}</button>
          </div>
        ` : `
          <div class="speaker-calibration">
            <div class="calibration-header">
              <h4>${t('settings.calibrationTitle')}</h4>
              <p class="form-hint">${t('settings.calibrationHint')}</p>
            </div>

            <div class="calibration-progress">
              <div class="calibration-counter">
                <span class="calibration-counter-label">${t('settings.consecutiveSuccess')}</span>
                <div class="calibration-counter-display">
                  <span class="calibration-counter-value" id="calibrationCounter">0</span>
                  <span class="calibration-counter-total">/ 3</span>
                </div>
              </div>
              <div class="calibration-attempts">
                <span class="form-hint">${t('settings.attempts')}: <strong id="calibrationAttempts">0</strong></span>
              </div>
            </div>

            <div class="calibration-samples-visual">
              <div class="calibration-sample" data-sample="1">
                <div class="calibration-sample-ring" id="calSample1">
                  <span class="calibration-sample-number">1</span>
                </div>
                <span class="calibration-sample-label">${t('settings.sayYabby')}</span>
              </div>
              <div class="calibration-sample" data-sample="2">
                <div class="calibration-sample-ring" id="calSample2">
                  <span class="calibration-sample-number">2</span>
                </div>
                <span class="calibration-sample-label">${t('settings.sayYabby')}</span>
              </div>
              <div class="calibration-sample" data-sample="3">
                <div class="calibration-sample-ring" id="calSample3">
                  <span class="calibration-sample-number">3</span>
                </div>
                <span class="calibration-sample-label">${t('settings.sayYabby')}</span>
              </div>
            </div>

            <div id="calibrationMonitor" class="calibration-monitor-container"></div>

            <div class="calibration-status" id="calibrationStatus"></div>

            <button class="btn btn-primary" id="calibrationStartBtn" ${!serviceUp ? 'disabled' : ''}>
              <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6" fill="var(--accent-red)"/></svg>
              ${t('settings.startCalibration')}
            </button>
          </div>
        `}
      </div>
    </div>
  `;

  // Clear enrollment
  document.getElementById('clearEnrollment')?.addEventListener('click', async () => {
    try {
      await fetch('/api/speaker/enroll', { method: 'DELETE' });
      showToast({ type: 'success', title: t('common.delete'), message: t('settings.enrollmentDeleted') });
      await renderSpeaker(el);
    } catch (err) {
      showToast({ type: 'error', title: t('common.error'), message: err.message });
    }
  });

  // Calibration system using shared CalibrationSession
  const calibrationBtn = document.getElementById('calibrationStartBtn');
  if (!calibrationBtn || status.enrolled) return;

  // Import and create calibration session
  const { CalibrationSession } = await import('../calibration-core.js');
  const calibrationSession = new CalibrationSession({
    btnId: 'calibrationStartBtn',
    statusId: 'calibrationStatus',
    counterId: 'calibrationCounter',
    attemptsId: 'calibrationAttempts',
    samplePrefix: 'calSample',
    monitorId: 'calibrationMonitor',
    onComplete: async () => {
      showToast({ type: 'success', title: t('common.success'), message: t('settings.calibrationComplete') });
      await renderSpeaker(el);
    }
  });

  // Wire up button
  calibrationBtn.addEventListener('click', () => calibrationSession.start(t));
}

async function enrollSamples(samples, el) {
  try {
    const formData = new FormData();
    samples.forEach((blob, i) => formData.append('samples', blob, `sample_${i}.wav`));
    const res = await fetch('/api/speaker/enroll', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(await res.text());
    showToast({ type: 'success', title: t('settings.enrolled'), message: t('settings.profileRecorded') });
    await renderSpeaker(el);
  } catch (err) {
    showToast({ type: 'error', title: t('common.error'), message: err.message });
    document.getElementById('speakerEnrollStatus').textContent = `${t('common.error')} — ${t('common.retry')}`;
    document.getElementById('speakerRecordBtn').disabled = false;
    document.getElementById('speakerRecordBtn').textContent = t('common.retry');
  }
}

function float32ToWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// ═══════════════════════════════════════════
// Provider labels (shared by Usage tab)
// ═══════════════════════════════════════════

const PROVIDER_LABELS = {
  openai: { name: 'OpenAI', envKey: 'OPENAI_API_KEY', color: 'var(--accent-green)', placeholder: 'sk-proj-...' },
  anthropic: { name: 'Anthropic', envKey: 'ANTHROPIC_API_KEY', color: 'var(--accent-purple)', placeholder: 'sk-ant-...' },
  google: { name: 'Google AI', envKey: 'GOOGLE_API_KEY', color: 'var(--accent-blue)', placeholder: 'AIza...' },
  groq: { name: 'Groq', envKey: 'GROQ_API_KEY', color: 'var(--accent-orange)', placeholder: 'gsk_...' },
  ollama: { name: 'Ollama', envKey: '—', color: 'var(--accent-cyan)', placeholder: '' },
  mistral: { name: 'Mistral', envKey: 'MISTRAL_API_KEY', color: 'var(--accent-yellow)', placeholder: '...' },
  openrouter: { name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', color: 'var(--accent-red)', placeholder: 'sk-or-...' },
};

// ═══════════════════════════════════════════
// Folder Browser (shared)
// ═══════════════════════════════════════════

async function settingsFolderBrowse(startPath) {
  const container = document.getElementById('cfgFolderBrowser');
  if (!container) return;

  async function loadDir(dirPath) {
    container.style.opacity = '0.5';
    container.style.pointerEvents = 'none';
    try {
      const resp = await fetch(`/api/workspace/browse?path=${encodeURIComponent(dirPath)}`);
      const data = await resp.json();
      if (!resp.ok) { container.innerHTML = `<div style="color:var(--accent-red);padding:12px">${esc(data.error)}</div>`; return; }

      const input = document.getElementById('cfgSandboxRoot');
      if (input) input.value = data.path;

      const parts = data.path.split('/').filter(Boolean);

      // Compact breadcrumb
      let breadcrumb = '<div style="display:flex;align-items:center;gap:2px;padding:0 4px 10px;font-size:0.8rem;border-bottom:1px solid var(--border);margin-bottom:8px">';
      const crumbs = [{ label: '~', path: '~' }];
      for (let i = 0; i < parts.length; i++) crumbs.push({ label: parts[i], path: '/' + parts.slice(0, i + 1).join('/') });
      const showFrom = Math.max(0, crumbs.length - 4);
      if (showFrom > 0) breadcrumb += `<span style="color:var(--text-muted);padding:2px 4px">...</span><span style="color:var(--text-muted)">/</span>`;
      for (let i = showFrom; i < crumbs.length; i++) {
        if (i > showFrom) breadcrumb += `<span style="color:var(--text-muted);opacity:0.4">/</span>`;
        const isLast = i === crumbs.length - 1;
        breadcrumb += `<span class="fb-crumb" data-path="${esc(crumbs[i].path)}" style="cursor:pointer;padding:2px 6px;border-radius:4px;${isLast ? 'color:var(--text);font-weight:600' : 'color:var(--accent-blue)'};transition:background 0.15s">${esc(crumbs[i].label)}</span>`;
      }
      breadcrumb += '</div>';

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
      if (data.dirs.length === 0) list += '<div style="padding:12px;color:var(--text-muted);font-size:0.85rem;text-align:center">No subfolders</div>';
      list += '</div>';

      const footer = `<div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:8px">
        <span style="font-size:0.78rem;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1" title="${esc(data.path)}">${esc(data.path)}</span>
        <button class="btn btn-primary btn-sm fb-select" type="button" style="font-size:0.82rem;padding:5px 16px;white-space:nowrap;border-radius:6px">Select</button>
      </div>`;

      container.innerHTML = breadcrumb + list + footer;

      container.querySelectorAll('.fb-item, .fb-crumb').forEach(el => {
        el.addEventListener('click', () => loadDir(el.dataset.path));
        el.addEventListener('mouseenter', () => { el.style.background = 'var(--bg-hover, rgba(255,255,255,0.06))'; });
        el.addEventListener('mouseleave', () => { el.style.background = ''; });
      });

      container.querySelector('.fb-select')?.addEventListener('click', () => { container.style.display = 'none'; });
    } catch (err) {
      container.innerHTML = `<div style="color:var(--accent-red);padding:12px">${esc(err.message)}</div>`;
    } finally {
      container.style.opacity = '1';
      container.style.pointerEvents = '';
    }
  }

  await loadDir(startPath);
}

// ═══════════════════════════════════════════
// Projects Tab
// ═══════════════════════════════════════════

async function renderProjects(el) {
  const config = await api.config.getAll();
  const projects = config.projects || {};
  const sandboxRoot = projects.sandboxRoot || '';
  const cleanOnArchive = projects.cleanOnArchive || false;

  el.innerHTML = `
    <div class="settings-sections">
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2 5h14v10H2z"/><path d="M2 5l2-3h6l2 3"/></svg>
          <h3>${t('settings.projectSandbox')}</h3>
        </div>

        <div class="settings-grid">
          <div class="form-group">
            <label class="form-label">${t('settings.rootFolder')}</label>
            <div style="display:flex;gap:8px;align-items:center">
              <input class="input" type="text" id="cfgSandboxRoot" value="${esc(sandboxRoot)}" placeholder="~/Documents/Yabby Workspace" style="flex:1" />
              <button class="btn btn-secondary btn-sm" id="cfgBrowseFolder" type="button" style="white-space:nowrap">Browse...</button>
            </div>
            <div id="cfgFolderBrowser" style="display:none;border:1px solid var(--border);border-radius:8px;padding:12px;margin-top:8px;max-height:280px;overflow-y:auto;background:var(--bg-secondary)"></div>
            <span class="form-hint">${t('settings.rootFolderHint')}</span>
          </div>

          <div class="form-group">
            <label class="toggle">
              <input type="checkbox" id="cfgCleanOnArchive" ${cleanOnArchive ? 'checked' : ''} />
              <span class="toggle-track"></span>
              ${t('settings.cleanOnArchive')}
            </label>
            <span class="form-hint">${t('settings.cleanOnArchiveHint')}</span>
          </div>
        </div>

        <div style="display: flex; gap: 8px; align-items: center;">
          <button class="btn btn-primary btn-sm settings-save" id="saveProjects">${t('common.save')}</button>
          <button class="btn btn-secondary btn-sm" id="openWorkspace" type="button">${t('settings.workspaceOpenFinder')}</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById('cfgBrowseFolder')?.addEventListener('click', () => {
    const browser = document.getElementById('cfgFolderBrowser');
    if (browser.style.display === 'none') {
      browser.style.display = '';
      const startPath = document.getElementById('cfgSandboxRoot').value.trim() || '~/Documents';
      settingsFolderBrowse(startPath);
    } else {
      browser.style.display = 'none';
    }
  });

  document.getElementById('openWorkspace')?.addEventListener('click', async () => {
    try {
      await fetch('/api/workspace/open', { method: 'POST' });
    } catch (err) {
      console.error('[SETTINGS] Failed to open workspace:', err);
    }
  });

  document.getElementById('saveProjects')?.addEventListener('click', async () => {
    await saveConfig('projects', {
      sandboxRoot: document.getElementById('cfgSandboxRoot').value.trim() || undefined,
      cleanOnArchive: document.getElementById('cfgCleanOnArchive').checked,
    });
  });
}

// ═══════════════════════════════════════════
// Auth Tab
// ═══════════════════════════════════════════

async function renderAuth(el) {
  const config = await api.config.getAll();
  const auth = config.auth || {};

  el.innerHTML = `
    <div class="settings-sections">
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="4" y="8" width="10" height="8" rx="1.5"/><path d="M6 8V6a3 3 0 016 0v2"/><circle cx="9" cy="12" r="1"/></svg>
          <h3>${t('settings.auth')}</h3>
        </div>

        <div class="settings-grid">
          <div class="form-group">
            <label class="toggle">
              <input type="checkbox" id="cfgAuthEnabled" ${auth.enabled ? 'checked' : ''} />
              <span class="toggle-track"></span>
              ${t('settings.enableAuth')}
            </label>
            <span class="form-hint">${t('settings.enableAuthHint')}</span>
          </div>

          <div class="form-group">
            <label class="form-label">${t('settings.gatewayPassword')}</label>
            <input class="input" type="password" id="cfgAuthPassword" value="${esc(auth.gatewayPassword || '')}" placeholder="${t('settings.enterPassword')}" />
            <span class="form-hint">${t('settings.passwordHint')}</span>
          </div>

          <div class="form-group">
            <label class="form-label">${t('settings.sessionDuration')}</label>
            <input class="input" type="number" id="cfgAuthTTL" value="${auth.sessionTtlDays || 7}" min="1" max="365" />
          </div>
        </div>

        <button class="btn btn-primary btn-sm settings-save" id="saveAuth">${t('common.save')}</button>
      </div>

      <!-- API Tokens -->
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 2L2 6v6l7 4 7-4V6L9 2z"/><path d="M2 6l7 4 7-4"/><path d="M9 10v6"/></svg>
          <h3>${t('settings.apiTokens')}</h3>
        </div>
        <p class="form-hint" style="margin-bottom: var(--space-md)">${t('settings.apiTokensDesc')}</p>
        <div class="form-row" style="align-items:flex-end;margin-bottom:var(--space-md)">
          <div class="form-group" style="flex:2">
            <label class="form-label">${t('settings.tokenName')}</label>
            <input class="input" id="newTokenName" placeholder="telegram-bot" />
          </div>
          <button class="btn btn-primary btn-sm" id="createTokenBtn">${t('settings.createToken')}</button>
        </div>
        <div id="tokenResult" style="display:none" class="settings-token-result"></div>
      </div>
    </div>
  `;

  document.getElementById('saveAuth')?.addEventListener('click', async () => {
    await saveConfig('auth', {
      enabled: document.getElementById('cfgAuthEnabled').checked,
      gatewayPassword: document.getElementById('cfgAuthPassword').value || null,
      sessionTtlDays: parseInt(document.getElementById('cfgAuthTTL').value) || 7,
    });
  });

  document.getElementById('createTokenBtn')?.addEventListener('click', async () => {
    const name = document.getElementById('newTokenName').value.trim();
    if (!name) {
      showToast({ type: 'error', title: t('common.error'), message: t('settings.tokenNameRequired') });
      return;
    }

    const resultEl = document.getElementById('tokenResult');
    try {
      const res = await api.auth.createToken(name);
      resultEl.style.display = 'block';
      resultEl.innerHTML = `
        <div class="settings-token-show">
          <span class="form-label">${t('settings.tokenCreatedCopy')}</span>
          <code class="settings-token-value">${esc(res.token)}</code>
        </div>
      `;
      document.getElementById('newTokenName').value = '';
      showToast({ type: 'success', title: t('settings.tokenCreated'), message: name });
    } catch (err) {
      resultEl.style.display = 'block';
      resultEl.innerHTML = `<span style="color:var(--accent-red)">${esc(err.message)}</span>`;
    }
  });
}

// ═══════════════════════════════════════════
// Usage Tab
// ═══════════════════════════════════════════

async function renderUsage(el) {
  const usage = await api.providers.usage();

  el.innerHTML = `
    <div class="settings-sections">
      <!-- Cost summary -->
      <div class="settings-section">
        <div class="settings-section-header">
          <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="9" cy="9" r="7"/><path d="M9 5v8M6.5 7h5a1.5 1.5 0 010 3H7"/></svg>
          <h3>${t('settings.costs30Days')}</h3>
        </div>
        <div class="usage-total">
          <span class="usage-total-value">$${parseFloat(usage.total_cost || 0).toFixed(4)}</span>
          <span class="usage-total-label">${t('settings.totalCost')}</span>
        </div>
      </div>

      <!-- By provider -->
      <div class="settings-section">
        <div class="settings-section-header">
          <h3>${t('settings.byProvider')}</h3>
        </div>
        ${(usage.by_provider || []).length === 0 ? `<p class="text-muted">${t('settings.noData')}</p>` : `
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>${t('settings.provider')}</th>
                <th>${t('settings.calls')}</th>
                <th>${t('settings.inputTokens')}</th>
                <th>${t('settings.outputTokens')}</th>
                <th>${t('settings.cost')}</th>
              </tr>
            </thead>
            <tbody>
              ${(usage.by_provider || []).map(p => `
                <tr>
                  <td><span class="provider-dot" style="background:${(PROVIDER_LABELS[p.provider] || {}).color || 'var(--text-muted)'}"></span>${esc(p.provider)}</td>
                  <td>${p.calls}</td>
                  <td>${Number(p.total_input || 0).toLocaleString()}</td>
                  <td>${Number(p.total_output || 0).toLocaleString()}</td>
                  <td>$${parseFloat(p.total_cost || 0).toFixed(4)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        `}
      </div>

      <!-- By day -->
      <div class="settings-section">
        <div class="settings-section-header">
          <h3>${t('settings.byDay')}</h3>
        </div>
        ${(usage.by_day || []).length === 0 ? `<p class="text-muted">${t('settings.noData')}</p>` : `
        <div class="usage-chart" id="usageChart">
          ${renderUsageChart(usage.by_day)}
        </div>
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>${t('common.date')}</th>
                <th>${t('settings.provider')}</th>
                <th>${t('settings.calls')}</th>
                <th>Tokens</th>
                <th>${t('settings.cost')}</th>
              </tr>
            </thead>
            <tbody>
              ${(usage.by_day || []).slice(0, 30).map(d => `
                <tr>
                  <td>${new Date(d.day).toLocaleDateString('fr-FR', { month: 'short', day: 'numeric' })}</td>
                  <td>${esc(d.provider)}</td>
                  <td>${d.calls}</td>
                  <td>${Number(d.input_tokens || 0).toLocaleString()} / ${Number(d.output_tokens || 0).toLocaleString()}</td>
                  <td>$${parseFloat(d.cost || 0).toFixed(4)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        `}
      </div>
    </div>
  `;
}

function renderUsageChart(byDay) {
  if (!byDay || byDay.length === 0) return '';

  // Aggregate cost per day
  const dayMap = {};
  for (const d of byDay) {
    const key = new Date(d.day).toLocaleDateString('fr-FR', { month: 'short', day: 'numeric' });
    dayMap[key] = (dayMap[key] || 0) + parseFloat(d.cost || 0);
  }

  const entries = Object.entries(dayMap);
  const maxCost = Math.max(...entries.map(([, v]) => v), 0.0001);

  return `<div class="usage-bars">${entries.map(([day, cost]) => {
    const pct = Math.max((cost / maxCost) * 100, 2);
    return `<div class="usage-bar-group">
      <div class="usage-bar" style="height:${pct}%"></div>
      <span class="usage-bar-label">${day}</span>
    </div>`;
  }).join('')}</div>`;
}
