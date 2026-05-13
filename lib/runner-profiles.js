/* ═══════════════════════════════════════════════════════
   YABBY — Runner Profiles
   ═══════════════════════════════════════════════════════
   Defines how each CLI runner is invoked, its capabilities,
   and how to parse its stdout output.
*/

import { writeFileSync } from "fs";
import { join } from "path";

// ── Claude Code ──

const claude = {
  label: "Claude Code",
  beta: false,
  supportsResume: true,
  supportsSystemPrompt: true,
  outputFormat: "stream-json",

  getCommand(config) {
    return config?.runnerPath || process.env.CLAUDE_CMD || "claude";
  },

  buildArgs(task, { sessionId, systemPrompt, isVerbose, settingsPath }) {
    const base = ["-p", "--dangerously-skip-permissions"];
    if (isVerbose) base.push("--verbose", "--output-format", "stream-json");
    if (settingsPath) base.push("--settings", settingsPath);
    return [...base, "--session-id", sessionId, "--system-prompt", systemPrompt, task];
  },

  buildResumeArgs(task, { sessionId, isVerbose, settingsPath, forkSession }) {
    const base = ["-p", "--dangerously-skip-permissions"];
    if (isVerbose) base.push("--verbose", "--output-format", "stream-json");
    if (settingsPath) base.push("--settings", settingsPath);
    // We use --resume <sessionId> (not --continue) because multiple sessions
    // can exist in the same CWD (retries, orphans, sub-agents). --continue would
    // pick the most recently modified one, which is not necessarily the right
    // session for the agent we want to resume.
    const args = [...base, "--resume", sessionId];
    // --fork-session creates a new session that inherits history from the parent
    // but is independent going forward. Used for domain shifts where the agent
    // keeps its identity but starts fresh on a new topic.
    if (forkSession) args.push("--fork-session");
    args.push(task);
    return args;
  },

  parseStdoutLine(line, cb, isVerbose) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === "tool_use") {
            const toolDetailShort = block.name === "Bash"
              ? block.input?.command?.slice(0, 500)
              : block.name === "Edit" || block.name === "Write"
                ? block.input?.file_path
                : block.name === "Read"
                  ? block.input?.file_path
                  : JSON.stringify(block.input || {}).slice(0, 300);

            const toolDetailFull = isVerbose
              ? JSON.stringify(block.input || {})
              : toolDetailShort;

            cb.onToolUse(block.name, toolDetailShort, toolDetailFull, block.id);
          } else if (block.type === "text" && block.text) {
            const limit = isVerbose ? 5000 : 1000;
            cb.onText(block.text.slice(0, limit));
          }
        }
      } else if (parsed.type === "tool_result" || parsed.type === "tool_output") {
        if (isVerbose) {
          const content = parsed.content || parsed.output || "";
          const resultText = typeof content === "string" ? content : JSON.stringify(content);
          cb.onToolResult(parsed.tool_use_id || parsed.id, resultText.slice(0, 3000));
        }
      } else if (parsed.type === "result") {
        cb.onResult(parsed.cost_usd, parsed.duration_ms, parsed.result);
      } else if (parsed.type === "system" && parsed.subtype === "task_started") {
        cb.onBgTaskStarted?.(parsed);
      } else if (parsed.type === "system" && parsed.subtype === "task_notification") {
        cb.onBgTaskNotification?.(parsed);
      }
    } catch {
      // Not JSON — raw output, ignore for Claude
    }
  },

  envOverrides(baseEnv) {
    return { ...baseEnv, CLAUDECODE: "" };
  },
};

// ── OpenAI Codex ──

