/* ═══════════════════════════════════════════════════════
   YABBY — Centralized API Client
   ═══════════════════════════════════════════════════════
   Single module for all backend calls. Used by both
   voice.js (tool dispatch) and UI components (buttons).
*/

const BASE = window.location.origin;

/** Build auth headers if a token is stored */
function authHeaders() {
  const token = localStorage.getItem('yabby_token');
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

/** Handle 401 — redirect to login */
function handle401(res) {
  if (res.status === 401) {
    // Only redirect if auth is actually enabled (avoid loop)
    const onLoginPage = window.location.hash === '#/login';
    if (!onLoginPage) {
      localStorage.removeItem('yabby_token');
      window.location.hash = '#/login';
    }
  }
}

async function get(path) {
  const res = await fetch(BASE + path, { headers: authHeaders() });
  if (!res.ok) { handle401(res); throw new Error(await res.text()); }
  return res.json();
}

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) { handle401(res); throw new Error(await res.text()); }
  return res.json();
}

async function put(path, body) {
  const res = await fetch(BASE + path, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) { handle401(res); throw new Error(await res.text()); }
  return res.json();
}

async function patch(path, body) {
  const res = await fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) { handle401(res); throw new Error(await res.text()); }
  return res.json();
}

async function del(path) {
  const res = await fetch(BASE + path, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) { handle401(res); throw new Error(await res.text()); }
  return res.json();
}

/** Post raw body (for SDP, audio) */
async function postRaw(path, body, contentType, extraHeaders = {}) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': contentType, ...authHeaders(), ...extraHeaders },
    body,
  });
  return res;
}

