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
import { getRunningBgTasksWithPid, markBgTaskNotification } from "../db/queries/bg-tasks.js";

const POLL_INTERVAL_MS = 30_000; // 30s — light enough for real-time-ish, easy on DB
const OUTPUT_TAIL_BYTES = 2000;

let timer = null;

function isPidAlive(pid) {
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

async function bridgeBgCompleteToAgent(row, exitTail) {
  if (!row.agent_id) return; // standalone tasks without agent don't bridge
  try {
    const { enqueueTask } = await import("../db/queries/agent-task-queue.js");
    const desc = row.description || row.cli_task_id;
    const tailExcerpt = exitTail ? `\n\nDernières lignes de l'output:\n\`\`\`\n${exitTail.slice(0, 1500)}\n\`\`\`` : "";
    const instruction =
      `[BG_COMPLETED] Le job en arrière-plan "${desc}" s'est terminé (pid=${row.pid}). ` +
      `Output complet: ${row.output_file || "n/a"}.${tailExcerpt}\n\n` +
      `Lis l'output, vérifie le résultat et fais le rapport à l'utilisateur via les canaux habituels.`;
    await enqueueTask(
      row.agent_id,
      instruction,
      "bg_job_complete",
      row.cli_task_id,
      60,
      `[BG] ${desc.slice(0, 100)}`
    );
    log(`[BG-WATCHER] Bridge enqueued for agent ${row.agent_id} (bg=${row.cli_task_id})`);
    // Kick the queue processor so it picks up the new item immediately.
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
    log(`[BG-WATCHER] PID ${row.pid} (${row.cli_task_id}) is gone — marking completed`);
    const tail = await readOutputTail(row.output_file);
    try {
      await markBgTaskNotification(row.cli_task_id, {
        status: "completed",
        outputFile: row.output_file,
        summary: tail ? tail.slice(0, 500) : "(no output captured)",
        usage: null,
      });
    } catch (err) {
      log(`[BG-WATCHER] markBgTaskNotification failed for ${row.cli_task_id}: ${err.message}`);
      continue; // don't bridge if DB write failed (race-safe retry next tick)
    }
    await bridgeBgCompleteToAgent(row, tail);
    await cleanupPidFile(row.pid_file);
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
