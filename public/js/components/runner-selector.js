/* ═══════════════════════════════════════════════════════
   YABBY — Runner Selector (shared between Onboarding + Settings)
   ═══════════════════════════════════════════════════════
   Exports the runner-card grid + API-key-per-runner section used
   by both the onboarding flow and the /settings page. Keep this
   module in sync — Onboarding and Settings MUST show the exact
   same UX for picking a CLI runner and configuring its LLM key.
*/

import { api } from '../api.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

export const RUNNERS_NEEDING_LLM_KEY = new Set(['aider', 'goose', 'cline', 'continue']);

export const API_KEY_PROVIDERS = [
  { id: 'openai',     name: 'OpenAI',     required: true,  placeholder: 'sk-proj-...' },
  { id: 'anthropic',  name: 'Anthropic',  required: false, placeholder: 'sk-ant-...' },
  { id: 'groq',       name: 'Groq',       required: false, placeholder: 'gsk_...' },
  { id: 'mistral',    name: 'Mistral',    required: false, placeholder: '...' },
  { id: 'google',     name: 'Google AI',  required: false, placeholder: 'AIza...' },
  { id: 'openrouter', name: 'OpenRouter', required: false, placeholder: 'sk-or-...' },
];

export const RUNNER_KEY_DOCS = {
  aider: { descKey: 'onboarding.runnerDocAider', recommended: 'anthropic', keys: [
    { id: 'anthropic',  models: 'Claude Sonnet 4, Opus 4', recommended: true },
    { id: 'openai',     models: 'GPT-4o, o3, o4-mini' },
    { id: 'google',     models: 'Gemini 2.5 Pro' },
    { id: 'openrouter', modelsKey: 'onboarding.multiProvider' },
    { id: 'groq',       models: 'Llama 3, Mixtral' },
  ]},
  goose: { descKey: 'onboarding.runnerDocGoose', recommended: 'openai', keys: [
    { id: 'openai',     models: 'GPT-4o, o3', recommended: true },
    { id: 'anthropic',  models: 'Claude Sonnet 4, Opus 4' },
    { id: 'openrouter', modelsKey: 'onboarding.multiProvider' },
  ]},
  cline: { descKey: 'onboarding.runnerDocCline', recommended: 'anthropic', keys: [
    { id: 'anthropic',  models: 'Claude Sonnet 4', recommended: true },
    { id: 'openai',     models: 'GPT-4o, o3' },
    { id: 'openrouter', modelsKey: 'onboarding.multiProvider' },
    { id: 'google',     models: 'Gemini 2.5 Pro' },
    { id: 'mistral',    models: 'Mistral Large, Codestral' },
  ]},
  continue: { descKey: 'onboarding.runnerDocContinue', recommended: 'anthropic', keys: [
    { id: 'anthropic',  models: 'Claude Sonnet 4, Opus 4', recommended: true },
    { id: 'openai',     models: 'GPT-4o, o3' },
    { id: 'mistral',    models: 'Codestral' },
    { id: 'google',     models: 'Gemini 2.5 Pro' },
  ]},
};

// ── Runner grid ──────────────────────────────────────────────
export function renderRunnerGrid(runners, selectedRunner) {
  const anyFound = runners.some(r => r.found);
  return `
    ${!anyFound ? `<div class="ob-alert-warn">${t('onboarding.runnerNoneDetected')}<br><code>npm i -g @anthropic-ai/claude-code</code></div>` : ''}
    <div class="runner-grid">
      ${runners.map(r => `
        <div class="runner-card ${selectedRunner === r.id ? 'selected' : ''} ${r.found ? 'runner-found' : 'runner-missing'}" data-runner="${r.id}">
          <div class="runner-status-dot" style="background: ${r.found ? 'var(--accent-green)' : 'var(--accent-red)'}"></div>
          <span class="runner-card-name">${esc(r.name)}${r.beta ? ' <span class="runner-beta-badge">Beta</span>' : ''}</span>
          ${r.found ? `<span class="runner-card-version">${esc(r.version || '')}</span>` : `<span class="runner-card-needs">${esc(r.needs)}</span>`}
          ${!r.found ? `<span class="runner-install-hint">${esc(r.installCmd)}</span>` : ''}
        </div>
      `).join('')}
    </div>
    <p class="ob-hint" style="margin-top:var(--space-sm)">${t('onboarding.runnerBetaHint')}</p>`;
}

