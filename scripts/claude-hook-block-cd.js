#!/usr/bin/env node
/**
 * YABBY — Claude Code PreToolUse hook: block absolute-path `cd`.
 *
 * `cd /absolute/path` doesn't persist between tasks (each bash call is a
 * fresh shell, and each task resumes in the agent's persistent CWD).
 * This hook blocks such commands and tells the agent to either use
 * absolute paths directly or call change-workspace for persistence.
 *
 * NO-OP allowance: `cd .`, `cd ./`, or `cd <currentCwd>` (or its realpath)
 * are inoffensive and pass through silently. This avoids triggering
 * defensive change-workspace calls toward the workspace the agent is
 * already in.
 *
 * Env: YABBY_AGENT_ID, YABBY_API_PORT
 * Protocol: https://docs.claude.com/en/docs/claude-code/hooks
 */

import fs from "fs";

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const { tool_name, tool_input } = JSON.parse(input);
    if (tool_name !== "Bash" || !tool_input?.command) process.exit(0);

    // Match `cd /...` at start, after ; && || | (, with optional quotes
    const absCd = /(?:^|[;&|(]|&&|\|\|)\s*cd\s+(?:"\/|'\/|\/)/;
    if (!absCd.test(tool_input.command)) process.exit(0);

    // Extract the cd target so we can check no-ops
    const targetMatch = tool_input.command.match(
      /(?:^|[;&|(]|&&|\|\|)\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))/
    );
    const target = targetMatch && (targetMatch[1] || targetMatch[2] || targetMatch[3]);

    // No-op: cd toward the current directory
    if (target) {
      try {
        const cwd = fs.realpathSync(process.cwd());
        const targetReal = fs.realpathSync(target);
        if (cwd === targetReal) {
          // Same directory — no-op, let the cd through (it changes nothing)
          process.exit(0);
        }
      } catch {
        // realpath failed (broken path) — fall through to block
      }
    }

    const agentId = process.env.YABBY_AGENT_ID || "<agent_id>";
    const port = process.env.YABBY_API_PORT || "3000";

    const reason =
      `\`cd /chemin/absolu\` ne persiste pas entre les tâches. Choisis :\n\n` +
      `1. ACTION PONCTUELLE (lire / lister / vérifier) → chemin absolu direct, SANS cd :\n` +
      `   ls /path    cat /path/file    git -C /path status\n\n` +
      `2. TRAVAIL PERSISTANT (≥2 actions sur ce répertoire ET pas le CWD actuel) :\n` +
      `   curl -s -X POST http://localhost:${port}/api/agents/${agentId}/change-workspace \\\n` +
      `     -H "Content-Type: application/json" \\\n` +
      `     -d '{"workspace_path":"/path","reason":"..."}'\n\n` +
      `⚠️ N'appelle PAS change-workspace si tu es DÉJÀ dans ce répertoire — tu ne ferais que tuer ta task pour rien. Vérifie avec \`pwd\` avant.`;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0); // fail-open
  }
});
