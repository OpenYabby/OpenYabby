#!/usr/bin/env node
/**
 * YABBY — PreToolUse hook: wrap Bash(run_in_background=true) so we can
 * track the bg child's PID, exit code, and whether the agent meant it
 * as a permanent service.
 *
 * Wrap (POSIX, bash/zsh/dash/sh, macOS+Linux):
 *   sh -c '<orig> & C=$!; echo $C > <pid>; wait $C; rc=$?; echo $rc > <exit>'
 *
 * Side channel for service intent: if tool_input.description ends with
 * `[bg:service]`, drop an empty marker file at /tmp/yabby-bg/<id>.service.
 *
 * Fail-open: any error → exit 0, command passes through unchanged.
 */

import { mkdirSync, existsSync, writeFileSync, chmodSync } from "fs";

const PID_DIR = "/tmp/yabby-bg";
const SERVICE_TAG = /\[bg:service\]\s*$/i;

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const { tool_name, tool_input, tool_use_id } = JSON.parse(input);

    if (tool_name !== "Bash") process.exit(0);
    if (!tool_input?.run_in_background) process.exit(0);
    if (!tool_input?.command || typeof tool_input.command !== "string") process.exit(0);
    if (!tool_use_id) process.exit(0);

    if (!existsSync(PID_DIR)) mkdirSync(PID_DIR, { recursive: true, mode: 0o755 });

    const pidFile = `${PID_DIR}/${tool_use_id}.pid`;
    const exitFile = `${PID_DIR}/${tool_use_id}.exit`;
    const bookkeeperFile = `${PID_DIR}/${tool_use_id}.sh`;

    // Service marker via description tag — explicit agent-controlled channel,
    // no regex on the command itself.
    if (typeof tool_input.description === "string" && SERVICE_TAG.test(tool_input.description)) {
      try { writeFileSync(`${PID_DIR}/${tool_use_id}.service`, ""); } catch {}
    }

    // Write a bookkeeper script that wraps the user command. Putting it in a
    // file avoids ALL shell escape issues (Python f-strings, nested quotes,
    // heredocs etc.) — the command is embedded verbatim.
    //
    // The bookkeeper:
    //   1. Backgrounds the user command in a group `{ ... ; } &`
    //   2. Records the child PID for the bg-watcher
    //   3. Waits for the child and records its exit code
    //
    // The hook returns a command that detaches the bookkeeper via nohup + `&`
    // so the Claude CLI's `run_in_background=true` sees a fast-returning tool
    // call (otherwise the CLI emits task_notification:completed prematurely
    // because the wrapper would block on `wait`).
    const bookkeeperScript = [
      `#!/bin/sh`,
      `{ ${tool_input.command} ; } &`,
      `C=$!`,
      `echo $C > ${pidFile}`,
      `wait $C`,
      `rc=$?`,
      `echo $rc > ${exitFile}`,
      ``,
    ].join("\n");
    writeFileSync(bookkeeperFile, bookkeeperScript);
    chmodSync(bookkeeperFile, 0o755);

    const wrapped = `sh -c 'nohup ${bookkeeperFile} </dev/null >/dev/null 2>&1 &'`;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { ...tool_input, command: wrapped },
        additionalContext: `Yabby bg-watcher: PID→${pidFile}, exit→${exitFile}`,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
