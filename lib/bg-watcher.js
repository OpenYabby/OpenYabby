/**
 * YABBY — Background task watcher.
 *
 * Polls all `bg_tasks` rows with status='running' AND pid IS NOT NULL every
 * POLL_INTERVAL_MS and uses `process.kill(pid, 0)` to detect when the bg
 * process has exited at the OS level. This is independent of:
 *   - whether the parent CLI is still alive
 *   - whether the CLI emitted a task_notification
 *   - the runner profile (Claude / Codex / future runners)
 *
 * Signal 0 is a non-destructive existence check:
 *   - PID exists & we have permission → no error
 *   - PID gone → ESRCH error → we mark the bg_task completed
 *   - PID exists but no permission → EPERM → treat as still alive (rare;
 *     would mean the bg was started under a different uid, which we don't do)
 *
 * On detected completion:
 *   1. Read the tail of output_file (provided by the CLI on task_started)
 *      to capture exit-time context as the bg's summary
 *   2. UPDATE bg_tasks → status='completed', ended_at=NOW(), summary=tail
 *   3. enqueueTask(agentId, "[BG_COMPLETED] …", source='bg_job_complete')
 *      so the agent's next --resume turn reports back to the user
 *   4. Delete the pid file
 *
 * The watcher runs as a single background timer on the server. It does NOT
 * spawn child processes itself — just polls DB + OS.
 */

import { readFile, unlink, stat } from "fs/promises";
import { existsSync } from "fs";
import { log } from "./logger.js";
import { getRunningBgTasksWithPid, markBgTaskExit } from "../db/queries/bg-tasks.js";

const POLL_INTERVAL_MS = 30_000; // 30s — light enough for real-time-ish, easy on DB
const OUTPUT_TAIL_BYTES = 2000;

let timer = null;

export function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return true;
  } catch (err) {
    if (err.code === "ESRCH") return false; // process gone
    if (err.code === "EPERM") return true; // exists, not ours — treat as alive
    return false; // unknown error → assume gone (fail-forward)
  }
}

async function readOutputTail(outputFile) {
  if (!outputFile) return null;
  try {
    if (!existsSync(outputFile)) return null;
    const st = await stat(outputFile);
    const buf = await readFile(outputFile, "utf-8");
    const tail = buf.slice(Math.max(0, buf.length - OUTPUT_TAIL_BYTES));
    return tail.trim() || `(empty output, size=${st.size})`;
  } catch (err) {
    return `(could not read output: ${err.message})`;
  }
}

async function cleanupPidFile(pidFile) {
  if (!pidFile) return;
  try {
    await unlink(pidFile);
  } catch { /* already gone, ignore */ }
}

function buildBridgeInstruction(row, exitTail, status, exitCode) {
  const desc = row.description || row.cli_task_id;
  const tailExcerpt = exitTail ? `\n\nDernières lignes de l'output:\n\`\`\`\n${exitTail.slice(0, 1500)}\n\`\`\`` : "";
  const outputRef = `Output complet: ${row.output_file || "n/a"}.`;
  const exitInfo = exitCode === null || exitCode === undefined ? "exit inconnu (probable SIGKILL/OOM)" : `exit=${exitCode}`;

  if (status === "service_died") {
    return `[BG_SERVICE_DIED] Le service "${desc}" s'est arrêté (pid=${row.pid}, ${exitInfo}). ` +
      `${outputRef}${tailExcerpt}\n\n` +
      `Si c'était un kill volontaire de l'utilisateur, confirme-le simplement. ` +
      `Sinon, vérifie pourquoi il est tombé et relance si nécessaire.`;
  }
  if (status === "failed") {
    return `[BG_FAILED] Le job en arrière-plan "${desc}" a échoué (pid=${row.pid}, ${exitInfo}). ` +
      `${outputRef}${tailExcerpt}\n\n` +
      `Lis l'output, identifie la cause, corrige si possible et rapporte à l'utilisateur.`;
  }
  // completed
  return `[BG_COMPLETED] Le job en arrière-plan "${desc}" s'est terminé avec succès (pid=${row.pid}, ${exitInfo}). ` +
    `${outputRef}${tailExcerpt}\n\n` +
    `Lis l'output, vérifie le résultat et fais le rapport à l'utilisateur via les canaux habituels.`;
}

