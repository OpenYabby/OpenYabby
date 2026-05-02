/* ═══════════════════════════════════════════════════════
   YABBY — Session History Summarizer
   ═══════════════════════════════════════════════════════
   Reads a task's activity log (logs/{taskId}-activity.log) and produces
   a compact textual summary suitable for injection into a new system prompt
   when an agent changes its workspace (POST /api/agents/:id/change-workspace).

   Format of the activity log (one entry per line):
     [ISO_TIMESTAMP] TASK STARTED: <instruction text>
     [ISO_TIMESTAMP] TOOL: <toolName> → <json args>
     [ISO_TIMESTAMP] RUNNER: <assistant text>
     [ISO_TIMESTAMP] RESULT: <final result>
*/

import fs from "fs";
import path from "path";
import { log } from "./logger.js";

const LOGS_DIR = path.join(process.cwd(), "logs");
const DEFAULT_MAX_CHARS = 3000;
const DEFAULT_MAX_ENTRIES = 40;

/**
 * Summarize an agent's activity log for context transfer.
 * Returns a multi-line string ready to paste into a system prompt,
 * or null if the log doesn't exist or is empty.
 *
 * @param {string} taskId - Task ID whose activity log to summarize
 * @param {object} [opts]
 * @param {number} [opts.maxChars=3000] - Hard cap on the output length
 * @param {number} [opts.maxEntries=40] - Max number of log entries to include (last N)
 * @returns {Promise<string|null>}
 */
export async function summarizeSessionHistory(taskId, opts = {}) {
  const { maxChars = DEFAULT_MAX_CHARS, maxEntries = DEFAULT_MAX_ENTRIES } = opts;
  const logPath = path.join(LOGS_DIR, `${taskId}-activity.log`);

  if (!fs.existsSync(logPath)) {
    log(`[SESSION-HISTORY] No activity log for task ${taskId}`);
    return null;
  }

  let content;
  try {
    content = await fs.promises.readFile(logPath, "utf8");
  } catch (err) {
    log(`[SESSION-HISTORY] Failed to read ${logPath}: ${err.message}`);
    return null;
  }

  // Entries are ISO-timestamped lines. Some entries span multiple lines
  // (e.g. multi-line TASK STARTED body). Simple split-by-ISO-timestamp regex:
  const entryRegex = /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z)\]\s+([A-Z_]+(?:\s+[A-Z]+)?:?)\s*(.*)/;
  const rawLines = content.split("\n");
  const entries = [];

  let currentEntry = null;
  for (const line of rawLines) {
    const match = line.match(entryRegex);
    if (match) {
      if (currentEntry) entries.push(currentEntry);
      currentEntry = {
        timestamp: match[1],
        type: match[2].replace(/:\s*$/, ""),
        body: match[3] || "",
      };
    } else if (currentEntry && line.trim()) {
      // Continuation of previous entry
      currentEntry.body += "\n" + line;
    }
  }
  if (currentEntry) entries.push(currentEntry);

  if (entries.length === 0) {
    return null;
  }

  // Keep only the most interesting entries — skip spammy ones like
  // repeated heartbeats, GUI lock acquire/release, ToolSearch
  const interestingEntries = entries.filter((e) => {
    const body = e.body.toLowerCase();
    if (e.type === "TOOL") {
      if (body.includes("heartbeat")) return false;
      if (body.includes("gui-lock")) return false;
      if (body.includes("toolsearch")) return false;
    }
    return true;
  });

  // Keep the last N entries
  const kept = interestingEntries.slice(-maxEntries);

  // Format each entry as a short line, truncating long bodies
  const lines = kept.map((e) => {
    const body = e.body.replace(/\s+/g, " ").trim();
    const truncated = body.length > 200 ? body.slice(0, 200) + "…" : body;
    return `- [${e.type}] ${truncated}`;
  });

  let summary = lines.join("\n");

  // Hard cap on total length — trim from the top so the most recent entries win
  if (summary.length > maxChars) {
    summary = "… (older entries truncated) …\n" + summary.slice(summary.length - maxChars);
  }

  return summary;
}
