import { randomUUID } from "crypto";
import { log, emitSpeakerNotification } from "./logger.js";
import { serverMsg } from "./i18n.js";
import { getAgent, getActiveTaskId, setActiveTask, updateAgentTaskStatus, isStandaloneAgent } from "../db/queries/agents.js";
import { getNextPendingTask, markTaskProcessing, markTaskCompleted, markTaskFailed, getQueueLength } from "../db/queries/agent-task-queue.js";
import { getTask, getTaskStatus } from "../db/queries/tasks.js";
import { spawnClaudeTask } from "./spawner.js";
import { agentSend } from "./agent-bus.js";
import { onTaskCompleted } from "./task-completion-bus.js";

// Track processors currently running to prevent concurrent processing of same agent
const activeProcessors = new Set();

/**
 * Deliver task completion to the agent's web chat + every channel the agent
 * is reachable on (WhatsApp, Telegram, Discord, Slack, Signal — present and
 * future). Function name kept for the existing static test grep at
 * tests/whatsapp-agent-routing.test.js; the body is now channel-agnostic.
 *
 * Sequence on success:
 *   1. raw result → web chat only (collapsed accordion via source='task_result_raw')
 *   2. "✅ task completed" status → all surfaces via deliverTaskMessage
 *   3. polished follow-up via reformulateResult → all surfaces; on failure,
 *      raw fallback to non-WhatsApp channels (preserves the previous
 *      sendResultToOriginChannel safety net that protected Telegram users)
 *   4. media block (images/PDFs detected in stdout or registered by tools)
 *
 * Setup tasks (agent_init): only the agentSetupDone notification fires.
 *
 * @param {string}  agentId   - target agent
 * @param {string}  result    - raw task result text
 * @param {boolean} isSetup   - true for the initial agent setup task
 * @param {string}  taskId    - task id (for media asset lookup)
 * @param {object}  queueTask - agent_task_queue row (carries source_id for origin routing)
 */
/**
 * Build a short, voice-friendly one-liner from a raw task result for the
 * Yabby mirror turn. The raw result often contains Markdown tables, lists,
 * section headings, review IDs, or multi-paragraph reports — none of which
 * are useful as a spoken notification.
 *
 * Strategy: scan the first few non-empty lines and pick the first one that
 * looks like a real content sentence (subject + verb-ish, not a section
 * heading). Skip lines that are purely titles ("Review Summary:", "Status:")
 * or Markdown structure (table rows, code fences, IDs). If nothing usable
 * surfaces, return an empty string — the localizer + caller fall back to a
 * generic neutral announcement.
 */
