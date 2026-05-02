#!/usr/bin/env node
/**
 * YABBY — Claude Code PreToolUse hook: confirm edits for LEAD agents.
 *
 * Goal: warn (not hard-block) lead agents the FIRST time they try to write
 * a file. Their job is to DELEGATE via assign_agent / talk_to_agent. When
 * a director codes directly, the team in PLAN.md never gets created and
 * the project collapses into a solo build (see PulseDesk: 80 files written
 * by Édouard alone, zero sub-agents).
 *
 * The mechanism is a "soft confirmation" — the runtime gets a deny on the
 * first attempt with a clear warning + ack recipe. The agent must then
 * explicitly touch a bypass file to confirm "yes, I really need to edit
 * this." The bypass is valid 5 minutes, then the gate snaps shut again.
 * This forces a second deliberate decision per coding burst rather than
 * a one-time escape hatch.
 *
 * Behaviour:
 *   - Non-lead agent → pass through silently.
 *   - Yabby super-agent → pass through silently.
 *   - Lead agent calling Write / Edit / Bash:
 *       * Recent bypass file (mtime within BYPASS_TTL_MS) → pass through.
 *       * Otherwise → return a DENY with a confirmation prompt: "are you
 *         sure? if yes, touch this file then retry."
 *
 * Env: YABBY_AGENT_ID, YABBY_AGENT_IS_LEAD ("1" → lead),
 *      YABBY_LANG (en|fr|es|de — defaults to en), YABBY_API_PORT
 * Protocol: https://docs.claude.com/en/docs/claude-code/hooks
 */

import fs from "fs";
import os from "os";
import path from "path";

const BYPASS_TTL_MS = 5 * 60 * 1000; // 5 minutes
const BYPASS_DIR = path.join(os.homedir(), ".claude", "yabby-bypass");

// Tools that ALWAYS need confirmation when called by a lead (no triage —
// these inherently mutate the filesystem). Native Write/Edit + MCP
// filesystem mutators (the lead would otherwise route around the gate
// by using mcp__filesystem__write_file instead of the native Write).
const ALWAYS_GATED_TOOLS = new Set([
  "Write",
  "Edit",
  "NotebookEdit",
  "mcp__filesystem__write_file",
  "mcp__filesystem__edit_file",
  "mcp__filesystem__create_directory",
  "mcp__filesystem__move_file",
]);

// Bash is gated CONDITIONALLY — read-only commands (curl, ls, cat, grep,
// find, ps, lsof, pwd, which, head, tail, wc, echo) are essential for the
// lead's status-check workflow (heartbeats, inbox polls, sandbox listings).
// Only mutating Bash trips the confirm gate.
//
// A command is considered "mutating" when it:
//   - starts with a known build/install/scaffold tool (npm/pnpm/yarn/pip/
//     pip3/pipenv/poetry/cargo/make/docker/docker-compose/tsc/vite/next/
//     webpack/rollup/esbuild/gradle/mvn/composer/bundle/go/rustc/swift)
//   - starts with rm/mv/cp/chmod/chown/sed -i (destructive)
//   - starts with git commit/git push/git add/git rm/git mv (writes history)
//   - contains a stdout redirect (>, >>) to a real file path (NOT /dev/null,
//     /dev/stderr, /dev/stdout, /tmp/* — those are throwaway/side-channel)
//   - contains a heredoc (<<) writing to a file
//
// Everything else passes through without an ack. The lead can curl the API
// all day, list the sandbox, cat PLAN.md, lsof status checks, redirect
// stderr to /dev/null, etc.
const MUTATING_BASH_STARTS = [
  /^\s*(npm|pnpm|yarn|npx|pip|pip3|pipenv|poetry|cargo|make|docker|docker-compose|tsc|vite|next|webpack|rollup|esbuild|gradle|mvn|composer|bundle|go\s+(install|build|run|mod)|rustc|swift)\b/i,
  /^\s*(rm|mv|cp|chmod|chown)\b/i,
  /^\s*sed\s+-i\b/i,
  /^\s*git\s+(commit|push|add|rm|mv|reset|checkout|merge|rebase|stash)\b/i,
];

