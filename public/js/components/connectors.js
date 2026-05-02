/* ═══════════════════════════════════════════════════════
   YABBY — Connectors & MCP (Unified)
   ═══════════════════════════════════════════════════════
   Single page for all integrations: catalog connectors
   (built-in + MCP backed) and custom MCP servers.
*/

import { api } from '../api.js';
import { openModal, closeModal } from './modal.js';
import { showToast } from './toast.js';
import { t } from '../i18n.js';

let container = null;

export async function render(el) {
  container = el;
  container.innerHTML = `<div class="connectors-loading">${t('common.loading')}</div>`;
  await refresh();
  return () => { container = null; };
}

async function refresh() {
  if (!container) return;

  const [connectors, catalogData, requests, mcpData, baseToolsData] = await Promise.all([
    api.connectors.list().catch(() => []),
    api.connectors.catalog().catch(() => ({ catalog: [], byCategory: {} })),
    api.connectors.requests().catch(() => []),
    api.mcp.servers().catch(() => ({ servers: [] })),
    fetch('/api/tools/list?category=base&format=summary').then(r => r.json()).catch(() => ({ count: 0 })),
  ]);

  const allMcpServers = mcpData.servers || mcpData || [];
  const catalog = catalogData.catalog || [];

  // Filter out MCP servers that belong to catalog connectors (they show as connector cards)
  const connectorMcpPrefixes = connectors.map(c => `connector_${c.catalogId}_`);
  const mcpServers = allMcpServers.filter(s =>
    !connectorMcpPrefixes.some(prefix => s.name?.startsWith(prefix))
  );

  // Separate connected from disconnected/error
  const connected = connectors.filter(c => c.status === 'connected');
  const other = connectors.filter(c => c.status !== 'connected');

  // Total tool count across base (Yabby MCP) + connectors + external MCP servers
  const baseToolCount = baseToolsData.count || 0;
  const connectorToolCount = connected.reduce((s, c) => s + (c.toolCount || c.tools?.length || 0), 0);
  const mcpToolCount = mcpServers.reduce((s, m) => s + (m.toolCount || m.tools?.length || 0), 0);
  const totalTools = baseToolCount + connectorToolCount + mcpToolCount;

  container.innerHTML = `
    <div class="connectors-page">
      <div class="connectors-header">
        <div>
          <h2 class="connectors-title">${t('connectors.title')}</h2>
          <p class="connectors-subtitle">${t('connectors.subtitle')}</p>
        </div>
        <button class="btn btn-primary" id="addConnectorBtn">${t('connectors.addConnector')}</button>
      </div>

      <!-- ═══ Native MCP / System Status ═══ -->
      <div class="conn-native-card">
        <div class="conn-native-header">
          <div class="conn-native-icon">
            <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><circle cx="6" cy="7" r="1" fill="currentColor"/><circle cx="6" cy="17" r="1" fill="currentColor"/><path d="M10 7h6"/><path d="M10 17h6"/></svg>
          </div>
          <div class="conn-native-info">
            <div class="conn-native-name">Yabby MCP Server</div>
            <div class="conn-native-desc">${t('connectors.builtInMcp')}</div>
          </div>
          <span class="badge badge-done">${t('status.connected')}</span>
        </div>
        <div class="conn-native-stats">
          <div class="conn-native-stat">
            <span class="conn-native-stat-value">${totalTools}</span>
            <span class="conn-native-stat-label">${t('connectors.toolsAvailable')}</span>
          </div>
          <div class="conn-native-stat">
            <span class="conn-native-stat-value">${connected.length}</span>
            <span class="conn-native-stat-label">${t('connectors.activeConnectors')}</span>
          </div>
          <div class="conn-native-stat">
            <span class="conn-native-stat-value">${mcpServers.length}</span>
            <span class="conn-native-stat-label">serveurs MCP</span>
          </div>
        </div>
      </div>

      <!-- ═══ Active Connectors ═══ -->
      ${connected.length > 0 || other.length > 0 ? `
      <div class="connectors-section">
        <h3 class="connectors-section-title">
          <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M9 2v4M9 12v4M2 9h4M12 9h4"/><circle cx="9" cy="9" r="3"/></svg>
          Connecteurs catalog (${connected.length + other.length})
        </h3>
        <div class="conn-cards-grid">
          ${connected.map(c => renderConnectedCard(c, catalog)).join('')}
          ${other.map(c => renderConnectedCard(c, catalog)).join('')}
        </div>
      </div>
      ` : ''}

      <!-- ═══ Custom MCP Servers ═══ -->
      <div class="connectors-section">
        <h3 class="connectors-section-title">
          <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="14" height="5" rx="1.5"/><rect x="2" y="11" width="14" height="5" rx="1.5"/><circle cx="5" cy="6.5" r="1" fill="currentColor"/><circle cx="5" cy="13.5" r="1" fill="currentColor"/></svg>
          Serveurs MCP additionnels${mcpServers.length > 0 ? ` (${mcpServers.length})` : ''}
        </h3>

        ${mcpServers.length > 0 ? `
          <div class="conn-cards-grid" style="margin-bottom: var(--space-lg)">
            ${mcpServers.map(s => renderMcpServerCard(s)).join('')}
          </div>
        ` : ''}

        <p class="conn-section-hint">${t('connectors.mcpHelp')}</p>
        <div class="conn-mcp-form">
          <div class="form-group">
            <label class="form-label" for="mcpName">${t('common.name')}</label>
            <input class="input" id="mcpName" placeholder="ex: filesystem" />
          </div>
          <div class="form-group">
            <label class="form-label" for="mcpCmd">${t('connectors.command')}</label>
            <input class="input" id="mcpCmd" placeholder="ex: npx" />
          </div>
          <div class="form-group" style="flex:2">
            <label class="form-label" for="mcpArgs">${t('connectors.arguments')}</label>
            <input class="input" id="mcpArgs" placeholder="ex: -y @modelcontextprotocol/server-filesystem /tmp" />
          </div>
          <button class="btn btn-primary" id="mcpConnectBtn">${t('common.connect')}</button>
        </div>
        <p class="conn-section-hint" style="margin-top: var(--space-sm)">
          ${t('connectors.persistentMcpHelp')}
        </p>
      </div>

      <!-- ═══ Agent Requests ═══ -->
      ${requests.length > 0 ? `
      <div class="connectors-section">
        <h3 class="connectors-section-title">
          <span class="conn-dot conn-dot-orange"></span>
          ${t('connectors.agentRequests')} (${requests.length})
        </h3>
        <div class="conn-requests">
          ${requests.map(r => renderRequest(r, catalog)).join('')}
        </div>
      </div>
      ` : ''}

      <!-- ═══ How it works (collapsible) ═══ -->
      <div class="connectors-section">
        <h3 class="connectors-section-title conn-guide-toggle" id="guideToggle" style="cursor:pointer; user-select:none">
          <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="9" r="7"/><path d="M7 7.5a2 2 0 1 1 2.5 1.94V10.5"/><circle cx="9" cy="13" r="0.5" fill="currentColor"/></svg>
          ${t('connectors.howItWorks')}
          <span class="conn-guide-arrow" id="guideArrow" style="margin-left:auto; font-size:0.75rem; transition:transform 0.2s">\u25B6</span>
        </h3>
        <div class="conn-guide-content" id="guideContent" style="display:none">
          <p class="conn-section-hint">${t('connectors.howItWorksDesc')}</p>
          <div class="conn-guide-grid">
            <div class="conn-guide-card">
              <h4 class="conn-guide-card-title">\uD83D\uDD17 ${t('connectors.scopingTitle')}</h4>
              <p>${t('connectors.scopingDesc')}</p>
            </div>
            <div class="conn-guide-card">
              <h4 class="conn-guide-card-title">\uD83E\uDD16 ${t('connectors.requestFlowTitle')}</h4>
              <p>${t('connectors.requestFlowDesc')}</p>
            </div>
          </div>
          <div class="conn-guide-card" style="margin-top:var(--space-md)">
            <h4 class="conn-guide-card-title">\uD83D\uDC19 ${t('connectors.exampleTitle')}</h4>
            <div class="conn-guide-steps">
              <p>${t('connectors.exampleStep1')}</p>
              <p>${t('connectors.exampleStep2')}</p>
              <p>${t('connectors.exampleStep3')}</p>
              <p>${t('connectors.exampleStep4')}</p>
            </div>
          </div>
          <div class="conn-guide-card" style="margin-top:var(--space-md)">
            <h4 class="conn-guide-card-title">\uD83C\uDFF7\uFE0F ${t('connectors.toolNamingTitle')}</h4>
            <p>${t('connectors.toolNamingBuiltin')}</p>
            <p>${t('connectors.toolNamingMcp')}</p>
          </div>
        </div>
      </div>
    </div>
  `;

  wireEvents(connectors, catalog);

  // Guide toggle
  container.querySelector('#guideToggle')?.addEventListener('click', () => {
    const content = container.querySelector('#guideContent');
    const arrow = container.querySelector('#guideArrow');
    if (content) {
      const open = content.style.display !== 'none';
      content.style.display = open ? 'none' : 'block';
      if (arrow) arrow.style.transform = open ? '' : 'rotate(90deg)';
    }
  });
}