function buildMirrorSummary(result) {
  if (!result || typeof result !== 'string') return '';
  const head = result.replace(/\r/g, '').trim().slice(0, 1500);
  if (!head) return '';

  // Drop common Markdown headings/list markers from the front so the lines
  // read cleanly.
  const cleaned = head
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*•]\s+/gm, '')
    .replace(/^\d+[.)]\s+/gm, '');

  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);

  // A line is "structural" (skip it) when it looks like Markdown framing or a
  // section heading rather than a sentence.
  const isStructural = (line) => {
    if (!line) return true;
    if (/\||```|review id\s*:|status\s*\|/i.test(line)) return true;
    // Trailing colon with no sentence-ending punctuation = section heading
    // (e.g. "Review Summary:", "Next Steps:", "Résumé :").
    if (/[:：]\s*$/.test(line) && !/[.!?…]/.test(line)) return true;
    // Very short label-like line: < 5 words AND no terminal punctuation.
    const wordCount = line.split(/\s+/).length;
    if (wordCount < 5 && !/[.!?…]/.test(line)) return true;
    return false;
  };

  // Find the first content line and extract its first sentence.
  for (const line of lines.slice(0, 8)) {
    if (isStructural(line)) continue;
    const sentenceMatch = line.match(/^(.+?[.!?…])(\s|$)/);
    let sentence = sentenceMatch ? sentenceMatch[1] : line;
    sentence = sentence.replace(/\s+/g, ' ').trim();
    if (!sentence) continue;
    if (sentence.length > 180) sentence = sentence.slice(0, 177).trimEnd() + '…';
    return sentence;
  }

  return '';
}

async function sendResultToWhatsAppThread(agentId, result, isSetup = false, taskId = null, queueTask = null) {
  try {
    log(`[QUEUE] 📤 sendResultToWhatsAppThread called`);
    log(`[QUEUE]    - agentId: ${agentId}`);
    log(`[QUEUE]    - isSetup: ${isSetup}`);
    log(`[QUEUE]    - taskId: ${taskId}`);
    log(`[QUEUE]    - result: ${result ? `${result.length} chars` : 'null'}`);

    const isYabby = agentId === "yabby-000000";
    const { getOrCreateAgentConversation, addTurn } = await import("../db/queries/conversations.js");
    const conversationId = isYabby
      ? "00000000-0000-0000-0000-000000000001"
      : await getOrCreateAgentConversation(agentId);
    const { deliverTaskMessage } = await import("./channels/task-delivery.js");

    // === SETUP TASKS ===
    // Single confirmation, no raw dump, no reformulation — same UX as before.
    if (isSetup) {
      try {
        await deliverTaskMessage({
          agentId,
          conversationId,
          text: serverMsg().agentSetupDone,
          queueTask,
          isYabby,
          systemMarker: true,
        });
      } catch (err) {
        log(`[QUEUE] Setup completion notification failed (non-fatal): ${err.message}`);
      }
      log(`[QUEUE] ⏭️  Setup done — confirmation sent`);
      return;
    }

    // === 1. RAW RESULT — web chat only (collapsed accordion in the UI) ===
    // Tagged with source='task_result_raw' so the frontend can render it
    // distinctly. The source is in the channelSources blocklist of
    // notification-listener.js so it does NOT cross-post via the Redis
    // pubsub forwarder.
    if (result && typeof result === 'string') {
      try {
        const turn = await addTurn('assistant', result, conversationId, 'task_result_raw');
        const { emitConversationUpdate } = await import("./logger.js");
        await emitConversationUpdate(conversationId, turn.turnCount);
        log(`[QUEUE] ✅ Saved raw result to agent conversation ${conversationId} (web only)`);
      } catch (err) {
        log(`[QUEUE] Raw result write failed (non-fatal): ${err.message}`);
      }
    }

    // === 2. COMPLETED STATUS — all surfaces ===
    try {
      await deliverTaskMessage({
        agentId,
        conversationId,
        text: serverMsg().taskSuccess,
        queueTask,
        isYabby,
        systemMarker: true,
      });
    } catch (err) {
      log(`[QUEUE] taskSuccess delivery failed (non-fatal): ${err.message}`);
    }

    // === 3. POLISHED FOLLOW-UP — all surfaces, with raw fallback for
    //        non-WhatsApp channels if reformulation fails (preserves the
    //        safety net the old sendResultToOriginChannel had at line 233).
    //
    // Skip rule for the Yabby super-agent: only when the Realtime voice is
    // genuinely ACTIVE (mic open, DataChannel live) will OpenAI Realtime
    // receive the [task completed] system marker and produce its own
    // contextual reply, which notification-listener then mirrors to other
    // channels. In that case generating a parallel gpt-4.1-nano polish would
    // duplicate the same answer in two styles.
    //
    // The web page being open is NOT enough — when the user has put the
    // session in standby (wake-word suspended), SSE stays connected but
    // Realtime is gone, so nobody speaks the result. The client signals
    // its true state via POST /api/voice/state → Redis key voice:active
    // (60s TTL, refreshed every 30s while active). Falsy/missing key
    // means voice is suspended or the tab is closed → keep the polish.
    let skipPolished = false;
    if (isYabby && result && typeof result === 'string') {
      try {
        const { redis, KEY } = await import("../db/redis.js");
        const voiceActive = await redis.get(KEY("voice:active"));
        if (voiceActive === "1") {
          skipPolished = true;
          log(`[QUEUE] Yabby polished SKIPPED — voice is active (Realtime will reply contextually)`);
        } else {
          log(`[QUEUE] Yabby polished KEPT — voice is suspended/idle (Realtime not engaged)`);
        }
      } catch (err) {
        log(`[QUEUE] Voice-active check failed (keeping polished as default): ${err.message}`);
      }
    }

    if (result && typeof result === 'string' && !skipPolished) {
      let followUp = null;
      try {
        const { reformulateResult } = await import("./channels/notification-listener.js");
        followUp = await reformulateResult(result);
      } catch (err) {
        log(`[QUEUE] Reformulation threw (non-fatal): ${err.message}`);
      }

      if (followUp) {
        try {
          await deliverTaskMessage({
            agentId,
            conversationId,
            text: followUp,
            queueTask,
            isYabby,
          });
          log(`[QUEUE] ✅ Sent reformulated follow-up to all surfaces`);
        } catch (err) {
          log(`[QUEUE] Follow-up delivery failed (non-fatal): ${err.message}`);
        }
      } else {
        // Reformulation failed/unavailable. WhatsApp users still got the raw
        // result via the conversation history that the agent reads back when
        // they ask. Non-WhatsApp origin channels would otherwise see only the
        // status bubble — send the raw as fallback so they don't lose the
        // actual answer.
        if (queueTask?.source_id && typeof queueTask.source_id === 'string') {
          const sep = queueTask.source_id.indexOf(':');
          if (sep > 0) {
            const channelName = queueTask.source_id.slice(0, sep);
            const chatId = queueTask.source_id.slice(sep + 1);
            if (channelName !== 'whatsapp' && chatId) {
              try {
                const { getChannel } = await import("./channels/index.js");
                const adapter = getChannel(channelName);
                if (adapter?.running) {
                  await adapter.send(chatId, result);
                  log(`[QUEUE] ⚠ Reformulation unavailable, sent raw result to ${channelName}:${chatId}`);
                }
              } catch (err) {
                log(`[QUEUE] Raw fallback to ${channelName} failed: ${err.message}`);
              }
            }
          }
        }
      }
    }

    // === 4. MEDIA — images/PDFs detected in stdout or registered by tools.
    // Re-resolves the WhatsApp group + channel bindings since the helper
    // above doesn't return them. Same logic as before; unchanged behavior.
    try {
      const { getAgentWhatsAppGroup } = await import("../db/queries/agent-whatsapp-groups.js");
      const { getChannel } = await import("./channels/index.js");
      const whatsapp = getChannel("whatsapp");
      const whatsappGroup = isYabby
        ? (whatsapp?._yabbyGroupId ? { group_id: whatsapp._yabbyGroupId } : null)
        : await getAgentWhatsAppGroup(agentId);

      const { extractMediaPaths } = await import("./media/extract-paths.js");
      const { write: storeWrite } = await import("./media/store.js");
      const { readFile } = await import("fs/promises");

      // Source 1: structured assetIds collected by spawner from tool results
      const { taskMediaAssets } = await import("./spawner.js");
      const structuredAssets = taskId ? (taskMediaAssets.get(taskId) || []) : [];
      if (taskId) taskMediaAssets.delete(taskId);

      // Source 2: file paths detected in result text
      const detectedFiles = result ? await extractMediaPaths(result) : [];

      // Ingest detected files into media store
      const ingestedAssets = [];
      for (const file of detectedFiles) {
        try {
          const buffer = await readFile(file.path);
          const asset = await storeWrite(buffer, file.mime, {
            source: "task", metadata: { taskId, agentId, path: file.path }
          });
          ingestedAssets.push({ assetId: asset.id, mime: file.mime });
          log(`[QUEUE] Ingested ${file.path} → asset ${asset.id}`);
        } catch (err) {
          log(`[QUEUE] Failed to ingest ${file.path}: ${err.message}`);
        }
      }

      // Merge both sources
      const allAssets = [
        ...structuredAssets.map(id => ({ assetId: id, mime: null })),
        ...ingestedAssets,
      ];

      if (allAssets.length > 0) {
        // Collect all channels this agent is reachable on
        const targets = [];
        if (whatsapp?.running && whatsappGroup?.group_id) {
          targets.push({ channelName: "whatsapp", chatId: whatsappGroup.group_id, adapter: whatsapp });
        }
        try {
          const { getThreadManager } = await import("./channels/thread-binding-manager.js");
          const manager = getThreadManager("_global", "main");
          const bindings = await manager.getAllByAgentId(agentId);
          for (const b of bindings) {
            if (b.channel_name === "whatsapp") continue; // already handled
            const adapter = getChannel(b.channel_name);
            if (adapter?.running) {
              targets.push({ channelName: b.channel_name, chatId: b.thread_id, adapter });
            }
          }
        } catch (err) {
          log(`[QUEUE] Thread binding lookup failed (non-fatal): ${err.message}`);
        }

        log(`[QUEUE] 📸 Dispatching ${allAssets.length} media asset(s) to ${targets.length} channel(s)`);
        for (const { channelName, chatId, adapter } of targets) {
          for (const { assetId, mime } of allAssets) {
            try {
              const isImage = mime && mime.startsWith("image/");
              if (isImage) {
                await adapter.sendImage(chatId, { assetId });
              } else {
                await adapter.sendDocument(chatId, { assetId });
              }
              log(`[QUEUE] ✅ Sent ${assetId} to ${channelName}:${chatId}`);
            } catch (err) {
              log(`[QUEUE] ⚠ Failed ${assetId} on ${channelName}: ${err.message}`);
            }
          }
        }
      }
    } catch (err) {
      log(`[QUEUE] Media extraction/dispatch failed (non-fatal): ${err.message}`);
    }

    // === 5. YABBY MIRROR — top-level project agent completions are mirrored
    // into the Yabby super-agent conversation so every Yabby surface (web
    // Yabby chat panel, voice resume context, Yabby's bound WhatsApp /
    // Telegram / Discord / Slack) sees the same timeline non-project mode
    // already enjoys. The agent's own conversation + bound thread keep the
    // full raw + polished turns; this is just a one-line notification.
    //
    // Gating: top-level agents (no parentAgentId) AND attached to a project
    // (projectId !== null). Standalone conversational agents (e.g. one
    // that posts a daily joke) don't produce technical deliverables — their
    // results are casual messages that don't belong in Yabby's main
    // timeline, and mirroring them would also confuse Realtime ("🔔 Julia:
    // Hi!" reads as user-from-Julia and Yabby would reply to "Julia").
    //
    // Sub-agent completions notify their parent via agentSend; the
    // parent's eventual review-task completion is what propagates here.
    //
    // The mirror also fires its own emitSpeakerNotification so voice
    // announces top-level completions even when the spawner takes the
    // discovery-phase short-circuit (which silences voice for plan
    // submissions, team-assembly tasks, etc.). The 5s dedup inside
    // emitSpeakerNotification prevents echo when the spawner already fired.
    // ─── MIRROR ENTRY ────────────────────────────────────────────────────
    // Detailed entry log so we can see at a glance whether the mirror block
    // even tried to run for this completion. If you don't see this line
    // for a top-level project agent, the gating before us (isYabby /
    // result missing / wrong type) excluded it.
    log(`[MIRROR] entry — agentId=${agentId} isYabby=${isYabby} hasResult=${!!result} resultLen=${typeof result === 'string' ? result.length : 'n/a'} taskId=${taskId}`);

    if (!isYabby && result && typeof result === 'string') {
      try {
        const agent = await getAgent(agentId);
        log(`[MIRROR] agent=${agent?.name || '<missing>'} parentAgentId=${agent?.parentAgentId || 'null'} projectId=${agent?.projectId || 'null'}`);
        if (!agent) {
          log(`[MIRROR] ⛔ SKIP — agent not found (agentId=${agentId})`);
        } else if (agent.parentAgentId) {
          log(`[MIRROR] ⛔ SKIP — sub-agent (parentAgentId=${agent.parentAgentId}); parent's review task will mirror instead`);
        } else if (!agent.projectId) {
          log(`[MIRROR] ⛔ SKIP — standalone agent (no projectId); mirror is for project agents only`);
        }
        if (agent && !agent.parentAgentId && agent.projectId) {
          // Skip the mirror in three cases where a parallel path already
          // covers the user-visible signal:
          //
          // 1. Discovery phase — the kickoff/discovery task is internal
          //    prep, not a user-visible deliverable. Mirroring it would
          //    announce "project completed" before the lead has done any
          //    actual work. Matches the spawner's existing gate at
          //    spawner.js:1088 which silences voice in discovery for
          //    exactly the same reason.
          //
          // 2. plan_reviews row exists for this taskId — handleSSEPlanReview
          //    already opens the modal and announces the plan via voice.
          //
          // 3. project_questions row exists for this agent in the last
          //    5 minutes — handleSSEProjectQuestion already prompts the
          //    user via the voice channel.
          let skipMirror = false;
          let skipReason = '';
          // ─── PHASE CHECK ──
          try {
            const taskRecord = taskId ? await getTask(taskId) : null;
            const phase = taskRecord?.phase ?? '<no-phase>';
            log(`[MIRROR] phase check — taskId=${taskId} phase="${phase}"`);
            if (taskRecord?.phase === 'discovery') {
              skipMirror = true;
              skipReason = `discovery phase (taskId=${taskId})`;
            }
          } catch (err) {
            log(`[MIRROR] phase check failed (proceeding): ${err.message}`);
          }
          // ─── SPECIALIZED-EVENT CHECK ──
          if (!skipMirror) {
            try {
              const { query } = await import("../db/pg.js");
              const planRow = taskId
                ? await query(
                    `SELECT 1 FROM plan_reviews WHERE task_id = $1 LIMIT 1`,
                    [taskId]
                  )
                : { rows: [] };
              const questionRow = await query(
                `SELECT 1 FROM project_questions
                 WHERE agent_id = $1 AND created_at > NOW() - INTERVAL '5 minutes'
                 LIMIT 1`,
                [agentId]
              );
              log(`[MIRROR] specialized-event check — planRows=${planRow.rows.length} questionRows=${questionRow.rows.length}`);
              if (planRow.rows.length > 0) {
                skipMirror = true;
                skipReason = `plan_review row exists for taskId=${taskId}`;
              } else if (questionRow.rows.length > 0) {
                skipMirror = true;
                skipReason = `project_question row exists for agentId=${agentId} (5min window)`;
              }
            } catch (err) {
              log(`[MIRROR] specialized-event check failed (proceeding): ${err.message}`);
            }
          }
          // ─── RAW OUTPUT PERSIST ──
          // Persist the raw task result into Yabby's main conversation as
          // a `task_result_raw` turn. The voice-panel renders this source
          // type as a collapsed `<details>` accordion ("View raw output" /
          // "Voir la sortie brute"), so the user can inspect what the
          // agent actually produced without polluting the timeline. This
          // is INDEPENDENT of the mirror skip logic — even when the short
          // mirror notification is suppressed (discovery phase, plan_review
          // already covers it, etc.), the raw output still belongs in the
          // Yabby panel as completion evidence. Channels skip this source
          // automatically via notification-listener's internalSources
          // filter so it never reaches WhatsApp/Telegram/etc.
          //
          // When the task submitted a plan_review, we APPEND the full
          // plan_content as an annexe so the accordion contains both the
          // agent's spoken-style recap (the raw `result`) AND the
          // detailed plan markdown — one accordion, two readable
          // sections. The Realtime model also gets both when it reads
          // history, which lets it answer follow-up questions like "what
          // was the design palette in the plan?" naturally.
          try {
            const { addTurn } = await import("../db/queries/conversations.js");
            const { emitConversationUpdate } = await import("./logger.js");
            let bodyText = result;
            try {
              if (taskId) {
                const { query: pgQuery } = await import("../db/pg.js");
                const planRow = await pgQuery(
                  `SELECT plan_content FROM plan_reviews WHERE task_id = $1 ORDER BY created_at DESC LIMIT 1`,
                  [taskId]
                );
                if (planRow.rows[0]?.plan_content) {
                  bodyText = `${result}\n\n---\n\n## 📋 Plan complet\n\n${planRow.rows[0].plan_content}`;
                  log(`[MIRROR] 📋 plan_content annexe appended (${planRow.rows[0].plan_content.length} chars)`);
                }
              }
            } catch (annexErr) {
              log(`[MIRROR] plan annexe lookup failed (proceeding with raw result only): ${annexErr.message}`);
            }
            const turn = await addTurn(
              'assistant',
              bodyText,
              "00000000-0000-0000-0000-000000000001",
              'task_result_raw'
            );
            await emitConversationUpdate("00000000-0000-0000-0000-000000000001", turn.turnCount);
            log(`[MIRROR] 📋 raw output persisted to Yabby panel (${bodyText.length} chars, source=task_result_raw)`);
          } catch (err) {
            log(`[MIRROR] raw output persist failed (non-fatal): ${err.message}`);
          }

          // ─── DECISION ──
          if (skipMirror) {
            log(`[MIRROR] ⛔ SKIP — ${skipReason}`);
          } else {
            log(`[MIRROR] ✅ FIRE — no skip condition matched, will run summarizer + speaker_notify`);
          }
          if (!skipMirror) {
            // One LLM pass extracts the actual accomplishment + writes it
            // in the user's language, skipping section headings ("Status
            // update:", "Review Summary:") and Markdown framing that the
            // local regex couldn't reliably catch. On failure, fall back
            // to the heuristic, then to a generic English line as last
            // resort.
            const { summarizeMirrorFromResult } = await import("./channels/notification-listener.js");
            const llmSummary = await summarizeMirrorFromResult(result, agent.name);
            // The LLM was asked to use the agent name as the sentence
            // subject ("Emma has shipped the backend..."). The heuristic
            // fallback doesn't know about the agent, so we prepend the
            // name there. Both produce a third-person report so Realtime
            // doesn't mistake the agent for the user — that was the bug
            // where Yabby started replying "Bonjour Julia!" to a
            // Julia-mirror turn.
            const summary =
              llmSummary ||
              (buildMirrorSummary(result) && `${agent.name} — ${buildMirrorSummary(result)}`) ||
              `${agent.name} has finished a task.`;
            const mirror = `🔔 ${summary}`;
            await deliverTaskMessage({
              agentId: "yabby-000000",
              conversationId: "00000000-0000-0000-0000-000000000001",
              text: mirror,
              queueTask,
              isYabby: true,
            });
            try {
              emitSpeakerNotification(
                agent,
                agent.projectId,
                "milestone",
                summary,
                { skipChannelBroadcast: true, taskId }
              );
            } catch (err) {
              log(`[QUEUE] Yabby mirror speaker_notify failed (non-fatal): ${err.message}`);
            }
            log(`[QUEUE] ✅ Mirrored ${agent.name} completion to Yabby surfaces`);
          }
        }
      } catch (err) {
        log(`[QUEUE] Yabby mirror failed (non-fatal): ${err.message}`);
      }
    }
  } catch (err) {
    log(`[QUEUE] ❌ Failed to deliver task result:`, err.message);
    // Don't throw - this is best-effort
  }
}

