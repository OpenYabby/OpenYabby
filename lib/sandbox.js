/**
 * Yabby Workspace — unified workspace with clear separation:
 *
 *   ~/Documents/Yabby Workspace/
 *   ├── Group Projects/           (multi-agent projects)
 *   │   └── {project-name}-{id}/
 *   └── Independent Tasks/        (standalone agents + Yabby super agent)
 *       ├── yabby/                (fixed, protected — Yabby super agent)
 *       └── {agent-name}/         (one persistent folder per standalone agent)
 *
 * Root location configurable via config key "projects.sandboxRoot".
 * Defaults to ~/Documents/Yabby Workspace.
 *
 * Features:
 * - Group Projects: human-readable folder names ({name}-{id-prefix})
 * - Independent Tasks: persistent per-agent folder (history accumulates)
 * - Yabby super agent: fixed folder "yabby/" (never renamed, auto-created at startup)
 * - Git repo auto-init, README, .gitignore
 * - Auto-migration from legacy ~/Desktop/Yabby Projects/
 * - Open in Finder/Explorer support
 */
import { mkdir, writeFile, rename, rmdir } from "fs/promises";
import { existsSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";
import { homedir } from "os";
import { log } from "./logger.js";
import { getConfig } from "./config.js";

const CLAUDE_IGNORE_TEMPLATE = [
  "node_modules/",
  ".next/",
  ".next-*/",
  ".turbo/",
  ".cache/",
  "out/",
  "dist/",
  "build/",
  "coverage/",
  ".vercel/",
  ".netlify/",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "*.log",
  "*.map",
  "**/*.map",
  ".git/",
  ".claude/",
  ".claude-settings.json",
  ".mcp.json",
  "tests/.auth/",
  "tests/.playwright/",
  "tests/reports/",
  "playwright-report/",
  "test-results/",
  ".lighthouseci/",
  ".DS_Store",
  ".env",
  ".env.*",
].join("\n") + "\n";

/**
 * Ensure a .claudeignore exists in the given directory. Idempotent — skips
 * if the file already exists. Called at sandbox creation (new projects) and
 * before each task spawn (backfill for existing sandboxes).
 */
export async function ensureClaudeIgnore(dir) {
  const target = join(dir, ".claudeignore");
  if (existsSync(target)) return;
  try {
    await writeFile(target, CLAUDE_IGNORE_TEMPLATE, { flag: "wx" });
  } catch {}
}

// Fixed folder name for Yabby super agent (never change)
const YABBY_FOLDER_NAME = "yabby";
const GROUP_PROJECTS_DIR = "Group Projects";
const INDEPENDENT_TASKS_DIR = "Independent Tasks";

/**
 * Get the Yabby Workspace root directory (from env, config, or default).
 * Contains "Group Projects/" and "Independent Tasks/" subdirectories.
 */
export function getSandboxRoot() {
  if (process.env.SANDBOX_ROOT) return process.env.SANDBOX_ROOT;
  const cfg = getConfig("projects");
  return cfg?.sandboxRoot || join(homedir(), "Documents", "Yabby Workspace");
}

/**
 * Get the Group Projects subdirectory (multi-agent projects).
 */
export function getGroupProjectsRoot() {
  return join(getSandboxRoot(), GROUP_PROJECTS_DIR);
}

/**
 * Get the Independent Tasks subdirectory (standalone agents + Yabby).
 */
export function getIndependentTasksRoot() {
  return join(getSandboxRoot(), INDEPENDENT_TASKS_DIR);
}

/**
 * Initialize the full Yabby Workspace structure at startup.
 * Creates root + Group Projects/ + Independent Tasks/ + Independent Tasks/yabby/
 */
export async function initWorkspaceStructure() {
  try {
    const root = getSandboxRoot();
    await mkdir(root, { recursive: true });
    log(`[SANDBOX] Root directory ready: ${root}`);

    const groupProjects = getGroupProjectsRoot();
    await mkdir(groupProjects, { recursive: true });
    log(`[SANDBOX] Group Projects/ ready`);

    const independentTasks = getIndependentTasksRoot();
    await mkdir(independentTasks, { recursive: true });
    log(`[SANDBOX] Independent Tasks/ ready`);

    // Always ensure Yabby workspace exists at startup
    await getYabbyWorkspacePath();

    return root;
  } catch (err) {
    log(`[SANDBOX] Could not initialize workspace: ${err.message}`);
    throw err;
  }
}

/**
 * Legacy alias — keeps backward compatibility.
 * @deprecated Use initWorkspaceStructure() instead.
 */
export async function initSandboxRoot() {
  return initWorkspaceStructure();
}

/**
 * Sanitize a name for use as a folder name.
 */
export function sanitizeName(name) {
  return (name || "project")
    .toLowerCase()
    .replace(/[^a-z0-9àâäéèêëïîôùûüÿçæœ\s-]/gi, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50) || "project";
}

/**
 * Get or create the sandbox directory for a project.
 * Located in Group Projects/{sanitized-name}-{id-prefix}
 * @param {string} projectId
 * @param {string} [projectName] — optional, for naming the folder
 * @returns {string} absolute path
 */
export async function getSandboxPath(projectId, projectName) {
  const root = getGroupProjectsRoot();
  // Ensure parent exists (e.g. if called before initWorkspaceStructure)
  await mkdir(root, { recursive: true });

  const idSuffix = projectId.slice(0, 8);

  // Legacy path (just ID) — keep using it
  if (existsSync(`${root}/${projectId}`)) {
    return `${root}/${projectId}`;
  }

  // Look for existing named folder
  try {
    const entries = readdirSync(root);
    const existing = entries.find(e => e.endsWith(`-${idSuffix}`) || e === projectId);
    if (existing) return `${root}/${existing}`;
  } catch {}

  // Create new folder with project name
  const folderName = projectName
    ? `${sanitizeName(projectName)}-${idSuffix}`
    : projectId;
  const sandboxPath = `${root}/${folderName}`;

  await mkdir(sandboxPath, { recursive: true });
  log(`[SANDBOX] Created project: ${sandboxPath}`);

  // Initialize project structure
  await initProjectStructure(sandboxPath, projectName || projectId);

  return sandboxPath;
}

/**
 * Get or create the persistent workspace directory for a standalone agent.
 * Located in Independent Tasks/{sanitized-agent-name}/
 * Each standalone agent has its own persistent folder — tasks accumulate there.
 * @param {string} agentId
 * @param {string} agentName
 * @returns {string} absolute path
 */
export async function getAgentWorkspacePath(agentId, agentName) {
  const root = getIndependentTasksRoot();
  await mkdir(root, { recursive: true });

  const folderName = sanitizeName(agentName || agentId);
  const workspacePath = `${root}/${folderName}`;

  if (!existsSync(workspacePath)) {
    await mkdir(workspacePath, { recursive: true });
    log(`[SANDBOX] Created agent workspace: ${workspacePath}`);
    await initAgentWorkspace(
      workspacePath,
      agentName || agentId,
      agentId,
      `Persistent workspace for agent "${agentName || agentId}". All files created across tasks are kept here.`
    );
  }

  return workspacePath;
}

/**
 * Get or create the fixed Yabby super agent workspace.
 * Located in Independent Tasks/yabby/ — always this name, never renamed.
 * Auto-created at server startup via initWorkspaceStructure().
 * @returns {string} absolute path
 */
export async function getYabbyWorkspacePath() {
  const root = getIndependentTasksRoot();
  await mkdir(root, { recursive: true });

  const yabbyPath = `${root}/${YABBY_FOLDER_NAME}`;

  if (!existsSync(yabbyPath)) {
    await mkdir(yabbyPath, { recursive: true });
    log(`[SANDBOX] Yabby workspace ready: ${yabbyPath}`);
    await initAgentWorkspace(
      yabbyPath,
      "Yabby",
      "yabby-000000",
      "Yabby workspace (main assistant). All files created via voice commands or chat are stored here. This folder is protected and will never be renamed."
    );
  }

  return yabbyPath;
}

/**
 * Initialize a new project sandbox with basic structure (src/, docs/, README, .gitignore, git init).
 */
async function initProjectStructure(sandboxPath, projectName) {
  try {
    // Create basic directories
    await mkdir(join(sandboxPath, "src"), { recursive: true });
    await mkdir(join(sandboxPath, "docs"), { recursive: true });

    // Create README
    const readme = `# ${projectName}\n\nCreated by Yabby on ${new Date().toLocaleDateString()}.\n\n## Structure\n\n- \`src/\` — Source code\n- \`docs/\` — Documentation\n`;
    await writeFile(join(sandboxPath, "README.md"), readme, { flag: "wx" }).catch(() => {});

    // Create .gitignore
    const gitignore = `node_modules/\n.env\n.DS_Store\n*.log\ndist/\nbuild/\n.mcp.json\n`;
    await writeFile(join(sandboxPath, ".gitignore"), gitignore, { flag: "wx" }).catch(() => {});

    // Create .claudeignore (reduces token consumption by excluding heavy dirs from Claude CLI view)
    await ensureClaudeIgnore(sandboxPath);

    // Git init
    await gitInit(sandboxPath, "Initial project setup by Yabby");
  } catch (err) {
    log(`[SANDBOX] Project structure init failed: ${err.message}`);
  }
}

/**
 * Initialize an agent workspace with README, .gitignore, git init.
 * Simpler than project structure — no src/ or docs/ subdirs (agent creates what it needs).
 */
async function initAgentWorkspace(workspacePath, agentName, agentId, contextMessage) {
  try {
    // Create README with agent context
    const readme = `# ${agentName}\n\n${contextMessage}\n\nAgent ID: ${agentId}\nCreated by Yabby on ${new Date().toLocaleDateString()}.\n\n## Notes\n\n- This folder is your dedicated workspace.\n- All files created by your successive tasks accumulate here.\n- Your work history is preserved between sessions.\n`;
    await writeFile(join(workspacePath, "README.md"), readme, { flag: "wx" }).catch(() => {});

    // Create .gitignore
    const gitignore = `node_modules/\n.env\n.DS_Store\n*.log\ndist/\nbuild/\n.mcp.json\n`;
    await writeFile(join(workspacePath, ".gitignore"), gitignore, { flag: "wx" }).catch(() => {});

    // Create .claudeignore
    await ensureClaudeIgnore(workspacePath);

    // Git init
    await gitInit(workspacePath, `Initial workspace for ${agentName}`);
  } catch (err) {
    log(`[SANDBOX] Agent workspace init failed: ${err.message}`);
  }
}

/**
 * Initialize a git repo in a directory (idempotent).
 */
async function gitInit(path, commitMessage) {
  if (existsSync(join(path, ".git"))) return;
  try {
    execSync("git init", { cwd: path, stdio: "ignore" });
    execSync("git add -A", { cwd: path, stdio: "ignore" });
    execSync(`git commit -m "${commitMessage}" --allow-empty`, {
      cwd: path,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Yabby",
        GIT_AUTHOR_EMAIL: "yabby@local",
        GIT_COMMITTER_NAME: "Yabby",
        GIT_COMMITTER_EMAIL: "yabby@local",
      },
    });
    log(`[SANDBOX] Git initialized in ${path}`);
  } catch (err) {
    log(`[SANDBOX] Git init failed in ${path}: ${err.message}`);
  }
}