const codex = {
  label: "OpenAI Codex",
  beta: false,
  supportsResume: true,
  supportsSystemPrompt: false, // uses CODEX_INSTRUCTIONS.md
  outputFormat: "ndjson",

  getCommand(config) {
    return config?.runnerPath || "codex";
  },

  buildArgs(task, { cwd, systemPrompt }) {
    // Codex reads CODEX_INSTRUCTIONS.md from cwd automatically
    if (systemPrompt && cwd) {
      try {
        writeFileSync(join(cwd, "CODEX_INSTRUCTIONS.md"), systemPrompt);
      } catch { /* best effort */ }
    }
    return ["exec", "--full-auto", "--cd", cwd, "--json", task];
  },

  buildResumeArgs(task, { sessionId }) {
    return ["exec", "resume", sessionId, "--json", task];
  },

  parseStdoutLine(line, cb, _isVerbose) {
    try {
      const ev = JSON.parse(line);
      if (ev.type === "thread.started" && ev.thread_id) {
        cb.onThreadStarted?.(ev.thread_id);
      } else if (ev.type === "function_call" || ev.type === "tool_call") {
        cb.onToolUse(ev.name || ev.tool || "codex-tool", JSON.stringify(ev.arguments || ev.input || {}).slice(0, 500), "", ev.id || "");
      } else if (ev.type === "item.started" && ev.item?.type === "tool_call") {
        cb.onToolUse(
          ev.item.name || "codex-tool",
          JSON.stringify(ev.item.arguments || ev.item.input || {}).slice(0, 500),
          "",
          ev.item.id || ev.id || "",
        );
      } else if (ev.type === "item.completed" && ev.item?.type === "tool_result") {
        const output = ev.item.output || ev.item.result || ev.item.content || "";
        const text = typeof output === "string" ? output : JSON.stringify(output);
        if (text) cb.onToolResult?.(ev.item.id || ev.id || "", text.slice(0, 3000));
      } else if (ev.type === "item.completed" && ev.item?.type === "agent_message") {
        const messageText = typeof ev.item.text === "string"
          ? ev.item.text
          : Array.isArray(ev.item.content)
            ? ev.item.content
              .map((part) => (part?.type === "output_text" || part?.type === "text") ? (part.text || "") : "")
              .filter(Boolean)
              .join("\n")
            : "";
        if (messageText) cb.onText(messageText.slice(0, 2000));
      } else if (ev.type === "message" && ev.content) {
        cb.onText((typeof ev.content === "string" ? ev.content : JSON.stringify(ev.content)).slice(0, 2000));
      } else if (ev.type === "output_text" || ev.type === "text") {
        cb.onText((ev.text || ev.content || "").slice(0, 2000));
      } else if (ev.type === "turn.completed" || ev.type === "completed" || ev.type === "done") {
        cb.onResult(ev.cost, ev.duration);
      }
    } catch {
      // Not JSON — treat as plain text
      if (line.length > 0) cb.onText(line.slice(0, 2000));
    }
  },

  envOverrides(baseEnv) {
    return baseEnv;
  },
};

// ── Aider ──

const aider = {
  label: "Aider",
  beta: true,
  supportsResume: false,
  supportsSystemPrompt: false,
  outputFormat: "plaintext",

  getCommand(config) {
    return config?.runnerPath || "aider";
  },

  buildArgs(task, { cwd, systemPrompt }) {
    const effective = systemPrompt
      ? `=== INSTRUCTIONS ===\n${systemPrompt}\n=== FIN ===\n\n${task}`
      : task;
    return ["--message", effective, "--yes", "--auto-commits"];
  },

  buildResumeArgs: null,

  parseStdoutLine(line, cb) {
    if (line.length > 0) cb.onText(line.slice(0, 2000));
  },

  envOverrides(baseEnv) {
    return baseEnv;
  },
};

// ── Goose (Block) ──

const goose = {
  label: "Goose (Block)",
  beta: true,
  supportsResume: true,
  supportsSystemPrompt: false,
  outputFormat: "plaintext",

  getCommand(config) {
    return config?.runnerPath || "goose";
  },

  buildArgs(task, { systemPrompt, runnerArgs = [] }) {
    const effective = systemPrompt
      ? `=== INSTRUCTIONS ===\n${systemPrompt}\n=== FIN ===\n\n${task}`
      : task;
    return ["run", ...runnerArgs, "--text", effective];
  },

  buildResumeArgs(task, { sessionId }) {
    return ["session", "resume", sessionId];
  },

  parseStdoutLine(line, cb) {
    if (line.length > 0) cb.onText(line.slice(0, 2000));
  },

  envOverrides(baseEnv) {
    return baseEnv;
  },
};

// ── Cline CLI ──

const cline = {
  label: "Cline CLI",
  beta: true,
  supportsResume: false,
  supportsSystemPrompt: false,
  outputFormat: "plaintext",

  getCommand(config) {
    return config?.runnerPath || "cline";
  },

  buildArgs(task, { systemPrompt, runnerArgs = [] }) {
    const effective = systemPrompt
      ? `=== INSTRUCTIONS ===\n${systemPrompt}\n=== FIN ===\n\n${task}`
      : task;
    return [...runnerArgs, effective];
  },

  buildResumeArgs: null,

  parseStdoutLine(line, cb) {
    if (line.length > 0) cb.onText(line.slice(0, 2000));
  },

  envOverrides(baseEnv) {
    return baseEnv;
  },
};

// ── Continue CLI ──

const continueCli = {
  label: "Continue CLI",
  beta: true,
  supportsResume: false,
  supportsSystemPrompt: false,
  outputFormat: "plaintext",

  getCommand(config) {
    return config?.runnerPath || "cn";
  },

  buildArgs(task, { systemPrompt }) {
    const effective = systemPrompt
      ? `=== INSTRUCTIONS ===\n${systemPrompt}\n=== FIN ===\n\n${task}`
      : task;
    return [effective];
  },

  buildResumeArgs: null,

  parseStdoutLine(line, cb) {
    if (line.length > 0) cb.onText(line.slice(0, 2000));
  },

  envOverrides(baseEnv) {
    return baseEnv;
  },
};

// ── Registry ──

const RUNNER_PROFILES = {
  claude,
  codex,
  aider,
  goose,
  cline,
  continue: continueCli,
};

export function getRunnerProfile(runnerId) {
  return RUNNER_PROFILES[runnerId] || RUNNER_PROFILES.claude;
}

export { RUNNER_PROFILES };