// sendResultToOriginChannel was removed in the multi-channel parity refactor.
// Its responsibilities — delivering the polished result to a non-WhatsApp
// originating channel and falling back to the raw result on reformulation
// failure — are now part of sendResultToWhatsAppThread above via
// deliverTaskMessage and the explicit raw-fallback branch in step 3.

/**
 * Identifies agents whose parent should receive auto-notifs on task
 * completion. Used by notifyParentOnSubAgentDone and cleanupAfterTask.
 *
 * Since all agents (including former "sub-agents") now run in persistent
 * mode (--resume between queue items), this function no longer gates the
 * "new session per task" behavior. The multi-task split is gone — every
 * non-Yabby agent keeps one task row for life, just like leads.
 *
 * It still returns true for agents that have a parent (explicit or
 * implicit via project lead) so the auto-notif chain works.
 */
function isSubAgent(agent) {
  return !!(agent.projectId && !agent.isLead);
}

/**
 * Resolves the effective parent of a sub-agent: parent_agent_id if set,
 * otherwise the project lead.
 */
async function resolveSubAgentParent(agent) {
  if (agent.parentAgentId) return agent.parentAgentId;
  if (!agent.projectId) return null;
  const { getProject } = await import("../db/queries/projects.js");
  const project = await getProject(agent.projectId);
  return project?.leadAgentId || null;
}

