#!/usr/bin/env node
/**
 * Full fresh-start reset for Yabby.
 *
 * Wipes all DB tables, Redis keys, media files, logs, and workspace.
 * Preserves the onboarding config so the 9-step wizard isn't needed again
 * (user name, language, voice, API keys, workspace path).
 *
 * Usage:
 *   node scripts/reset-yabby.js               # Prompts for confirmation
 *   node scripts/reset-yabby.js --yes         # Skip confirmation
 *   node scripts/reset-yabby.js --keep-workspace  # Don't wipe ~/Documents/Yabby Workspace
 */

import 'dotenv/config';
import { existsSync } from 'fs';
import { rm, mkdir, readdir, unlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { createInterface } from 'readline';
import pool, { query } from '../db/pg.js';
import { redis } from '../db/redis.js';

const YABBY_ID = 'yabby-000000';
const DEFAULT_CONV_ID = '00000000-0000-0000-0000-000000000001';

// Argument parsing
const args = process.argv.slice(2);
const skipConfirm = args.includes('--yes') || args.includes('-y');
const keepWorkspace = args.includes('--keep-workspace');

async function confirm() {
  if (skipConfirm) return true;
  console.log('\n⚠️  FRESH START — This will wipe:');
  console.log('   • All conversations, tasks, projects, agents (except Yabby)');
  console.log('   • All media files, logs, channel data, connectors');
  if (!keepWorkspace) console.log('   • The Yabby workspace folder');
  console.log('\n✅ Preserved:');
  console.log('   • Your name, language, voice, API keys, workspace path');
  console.log('   • Onboarding completion (no need to redo wizard)');
  console.log('');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(r => rl.question('Type "reset" to confirm: ', r));
  rl.close();
  return answer.trim() === 'reset';
}

async function wipeTable(tableName, where = '') {
  try {
    const sql = where ? `DELETE FROM ${tableName} WHERE ${where}` : `DELETE FROM ${tableName}`;
    const res = await query(sql);
    console.log(`  ✓ Wiped ${tableName}: ${res.rowCount} rows`);
    return res.rowCount;
  } catch (err) {
    if (err.code === '42P01') {
      // Table doesn't exist — skip silently (migrations may not have run)
      return 0;
    }
    console.log(`  ⚠ ${tableName}: ${err.message}`);
    return 0;
  }
}

async function wipeDir(dirPath, keepGitkeep = true) {
  if (!existsSync(dirPath)) return;
  try {
    const entries = await readdir(dirPath);
    for (const e of entries) {
      if (keepGitkeep && e === '.gitkeep') continue;
      await rm(join(dirPath, e), { recursive: true, force: true });
    }
    // Ensure .gitkeep exists
    if (keepGitkeep) {
      const gk = join(dirPath, '.gitkeep');
      if (!existsSync(gk)) await writeFile(gk, '');
    }
    console.log(`  ✓ Cleaned ${dirPath}`);
  } catch (err) {
    console.log(`  ⚠ ${dirPath}: ${err.message}`);
  }
}

async function main() {
  if (!(await confirm())) {
    console.log('Aborted.');
    process.exit(0);
  }

  console.log('\n🧹 Starting fresh-start reset...\n');

  // ── 1. Load preserved config values (done implicitly — we wipe SELECTED keys, not all) ──

  // ── 2. Wipe DB tables (in dependency order to avoid FK errors) ──
  console.log('📦 Wiping database tables...');

  // Child tables first (media joins, task queues, etc.)
  await wipeTable('turn_media');
  await wipeTable('message_media');
  await wipeTable('media_assets');
  await wipeTable('multi_agent_task_queue');
  await wipeTable('agent_task_queue');

  // NULL out agent pointers before we can delete tasks
  try {
    await query("UPDATE agents SET active_task_id = NULL, task_status = 'idle'");
  } catch {}

  await wipeTable('tasks');
  await wipeTable('scheduled_task_runs');
  await wipeTable('scheduled_tasks');

  await wipeTable('plan_reviews');
  await wipeTable('project_questions');
  await wipeTable('presentations');
  await wipeTable('project_connectors');
  await wipeTable('projects');

  await wipeTable('agent_messages');
  await wipeTable('agent_heartbeats');
  await wipeTable('agent_skills');
  await wipeTable('agent_whatsapp_groups');

  // Channels
  await wipeTable('channel_thread_bindings');
  await wipeTable('channel_pairings');
  await wipeTable('channel_messages');
  await wipeTable('channel_conversations');
  await wipeTable('dead_letters');
  await wipeTable('whatsapp_settings');

  // Connectors
  await wipeTable('connector_requests');
  await wipeTable('connectors');

  // Analytics
  await wipeTable('usage_log');
  await wipeTable('event_log');

  // Conversations — keep default conv row, wipe turns
  await wipeTable('conversation_turns');
  await wipeTable('conversations', `id != '${DEFAULT_CONV_ID}'`);

  // Reset default conversation state
  try {
    await query(
      "UPDATE conversations SET summary = '', last_response_id = NULL, updated_at = NOW() WHERE id = $1",
      [DEFAULT_CONV_ID]
    );
    console.log(`  ✓ Reset default conversation (${DEFAULT_CONV_ID})`);
  } catch {}

  // Agents — keep Yabby only, reset its state
  await wipeTable('agents', `id != '${YABBY_ID}'`);
  try {
    await query(
      `UPDATE agents SET active_task_id = NULL, task_status = 'idle', runner_sessions = '{}'::jsonb WHERE id = $1`,
      [YABBY_ID]
    );
    console.log(`  ✓ Reset Yabby agent state`);
  } catch (err) {
    // runner_sessions column may not exist on older schemas
    try {
      await query(
        `UPDATE agents SET active_task_id = NULL, task_status = 'idle' WHERE id = $1`,
        [YABBY_ID]
      );
      console.log(`  ✓ Reset Yabby agent state (legacy)`);
    } catch {}
  }

  // Ensure Yabby exists (re-seed if somehow missing)
  try {
    const { rows } = await query("SELECT id FROM agents WHERE id = $1", [YABBY_ID]);
    if (rows.length === 0) {
      await query(
        `INSERT INTO agents (id, name, role, system_prompt, is_super_agent, session_id, status, created_at)
         VALUES ($1, 'Yabby', 'Assistant Principal',
           'Tu es Yabby, l''assistant vocal principal. Tu orchestres les projets, les agents et les tâches.',
           TRUE, gen_random_uuid(), 'active', NOW())
         ON CONFLICT (id) DO NOTHING`,
        [YABBY_ID]
      );
      console.log(`  ✓ Re-seeded Yabby super-agent`);
    }
  } catch (err) {
    console.log(`  ⚠ Could not verify Yabby agent: ${err.message}`);
  }

  // Auth
  await wipeTable('api_tokens');
  await wipeTable('sessions');

  // Config — wipe runtime-only keys, preserve onboarding/API keys
  await wipeTable('config', `key IN ('mcp', 'channels')`);

  // ── 3. Mem0 ──
  console.log('\n🧠 Clearing memories...');
  try {
    const { clearMemories } = await import('../lib/memory.js');
    await clearMemories();
    console.log('  ✓ Cleared Mem0 memories (Qdrant vectors)');
  } catch (err) {
    console.log(`  ⚠ Mem0 clear skipped: ${err.message}`);
  }

  // Mem0 also keeps a history SQLite DB that's not cleared by deleteAll().
  // Nuke it so Yabby doesn't recall old memories by name/text.
  const memoryDbPath = join(process.cwd(), 'memory.db');
  if (existsSync(memoryDbPath)) {
    try {
      await unlink(memoryDbPath);
      console.log('  ✓ Deleted memory.db (Mem0 history)');
    } catch (err) {
      console.log(`  ⚠ memory.db delete failed: ${err.message}`);
    }
  }

  // ── 4. Redis — flush all yabby:* keys ──
  console.log('\n🔴 Flushing Redis...');
  try {
    const stream = redis.scanIterator({ MATCH: 'yabby:*', COUNT: 200 });
    let n = 0;
    for await (const key of stream) {
      // scanIterator can yield arrays in some versions
      if (Array.isArray(key)) {
        for (const k of key) {
          await redis.del(k);
          n++;
        }
      } else {
        await redis.del(key);
        n++;
      }
    }
    console.log(`  ✓ Deleted ${n} Redis keys`);
  } catch (err) {
    console.log(`  ⚠ Redis scan failed: ${err.message}`);
  }

  // ── 5. Files on disk ──
  console.log('\n💾 Cleaning disk...');

  const projectRoot = process.cwd();
  await wipeDir(join(projectRoot, 'media'));
  await wipeDir(join(projectRoot, 'logs'));

  // .running-tasks.json
  try {
    await unlink(join(projectRoot, '.running-tasks.json'));
    console.log('  ✓ Deleted .running-tasks.json');
  } catch {}

  // Workspace
  if (!keepWorkspace) {
    const workspacePath = join(homedir(), 'Documents', 'Yabby Workspace');
    if (existsSync(workspacePath)) {
      try {
        await rm(workspacePath, { recursive: true, force: true });
        // Recreate empty structure
        await mkdir(join(workspacePath, 'Group Projects'), { recursive: true });
        await mkdir(join(workspacePath, 'Independent Tasks'), { recursive: true });
        console.log(`  ✓ Reset workspace (${workspacePath})`);
      } catch (err) {
        console.log(`  ⚠ Workspace cleanup: ${err.message}`);
      }
    }

    // Also check alternate path
    const altWorkspace = join(homedir(), 'Documents', 'yabby-workspace');
    if (existsSync(altWorkspace)) {
      try {
        await rm(altWorkspace, { recursive: true, force: true });
        console.log(`  ✓ Removed alternate workspace (${altWorkspace})`);
      } catch {}
    }
  } else {
    console.log('  ⊝ Workspace preserved (--keep-workspace)');
  }

  console.log('\n✅ Fresh-start reset complete.');
  console.log('   Run `npm start` to launch Yabby with your preserved settings.\n');

  await pool.end();
  await redis.quit();
  process.exit(0);
}

main().catch(err => {
  console.error('❌ Reset failed:', err);
  process.exit(1);
});
