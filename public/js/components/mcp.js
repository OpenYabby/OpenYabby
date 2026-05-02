/* ═══════════════════════════════════════════════════════
   YABBY — MCP Servers View
   ═══════════════════════════════════════════════════════ */

import { api } from '../api.js';
import { esc } from '../utils.js';
import { showToast } from './toast.js';
import { t } from '../i18n.js';

export async function render(container) {
  container.innerHTML = `
    <div class="settings">
      <div class="settings-header">
        <h2 class="settings-title">Serveurs MCP</h2>
      </div>
      <div id="mcpContent" class="settings-content">
        <div class="settings-loading">Chargement...</div>
      </div>
    </div>
  `;

  await loadMcp();

  async function loadMcp() {
    const el = document.getElementById('mcpContent');
    if (!el) return;

    try {
      const data = await api.mcp.servers();
      const servers = data.servers || [];

      el.innerHTML = `
        <div class="settings-sections">
          <!-- Add server form -->
          <div class="settings-section">
            <div class="settings-section-header">
              <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 2v14M2 9h14"/></svg>
              <h3>Connecter un serveur</h3>
            </div>
            <div class="settings-grid">
              <div class="form-group">
                <label class="form-label">Nom</label>
                <input class="input" id="mcpName" placeholder="filesystem" />
              </div>
              <div class="form-group">
                <label class="form-label">Commande</label>
                <input class="input" id="mcpCommand" placeholder="npx" />
              </div>
              <div class="form-group" style="grid-column: 1 / -1">
                <label class="form-label">Arguments (séparés par des espaces)</label>
                <input class="input" id="mcpArgs" placeholder="-y @modelcontextprotocol/server-filesystem /tmp" />
              </div>
            </div>
            <button class="btn btn-primary btn-sm" id="mcpConnect" style="margin-top: var(--space-md)">Connecter</button>
          </div>

          <!-- Connected servers -->
          <div class="settings-section">
            <div class="settings-section-header">
              <svg viewBox="0 0 18 18" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="4" width="14" height="5" rx="1.5"/><rect x="2" y="11" width="14" height="5" rx="1.5"/><circle cx="5" cy="6.5" r="1" fill="currentColor"/><circle cx="5" cy="13.5" r="1" fill="currentColor"/></svg>
              <h3>Serveurs connectés (${servers.length})</h3>
            </div>
            ${servers.length === 0 ? `
              <p class="text-muted">Aucun serveur MCP connecté.</p>
            ` : `
              <div class="provider-grid">
                ${servers.map(s => `
                  <div class="provider-card provider-enabled">
                    <div class="provider-card-top">
                      <div class="provider-indicator" style="background: var(--accent-green)"></div>
                      <div class="provider-info">
                        <span class="provider-name">${esc(s.name)}</span>
                        <span class="provider-env">${esc(s.command)} ${(s.args || []).join(' ')} · ${s.toolCount} outils</span>
                      </div>
                      <button class="btn btn-sm btn-icon" data-disconnect="${esc(s.name)}" title="Déconnecter">✕</button>
                    </div>
                    ${s.tools && s.tools.length > 0 ? `
                      <div class="mcp-tools-list">
                        ${s.tools.map(t => `<span class="model-tag">${esc(t.name)}</span>`).join('')}
                      </div>
                    ` : ''}
                  </div>
                `).join('')}
              </div>
            `}
          </div>
        </div>
      `;

      // Connect handler
      document.getElementById('mcpConnect')?.addEventListener('click', async () => {
        const name = document.getElementById('mcpName')?.value?.trim();
        const command = document.getElementById('mcpCommand')?.value?.trim();
        const argsStr = document.getElementById('mcpArgs')?.value?.trim();
        if (!name || !command) {
          showToast({ type: 'error', title: t('common.error'), message: t('mcp.nameCommandRequired') || 'Name and command required' });
          return;
        }
        const args = argsStr ? argsStr.split(/\s+/) : [];
        try {
          await api.mcp.connect({ name, command, args });
          showToast({ type: 'success', title: t('status.connected'), message: name });
          await loadMcp();
        } catch (err) {
          showToast({ type: 'error', title: 'Erreur', message: err.message });
        }
      });

      // Disconnect handlers
      el.querySelectorAll('[data-disconnect]').forEach(btn => {
        btn.addEventListener('click', async () => {
          try {
            await api.mcp.disconnect(btn.dataset.disconnect);
            showToast({ type: 'success', title: t('status.disconnected'), message: btn.dataset.disconnect });
            await loadMcp();
          } catch (err) {
            showToast({ type: 'error', title: t('common.error'), message: err.message });
          }
        });
      });

    } catch (err) {
      el.innerHTML = `<div class="settings-error">Erreur: ${esc(err.message)}</div>`;
    }
  }
}