/* ── Card renderers ── */

function renderConnectedCard(conn, catalog) {
  const cat = catalog.find(c => c.id === conn.catalogId);
  const icon = cat?.icon || '\uD83D\uDD0C';
  const statusClass = conn.status === 'connected' ? 'conn-dot-green'
    : conn.status === 'error' ? 'conn-dot-red' : 'conn-dot-gray';
  const sLabel = conn.status === 'connected' ? t('status.connected')
    : conn.status === 'error' ? t('common.error').toLowerCase() : t('status.disconnected');
  const tools = conn.tools || [];
  const toolCount = conn.toolCount || tools.length || 0;

  // Clean tool names: strip mcp_connector_{catalogId}_{hash}_ or conn_{catalogId}_ prefix
  const cleanTools = tools.map(name => {
    return name
      .replace(/^mcp_connector_[^_]+_[^_]+_/, '')
      .replace(/^conn_[^_]+_/, '')
      .replace(/_/g, ' ');
  });

  return `
    <div class="conn-card ${conn.status === 'connected' ? 'conn-card-active' : conn.status === 'error' ? 'conn-card-error' : ''}">
      <div class="conn-card-header">
        <div class="conn-icon">${icon}</div>
        <div class="conn-card-info">
          <span class="conn-card-name">${esc(conn.label)}</span>
          <span class="conn-card-meta">
            <span class="conn-dot ${statusClass}"></span> ${sLabel}
            <span class="conn-card-sep">\u00B7</span>
            <span class="conn-card-backend">${esc(conn.backend)}</span>
            ${conn.status === 'connected' && toolCount > 0 ? `
              <span class="conn-card-sep">\u00B7</span>
              <span style="color:var(--accent-green)">${toolCount} ${toolCount !== 1 ? t('connectors.tools') : t('connectors.tool')}</span>
            ` : ''}
          </span>
        </div>
      </div>
      ${conn.errorMessage ? `<div class="conn-error">${esc(conn.errorMessage)}</div>` : ''}
      ${cleanTools.length > 0 ? `
        <div class="conn-tools-list">
          ${cleanTools.map(tl => `<span class="conn-tool-tag">${esc(tl)}</span>`).join('')}
        </div>
      ` : ''}
      <div class="conn-card-actions">
        ${conn.status === 'connected'
          ? `<button class="btn btn-sm" data-conn-disconnect="${conn.id}">${t('common.disconnect')}</button>`
          : `<button class="btn btn-sm btn-primary" data-conn-connect="${conn.id}">${t('common.connect')}</button>`
        }
        <button class="btn btn-sm btn-icon" data-conn-delete="${conn.id}" title="${t('common.delete')}">\u2715</button>
      </div>
    </div>
  `;
}

