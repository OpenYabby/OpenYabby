/* ═══════════════════════════════════════════════════════
   YABBY — Plan Review Modal
   ═══════════════════════════════════════════════════════
   Displays the lead agent's plan as rendered markdown.
   The plan body scrolls independently so the footer (approve /
   modify / cancel / later) stays visible at all times.
*/

import { openModal, closeModal } from './modal.js';
import { t } from '../i18n.js';
import { state } from '../state.js';

/**
 * Open the plan review modal.
 * @param {object} data — { reviewId, planContent, projectName, agentName, viewOnly?: boolean, status?: string }
 *
 * `viewOnly: true` renders the plan as read-only (no Approve / Modify /
 * Cancel / Later actions, only a Close button) — used by the project
 * detail "Voir le plan" button to inspect a previously-resolved plan
 * without offering accidental re-resolution.
 */
export function openPlanReviewModal(data) {
  const { reviewId, planContent, projectName, agentName, viewOnly = false, status } = data;

  // Set global state flag (only when actionable — read-only views must not
  // block voice/auto-popup gating since the user just wants to peek).
  if (!viewOnly) {
    state.set('planReviewActive', true);
    state.set('activePlanReviewId', reviewId);
  }

  // Render the plan as markdown (fallback to preformatted text)
  const renderedPlan = typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined'
    ? DOMPurify.sanitize(marked.parse(planContent || ''))
    : `<pre style="white-space: pre-wrap;">${escHtml(planContent || '')}</pre>`;

  // We build our own footer (hideSubmit: true in openModal) so we control the
  // exact layout and button states. The previous approach injected buttons
  // into the default footer and then queried them back with :first-child,
  // which silently picked the wrong button after re-ordering.
  // Footer differs for read-only (just Close) vs actionable (Later /
  // Cancel / Modify / Approve). Read-only is the path used from the
  // project-detail "Voir le plan" button to inspect a resolved plan.
  const footerHtml = viewOnly
    ? `
      <div id="planReviewFooter" style="
        display: flex;
        align-items: center;
        gap: var(--space-sm);
        padding: var(--space-lg) 0 0;
        margin-top: var(--space-md);
        border-top: 1px solid var(--glass-border);
        flex-shrink: 0;
      ">
        ${status ? `<span class="badge" style="font-size: var(--text-xs); color: var(--text-secondary);">${escHtml(status)}</span>` : ''}
        <div style="flex: 1 1 auto;"></div>
        <button type="button" id="planCloseBtn" class="btn btn-primary">
          ${t('common.close')}
        </button>
      </div>
    `
    : `
      <div id="planFeedbackArea" style="display: none; flex-shrink: 0; margin-top: var(--space-md);">
        <div class="form-group">
          <label class="form-label">${t('planReview.feedbackLabel')}</label>
          <textarea class="textarea" id="planFeedback"
            placeholder="${t('planReview.feedbackPlaceholder')}" rows="4"></textarea>
        </div>
      </div>

      <div id="planReviewFooter" style="
        display: flex;
        align-items: center;
        gap: var(--space-sm);
        padding: var(--space-lg) 0 0;
        margin-top: var(--space-md);
        border-top: 1px solid var(--glass-border);
        flex-shrink: 0;
      ">
        <button type="button" id="planLaterBtn" class="btn" style="color: var(--text-secondary);">
          ${t('planReview.reviewLater')}
        </button>
        <button type="button" id="planCancelBtn" class="btn btn-danger">
          ${t('planReview.cancelProject')}
        </button>
        <div style="flex: 1 1 auto;"></div>
        <button type="button" id="planModifyBtn" class="btn" style="border: 1px solid var(--accent-blue); color: var(--accent-blue);">
          ${t('planReview.modify')}
        </button>
        <button type="button" id="planApproveBtn" class="btn btn-primary">
          ${t('planReview.approve')}
        </button>
      </div>
    `;

  openModal({
    title: `${t('planReview.title')}${projectName || 'Projet'}`,
    wide: true,
    hideSubmit: true,
    body: `
      <div style="margin-bottom: var(--space-sm); flex-shrink: 0;">
        <p style="color: var(--text-secondary); font-size: var(--text-sm); margin: 0;">
          ${t('planReview.proposedBy')}<strong>${escHtml(agentName || 'Agent')}</strong>
        </p>
      </div>

      <div id="planDetailedView" class="plan-review-content" style="flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: var(--space-md); background: var(--bg-secondary); border-radius: var(--radius-md); border: 1px solid var(--border-color);">
        <div class="markdown-body">${renderedPlan}</div>
      </div>

      ${footerHtml}
    `,
  });

  // Wire everything up after the modal DOM is live.
  requestAnimationFrame(() => {
    const modal = document.querySelector('.modal-backdrop .modal');
    const modalBody = document.getElementById('modalBody');
    if (!modal || !modalBody) return;

    // Make the modal a flex column so the plan body can scroll while the
    // action bar stays fully visible at the bottom. Without this, a long
    // plan pushes the footer out of the viewport.
    modal.style.display = 'flex';
    modal.style.flexDirection = 'column';
    modal.style.overflow = 'hidden';
    modalBody.style.flex = '1 1 auto';
    modalBody.style.minHeight = '0';
    modalBody.style.overflow = 'hidden';
    modalBody.style.display = 'flex';
    modalBody.style.flexDirection = 'column';

    // Apply syntax highlighting inside the plan body
    if (typeof Prism !== 'undefined') {
      Prism.highlightAllUnder(modalBody.querySelector('.markdown-body'));
    }

    // Read-only: just wire the Close button and bail out before the
    // approve/modify/cancel logic runs.
    if (viewOnly) {
      const closeBtn = document.getElementById('planCloseBtn');
      closeBtn?.addEventListener('click', () => closeModal());
      return;
    }

    const laterBtn = document.getElementById('planLaterBtn');
    const cancelBtn = document.getElementById('planCancelBtn');
    const modifyBtn = document.getElementById('planModifyBtn');
    const approveBtn = document.getElementById('planApproveBtn');
    const feedbackArea = document.getElementById('planFeedbackArea');
    if (!laterBtn || !cancelBtn || !modifyBtn || !approveBtn) return;

    let feedbackMode = false;

    // ── "Review later" — just close, keep the plan pending in notifications
    laterBtn.addEventListener('click', () => {
      state.set('planReviewActive', false);
      state.set('activePlanReviewId', null);
      closeModal();
    });

    // ── "Cancel project" — destructive, requires confirmation
    cancelBtn.addEventListener('click', async () => {
      if (!confirm(t('planReview.cancelConfirm'))) return;
      try {
        const { api } = await import('../api.js');
        const { showToast } = await import('./toast.js');
        await api.planReviews.resolve(reviewId, 'cancelled');
        showToast('warning', t('planReview.projectCancelled'));
        state.set('planReviewActive', false);
        state.set('activePlanReviewId', null);
        closeModal();
      } catch (err) {
        console.error('[plan-review] Cancel error:', err);
        const { showToast } = await import('./toast.js');
        showToast('error', `${t('planReview.cancelError')}: ${err.message}`);
      }
    });

    // ── "Modify" — toggle feedback mode; hide irrelevant buttons
    modifyBtn.addEventListener('click', () => {
      feedbackMode = true;
      if (feedbackArea) feedbackArea.style.display = 'block';
      modifyBtn.style.display = 'none';
      laterBtn.style.display = 'none';
      cancelBtn.style.display = 'none';
      approveBtn.textContent = t('planReview.sendModifications');
      approveBtn.classList.remove('btn-primary');
      approveBtn.style.cssText = 'border: 1px solid var(--accent-blue); color: var(--accent-blue);';
      document.getElementById('planFeedback')?.focus();
    });

    // ── "Approve" (or "Send modifications" in feedback mode)
    approveBtn.addEventListener('click', async () => {
      approveBtn.disabled = true;
      const originalLabel = approveBtn.textContent;
      approveBtn.textContent = '...';
      try {
        const { api } = await import('../api.js');
        const { showToast } = await import('./toast.js');

        if (feedbackMode) {
          const feedback = document.getElementById('planFeedback')?.value?.trim();
          if (!feedback) throw new Error(t('planReview.feedbackRequired'));
          await api.planReviews.resolve(reviewId, 'revised', feedback);
          showToast('info', t('planReview.revisionRequested'));
        } else {
          await api.planReviews.resolve(reviewId, 'approved');
          showToast('success', t('planReview.planApproved'));
        }

        state.set('planReviewActive', false);
        state.set('activePlanReviewId', null);
        closeModal();
      } catch (err) {
        console.error('[plan-review] Approve/revise error:', err);
        const { showToast } = await import('./toast.js');
        showToast('error', err.message || t('common.error'));
        approveBtn.disabled = false;
        approveBtn.textContent = originalLabel;
      }
    });
  });
}

function escHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