/**
 * Post-completion: ALL agents are persistent (one task row for life),
 * so we always keep active_task_id for the next --resume. The processor
 * gate uses tasks.status (not active_task_id) to detect "still running".
 */
async function cleanupAfterTask(agent, finishedTaskId) {
  log(`[QUEUE] Persistent agent ${agent.name} keeps task ${finishedTaskId} for next --resume`);
}

/**
 * Automatic notification to the lead when a sub-agent's task completes.
 * Server-side guarantee: the sub-agent has no URL to call, a notification
 * always reaches the parent.
 */
async function notifyParentOnSubAgentDone(agent, task) {
  if (!isSubAgent(agent)) return;

  const parentId = await resolveSubAgentParent(agent);
  if (!parentId) {
    log(`[QUEUE] No parent resolvable for sub-agent ${agent.name}, notif skipped`);
    return;
  }

  const content = task.result
    ? String(task.result)
    : "(the sub-agent completed without producing a final report)";

  try {
    await agentSend(agent.id, parentId, agent.projectId, content, 'task_complete');
    log(`[QUEUE] Auto task_complete sent: ${agent.name} → parent ${parentId}`);
  } catch (err) {
    log(`[QUEUE] Auto task_complete FAILED for ${agent.name}: ${err.message}`);
  }
}