function renderMcpServerCard(server) {
  const toolCount = server.toolCount || server.tools?.length || 0;
  return `
    <div class="conn-card conn-card-active conn-card-mcp">
      <div class="conn-card-header">
        <div class="conn-icon">
          <svg viewBox="0 0 18 18" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="4" width="14" height="5" rx="1.5"/><rect x="2" y="11" width="14" height="5" rx="1.5"/><circle cx="5" cy="6.5" r="1" fill="currentColor"/><circle cx="5" cy="13.5" r="1" fill="currentColor"/></svg>
        </div>
        <div class="conn-card-info">
          <span class="conn-card-name">${esc(server.name)}</span>
          <span class="conn-card-meta">
            <span class="conn-dot conn-dot-green"></span> ${t('status.connected')}
            <span class="conn-card-sep">\u00B7</span>
            ${toolCount} ${toolCount !== 1 ? t('connectors.tools') : t('connectors.tool')}
          </span>
        </div>
      </div>
      ${server.tools?.length ? `
        <div class="conn-tools-list">
          ${server.tools.map(tl => `<span class="conn-tool-tag">${esc(tl.name)}</span>`).join('')}
        </div>
      ` : ''}
      <div class="conn-card-actions">
        <span class="conn-card-cmd">${esc(server.command)} ${esc((server.args || []).join(' '))}</span>
        <button class="btn btn-sm btn-icon" data-mcp-disconnect="${esc(server.name)}" title="${t('common.disconnect')}">\u2715</button>
      </div>
    </div>
  `;
}