async function bridgeBgToAgent(row, exitTail, status, exitCode) {
  if (!row.agent_id) return; // standalone tasks without agent don't bridge
  try {
    const { enqueueTask } = await import("../db/queries/agent-task-queue.js");
    const desc = row.description || row.cli_task_id;
    const prefix = status === "service_died" ? "BG/service" : status === "failed" ? "BG/fail" : "BG";
    const instruction = buildBridgeInstruction(row, exitTail, status, exitCode);
    await enqueueTask(
      row.agent_id,
      instruction,
      "bg_job_complete",
      row.cli_task_id,
      60,
      `[${prefix}] ${desc.slice(0, 100)}`
    );
    log(`[BG-WATCHER] Bridge enqueued (${status}) for agent ${row.agent_id} (bg=${row.cli_task_id})`);
    setImmediate(async () => {
      try {
        const { processAgentQueue } = await import("./agent-task-processor.js");
        await processAgentQueue(row.agent_id);
      } catch (err) {
        log(`[BG-WATCHER] processAgentQueue kick failed: ${err.message}`);
      }
    });
  } catch (err) {
    log(`[BG-WATCHER] Bridge enqueue failed for ${row.cli_task_id}: ${err.message}`);
  }
}

async function readExitCode(exitFile) {
  if (!exitFile || !existsSync(exitFile)) return null;
  try {
    const raw = await readFile(exitFile, "utf-8");
    const parsed = parseInt(raw.trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function poll() {
  let rows = [];
  try {
    rows = await getRunningBgTasksWithPid();
  } catch (err) {
    log(`[BG-WATCHER] DB read failed: ${err.message}`);
    return;
  }
  if (rows.length === 0) return;

  for (const row of rows) {
    if (isPidAlive(row.pid)) continue;
    const exitCode = await readExitCode(row.exit_file);
    // Decide status: service_died wins (even on exit 0 — services exiting
    // is anomalous). Otherwise exit 0 = completed, anything else = failed.
    // exitCode === null means the wrap couldn't capture (SIGKILL / OOM /
    // hook didn't wrap) — treat as failed for non-services so the agent
    // gets a diagnostic prompt instead of a success notification.
    let status;
    if (row.is_service) {
      status = "service_died";
    } else if (exitCode === 0) {
      status = "completed";
    } else {
      status = "failed";
    }
    log(`[BG-WATCHER] PID ${row.pid} (${row.cli_task_id}) is gone — exit=${exitCode ?? "null"} → ${status}`);
    const tail = await readOutputTail(row.output_file);
    try {
      await markBgTaskExit(row.cli_task_id, {
        status,
        exitCode,
        exitSignal: null,
        summary: tail ? tail.slice(0, 500) : "(no output captured)",
      });
    } catch (err) {
      log(`[BG-WATCHER] markBgTaskExit failed for ${row.cli_task_id}: ${err.message}`);
      continue;
    }
    await bridgeBgToAgent(row, tail, status, exitCode);
    await cleanupPidFile(row.pid_file);
    await cleanupPidFile(row.exit_file);
    if (row.tool_use_id) {
      await cleanupPidFile(`/tmp/yabby-bg/${row.tool_use_id}.service`);
      await cleanupPidFile(`/tmp/yabby-bg/${row.tool_use_id}.sh`);
    }
  }
}

export function startBgWatcher() {
  if (timer) return;
  log(`[BG-WATCHER] starting (poll every ${POLL_INTERVAL_MS / 1000}s)`);
  // First tick after a short delay to let startup settle.
  setTimeout(() => {
    poll().catch((err) => log(`[BG-WATCHER] initial poll error: ${err.message}`));
  }, 5_000);
  timer = setInterval(() => {
    poll().catch((err) => log(`[BG-WATCHER] poll error: ${err.message}`));
  }, POLL_INTERVAL_MS);
  timer.unref?.(); // don't keep node alive
}

export function stopBgWatcher() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
