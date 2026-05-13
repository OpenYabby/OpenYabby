#!/usr/bin/env node
/**
 * YABBY — Claude Code PreToolUse hook: capture bg PID via $$ + exec wrap.
 *
 * When the agent calls `Bash(run_in_background=true)`, we wrap the command
 * so the spawned shell writes its own PID to a file before exec'ing the
 * real command:
 *
 *   sh -c 'echo $$ > <pid_file>; exec <original>'
 *
 * `$$` is the shell's PID. `exec` replaces the shell with the user command,
 * keeping the same PID. So the file content == the bg process's host-OS PID.
 *
 * The Yabby bg-watcher reads `<pid_file>` and runs `process.kill(pid, 0)`
 * to detect bg completion independently of the parent CLI's lifecycle.
 *
 * pid_file naming: /tmp/yabby-bg/<tool_use_id>.pid
 *   tool_use_id is set by Claude per tool call, unique and stable. The CLI
 *   emits the same id in the subsequent system.task_started event so the
 *   spawner can correlate.
 *
 * Fail-open: any error → exit 0 silently, command passes through unchanged.
 * Protocol: https://code.claude.com/docs/en/hooks
 */

import { mkdirSync, existsSync } from "fs";

const PID_DIR = "/tmp/yabby-bg";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const { tool_name, tool_input, tool_use_id } = JSON.parse(input);

    // Only Bash with run_in_background=true is relevant.
    if (tool_name !== "Bash") process.exit(0);
    if (!tool_input?.run_in_background) process.exit(0);
    if (!tool_input?.command || typeof tool_input.command !== "string") process.exit(0);
    if (!tool_use_id) process.exit(0);

    // Ensure the pid dir exists.
    if (!existsSync(PID_DIR)) {
      mkdirSync(PID_DIR, { recursive: true, mode: 0o755 });
    }

    const pidFile = `${PID_DIR}/${tool_use_id}.pid`;
    const original = tool_input.command;

    // Escape single quotes inside the original command for the sh -c wrapper.
    // Standard POSIX trick: '...'\''...'.
    const escaped = original.replace(/'/g, "'\\''");
    const wrapped = `sh -c 'echo $$ > ${pidFile}; exec sh -c '\\''${escaped}'\\'''`;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...tool_input, command: wrapped },
        additionalContext: `Yabby bg-watcher: PID will be captured in ${pidFile}`,
      },
    }));
    process.exit(0);
  } catch {
    // Fail-open: original command passes through unchanged.
    process.exit(0);
  }
});