function renderRequest(req, catalog) {
  const cat = catalog.find(c => c.id === req.catalogId);
  return `
    <div class="conn-request-card">
      <div class="conn-request-info">
        <strong>${esc(cat?.name || req.catalogId)}</strong> ${cat?.icon || ''}
        <span class="conn-request-reason">\u2014 ${esc(req.reason)}</span>
      </div>
      <div class="conn-request-actions">
        <button class="btn btn-sm btn-primary" data-req-approve="${req.id}">${t('connectors.approve')}</button>
        <button class="btn btn-sm" data-req-reject="${req.id}">${t('connectors.reject')}</button>
        <button class="btn btn-sm" data-req-defer="${req.id}">${t('connectors.later')}</button>
      </div>
    </div>
  `;
}

/* ── Event wiring ── */

function wireEvents(connectors, catalog) {
  if (!container) return;

  // "+ Add connector" button → open catalog modal
  container.querySelector('#addConnectorBtn')?.addEventListener('click', () => {
    openPageCatalogModal(catalog, connectors);
  });

  // Connect / Disconnect / Delete persistent connectors
  container.querySelectorAll('[data-conn-connect]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await api.connectors.connect(btn.dataset.connConnect);
        showToast({ type: 'success', title: t('connectors.connectorStarted'), message: '' });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      refresh();
    });
  });

  container.querySelectorAll('[data-conn-disconnect]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.connectors.disconnect(btn.dataset.connDisconnect);
        showToast({ type: 'success', title: t('connectors.connectorStopped'), message: '' });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      refresh();
    });
  });

  container.querySelectorAll('[data-conn-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.connectors.remove(btn.dataset.connDelete);
        showToast({ type: 'success', title: t('connectors.removed'), message: '' });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      refresh();
    });
  });

  // MCP custom server — connect
  const mcpBtn = container.querySelector('#mcpConnectBtn');
  if (mcpBtn) {
    mcpBtn.addEventListener('click', async () => {
      const name = container.querySelector('#mcpName')?.value.trim();
      const command = container.querySelector('#mcpCmd')?.value.trim();
      const argsStr = container.querySelector('#mcpArgs')?.value.trim();
      if (!name || !command) {
        showToast({ type: 'error', title: t('common.error'), message: t('connectors.nameAndCommandRequired') });
        return;
      }
      mcpBtn.disabled = true;
      mcpBtn.textContent = '...';
      try {
        await api.mcp.connect({ name, command, args: argsStr ? argsStr.split(/\s+/) : [] });
        showToast({ type: 'success', title: t('connectors.connectorStarted'), message: name });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      refresh();
    });
  }

  // MCP disconnect (ad-hoc servers)
  container.querySelectorAll('[data-mcp-disconnect]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.mcp.disconnect(btn.dataset.mcpDisconnect);
        showToast({ type: 'success', title: t('connectors.connectorStopped'), message: btn.dataset.mcpDisconnect });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      refresh();
    });
  });

  // Agent requests
  container.querySelectorAll('[data-req-approve]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.connectors.resolveRequest(btn.dataset.reqApprove, 'approved');
        showToast({ type: 'success', title: t('connectors.approved'), message: t('connectors.requestApproved') });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      refresh();
    });
  });
  container.querySelectorAll('[data-req-reject]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.connectors.resolveRequest(btn.dataset.reqReject, 'rejected');
      } catch {}
      refresh();
    });
  });
  container.querySelectorAll('[data-req-defer]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.connectors.resolveRequest(btn.dataset.reqDefer, 'deferred');
      } catch {}
      refresh();
    });
  });
}

