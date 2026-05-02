/**
 * Multi-Agent Task Queue Orchestrator
 * ────────────────────────────────────
 * Avance une cascade de tâches `multi_agent_task_queue` étape par étape :
 * même `position` = exécution parallèle, `position` suivante = attend que
 * toute la position courante soit terminée.
 *
 * Appelé depuis `lib/agent-task-processor.js` quand un queue item termine.
 */

import { log } from "./logger.js";
import { getAgent, findAgentByName } from "../db/queries/agents.js";
import { enqueueTask } from "../db/queries/agent-task-queue.js";
import {
  getMultiAgentCascade,
  isCascadePositionDone,
  setCascadePosition,
  markCascadeCompleted,
  markCascadeFailed,
  markCascadeStarted,
} from "../db/queries/multi-agent-task-queue.js";

/**
 * Résout un agent_id ou nom vers un id canonique.
 */
async function resolveAgentId(idOrName) {
  if (!idOrName) return null;
  let a = await getAgent(idOrName);
  if (!a) a = await findAgentByName(idOrName);
  return a ? a.id : null;
}

/**
 * Enfile tous les items d'une position donnée sur la queue de leurs agents
 * respectifs. Déclenche le processor pour chaque agent cible.
 */
async function enqueuePositionItems(cascade, position, processAgentQueue) {
  const items = (cascade.items || []).filter(it => Number(it.position) === position);
  if (items.length === 0) return 0;

  for (const item of items) {
    const resolvedId = await resolveAgentId(item.agent_id);
    if (!resolvedId) {
      log(`[CASCADE ${cascade.id}] agent "${item.agent_id}" introuvable, skip`);
      continue;
    }
    await enqueueTask(
      resolvedId,
      item.instruction,
      'multi_agent',
      null,
      50,
      item.title,
      { multiAgentTaskId: cascade.id, multiAgentPosition: position }
    );
    log(`[CASCADE ${cascade.id}] enqueued "${item.title}" for ${resolvedId} (position ${position})`);
    // Fire-and-forget processor trigger per agent
    setImmediate(() => {
      processAgentQueue(resolvedId).catch(err => {
        log(`[CASCADE ${cascade.id}] processAgentQueue failed for ${resolvedId}: ${err.message}`);
      });
    });
  }
  return items.length;
}

/**
 * Démarre explicitement une cascade (position 0 → position 1).
 * Appelé une fois, au moment où l'initiateur (step 0) est enfilé.
 * La position 0 (l'initiateur) est déjà dans agent_task_queue.
 */
export async function startCascade(cascadeId, processAgentQueue) {
  const cascade = await getMultiAgentCascade(cascadeId);
  if (!cascade) return;
  await markCascadeStarted(cascadeId);
  log(`[CASCADE ${cascade.id}] started (owner=${cascade.owner_agent_id}, ${cascade.items.length} items)`);
}

/**
 * Appelé à chaque fin d'un queue item. Vérifie s'il fait partie d'une cascade
 * et avance la position si tous les items de la position courante sont finis.
 *
 * @param {object} finishedQueueItem - row agent_task_queue juste passée à completed/failed
 * @param {Function} processAgentQueue - référence à processAgentQueue (injected to avoid circular import)
 */
export async function advanceCascadeIfNeeded(finishedQueueItem, processAgentQueue) {
  const cascadeId = finishedQueueItem.multi_agent_task_id;
  if (!cascadeId) return; // not part of a cascade

  const cascade = await getMultiAgentCascade(cascadeId);
  if (!cascade || cascade.status !== 'running') return;

  const position = finishedQueueItem.multi_agent_position;
  if (position == null) return;

  // Is the current position fully done?
  const { done, hasFailures } = await isCascadePositionDone(cascadeId, position);
  if (!done) {
    log(`[CASCADE ${cascade.id}] position ${position} still has pending items, waiting`);
    return;
  }

  if (hasFailures && cascade.on_error === 'stop') {
    log(`[CASCADE ${cascade.id}] position ${position} had failures, stopping cascade (on_error=stop)`);
    await markCascadeFailed(cascade.id, `Position ${position} had failed items`);
    return;
  }

  // Advance to next position
  const nextPosition = position + 1;
  const hasNext = (cascade.items || []).some(it => Number(it.position) === nextPosition);

  if (!hasNext) {
    await markCascadeCompleted(cascade.id);
    log(`[CASCADE ${cascade.id}] all positions completed (last was ${position})`);
    return;
  }

  await setCascadePosition(cascade.id, nextPosition);
  const enqueued = await enqueuePositionItems(cascade, nextPosition, processAgentQueue);
  log(`[CASCADE ${cascade.id}] advanced to position ${nextPosition} (${enqueued} item(s) dispatched)`);
}

/**
 * Helper utilisé quand le queue item initial (step 0) vient d'être enfilé
 * sans être lié à une cascade existante MAIS avec une spec next_tasks.
 * Crée la cascade et met à jour le queue item pour qu'il soit lié à la
 * cascade comme étant en position 0.
 */
export async function bindInitialItemToCascade(initialQueueItemId, cascadeId) {
  const { query } = await import("../db/pg.js");
  await query(
    `UPDATE agent_task_queue
     SET multi_agent_task_id = $1, multi_agent_position = 0
     WHERE id = $2`,
    [cascadeId, initialQueueItemId]
  );
}