/**
 * Migrate projects from the legacy ~/Desktop/Yabby Projects/ to the new
 * Yabby Workspace/Group Projects/. Idempotent — uses a .migrated marker.
 */
export async function migrateOldSandbox() {
  const legacyPath = join(homedir(), "Desktop", "Yabby Projects");
  const newRoot = getSandboxRoot();
  const marker = join(newRoot, ".migrated");

  // Skip if already migrated
  if (existsSync(marker)) return;

  // Skip if legacy folder doesn't exist
  if (!existsSync(legacyPath)) {
    // Create marker anyway so we don't check again
    try {
      await writeFile(marker, new Date().toISOString());
    } catch {}
    return;
  }

  // Skip if the new root IS the legacy path (user changed config to point to legacy)
  if (legacyPath === newRoot) return;

  try {
    const entries = readdirSync(legacyPath);
    if (entries.length === 0) {
      log(`[MIGRATION] Legacy folder empty, nothing to migrate`);
      try { await rmdir(legacyPath); } catch {}
      await writeFile(marker, new Date().toISOString());
      return;
    }

    const groupProjects = getGroupProjectsRoot();
    await mkdir(groupProjects, { recursive: true });

    let migrated = 0;
    let skipped = 0;

    for (const entry of entries) {
      const src = join(legacyPath, entry);
      const dest = join(groupProjects, entry);

      if (existsSync(dest)) {
        log(`[MIGRATION] Skipped (already exists): ${entry}`);
        skipped++;
        continue;
      }

      try {
        await rename(src, dest);
        log(`[MIGRATION] Moved: ${entry}`);
        migrated++;
      } catch (err) {
        log(`[MIGRATION] Failed to move ${entry}: ${err.message}`);
      }
    }

    log(`[MIGRATION] Complete: ${migrated} moved, ${skipped} skipped`);

    // Try to remove legacy folder if empty
    try {
      const remaining = readdirSync(legacyPath);
      if (remaining.length === 0) {
        await rmdir(legacyPath);
        log(`[MIGRATION] Removed empty legacy folder`);
      }
    } catch {}

    // Create marker to prevent re-migration
    await writeFile(marker, new Date().toISOString());
  } catch (err) {
    log(`[MIGRATION] Error: ${err.message}`);
  }
}

/**
 * Open a sandbox folder in the system file manager.
 * Returns true if successful.
 */
export function openInFileManager(sandboxPath) {
  try {
    if (process.platform === "darwin") {
      execSync(`open "${sandboxPath}"`);
    } else if (process.platform === "win32") {
      execSync(`explorer "${sandboxPath}"`);
    } else {
      execSync(`xdg-open "${sandboxPath}"`);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get sandbox info for a project (path, size, file count).
 */
export async function getSandboxInfo(projectId, projectName) {
  try {
    const path = await getSandboxPath(projectId, projectName);
    let fileCount = 0;
    let hasGit = false;

    try {
      const entries = readdirSync(path);
      fileCount = entries.filter(e => !e.startsWith(".")).length;
      hasGit = existsSync(join(path, ".git"));
    } catch {}

    return { path, fileCount, hasGit, exists: true };
  } catch {
    return { path: null, fileCount: 0, hasGit: false, exists: false };
  }
}