/* ── Catalog modal (page version) ── */

function openPageCatalogModal(catalog, connectors = []) {
  const CATEGORY_ORDER = ['tools', 'dev', 'project', 'productivity', 'design', 'data', 'search', 'communication', 'business', 'devops', 'google'];
  const CATEGORY_LABELS = {
    tools: t('connectors.categories.tools'),
    dev: t('connectors.categories.dev'),
    project: t('connectors.categories.projectMgmt'),
    productivity: t('connectors.categories.productivity'),
    design: t('connectors.categories.design'),
    data: t('connectors.categories.data'),
    search: t('connectors.categories.searchWeb'),
    communication: t('connectors.categories.communication'),
    business: t('connectors.categories.business'),
    devops: t('connectors.categories.devops'),
    google: t('connectors.categories.google'),
  };

  const installedMap = {};
  for (const c of connectors) {
    if (c.status !== 'archived') installedMap[c.catalogId] = c;
  }

  function buildGrid(filter = '') {
    const lf = filter.toLowerCase();
    let html = '';

    const quickItems = catalog.filter(c => c.quickInstall && !c.comingSoon && (!lf || c.name.toLowerCase().includes(lf) || (c.description || '').toLowerCase().includes(lf)));
    if (quickItems.length > 0) {
      html += `<div class="catalog-category"><div class="catalog-category-title">\u26A1 ${t('connectors.quickInstall')}</div><div class="catalog-items">`;
      for (const item of quickItems) html += renderCatalogItem(item, installedMap);
      html += '</div></div>';
    }

    for (const cat of CATEGORY_ORDER) {
      const items = catalog.filter(c => c.category === cat && !c.quickInstall && (!lf || c.name.toLowerCase().includes(lf) || (c.description || '').toLowerCase().includes(lf)));
      if (!items.length) continue;
      html += `<div class="catalog-category"><div class="catalog-category-title">${esc(CATEGORY_LABELS[cat] || cat)}</div><div class="catalog-items">`;
      for (const item of items) html += renderCatalogItem(item, installedMap);
      html += '</div></div>';
    }
    return html;
  }

  function renderCatalogItem(item, installed) {
    const isSoon = item.comingSoon;
    const conn = installed[item.id];
    const isInstalled = conn && (conn.status === 'connected' || conn.status === 'disconnected' || conn.status === 'error');
    const isConnected = conn?.status === 'connected';
    const showBuiltin = item.backends.includes('builtin');
    const showMcp = item.backends.includes('mcp');
    const needsAuth = item.authType !== 'none' && (item.authFields || []).length > 0;

    let actionsHtml;
    if (isSoon) {
      actionsHtml = `<span class="badge-coming-soon">${t('connectors.comingSoon')}</span>`;
    } else if (isInstalled) {
      actionsHtml = `
        <span class="qi-status ${isConnected ? 'qi-status-ok' : conn?.status === 'error' ? 'qi-status-err' : ''}" style="font-size:0.72rem">
          <span class="conn-dot ${isConnected ? 'conn-dot-green' : conn?.status === 'error' ? 'conn-dot-red' : 'conn-dot-gray'}"></span>
          ${isConnected ? t('connectors.installed') : conn?.status === 'error' ? t('common.error') : t('status.disconnected')}
        </span>
        ${!isConnected ? `<button class="btn btn-sm btn-primary" data-qi-retry="${conn.id}" style="font-size:0.72rem">${t('common.connect')}</button>` : ''}
        <button class="btn btn-sm" data-qi-reinstall="${item.id}" style="font-size:0.72rem" title="${t('connectors.reinstall')}">\u21BB</button>
        <button class="btn btn-sm qi-btn-danger" data-qi-uninstall="${conn.id}" style="font-size:0.72rem" title="${t('connectors.uninstall')}">\u2715</button>
      `;
    } else if (item.quickInstall && !needsAuth) {
      actionsHtml = `<button class="btn btn-sm btn-primary" data-qi-install="${item.id}" data-qi-backend="mcp">${t('connectors.install')}</button>`;
    } else if (showBuiltin && showMcp) {
      actionsHtml = `
        <button class="btn btn-sm" data-page-add="${item.id}" data-page-backend="builtin">${t('connectors.builtin')}</button>
        <button class="btn btn-sm" data-page-add="${item.id}" data-page-backend="mcp">MCP</button>
      `;
    } else if (showBuiltin) {
      actionsHtml = `<button class="btn btn-sm btn-primary" data-page-add="${item.id}" data-page-backend="builtin">${t('common.add')}</button>`;
    } else if (needsAuth) {
      actionsHtml = `<button class="btn btn-sm btn-primary" data-qi-setup="${item.id}" data-qi-backend="mcp">${t('common.add')}</button>`;
    } else {
      actionsHtml = `<button class="btn btn-sm btn-primary" data-qi-install="${item.id}" data-qi-backend="mcp">${t('connectors.install')}</button>`;
    }

    return `
      <div class="catalog-item ${isSoon ? 'catalog-coming-soon' : ''} ${isInstalled ? 'catalog-item-installed' : ''}">
        <div class="catalog-item-header">
          <span class="catalog-item-icon">${item.icon}</span>
          <div class="catalog-item-info">
            <span class="catalog-item-name">${esc(item.name)}</span>
            <span class="catalog-item-desc">${esc(item.description)}</span>
          </div>
        </div>
        <div class="catalog-item-actions">${actionsHtml}</div>
      </div>
    `;
  }

  const body = `
    <input class="input catalog-modal-search" id="pageCatalogSearch" placeholder="${t('connectors.searchCatalog')}" />
    <div class="catalog-modal-grid" id="pageCatalogGrid">${buildGrid()}</div>
  `;

  openModal({ title: t('connectors.catalog'), body, wide: true, hideSubmit: true });

  setTimeout(() => {
    const searchInput = document.getElementById('pageCatalogSearch');
    searchInput?.addEventListener('input', () => {
      const grid = document.getElementById('pageCatalogGrid');
      if (grid) grid.innerHTML = buildGrid(searchInput.value.trim());
      wireCatalogActions(catalog, connectors);
    });
    searchInput?.focus();
    wireCatalogActions(catalog, connectors);
  }, 50);
}

