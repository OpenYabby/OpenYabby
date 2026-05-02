/* ═══════════════════════════════════════════════════════
   YABBY — Reusable Modal System
   ═══════════════════════════════════════════════════════
   Usage:
     import { openModal, closeModal } from './components/modal.js';

     openModal({
       title: 'Créer un projet',
       body: '<div class="form-group">...</div>',
       onSubmit: (formData) => { ... },
       submitLabel: 'Créer',
     });
*/

import { t } from '../i18n.js';

let currentReject = null;

/** Open a modal with given options */
export function openModal({ title, body, onSubmit, submitLabel = t('modal.defaultSubmit'), cancelLabel = t('modal.defaultCancel'), danger = false, wide = false, hideSubmit = false }) {
  const backdrop = document.getElementById('modalBackdrop');
  const content = document.getElementById('modalContent');
  if (!backdrop || !content) return;

  // Wide variant
  if (wide) content.classList.add('modal-wide');
  else content.classList.remove('modal-wide');

  content.innerHTML = `
    <div class="modal-header">
      <span class="modal-title">${escModal(title)}</span>
      <button class="modal-close" id="modalCloseBtn">&times;</button>
    </div>
    <div class="modal-body" id="modalBody">
      ${body}
    </div>
    ${hideSubmit ? '' : `
    <div class="modal-footer">
      <button class="btn" id="modalCancelBtn">${escModal(cancelLabel)}</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modalSubmitBtn">${escModal(submitLabel)}</button>
    </div>
    `}
  `;

  // Show
  backdrop.classList.add('visible');

  // Cleanup refs
  const closeBtn = document.getElementById('modalCloseBtn');
  const cancelBtn = document.getElementById('modalCancelBtn');
  const submitBtn = document.getElementById('modalSubmitBtn');

  const close = () => closeModal();

  closeBtn?.addEventListener('click', close);
  cancelBtn?.addEventListener('click', close);

  submitBtn?.addEventListener('click', async () => {
    if (!onSubmit) { close(); return; }

    // Collect form data from modal body inputs
    const formBody = document.getElementById('modalBody');
    const data = {};
    formBody.querySelectorAll('[data-field]').forEach(el => {
      const field = el.dataset.field;
      if (el.type === 'checkbox') {
        data[field] = el.checked;
      } else if (el.tagName === 'SELECT') {
        data[field] = el.value;
      } else {
        data[field] = el.value;
      }
    });

    // Disable submit during processing
    submitBtn.disabled = true;
    submitBtn.textContent = '...';

    try {
      await onSubmit(data);
      close();
    } catch (err) {
      // Show error inline
      let errDiv = formBody.querySelector('.modal-error');
      if (!errDiv) {
        errDiv = document.createElement('div');
        errDiv.className = 'modal-error';
        errDiv.style.cssText = 'color: var(--accent-red); font-size: var(--text-sm); padding: var(--space-sm) 0;';
        formBody.appendChild(errDiv);
      }
      errDiv.textContent = err.message || t('common.error');
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel;
    }
  });

  // Escape key
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      close();
      document.removeEventListener('keydown', escHandler);
    }
  };
  document.addEventListener('keydown', escHandler);
  currentReject = () => document.removeEventListener('keydown', escHandler);

  // Backdrop click
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close();
  }, { once: true });

  // Focus first input
  requestAnimationFrame(() => {
    const firstInput = content.querySelector('input, textarea, select');
    if (firstInput) firstInput.focus();
  });
}

/** Close the current modal */
export function closeModal() {
  const backdrop = document.getElementById('modalBackdrop');
  if (backdrop) {
    backdrop.classList.remove('visible');
  }
  if (currentReject) {
    currentReject();
    currentReject = null;
  }
}