/**
 * Process the queue of a standalone agent.
 * Called when:
 * - A new instruction is added
 * - The current task completes
 * - The user interrupts and resumes
 *
 * @param {string} agentId - Agent ID
 */
export async function processAgentQueue(agentId) {
  // Prevent concurrent processing for same agent
  if (activeProcessors.has(agentId)) {
    log(`[QUEUE] Processor already running for agent ${agentId}, skipping`);
    return;
  }

  activeProcessors.add(agentId);

  try {
    await _processAgentQueueInternal(agentId);
  } finally {
    activeProcessors.delete(agentId);
  }
}

async function _processAgentQueueInternal(agentId) {
  const agent = await getAgent(agentId);
  if (!agent) {
    log(`[QUEUE] Agent ${agentId} not found`);
    return;
  }

  // Only for standalone agents
  if (!await isStandaloneAgent(agentId)) {
    log(`[QUEUE] Agent ${agent.name} is not standalone, skipping queue`);
    return;
  }

  // Check if the agent already has a running task
  const activeTaskId = await getActiveTaskId(agentId);
  if (activeTaskId) {
    const taskStatus = await getTaskStatus(activeTaskId);
    if (taskStatus === 'running') {
      log(`[QUEUE] Agent ${agent.name} has running task ${activeTaskId}, skipping`);
      return; // Task in progress, nothing to do
    }
  }

  // Get the next pending instruction
  const nextTask = await getNextPendingTask(agentId);
  if (!nextTask) {
    log(`[QUEUE] No pending tasks for agent ${agent.name}`);
    await updateAgentTaskStatus(agentId, 'idle');
    return;
  }

  log(`[QUEUE] Processing queue item ${nextTask.id} for agent ${agent.name} (source: ${nextTask.source})`);
  await markTaskProcessing(nextTask.id);

  try {
    // ALL non-Yabby agents run in persistent mode: one task row for life,
    // --resume between queue items, full context preserved. The old
    // "multi-task" split for sub-agents (fresh session per queue item) is
    // gone — it wasted ~15-25k tokens of preamble per task.
    //
    // Special modes:
    //   - api_resume: explicit resume of a past archived task (lead decides)
    //   - api_fork: fork the agent's current session (--fork-session) for a
    //     domain shift where old context is irrelevant but identity is kept.

    // Explicit resume of a past task
    let explicitResumeTaskId = null;
    if (nextTask.source === 'api_resume' && nextTask.source_id) {
      const candidate = await getTask(nextTask.source_id);
      if (candidate && candidate.agentId === agent.id && candidate.sessionId) {
        explicitResumeTaskId = candidate.id;
      } else {
        log(`[QUEUE] api_resume fallback — source_id=${nextTask.source_id} unusable, will spawn fresh`);
      }
    }

    // Fork mode: create a new session that inherits the current one's history
    // but is independent going forward. Used for domain shifts.
    const isForkMode = nextTask.source === 'api_fork';

    // currentTaskId: the active task to resume. null = create new task.
    // Fork mode forces null (we want a new task row with a forked session).
    let currentTaskId = explicitResumeTaskId
      ? explicitResumeTaskId
      : (isForkMode ? null : activeTaskId);

    // Track whether this is a resume (skip "task launched" notification for resumes)
    const isResumedTask = !!currentTaskId;

    const isYabbySuperAgent = agentId === 'yabby-000000';
    const taskPhase = isYabbySuperAgent ? 'execution' : 'discovery';

    // All agents get "Persistent task" as task row title (the queue item
    // title tracks the specific work being done).
    const taskTitle = `[${agent.name}] ${serverMsg().persistentTask}`;

    // If the agent has no active task, create a NEW one
    // (also when fork mode — we always create a new task row for forks)
    if (!currentTaskId) {
      const newTaskId = genTaskId();

      // Fork mode: --resume <parent session> --fork-session. The CLI creates a
      // new session that inherits history from the parent but is independent.
      // We need the parent's session_id from the agent's most recent task.
      if (isForkMode && activeTaskId) {
        const parentTask = await getTask(activeTaskId);
        if (parentTask?.sessionId) {
          log(`[QUEUE] Forking session for agent ${agent.name}: parent=${parentTask.sessionId}`);
          await spawnClaudeTask(newTaskId, parentTask.sessionId, nextTask.instruction, true, {
            agentId: agent.id,
            projectId: agent.projectId || null,
            title: taskTitle,
            phase: taskPhase,
            forkSession: true,
            metadata: { source: 'api_fork', queueTitle: nextTask.title || null }
          });
          await setActiveTask(agentId, newTaskId);
          currentTaskId = newTaskId;
          log(`[QUEUE] Forked task ${newTaskId} from session ${parentTask.sessionId}`);
        } else {
          log(`[QUEUE] Fork requested but no parent session — creating fresh`);
          // Fall through to normal fresh creation below
        }
      }

      // Normal fresh creation (first task ever, or fork fallback)
      if (!currentTaskId) {
        const sessionId = randomUUID();
        log(`[QUEUE] Creating persistent task for agent ${agent.name}: "${taskTitle}"`);

        await spawnClaudeTask(newTaskId, sessionId, nextTask.instruction, false, {
          agentId: agent.id,
          projectId: agent.projectId || null,
          title: taskTitle,
          phase: taskPhase,
          metadata: { source: nextTask.source, queueTitle: nextTask.title || null }
        });

        await setActiveTask(agentId, newTaskId);
        currentTaskId = newTaskId;
        log(`[QUEUE] Created persistent task ${newTaskId} with session ${sessionId} (phase: ${taskPhase})`);
      }
    } else {
      // CONTINUE the existing task with --resume
      log(`[QUEUE] Continuing task ${currentTaskId} for agent ${agent.name}: "${taskTitle}"`);
      const taskEntry = await getTask(currentTaskId);

      if (!taskEntry) {
        log(`[QUEUE] ERROR: Active task ${currentTaskId} not found, creating new one`);
        // Fallback: Create new task
        const newTaskId = genTaskId();
        const sessionId = randomUUID();
        await spawnClaudeTask(newTaskId, sessionId, nextTask.instruction, false, {
          agentId: agent.id,
          projectId: agent.projectId || null,
          title: taskTitle,
          phase: taskPhase,
          metadata: { source: nextTask.source, queueTitle: nextTask.title || null }
        });
        await setActiveTask(agentId, newTaskId);
        currentTaskId = newTaskId;
      } else {
        // Continue with the existing session_id via --resume
        // Pass agentId + projectId so the spawner can:
        //   - Generate .claude-settings.json with the PreToolUse hook
        //   - Resolve the agent's current workspace (including override)
        //   - Inject the agent context block into the system prompt
        await spawnClaudeTask(
          currentTaskId,           // Same task_id
          taskEntry.sessionId,     // Session_id retrieved from DB
          nextTask.instruction,
          true,                    // isResume = true → utilise --resume
          {
            agentId: agent.id,
            projectId: agent.projectId || null,
            isRetry: true,         // Task already exists in DB — don't re-create
          }
        );
        // When we're resuming explicitly (sub-agent lead-driven resume), sync
        // active_task_id so agent_intervention, queue gating, and intervention
        // routing all agree on which task is current.
        if (explicitResumeTaskId) {
          await setActiveTask(agentId, currentTaskId);
        }
        log(`[QUEUE] Resumed task ${currentTaskId} with session ${taskEntry.sessionId}${explicitResumeTaskId ? ' (explicit resume)' : ''}`);
      }
    }

    await updateAgentTaskStatus(agentId, 'running');

    // Notify task started — always notify so the user sees activity.
    // Fans out to web chat + WhatsApp + every bound channel + originating
    // channel via the unified delivery helper.
    try {
      const { deliverTaskMessage } = await import("./channels/task-delivery.js");
      const { getOrCreateAgentConversation } = await import("../db/queries/conversations.js");
      const convId = isYabbySuperAgent
        ? "00000000-0000-0000-0000-000000000001"
        : await getOrCreateAgentConversation(agentId);
      const startMessage = nextTask.source === 'agent_init'
        ? serverMsg().agentSetup
        : serverMsg().taskLaunched;
      // Fan out [task launched] to all surfaces (web chat + WhatsApp +
      // every bound channel + originating channel). The LLM-handler may
      // also have just sent its own ack ("Launched, I'll update you...")
      // on the originating channel, so users on that channel see two
      // launch-style bubbles: the LLM ack first, then this canonical
      // system marker. The duplication is intentional — the system marker
      // makes the timeline scannable (matches [task completed] symmetry)
      // and works even when the LLM ack is missing/short/in another lang.
      await deliverTaskMessage({
        agentId,
        conversationId: convId,
        text: startMessage,
        queueTask: nextTask,
        isYabby: isYabbySuperAgent,
        systemMarker: true,
      });
    } catch (err) {
      log(`[QUEUE] Task started notification failed (non-fatal): ${err.message}`);
    }

    // Register a one-shot listener on the task-completion bus; the spawner
    // will emit when the task reaches a terminal status. No polling, no
    // arbitrary timeout. The listener handles all the post-completion work
    // (queue item cleanup, auto-notif to parent, cascade advancement, next
    // queue item trigger). We return immediately so the processor lock
    // releases and other agents' queues aren't blocked.
    const queueId = nextTask.id;
    onTaskCompleted(currentTaskId, async (event) => {
      try {
        await handleTaskTerminal(currentTaskId, agentId, queueId, event.status);
      } catch (err) {
        log(`[QUEUE] handleTaskTerminal failed for ${currentTaskId}: ${err.message}`);
      }
    });

  } catch (err) {
    log(`[QUEUE] Error processing task for ${agent.name}:`, err.message);
    await markTaskFailed(nextTask.id, err.message);
    await updateAgentTaskStatus(agentId, 'idle');

    // Notify the user
    emitSpeakerNotification(agent, null, "error", `${serverMsg().errorPrefix}: ${err.message}`);

    // Try to process next task anyway
    setImmediate(() => processAgentQueue(agentId));
  }
}