function wireCatalogActions(catalog, connectors = []) {
  document.querySelectorAll('[data-page-add]').forEach(btn => {
    btn.addEventListener('click', () => {
      const catalogId = btn.dataset.pageAdd;
      const backend = btn.dataset.pageBackend;
      const item = catalog.find(c => c.id === catalogId);
      if (!item) return;
      closeModal();
      setTimeout(() => openPageSetupModal(item, backend, catalog), 200);
    });
  });

  document.querySelectorAll('[data-qi-install]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const catalogId = btn.dataset.qiInstall;
      const backend = btn.dataset.qiBackend || 'mcp';
      const item = catalog.find(c => c.id === catalogId);
      btn.disabled = true;
      btn.textContent = t('connectors.installing');
      try {
        await api.connectors.create({ catalogId, label: item?.name || catalogId, backend, credentials: {}, isGlobal: true, autoConnect: true });
        showToast({ type: 'success', title: t('connectors.connectorStarted'), message: item?.name || catalogId });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      closeModal();
      refresh();
    });
  });

  document.querySelectorAll('[data-qi-setup]').forEach(btn => {
    btn.addEventListener('click', () => {
      const catalogId = btn.dataset.qiSetup;
      const backend = btn.dataset.qiBackend || 'mcp';
      const item = catalog.find(c => c.id === catalogId);
      if (item) {
        closeModal();
        setTimeout(() => openPageSetupModal(item, backend, catalog), 200);
      }
    });
  });

  document.querySelectorAll('[data-qi-uninstall]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api.connectors.disconnect(btn.dataset.qiUninstall);
        await api.connectors.remove(btn.dataset.qiUninstall);
        showToast({ type: 'success', title: t('connectors.removed'), message: '' });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      closeModal();
      refresh();
    });
  });

  document.querySelectorAll('[data-qi-retry]').forEach(btn => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await api.connectors.connect(btn.dataset.qiRetry);
        showToast({ type: 'success', title: t('connectors.connectorStarted'), message: '' });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      closeModal();
      refresh();
    });
  });

  document.querySelectorAll('[data-qi-reinstall]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const catalogId = btn.dataset.qiReinstall;
      const installed = connectors.find(c => c.catalogId === catalogId && c.status !== 'archived');
      if (!installed) return;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await api.connectors.disconnect(installed.id);
        await api.connectors.connect(installed.id);
        showToast({ type: 'success', title: t('connectors.connectorStarted'), message: '' });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      closeModal();
      refresh();
    });
  });
}