// Some "mutating" tools also have read-only subcommands. `npm --version`,
// `docker ps`, `docker images`, `pip list`, `git log`, `cargo --help` etc.
// are pure information queries — they don't install, build, write, or
// commit anything. When the FIRST argument after the binary matches one
// of these read-only verbs/flags, treat the whole call as read-only.
const READ_ONLY_SUBCOMMAND = /^\s*\S+\s+(--?(v|version|h|help)|list|ls|info|show|status|inspect|ps|images|search|view|env|config(?:\s+(get|list|--get|--list))?|log|diff|tag\s*$|describe|outdated|doctor|whoami|root|cache\s+ls|registry|prefix|ls-(?:files|tree|remote))\b/i;

// Detect a STDOUT/append redirect to a meaningful target. Excludes:
//   - stderr redirects: 2>, 2>>, &>, &>>, 1>&2, 2>&1   (no real write)
//   - /dev/null, /dev/stderr, /dev/stdout, /dev/tty    (throwaway)
//   - /tmp/*                                            (scratch)
// Only `>` or `>>` not preceded by a digit (file descriptor) or `&` and
// not followed by `&` (which is fd redirection) counts.
function hasMutatingRedirect(part) {
  // Strip the safe stderr / fd patterns first so they don't interfere.
  const cleaned = part
    .replace(/\d*&?>{1,2}&\d+/g, " ")        // `2>&1`, `1>&2`, `&>&-`
    .replace(/2>{1,2}\s*\S+/g, " ")          // `2>file`, `2>>file`
    .replace(/&>{1,2}\s*\S+/g, " ");         // `&>file`, `&>>file`

  // Now look for a stdout redirect. Capture the target.
  const m = cleaned.match(/(?:^|[^0-9&>])>{1,2}\s*([^\s|&;]+)/);
  if (!m) return false;
  const target = m[1];
  // Throwaway / side-channel targets — never mutating from the project's POV.
  if (/^\/dev\/(null|stderr|stdout|tty)$/.test(target)) return false;
  if (/^\/tmp\//.test(target)) return false;
  return true;
}

const HEREDOC = /<<-?\s*['"]?[A-Z_]+/;

function isMutatingBash(command) {
  if (!command || typeof command !== "string") return false;
  // Split on common separators so we evaluate each invocation. A command
  // like `ls -la && rm -rf foo` should still trigger on the rm portion.
  const parts = command.split(/\s*(?:\|\||&&|;|\n)\s*/);
  for (const part of parts) {
    for (const re of MUTATING_BASH_STARTS) {
      if (re.test(part)) {
        // If the subcommand is a read-only verb/flag (--version, list, ps,
        // log, info, ...), this is just a status query — let it through.
        if (READ_ONLY_SUBCOMMAND.test(part)) continue;
        return true;
      }
    }
    if (hasMutatingRedirect(part)) return true;
    if (HEREDOC.test(part)) return true;
  }
  return false;
}

// Inline message dictionary — the hook is a fresh Node process per tool call,
// so we can't import the full lib/i18n.js (it pulls config + DB). Four locales
// match what the rest of the system supports (en/fr/es/de). Fallback: en.
function buildMessage(lang, toolName, bypassDir, bypassPath, minutes) {
  const messages = {
    en: () =>
      `⚠️ CONFIRM — You are a LEAD agent. The "${toolName}" tool will edit a file directly.\n\n` +
      `Lead agents normally DELEGATE via assign_agent + talk_to_agent — sub-agents do the coding. ` +
      `Files like PLAN.md, start.sh, or root config (docker-compose, .env) are legitimate for you to write directly. ` +
      `Source code under backend/, frontend/, apps/, src/, etc. is NOT.\n\n` +
      `If this edit IS legitimate (root config, plan, presentation script), confirm with:\n` +
      `  mkdir -p "${bypassDir}" && touch "${bypassPath}"\n` +
      `Then retry. The confirmation lasts ${minutes} minutes.\n\n` +
      `If you were about to write source code, STOP and use assign_agent + talk_to_agent instead — re-read PLAN.md, create the missing team members, dispatch the work to them.`,
    fr: () =>
      `⚠️ CONFIRMATION — Tu es un agent LEAD. Le tool "${toolName}" va modifier un fichier directement.\n\n` +
      `Les agents lead DÉLÈGUENT normalement via assign_agent + talk_to_agent — ce sont les sous-agents qui codent. ` +
      `Les fichiers comme PLAN.md, start.sh, ou la config racine (docker-compose, .env) sont légitimes pour toi. ` +
      `Le code source sous backend/, frontend/, apps/, src/, etc. ne l'est PAS.\n\n` +
      `Si cette édition EST légitime (config racine, plan, script de présentation), confirme avec :\n` +
      `  mkdir -p "${bypassDir}" && touch "${bypassPath}"\n` +
      `Puis recommence. La confirmation dure ${minutes} minutes.\n\n` +
      `Si tu allais écrire du code source, ARRÊTE et utilise assign_agent + talk_to_agent — re-lis PLAN.md, crée les membres d'équipe manquants, dispatche le travail.`,
    es: () =>
      `⚠️ CONFIRMACIÓN — Eres un agente LEAD. La herramienta "${toolName}" editará un archivo directamente.\n\n` +
      `Los agentes lead normalmente DELEGAN vía assign_agent + talk_to_agent — los sub-agentes son los que programan. ` +
      `Archivos como PLAN.md, start.sh o config raíz (docker-compose, .env) son legítimos para ti. ` +
      `El código fuente bajo backend/, frontend/, apps/, src/, etc. NO lo es.\n\n` +
      `Si esta edición ES legítima (config raíz, plan, script de presentación), confirma con:\n` +
      `  mkdir -p "${bypassDir}" && touch "${bypassPath}"\n` +
      `Luego reintenta. La confirmación dura ${minutes} minutos.\n\n` +
      `Si ibas a escribir código fuente, DETENTE y usa assign_agent + talk_to_agent — re-lee PLAN.md, crea los miembros de equipo faltantes, despacha el trabajo.`,
    de: () =>
      `⚠️ BESTÄTIGUNG — Du bist ein LEAD-Agent. Das Tool "${toolName}" wird eine Datei direkt bearbeiten.\n\n` +
      `Lead-Agenten DELEGIEREN normalerweise über assign_agent + talk_to_agent — Sub-Agenten codieren. ` +
      `Dateien wie PLAN.md, start.sh oder Root-Config (docker-compose, .env) darfst du direkt schreiben. ` +
      `Quellcode unter backend/, frontend/, apps/, src/, etc. NICHT.\n\n` +
      `Wenn diese Bearbeitung berechtigt IST (Root-Config, Plan, Präsentationsskript), bestätige mit:\n` +
      `  mkdir -p "${bypassDir}" && touch "${bypassPath}"\n` +
      `Dann erneut versuchen. Die Bestätigung gilt ${minutes} Minuten.\n\n` +
      `Falls du Quellcode schreiben wolltest, STOPP und nutze assign_agent + talk_to_agent — PLAN.md erneut lesen, fehlende Teammitglieder erstellen, Arbeit verteilen.`,
  };
  return (messages[lang] || messages.en)();
}

let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(input);
    const tool_name = parsed.tool_name;
    const tool_input = parsed.tool_input || {};

    // Triage: decide whether this specific call needs a confirmation.
    let needsGate = false;
    if (ALWAYS_GATED_TOOLS.has(tool_name)) {
      needsGate = true;
    } else if (tool_name === "Bash") {
      needsGate = isMutatingBash(tool_input.command);
    }
    if (!needsGate) process.exit(0);

    // Only gate when the spawner explicitly tagged this run as a lead.
    // Default behaviour for any non-lead agent is pass-through.
    const isLead = process.env.YABBY_AGENT_IS_LEAD === "1";
    if (!isLead) process.exit(0);

    const agentId = process.env.YABBY_AGENT_ID || "";
    if (!agentId || agentId === "yabby-000000") process.exit(0);

    // Check for a recent bypass ack
    const bypassPath = path.join(BYPASS_DIR, `${agentId}.bypass`);
    try {
      const st = fs.statSync(bypassPath);
      const age = Date.now() - st.mtimeMs;
      if (age >= 0 && age <= BYPASS_TTL_MS) process.exit(0); // still valid — let it through
    } catch {
      // No bypass file → fall through to deny
    }

    const minutes = Math.round(BYPASS_TTL_MS / 60000);
    const lang = (process.env.YABBY_LANG || "en").toLowerCase();
    const reason = buildMessage(lang, tool_name, BYPASS_DIR, bypassPath, minutes);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }));
    process.exit(0);
  } catch {
    process.exit(0); // fail-open — never block on a parse error
  }
});