export const api = {
  // ── Tasks ──
  tasks: {
    list:      ()                 => get('/api/tasks'),
    get:       (id)               => get(`/api/tasks/${id}`),
    getLog:    (id, limit = 100)  => get(`/api/tasks/${id}/log?limit=${limit}`),
    start:     (task, opts = {})  => post('/api/tasks/start', { task, ...opts }),
    check:     (taskIds)          => post('/api/tasks/check', { task_ids: taskIds }),
    continue:  (id, task)         => post('/api/tasks/continue', { task_id: id, task }),
    pause:     (id)               => post('/api/tasks/pause', { task_id: id }),
    kill:      (id)               => post('/api/tasks/kill', { task_id: id }),
    listSimple: ()               => get('/api/simple-tasks'),
    archive:   (id)              => post(`/api/tasks/${id}/archive`),
    recover:   (id, dropLast)    => post(`/api/tasks/${id}/recover`, dropLast ? { dropLast } : {}),
    runners:   ()                => get('/api/tasks/runners'),
    search:    (query, filters = {}) => {
      const params = new URLSearchParams({ q: query });
      if (filters.status) params.set('status', filters.status);
      if (filters.project_id) params.set('project', filters.project_id);
      if (filters.agent_id) params.set('agent', filters.agent_id);
      if (filters.limit) params.set('limit', filters.limit);
      return get(`/api/tasks/search?${params.toString()}`);
    },
  },

  // ── Projects ──
  projects: {
    list:      ()                  => get('/api/projects'),
    get:       (id)                => get(`/api/projects/${id}`),
    lookup:    (idOrName)          => get(`/api/projects/lookup/${encodeURIComponent(idOrName)}`),
    create:    (data)              => post('/api/projects', data),
    update:    (id, data)          => put(`/api/projects/${id}`, data),
    delete:    (id)                => del(`/api/projects/${id}`),
    rename:    (id, name)          => patch(`/api/projects/${id}/rename`, { name }),
    heartbeat: (id)                => get(`/api/projects/${id}/heartbeat`),
    tasks:     (id)                => get(`/api/projects/${id}/tasks`),
    events:    (id, limit = 50)    => get(`/api/projects/${id}/events?limit=${limit}`),
    messages:  (id, limit = 50)    => get(`/api/projects/${id}/messages?limit=${limit}`),
    agents:    (id)                => get(`/api/projects/${id}/agents`),
    createAgent: (id, data)        => post(`/api/projects/${id}/agents`, data),
    sandbox:   (id)                => get(`/api/projects/${id}/sandbox`),
    openSandbox: (id)              => post(`/api/projects/${id}/sandbox/open`),
  },

  // ── Agents ──
  agents: {
    list:             (projectId)       => get(`/api/agents${projectId ? '?project_id=' + projectId : ''}`),
    get:              (id)              => get(`/api/agents/${id}`),
    createStandalone: (data)            => post(`/api/agents`, data),
    update:           (id, data)        => put(`/api/agents/${id}`, data),
    suspend:          (id)              => post(`/api/agents/${id}/suspend`),
    activate:         (id)              => post(`/api/agents/${id}/activate`),
    delete:           (id)              => del(`/api/agents/${id}`),
    inbox:            (id, status)      => get(`/api/agents/${id}/inbox${status ? '?status=' + status : ''}`),
    sendMessage:      (id, text, mediaAssetIds) => post(`/api/agents/${id}/message`, { text, mediaAssetIds }), // Web chat endpoint
    skills:           (id)              => get(`/api/agents/${id}/skills`),
    addSkill:    (id, skillId)     => post(`/api/agents/${id}/skills`, { skill_id: skillId }),
    removeSkill: (agentId, skillId) => del(`/api/agents/${agentId}/skills/${skillId}`),
    voiceConfig: (id)              => get(`/api/agents/${id}/voice-config`),
  },

  // ── Skills ──
  skills: {
    list:   (category)  => get(`/api/skills${category ? '?category=' + category : ''}`),
    create: (data)      => post('/api/skills', data),
  },

  // ── Templates ──
  templates: {
    list:   (projectType) => get(`/api/templates${projectType ? '?project_type=' + projectType : ''}`),
    create: (data)        => post('/api/templates', data),
  },

  // ── Resolution ──
  resolve: (type, name, projectId) => {
    let url = `/api/resolve?type=${type}&name=${encodeURIComponent(name)}`;
    if (projectId) url += `&project_id=${projectId}`;
    return get(url);
  },

  // ── Conversation state ──
  conversation: {
    get:          ()            => get('/api/conversation-state'),
    saveResponse: (id)          => post('/api/conversation-state', { lastResponseId: id }),
    addTurn:      (role, text)  => post('/api/conversation-state/turn', { role, text }),
    reset:        ()            => del('/api/conversation-state'),
    getMemories:  ()            => get('/api/memories'),
    getYabbyChat: (opts = {})   => {
      const p = new URLSearchParams();
      if (opts.limit != null) p.set('limit', opts.limit);
      if (opts.offset != null) p.set('offset', opts.offset);
      const qs = p.toString();
      return get('/api/yabby-chat' + (qs ? '?' + qs : ''));
    },
  },

  // ── Agent chats ──
  agentChats: {
    get: (agentId, opts = {}) => {
      const p = new URLSearchParams();
      if (opts.limit != null) p.set('limit', opts.limit);
      if (opts.offset != null) p.set('offset', opts.offset);
      const qs = p.toString();
      return get(`/api/agent-chats/${agentId}` + (qs ? '?' + qs : ''));
    },
    addTurn: (agentId, role, text) => post(`/api/agent-chats/${agentId}/turn`, { role, text }),
  },

  // ── Voice session ──
  session: {
    create: (sdpOffer, headers) => postRaw('/session', sdpOffer, 'application/sdp', headers),
    getYabbyInstructions: ()    => get('/api/yabby-instructions'),
  },

  // ── Wake word ──
  wakeWord: {
    check: (audioBlob) => postRaw('/api/wake-word', audioBlob, 'audio/webm'),
    debug: (msg)       => fetch(`${BASE}/api/wake-debug?msg=${encodeURIComponent(msg)}`).catch(() => {}),
  },

  // ── Heartbeat & Notifications ──
  heartbeat:     (data)   => post('/api/heartbeat', data),
  notifySpeaker: (data)   => post('/api/notify-speaker', data),

  // ── Scheduled Tasks ──
  scheduled: {
    list:     ()          => get('/api/scheduled-tasks'),
    get:      (id)        => get(`/api/scheduled-tasks/${id}`),
    create:   (data)      => post('/api/scheduled-tasks', data),
    update:   (id, data)  => put(`/api/scheduled-tasks/${id}`, data),
    pause:    (id)        => post(`/api/scheduled-tasks/${id}/pause`),
    activate: (id)        => post(`/api/scheduled-tasks/${id}/activate`),
    trigger:  (id)        => post(`/api/scheduled-tasks/${id}/trigger`),
    archive:  (id)        => del(`/api/scheduled-tasks/${id}`),
    runs:     (id)        => get(`/api/scheduled-tasks/${id}/runs`),
  },

  // ── GUI Lock ──
  guiLock: {
    acquire: (taskId) => post('/api/gui-lock/acquire', { task_id: taskId }),
    release: (taskId) => post('/api/gui-lock/release', { task_id: taskId }),
  },

  // ── Config ──
  config: {
    getAll:  ()           => get('/api/config'),
    get:     (key)        => get(`/api/config/${key}`),
    set:     (key, value) => put(`/api/config/${key}`, value),
    reload:  ()           => post('/api/config/reload'),
    apiKeysStatus: ()     => get('/api/config/api-keys/status'),
    saveApiKeys: (keys)   => post('/api/config/api-keys', { keys }),
  },

  // ── Providers ──
  providers: {
    list:   ()      => get('/api/providers'),
    models: (name)  => get(`/api/providers/${name}/models`),
    test:   (name)  => post(`/api/providers/${name}/test`),
    usage:  (days)  => get(`/api/usage${days ? '?days=' + days : ''}`),
  },

  // ── Auth management ──
  auth: {
    me:          ()           => get('/api/auth/me'),
    login:       (body)       => post('/api/auth/login', body),
    logout:      ()           => post('/api/auth/logout'),
    createToken: (name, scopes) => post('/api/auth/token', { name, scopes }),
  },

  // ── Channels ──
  channels: {
    list:            ()          => get('/api/channels'),
    restart:         (name)      => post(`/api/channels/${name}/restart`),
    stop:            (name, clearSession = false) => post(`/api/channels/${name}/stop`, { clearSession }),
    reconnect:       (name)      => post(`/api/channels/${name}/reconnect`),
    send:            (name, channelId, text) => post(`/api/channels/${name}/send`, { channelId, text }),
    conversations:   (name)      => get(`/api/channels/${name}/conversations`),
    messages:        (convId)    => get(`/api/channels/conversations/${convId}/messages`),
    deadLetters:     ()          => get('/api/channels/dead-letters'),
    deleteDeadLetter:(id)        => del(`/api/channels/dead-letters/${id}`),
    clearDeadLetters:()          => del('/api/channels/dead-letters'),
    users:           (name)      => get(`/api/channels/${name}/users`),
  },

  // ── Plugins ──
  plugins: {
    list:    ()     => get('/api/plugins'),
    get:     (name) => get(`/api/plugins/${name}`),
    enable:  (name) => post(`/api/plugins/${name}/enable`),
    disable: (name) => post(`/api/plugins/${name}/disable`),
    health:  (name) => get(`/api/plugins/${name}/health`),
  },

  // ── Connectors ──
  connectors: {
    catalog:             ()          => get('/api/connectors/catalog'),
    list:                ()          => get('/api/connectors'),
    create:              (data)      => post('/api/connectors', data),
    get:                 (id)        => get(`/api/connectors/${id}`),
    update:              (id, data)  => put(`/api/connectors/${id}`, data),
    remove:              (id)        => del(`/api/connectors/${id}`),
    connect:             (id)        => post(`/api/connectors/${id}/connect`),
    disconnect:          (id)        => post(`/api/connectors/${id}/disconnect`),
    test:                (id, data)  => post(`/api/connectors/${id}/test`, data),
    forProject:          (pid)       => get(`/api/projects/${pid}/connectors`),
    linkToProject:       (pid, cid)  => post(`/api/projects/${pid}/connectors`, { connectorId: cid }),
    unlinkFromProject:   (pid, cid)  => del(`/api/projects/${pid}/connectors/${cid}`),
    requests:            ()          => get('/api/connector-requests'),
    resolveRequest:      (id, status) => post(`/api/connector-requests/${id}/resolve`, { status }),
  },

  // ── MCP ──
  mcp: {
    servers:    ()     => get('/api/mcp/servers'),
    connect:    (cfg)  => post('/api/mcp/servers', cfg),
    disconnect: (name) => del(`/api/mcp/servers/${name}`),
    tools:      ()     => get('/api/mcp/tools'),
    call:       (server, tool, args) => post('/api/mcp/call', { server, tool, args }),
  },

  // ── Plan Reviews ──
  planReviews: {
    list:    (projectId, opts = {}) => {
      const params = new URLSearchParams();
      if (projectId) params.set('projectId', projectId);
      if (opts.all) params.set('all', 'true');
      const qs = params.toString();
      return get('/api/plan-reviews' + (qs ? `?${qs}` : ''));
    },
    get:     (id)        => get(`/api/plan-reviews/${id}`),
    latest:  (projectId) => get(`/api/plan-reviews/latest?projectId=${encodeURIComponent(projectId)}`),
    resolve: (id, status, feedback) => post(`/api/plan-reviews/${id}/resolve`, { status, feedback }),
  },

  // ── Presentations ──
  presentations: {
    list:       (status) => get('/api/presentations' + (status ? `?status=${status}` : '')),
    get:        (id)     => get(`/api/presentations/${id}`),
    create:     (data)   => post('/api/presentations', data),
    update:     (id, data) => patch(`/api/presentations/${id}`, data),
    presented:  (id)     => post(`/api/presentations/${id}/presented`),
    run:        (id)     => post(`/api/presentations/${id}/run`),
    forProject: (pid)    => get(`/api/projects/${pid}/presentations`),
    forProjectActive: (pid) => get(`/api/projects/${pid}/presentation`),
  },

  // ── Project Questions ──
  projectQuestions: {
    list:    (projectId) => get('/api/project-questions' + (projectId ? `?projectId=${projectId}` : '')),
    resolve: (id, answer, answerData) => post(`/api/project-questions/${id}/resolve`, { answer, answer_data: answerData }),
    skip:    (id) => post(`/api/project-questions/${id}/skip`),
  },

  // ── TTS ──
  tts: {
    providers: ()                => get('/api/tts/providers'),
    voices:    (provider)        => get(`/api/tts/voices?provider=${provider || 'system'}`),
    speak:     (text, opts = {}) => post('/api/tts/speak', { text, ...opts }),
  },

  // ── Health ──
  health: {
    basic:    () => get('/api/health'),
    detailed: () => get('/api/health/detailed'),
    usage:    (days) => get(`/api/usage${days ? '?days=' + days : ''}`),
  },

  // ── Preview ──
  preview: {
    push:   (block)          => post('/api/preview/push', block),
    blocks: (opts = {})      => {
      const p = new URLSearchParams();
      if (opts.limit) p.set('limit', opts.limit);
      if (opts.offset) p.set('offset', opts.offset);
      if (opts.projectId) p.set('projectId', opts.projectId);
      return get(`/api/preview/blocks?${p.toString()}`);
    },
    get:    (id)             => get(`/api/preview/blocks/${id}`),
    remove: (id)             => del(`/api/preview/blocks/${id}`),
    reset:  (projectId)      => post('/api/preview/reset', projectId ? { projectId } : {}),
    eval:   (blockId, js)    => post('/api/preview/eval', { blockId, js }),
  },

  // ── Session reload ──
  sessionReload: () => post('/api/session/reload'),
};

/** Helper: resolve project name to ID */
export async function resolveProjectId(idOrName) {
  if (idOrName && idOrName.length <= 12 && /^[a-f0-9-]+$/i.test(idOrName)) {
    return idOrName;
  }
  try {
    const res = await api.resolve('project', idOrName);
    if (res.found && res.id) return res.id;
  } catch {}
  return idOrName;
}

/** Helper: resolve agent name to ID */
export async function resolveAgentId(idOrName) {
  if (idOrName && idOrName.length <= 12 && /^[a-f0-9-]+$/i.test(idOrName)) {
    return idOrName;
  }
  try {
    const res = await api.resolve('agent', idOrName);
    if (res.found && res.id) return res.id;
  } catch {}
  return idOrName;
}

// ── Agent Task Queue ──

export async function getAgentQueue(agentId) {
  return await get(`/api/agents/${agentId}/queue`);
}

export async function clearAgentQueue(agentId) {
  return await post(`/api/agents/${agentId}/queue/clear`);
}

export async function resumeAgent(agentId) {
  return await post(`/api/agents/${agentId}/resume`);
}