function openPageSetupModal(item, backend, catalog) {
  const fields = item.authFields || [];
  const needsAuth = item.authType !== 'none' && fields.length > 0;

  if (!needsAuth) {
    (async () => {
      try {
        await api.connectors.create({ catalogId: item.id, label: item.name, backend, credentials: {}, isGlobal: true, autoConnect: true });
        showToast({ type: 'success', title: t('connectors.connectorStarted'), message: `${item.name} ${t('connectors.added')}` });
      } catch (err) {
        showToast({ type: 'error', title: t('common.error'), message: err.message });
      }
      refresh();
    })();
    return;
  }

  let bodyHtml = `
    <div class="form-group">
      <label class="form-label">${t('common.name')}</label>
      <input class="input" data-field="connLabel" value="${esc(item.name)}" />
    </div>
  `;

  if (item.helpSteps?.length > 0) {
    bodyHtml += `
      <div class="conn-setup-guide" style="margin-bottom:var(--space-md)">
        <h5 style="margin:0 0 var(--space-xs)">${t('connectors.credentialsHelp')}</h5>
        <ol class="conn-steps-list" style="margin:0; padding-left:var(--space-md)">
          ${item.helpSteps.map(s => `<li style="font-size:0.82rem; color:var(--text-muted)">${esc(s)}</li>`).join('')}
        </ol>
        ${item.helpUrl ? `<button class="btn btn-sm" id="pageSetupOpen" type="button" style="margin-top:var(--space-xs)">${t('common.open')} ${esc(item.name)}</button>` : ''}
      </div>
    `;
  }

  for (const field of fields) {
    bodyHtml += `
      <div class="form-group">
        <label class="form-label">${esc(field.label)}</label>
        <div style="display:flex; gap:var(--space-sm); align-items:center">
          <input class="input" type="${field.type || 'text'}" data-field="${field.key}"
                 placeholder="${esc(field.placeholder || '')}" style="flex:1" />
          ${field.type === 'password' ? `<button class="btn btn-sm btn-icon" id="pageToggle_${field.key}" type="button" title="${t('connectors.togglePassword')}">\uD83D\uDC41</button>` : ''}
        </div>
      </div>
    `;
  }

  bodyHtml += `
    <div style="display:flex; gap:var(--space-sm); align-items:center">
      <button class="btn btn-sm" id="pageTestBtn" type="button">${t('connectors.test')}</button>
      ${item.testDescription ? `<span class="form-hint" style="font-size:0.75rem">${esc(item.testDescription)}</span>` : ''}
    </div>
    <div id="pageTestResult" style="min-height:1.2em; font-size:0.85rem; margin-top:var(--space-xs)"></div>
    <div class="form-group">
      <label class="toggle">
        <input type="checkbox" data-field="isGlobal" />
        <span>${t('connectors.globalConnector')}</span>
      </label>
    </div>
  `;

  openModal({
    title: `${item.icon} ${item.name} (${backend})`,
    body: bodyHtml,
    submitLabel: t('common.connect'),
    onSubmit: async (formData) => {
      const credentials = {};
      for (const field of fields) {
        if (formData[field.key]) credentials[field.key] = formData[field.key];
      }
      const label = (formData.connLabel || '').trim() || item.name;
      const result = await api.connectors.create({
        catalogId: item.id, label, backend, credentials, isGlobal: !!formData.isGlobal, autoConnect: true,
      });
      if (result.status === 'error') throw new Error(result.errorMessage || t('connectors.connectionFailed'));
      showToast({ type: 'success', title: t('connectors.connectorStarted'), message: `${label} ${t('connectors.added')}` });
      refresh();
    },
  });

  setTimeout(() => {
    document.getElementById('pageSetupOpen')?.addEventListener('click', () => window.open(item.helpUrl, '_blank'));
    for (const field of fields) {
      if (field.type === 'password') {
        document.getElementById(`pageToggle_${field.key}`)?.addEventListener('click', () => {
          const input = document.querySelector(`[data-field="${field.key}"]`);
          if (input) input.type = input.type === 'password' ? 'text' : 'password';
        });
      }
    }
    const testBtn = document.getElementById('pageTestBtn');
    const testResult = document.getElementById('pageTestResult');
    if (testBtn && testResult) {
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true; testBtn.textContent = '...'; testResult.innerHTML = '';
        const credentials = {};
        for (const field of fields) {
          const input = document.querySelector(`[data-field="${field.key}"]`);
          if (input?.value) credentials[field.key] = input.value.trim();
        }
        try {
          const res = await api.connectors.test('_new', { catalogId: item.id, credentials, backend });
          testResult.innerHTML = res.valid
            ? `<span style="color:var(--accent-green)">\u2713 ${t('connectors.valid')}</span>`
            : `<span style="color:var(--accent-red)">\u2717 ${esc(res.error || t('connectors.invalid'))}</span>`;
        } catch (err) {
          testResult.innerHTML = `<span style="color:var(--accent-red)">\u2717 ${esc(err.message)}</span>`;
        }
        testBtn.disabled = false; testBtn.textContent = t('connectors.test');
      });
    }
  }, 100);
}

function esc(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
