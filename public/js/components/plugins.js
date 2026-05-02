/* ═══════════════════════════════════════════════════════
   YABBY — Plugins View
   ═══════════════════════════════════════════════════════ */

import { api } from '../api.js';
import { esc, statusBadgeClass, statusLabel } from '../utils.js';
import { showToast } from './toast.js';
import { t } from '../i18n.js';

export async function render(container) {
  container.innerHTML = `
    <div class="settings">
      <div class="settings-header">
        <h2 class="settings-title">${t('plugins.title')}</h2>
      </div>
      <div id="pluginsContent" class="settings-content">
        <div class="settings-loading">${t('common.loading')}</div>
      </div>
    </div>
  `;

  await loadPlugins();

  async function loadPlugins() {
    const el = document.getElementById('pluginsContent');
    if (!el) return;

    try {
      const data = await api.plugins.list();
      const plugins = data.plugins || [];
      const tools = data.tools || {};

      el.innerHTML = `
        <div class="settings-sections">
          <!-- Tool summary -->
          <div class="settings-section">
            <div class="settings-section-header">
              <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 2v14M2 9h14"/></svg>
              <h3>${t('plugins.registeredTools')}</h3>
            </div>
            <div class="stats-row">
              <div class="stat-card"><span class="stat-value">${tools.base || 0}</span><span class="stat-label">${t('plugins.base')}</span></div>
              <div class="stat-card"><span class="stat-value">${tools.plugin || 0}</span><span class="stat-label">${t('plugins.pluginTools')}</span></div>
              <div class="stat-card"><span class="stat-value">${tools.mcp || 0}</span><span class="stat-label">${t('plugins.mcpTools')}</span></div>
              <div class="stat-card stat-card-accent"><span class="stat-value">${tools.total || 0}</span><span class="stat-label">${t('plugins.total')}</span></div>
            </div>
          </div>

          <!-- Plugins list -->
          <div class="settings-section">
            <div class="settings-section-header">
              <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="3" width="12" height="12" rx="2"/><path d="M7 3v-2M11 3v-2M7 15v2M11 15v2M3 7h-2M3 11h-2M15 7h2M15 11h2"/></svg>
              <h3>${t('plugins.pluginsCount')} (${plugins.length})</h3>
            </div>
            ${plugins.length === 0 ? `
              <div class="empty-hint">
                <p>${t('plugins.noPlugins')}</p>
                <p class="text-muted">${t('plugins.pluginHint')}</p>
              </div>
            ` : `
              <div class="provider-grid">
                ${plugins.map(p => `
                  <div class="provider-card ${p.status === 'active' ? 'provider-enabled' : ''}">
                    <div class="provider-card-top">
                      <div class="provider-indicator" style="background: var(--status-${p.status === 'active' ? 'done' : p.status === 'error' ? 'error' : 'idle'})"></div>
                      <div class="provider-info">
                        <span class="provider-name">${esc(p.name)}</span>
                        <span class="provider-env">v${esc(p.version)} ${p.description ? '· ' + esc(p.description) : ''}</span>
                      </div>
                      <span class="badge ${statusBadgeClass(p.status)}">${statusLabel(p.status)}</span>
                    </div>
                    ${p.error ? `<div class="provider-hint" style="color:var(--accent-red)">${esc(p.error)}</div>` : ''}
                    <div class="provider-actions">
                      ${p.status === 'active'
                        ? `<button class="btn btn-sm" data-disable="${esc(p.name)}">${t('plugins.disable')}</button>`
                        : `<button class="btn btn-sm btn-primary" data-enable="${esc(p.name)}">${t('plugins.enable')}</button>`
                      }
                    </div>
                  </div>
                `).join('')}
              </div>
            `}
          </div>
        </div>
      `;

      // Enable/disable handlers
      el.querySelectorAll('[data-enable]').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api.plugins.enable(btn.dataset.enable);
            showToast({ type: 'success', title: t('plugins.activated'), message: btn.dataset.enable });
            await loadPlugins();
          } catch (err) {
            showToast({ type: 'error', title: t('common.error'), message: err.message });
            btn.disabled = false;
          }
        });
      });

      el.querySelectorAll('[data-disable]').forEach(btn => {
        btn.addEventListener('click', async () => {
          btn.disabled = true;
          try {
            await api.plugins.disable(btn.dataset.disable);
            showToast({ type: 'success', title: t('plugins.deactivated'), message: btn.dataset.disable });
            await loadPlugins();
          } catch (err) {
            showToast({ type: 'error', title: t('common.error'), message: err.message });
            btn.disabled = false;
          }
        });
      });

    } catch (err) {
      el.innerHTML = `<div class="settings-error">${t('common.error')}: ${esc(err.message)}</div>`;
    }
  }
}