function escModal(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/* ── Pre-built modal forms ── */

/** Modal to create a project */
export function openCreateProjectModal(onCreated) {
  openModal({
    title: t('modal.newProject'),
    body: `
      <div class="form-group">
        <label class="form-label">${t('common.name')}</label>
        <input class="input" data-field="name" placeholder="${t('modal.projectNamePlaceholder')}" required>
      </div>
      <div class="form-group">
        <label class="form-label">${t('common.description')}</label>
        <textarea class="textarea" data-field="description" placeholder="${t('modal.objectivesPlaceholder')}" rows="3"></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t('common.type')}</label>
          <select class="select" data-field="project_type">
            <option value="dev">${t('modal.typeDev')}</option>
            <option value="design">${t('modal.typeDesign')}</option>
            <option value="marketing">${t('modal.typeMarketing')}</option>
            <option value="book">${t('modal.typeWriting')}</option>
            <option value="event">${t('modal.typeEvent')}</option>
            <option value="startup">${t('modal.typeStartup')}</option>
            <option value="other">${t('modal.typeOther')}</option>
          </select>
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">${t('modal.detailedContext')}</label>
        <textarea class="textarea" data-field="context" placeholder="${t('modal.contextPlaceholder')}" rows="3"></textarea>
      </div>
    `,
    submitLabel: t('modal.createProject'),
    onSubmit: async (data) => {
      if (!data.name?.trim()) throw new Error(t('modal.nameRequired'));
      const { api } = await import('../api.js');
      const result = await api.projects.create(data);
      if (onCreated) onCreated(result);
    },
  });
}

/** Modal to create an agent in a project */
export function openCreateAgentModal(projectId, agents, onCreated) {
  const parentOptions = (agents || [])
    .filter(a => a.status !== 'archived')
    .map(a => `<option value="${a.id}">${escModal(a.name)} (${escModal(a.role)})</option>`)
    .join('');

  openModal({
    title: t('modal.newAgent'),
    body: `
      <div class="form-group">
        <label class="form-label">${t('common.name')}</label>
        <input class="input" data-field="name" placeholder="${t('modal.agentNamePlaceholder')}" required>
      </div>
      <div class="form-group">
        <label class="form-label">${t('modal.role')}</label>
        <input class="input" data-field="role" placeholder="${t('modal.rolePlaceholder')}">
      </div>
      <div class="form-group">
        <label class="form-label">${t('modal.instructions')}</label>
        <textarea class="textarea" data-field="role_instructions" placeholder="${t('modal.instructionsPlaceholder')}" rows="4"></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t('modal.parentAgent')}</label>
          <select class="select" data-field="parent_agent_id">
            <option value="">${t('modal.noParent')}</option>
            ${parentOptions}
          </select>
        </div>
      </div>
      <label class="toggle">
        <input type="checkbox" data-field="is_lead">
        <span class="toggle-track"></span>
        ${t('modal.projectDirector')}
      </label>
    `,
    submitLabel: t('modal.createAgent'),
    onSubmit: async (data) => {
      if (!data.name?.trim()) throw new Error(t('modal.nameRequired'));
      if (!data.role?.trim()) throw new Error(t('modal.roleRequired'));
      const { api } = await import('../api.js');
      const result = await api.projects.createAgent(projectId, data);
      if (onCreated) onCreated(result);
    },
  });
}

/** Modal to create a new task */
export function openCreateTaskModal(projects, onCreated) {
  const projectOptions = (projects || [])
    .filter(p => p.id !== 'default' && p.status !== 'archived')
    .map(p => `<option value="${p.id}">${escModal(p.name)}</option>`)
    .join('');

  openModal({
    title: t('modal.newTask'),
    body: `
      <div class="form-group">
        <label class="form-label">${t('modal.taskDescLabel')}</label>
        <textarea class="textarea" data-field="task" placeholder="${t('modal.taskDescPlaceholder')}" rows="4" required></textarea>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">${t('modal.projectOptional')}</label>
          <select class="select" data-field="project_id">
            <option value="">${t('common.none')}</option>
            ${projectOptions}
          </select>
        </div>
      </div>
    `,
    submitLabel: t('modal.launchTask'),
    onSubmit: async (data) => {
      if (!data.task?.trim()) throw new Error(t('modal.descRequired'));
      const { api } = await import('../api.js');
      const opts = {};
      if (data.project_id) opts.project_id = data.project_id;
      const result = await api.tasks.start(data.task, opts);
      if (result.task_id) {
        const active = [...(await import('../state.js')).state.get('activeTaskIds'), result.task_id];
        (await import('../state.js')).state.set('activeTaskIds', active);
      }
      if (onCreated) onCreated(result);
    },
  });
}

/** Open agent chat window (replaces the old instruction modal) */
export function openSendInstructionModal(agentId, agentName, onSent) {
  import('./agent-chat.js').then(({ openAgentChat }) => {
    openAgentChat(agentId, agentName);
  });
}

/** Inline confirmation (returns promise) */
export function confirmAction(message = t('modal.confirmPrompt')) {
  return new Promise((resolve) => {
    openModal({
      title: t('modal.confirmation'),
      body: `<p style="color: var(--text-secondary); font-size: var(--text-md);">${escModal(message)}</p>`,
      submitLabel: t('modal.defaultSubmit'),
      cancelLabel: t('modal.defaultCancel'),
      danger: true,
      onSubmit: async () => resolve(true),
    });
    // If modal is closed without submit, resolve false
    const backdrop = document.getElementById('modalBackdrop');
    const observer = new MutationObserver(() => {
      if (!backdrop.classList.contains('visible')) {
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(backdrop, { attributes: true, attributeFilter: ['class'] });
  });
}