export function wireRunnerGrid(el, onSelect) {
  el.querySelectorAll('.runner-card').forEach(card => {
    card.addEventListener('click', () => {
      const runnerId = card.dataset.runner;
      el.querySelectorAll('.runner-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      onSelect(runnerId);
    });
  });
}

// ── OpenAI key section (always required) ────────────────────
export function renderOpenAiKeySection(apiKeysStatus) {
  const openai = API_KEY_PROVIDERS[0];
  const openaiConfigured = apiKeysStatus.openai?.configured;
  if (openaiConfigured) {
    return `
      <div class="ob-apikey-ready" id="obOpenaiReady">
        <svg viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="var(--accent-green)" stroke-width="2" style="flex-shrink:0"><circle cx="10" cy="10" r="8"/><path d="M6 10l3 3 5-5"/></svg>
        <div>
          <span class="ob-apikey-ready-text">${t('onboarding.openaiConfiguredReady')}</span>
          <span class="ob-apikey-ready-source">${apiKeysStatus.openai?.source === 'env' ? t('onboarding.openaiDetectedEnv') : t('onboarding.openaiSavedConfig')}</span>
        </div>
        <button class="btn btn-sm ob-apikey-change" data-provider="openai" type="button">${t('onboarding.modify')}</button>
      </div>
      <div class="ob-apikey-row" id="obOpenaiEditRow" style="display:none">
        <label class="ob-apikey-label">${esc(openai.name)} <span style="color:var(--accent-red)">*</span></label>
        <div class="ob-apikey-input-wrap">
          <input type="password" class="input ob-apikey-input" id="obKey_openai" placeholder="${esc(openai.placeholder)}" value="" />
          <button class="btn btn-sm ob-apikey-toggle" data-key="openai" type="button" title="${t('onboarding.showHide')}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg></button>
          <button class="btn btn-sm btn-primary ob-apikey-test" data-provider="openai" type="button">${t('onboarding.test')}</button>
        </div>
        <div class="ob-apikey-result" id="obKeyResult_openai"></div>
      </div>`;
  }
  return `
    <div class="ob-apikey-row">
      <label class="ob-apikey-label">${esc(openai.name)} <span style="color:var(--accent-red)">*</span></label>
      <div class="ob-apikey-input-wrap">
        <input type="password" class="input ob-apikey-input" id="obKey_openai" placeholder="${esc(openai.placeholder)}" value="" />
        <button class="btn btn-sm ob-apikey-toggle" data-key="openai" type="button" title="${t('onboarding.showHide')}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg></button>
        <button class="btn btn-sm btn-primary ob-apikey-test" data-provider="openai" type="button">${t('onboarding.test')}</button>
      </div>
      <div class="ob-apikey-result" id="obKeyResult_openai"></div>
    </div>`;
}

// ── Per-runner LLM key section (only for runners that need it) ──
export function renderRunnerKeySection(runnerId, runnerName, apiKeysStatus) {
  const docs = RUNNER_KEY_DOCS[runnerId];
  if (!docs) return '';
  const keyRows = docs.keys.filter(k => k.id !== 'openai').map(k => {
    const provider = API_KEY_PROVIDERS.find(p => p.id === k.id);
    if (!provider) return '';
    const isConfigured = apiKeysStatus[k.id]?.configured;
    const isRecommended = k.recommended;
    const modelsDisplay = k.modelsKey ? t(k.modelsKey) : k.models;
    return `
      <div class="ob-apikey-row ${isRecommended ? 'ob-apikey-recommended' : ''}">
        <label class="ob-apikey-label">${esc(provider.name)}${isRecommended ? ` <span class="ob-badge-recommended">${t('onboarding.recommended')}</span>` : ''} <span class="ob-apikey-note">${esc(modelsDisplay)}</span></label>
        ${isConfigured ? `<div class="ob-apikey-configured-row"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="var(--accent-green)" stroke-width="2"><path d="M3 8l4 4 6-6"/></svg><span style="color:var(--accent-green)">${t('onboarding.keyConfigured')}</span><button class="btn btn-sm ob-apikey-change" data-provider="${k.id}" type="button">${t('onboarding.modify')}</button></div>` : ''}
        <div class="ob-apikey-input-wrap" ${isConfigured ? 'style="display:none"' : ''} id="obKeyWrap_${k.id}">
          <input type="password" class="input ob-apikey-input" id="obKey_${k.id}" placeholder="${esc(provider.placeholder)}" value="" />
          <button class="btn btn-sm ob-apikey-toggle" data-key="${k.id}" type="button" title="${t('onboarding.showHide')}"><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M1 8s3-5 7-5 7 5 7 5-3 5-7 5-7-5-7-5z"/><circle cx="8" cy="8" r="2"/></svg></button>
          <button class="btn btn-sm btn-primary ob-apikey-test" data-provider="${k.id}" type="button">${t('onboarding.test')}</button>
        </div>
        <div class="ob-apikey-result" id="obKeyResult_${k.id}"></div>
      </div>`;
  }).join('');
  const recommendedIsOpenai = docs.recommended === 'openai';
  const openaiOk = apiKeysStatus?.openai?.configured;
  const recommendedConfigured = recommendedIsOpenai ? openaiOk : apiKeysStatus[docs.recommended]?.configured;
  let statusLine;
  if (recommendedConfigured) {
    const recName = API_KEY_PROVIDERS.find(p => p.id === docs.recommended)?.name || docs.recommended;
    statusLine = `<span style="color:var(--accent-green)">${t('onboarding.providerConfigured').replace('{{provider}}', esc(recName)).replace('{{runner}}', esc(runnerName))}</span>`;
  } else if (openaiOk && !recommendedIsOpenai) {
    const recName = API_KEY_PROVIDERS.find(p => p.id === docs.recommended)?.name || '';
    statusLine = `<span style="color:var(--accent-orange)">${t('onboarding.providerDefaultFallback').replace('{{runner}}', esc(runnerName)).replace('{{provider}}', esc(recName))}</span>`;
  } else if (openaiOk) {
    statusLine = `<span style="color:var(--accent-green)">${t('onboarding.providerReady').replace('{{runner}}', esc(runnerName))}</span>`;
  } else {
    statusLine = `<span style="color:var(--accent-red)">${t('onboarding.noLlmKey').replace('{{runner}}', esc(runnerName))}</span>`;
  }
  return `
    <div class="ob-runner-keys">
      <h3 class="ob-runner-keys-title"><svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" style="flex-shrink:0"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M7 10h6M10 7v6"/></svg> ${t('onboarding.llmKeyFor').replace('{{runner}}', esc(runnerName))}</h3>
      <p class="ob-hint" style="margin-bottom:var(--space-sm)">${t(docs.descKey)}</p>
      <div class="ob-runner-status" style="margin-bottom:var(--space-md)">${statusLine}</div>
      <div class="ob-apikey-others-grid">${keyRows}</div>
      <p class="ob-hint" style="margin-top:var(--space-sm);font-style:italic">${t('onboarding.modifyKeysLater')}</p>
    </div>`;
}

// ── Wire up key input handlers (toggle / change / test) ──
// onKeyValidated(provider) — optional callback fired when a key tests valid.
export function wireApiKeyListeners(el, apiKeysStatus, onKeyValidated) {
  el.querySelectorAll('.ob-apikey-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(`obKey_${btn.dataset.key}`);
      if (input) input.type = input.type === 'password' ? 'text' : 'password';
    });
  });

  el.querySelectorAll('.ob-apikey-change').forEach(btn => {
    btn.addEventListener('click', () => {
      const provider = btn.dataset.provider;
      const readyBanner = document.getElementById('obOpenaiReady');
      const editRow = document.getElementById('obOpenaiEditRow');
      if (provider === 'openai' && readyBanner && editRow) {
        readyBanner.style.display = 'none';
        editRow.style.display = '';
        editRow.querySelector('.ob-apikey-input')?.focus();
        return;
      }
      const wrap = document.getElementById(`obKeyWrap_${provider}`);
      if (wrap) { wrap.style.display = ''; wrap.querySelector('.ob-apikey-input')?.focus(); }
      const configuredRow = btn.closest('.ob-apikey-configured-row');
      if (configuredRow) configuredRow.style.display = 'none';
    });
  });

  el.querySelectorAll('.ob-apikey-test').forEach(btn => {
    btn.addEventListener('click', async () => {
      const provider = btn.dataset.provider;
      const input = document.getElementById(`obKey_${provider}`);
      const resultEl = document.getElementById(`obKeyResult_${provider}`);
      if (!input || !resultEl) return;
      const key = input.value.trim();
      if (!key) { resultEl.innerHTML = `<span style="color:var(--accent-orange)">${t('onboarding.enterKeyFirst')}</span>`; return; }
      resultEl.innerHTML = `<span class="text-muted">${t('onboarding.validating')}</span>`;
      btn.disabled = true;
      try {
        const result = await api.config.saveApiKeys({ [provider]: key });
        if (result.results?.[provider]?.valid) {
          resultEl.innerHTML = `<span style="color:var(--accent-green)">${t('onboarding.keyValid')}</span>`;
          apiKeysStatus[provider] = { configured: true, source: 'config' };
          input.disabled = true;
          if (typeof onKeyValidated === 'function') onKeyValidated(provider);
        } else {
          const err = result.results?.[provider]?.error || t('onboarding.keyInvalid');
          resultEl.innerHTML = `<span style="color:var(--accent-red)">${esc(err)}</span>`;
        }
      } catch (err) {
        resultEl.innerHTML = `<span style="color:var(--accent-red)">${t('onboarding.errorPrefix')} ${esc(err.message)}</span>`;
      }
      btn.disabled = false;
    });
  });
}

// ── Convenience: fetch runners + apiKeys status together ──
export async function loadRunnerContext() {
  const [runnersData, apiKeysStatus] = await Promise.all([
    api.tasks.runners().catch(() => ({ runners: [], current: 'claude' })),
    api.config.apiKeysStatus().catch(() => ({})),
  ]);
  return { runnersData, apiKeysStatus };
}
