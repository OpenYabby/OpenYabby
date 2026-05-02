/* ═══════════════════════════════════════════════════════
   YABBY — Project Question Modal
   ═══════════════════════════════════════════════════════
   Displays lead agent's discovery question.
   Supports voice (simple text), modal (form), and connector types.
*/

import { openModal, closeModal } from './modal.js';
import { t } from '../i18n.js';

/**
 * Open the project question modal.
 * @param {object} data — { questionId, question, questionType, formSchema, projectName, agentName }
 */
export function openProjectQuestionModal(data) {
  const { questionId, question, questionType, formSchema, projectName, agentName } = data;

  let body = '';

  if (questionType === 'modal' && formSchema?.fields?.length) {
    // Dynamic form from formSchema
    body = `
      <p style="color: var(--text-secondary); font-size: var(--text-sm); margin-bottom: var(--space-sm);">
        Question de <strong>${escHtml(agentName || 'Agent')}</strong> pour le projet <strong>${escHtml(projectName || 'Projet')}</strong>
      </p>
      <div style="padding: var(--space-md); background: var(--bg-secondary); border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: var(--space-md);">
        <p style="margin: 0; font-size: var(--text-md);">${escHtml(question)}</p>
      </div>
      <div class="settings-grid">
        ${formSchema.fields.map(field => renderFormField(field)).join('')}
      </div>
    `;
  } else if (questionType === 'connector') {
    // Connector selector
    body = `
      <p style="color: var(--text-secondary); font-size: var(--text-sm); margin-bottom: var(--space-sm);">
        Question de <strong>${escHtml(agentName || 'Agent')}</strong> pour le projet <strong>${escHtml(projectName || 'Projet')}</strong>
      </p>
      <div style="padding: var(--space-md); background: var(--bg-secondary); border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: var(--space-md);">
        <p style="margin: 0; font-size: var(--text-md);">${escHtml(question)}</p>
      </div>
      <div id="connectorList" class="settings-grid">
        <p class="text-muted">Chargement des connecteurs...</p>
      </div>
      <div class="form-group" style="margin-top: var(--space-md);">
        <label class="form-label">Réponse complémentaire (optionnel)</label>
        <textarea class="textarea" data-field="answer" placeholder="Informations supplémentaires..." rows="2"></textarea>
      </div>
    `;
  } else {
    // Voice type — simple text answer
    body = `
      <p style="color: var(--text-secondary); font-size: var(--text-sm); margin-bottom: var(--space-sm);">
        Question de <strong>${escHtml(agentName || 'Agent')}</strong> pour le projet <strong>${escHtml(projectName || 'Projet')}</strong>
      </p>
      <div style="padding: var(--space-md); background: var(--bg-secondary); border-radius: var(--radius-md); border: 1px solid var(--border-color); margin-bottom: var(--space-md);">
        <p style="margin: 0; font-size: var(--text-md);">${escHtml(question)}</p>
      </div>
      <div class="form-group">
        <label class="form-label">Votre réponse</label>
        <textarea class="textarea" data-field="answer" placeholder="Tapez votre réponse ici..." rows="3"></textarea>
      </div>
    `;
  }

  openModal({
    title: `Question — ${projectName || 'Projet'}`,
    body,
    submitLabel: 'Répondre',
    cancelLabel: 'Ignorer',
    onSubmit: async (formData) => {
      const { api } = await import('../api.js');

      let answer, answerData;

      if (questionType === 'modal' && formSchema?.fields?.length) {
        // Collect all form fields as answer_data, build text answer
        answerData = {};
        const parts = [];
        for (const field of formSchema.fields) {
          const val = formData[field.name];
          if (val !== undefined && val !== '') {
            answerData[field.name] = val;
            parts.push(`${field.label || field.name}: ${val}`);
          }
        }
        answer = parts.join(', ') || 'Aucune sélection';
      } else if (questionType === 'connector') {
        // Collect selected connectors
        const checkboxes = document.querySelectorAll('#connectorList input[type="checkbox"]:checked');
        const selected = Array.from(checkboxes).map(cb => cb.value);
        answerData = { connectors: selected };
        answer = formData.answer
          ? `Connecteurs: ${selected.join(', ')}. ${formData.answer}`
          : `Connecteurs sélectionnés: ${selected.join(', ') || 'aucun'}`;
      } else {
        answer = formData.answer;
        answerData = {};
      }

      if (!answer?.trim()) throw new Error(t('projectQuestion.answerRequired'));
      await api.projectQuestions.resolve(questionId, answer, answerData);
    },
  });

  // Override cancel to skip the question instead of just closing
  requestAnimationFrame(() => {
    const cancelBtn = document.getElementById('modalCancelBtn');
    if (!cancelBtn) return;

    cancelBtn.replaceWith(cancelBtn.cloneNode(true));
    const newCancelBtn = document.querySelector('.modal-footer .btn:first-child');
    if (newCancelBtn) {
      newCancelBtn.addEventListener('click', async () => {
        try {
          const { api } = await import('../api.js');
          await api.projectQuestions.skip(questionId);
          closeModal();
        } catch (err) {
          console.error('[project-question] Skip error:', err);
          closeModal();
        }
      });
    }

    // Load connectors for connector type
    if (questionType === 'connector') {
      loadConnectors();
    }
  });
}

async function loadConnectors() {
  const listEl = document.getElementById('connectorList');
  if (!listEl) return;

  try {
    const { api } = await import('../api.js');
    const data = await api.connectors.list();
    const connectors = data.connectors || data || [];

    if (connectors.length === 0) {
      listEl.innerHTML = `<p class="text-muted">${t('projectQuestion.noConnectors')}</p>`;
      return;
    }

    listEl.innerHTML = connectors.map(c => `
      <label class="toggle" style="margin-bottom: var(--space-xs);">
        <input type="checkbox" value="${escHtml(c.id || c.name)}" />
        <span class="toggle-track"></span>
        <strong>${escHtml(c.name)}</strong> <span class="text-muted">${escHtml(c.type || '')}</span>
      </label>
    `).join('');
  } catch {
    listEl.innerHTML = '<p class="text-muted">Impossible de charger les connecteurs.</p>';
  }
}

function renderFormField(field) {
  const { name, label, type, options, placeholder, required } = field;

  if (type === 'select' && options?.length) {
    return `
      <div class="form-group">
        <label class="form-label">${escHtml(label || name)}</label>
        <select class="select" data-field="${escHtml(name)}">
          ${options.map(o => `<option value="${escHtml(typeof o === 'string' ? o : o.value)}">${escHtml(typeof o === 'string' ? o : o.label)}</option>`).join('')}
        </select>
      </div>
    `;
  }

  if (type === 'checkbox') {
    return `
      <label class="toggle">
        <input type="checkbox" data-field="${escHtml(name)}" />
        <span class="toggle-track"></span>
        ${escHtml(label || name)}
      </label>
    `;
  }

  if (type === 'textarea') {
    return `
      <div class="form-group">
        <label class="form-label">${escHtml(label || name)}</label>
        <textarea class="textarea" data-field="${escHtml(name)}" placeholder="${escHtml(placeholder || '')}" rows="3" ${required ? 'required' : ''}></textarea>
      </div>
    `;
  }

  // Default: text input
  return `
    <div class="form-group">
      <label class="form-label">${escHtml(label || name)}</label>
      <input class="input" type="${type || 'text'}" data-field="${escHtml(name)}" placeholder="${escHtml(placeholder || '')}" ${required ? 'required' : ''} />
    </div>
  `;
}

function escHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