/**
 * Handle a task reaching a terminal status (done / error / killed /
 * paused_llm_limit). Called from the task-completion bus listener — no
 * polling, no timeout. All side effects that were previously spread across
 * the waitForTaskCompletion branches live here in one place.
 *
 * @param {string} taskId - Terminated task id
 * @param {string} agentId - Agent owning the task
 * @param {number} queueId - agent_task_queue row id that scheduled this task
 * @param {string} status - final status reported by the spawner
 */
async function handleTaskTerminal(taskId, agentId, queueId, status) {
  const task = await getTask(taskId);
  const agent = await getAgent(agentId);

  // paused_llm_limit is terminal from the spawner's point of view but the
  // task can be resumed manually later. We mark the queue item failed with
  // a clear reason so the UI shows it; the resume endpoint creates a new
  // queue item when the user hits "reprendre".
  if (status === 'paused_llm_limit') {
    await markTaskFailed(queueId, 'LLM rate limit reached (task paused, can be resumed later)');
    await updateAgentTaskStatus(agentId, 'paused');
    log(`[QUEUE] Task ${taskId} paused (LLM rate limit) for agent ${agentId}`);
    return;
  }

  if (status === 'done') {
    await markTaskCompleted(queueId, task?.result || null);
    if (agent) await cleanupAfterTask(agent, taskId);
    if (agent) await notifyParentOnSubAgentDone(agent, task || {});

    // Advance multi-agent cascade if this queue item was part of one.
    const { getQueueTask } = await import("../db/queries/agent-task-queue.js");
    const queueTask = await getQueueTask(queueId);
    if (queueTask?.multi_agent_task_id) {
      const { advanceCascadeIfNeeded } = await import("./multi-agent-orchestrator.js");
      await advanceCascadeIfNeeded(queueTask, processAgentQueue);
    }

    const isSetup = queueTask?.source === 'agent_init';
    if (isSetup) {
      log(`[QUEUE] This is a setup task, will send simple confirmation instead of raw result`);
    }
    // Unified delivery: web chat + WhatsApp + every bound channel + originating
    // channel. queueTask carries source_id for origin routing.
    await sendResultToWhatsAppThread(agentId, task?.result || null, isSetup, taskId, queueTask);

    log(`[QUEUE] Task ${taskId} completed for agent ${agentId}`);
  } else {
    // error or killed
    await markTaskFailed(queueId, task?.error || `Task ended with status ${status}`);
    if (agent) await cleanupAfterTask(agent, taskId);

    const { getQueueTask } = await import("../db/queries/agent-task-queue.js");
    const failedQueueTask = await getQueueTask(queueId);
    if (failedQueueTask?.multi_agent_task_id) {
      const { advanceCascadeIfNeeded } = await import("./multi-agent-orchestrator.js");
      await advanceCascadeIfNeeded(failedQueueTask, processAgentQueue);
    }

    log(`[QUEUE] Task ${taskId} failed (${status}) for agent ${agentId}`);
  }

  // Advance the queue for this agent (or mark idle if empty)
  const queueLength = await getQueueLength(agentId);
  if (queueLength > 0) {
    log(`[QUEUE] ${queueLength} task(s) remaining for agent ${agentId}, processing next`);
    setImmediate(() => processAgentQueue(agentId));
  } else {
    log(`[QUEUE] Queue empty for agent ${agentId}`);
    await updateAgentTaskStatus(agentId, 'idle');
  }
}

/**
 * Generate a task ID (8 characters)
 */
function genTaskId() {
  return randomUUID().slice(0, 8);
}
