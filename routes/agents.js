import { Router } from "express";
import { randomUUID } from "crypto";
import { getAgent, listAgents, updateAgent, suspendAgent, activateAgent, deleteAgent, findAgentByName, findAgentByExactName, createAgent, isStandaloneAgent, getActiveTaskId, getAgentTaskStatus, updateAgentTaskStatus } from "../db/queries/agents.js";
import { logEvent } from "../db/queries/events.js";
import { log } from "../lib/logger.js";
import { buildStandaloneAgentPrompt, buildStandaloneAgentCliPrompt } from "../lib/prompts.js";
import { getAgentWhatsAppGroup, setAgentWhatsAppGroup } from "../db/queries/agent-whatsapp-groups.js";
import { getThreadManager } from "../lib/channels/thread-binding-manager.js";
import { query } from "../db/pg.js";
import { getQueuedTasks, getQueueLength, cancelPendingTasks } from "../db/queries/agent-task-queue.js";
import { serverMsg } from "../lib/i18n.js";
import { processAgentQueue } from "../lib/agent-task-processor.js";

const router = Router();

function genId() {
  return randomUUID().slice(0, 12);
}

/**
 * Generate a smart setup instruction for a standalone agent
 * @param {string} agentId - Agent ID
 * @param {string} name - Agent name
 * @param {string} role - Agent role
 * @param {string} roleInstructions - User instructions
 * @returns {string} Setup instruction
 */
function buildSetupInstruction(agentId, name, role, roleInstructions) {
  const apiPort = process.env.PORT || 3000;

  return `You have just been created as a standalone agent named "${name}". Here is your role and instructions:

**YOUR ROLE:**
${role}

**YOUR INSTRUCTIONS:**
${roleInstructions}

**⚠️ IMPORTANT CONTEXT:**
- You are in a **one-time setup task** that will configure how you operate
- This setup task will analyze your instructions and configure ALL necessary scheduling
- After this setup, you will automatically receive your scheduled tasks without manual intervention
- You must NOT create external tasks (bash cron jobs, etc.)

**SETUP TASK (DO THIS NOW):**

0. **⚠️ IMPORTANT CONTEXT - SCHEDULING IS DONE HERE, DURING SETUP**:
   - YOU (agent ${name}) are the one configuring the scheduling during this setup task
   - You are a CLI agent, you do NOT have access to the \`create_scheduled_task\` tool
   - Do NOT search for \`create_scheduled_task\` with ToolSearch (it does not exist in your CLI context)
   - To create scheduled tasks, you must use the HTTP API: \`POST /api/scheduled-tasks\`
   - ⛔ NEVER use \`CronCreate\` or bash cron jobs (non-persistent)
   - ✅ If your instructions require recurrence (daily, every X hours, etc.), you MUST create the scheduled task NOW via curl

1. **Analyze your instructions** to identify:
   - Whether a RECURRING task is requested (keywords: "daily", "every day", "every week", "weekly", "monthly", specific times like "at 10am", etc.)
   - Whether MULTIPLE DISTINCT TASKS are listed (enumerations, numbered lists, "do 10 analyses of...", etc.)
   - Whether it is a SIMPLE one-off TASK

2. **Configure your environment** according to the case:

   **CASE A - RECURRING task detected:**
   - ⚠️ CRITICAL: Use the HTTP API \`POST /api/scheduled-tasks\`
   - ⛔ NEVER use: CronCreate, bash cron jobs, or other scheduling tools
   - Choose the right \`scheduleType\`:
     * "cron" for specific times (e.g., "every day at 10am" → cron \`0 10 * * *\`)
     * "interval" for periods (e.g., "every 2 hours" → interval 7200000ms)

   - FULL EXAMPLE - Daily crypto analysis at 10am:
     \`\`\`bash
     curl -s -X POST http://localhost:${apiPort}/api/scheduled-tasks \\
       -H "Content-Type: application/json" \\
       -d '{
         "name": "Daily crypto watch",
         "description": "Crypto news analysis",
         "taskTemplate": "Analyze the latest crypto news from the past 24h. Identify the 3-5 main trends. Send a clear summary.",
         "scheduleType": "cron",
         "scheduleConfig": {
           "cronExpression": "0 10 * * *",
           "timezone": "Europe/Paris"
         },
         "agentId": "${agentId}"
       }'
     \`\`\`

   - EXAMPLE - Analysis every 3 hours:
     \`\`\`bash
     curl -s -X POST http://localhost:${apiPort}/api/scheduled-tasks \\
       -H "Content-Type: application/json" \\
       -d '{
         "name": "Hourly SaaS watch",
         "description": "SaaS market analysis",
         "taskTemplate": "Analyze the SaaS market and generate 2-3 innovative ideas with scoring.",
         "scheduleType": "interval",
         "scheduleConfig": {
           "intervalMs": 10800000
         },
         "agentId": "${agentId}"
       }'
     \`\`\`

   **CASE B - MULTIPLE DISTINCT TASKS:**
   - For EACH identified task, add it to your queue via API:
     \`\`\`bash
     curl -s -X POST http://localhost:${apiPort}/api/tasks/start \\
       -H "Content-Type: application/json" \\
       -d '{"task":"[precise task description]","agent_id":"${agentId}"}'
     \`\`\`
   - Example: if asked to "do 10 sector analyses", create 10 separate calls

   **CASE C - SIMPLE TASK:**
   - Execute it directly, no special configuration needed

3. **IMPORTANT - How to finish the setup**:
   - ⚠️ Do NOT try to send a message via API (no agent-bus, no /api/messages)
   - ⚠️ Do NOT try to inform Yabby or the speaker
   - ✅ Simply RETURN a summary of your configuration as the final result of this task
   - The system will automatically send this result to your WhatsApp thread

   **Summary format**:
   - Short and clear, style "✅ Setup complete: [summary]"
   - List what you configured DURING THIS SETUP:
     * Scheduled tasks created (with exact times/intervals) - CRITICAL: include the task ID returned by the API
     * Tasks added to the queue (count and list)
     * Simple task being executed
   - Example: "✅ Setup complete: Scheduled task created (ID: abc123) for analysis every 2h. First execution in 2h."

**REMINDER:**
- Each result of your tasks is automatically sent to your WhatsApp thread
- NEVER mention "Yabby", "agent-bus" or "system" in your responses to the user
- Focus on your specific role: ${role}
- You work in full autonomy

Start the setup now!`;
}

/**
 * Create a WhatsApp thread for a standalone agent
 * @param {object} agent - Agent object with id, name, role
 * @returns {Promise<object|null>} Group info or null if WhatsApp not available
 */
async function createWhatsAppThreadForAgent(agent) {
  try {
    // Get WhatsApp adapter
    const { getChannel } = await import("../lib/channels/index.js");
    const whatsapp = getChannel("whatsapp");

    if (!whatsapp || !whatsapp.running) {
      log(`[AGENT-WHATSAPP] WhatsApp not connected, skipping thread creation for ${agent.id}`);
      return null;
    }

    // Check if group already exists
    const existing = await getAgentWhatsAppGroup(agent.id);
    if (existing) {
      log(`[AGENT-WHATSAPP] Thread already exists for agent ${agent.id}: ${existing.group_id}`);
      return { groupId: existing.group_id, groupName: existing.group_name };
    }

    // Create WhatsApp group
    // Format: "💬 [Role] [AgentName]" (e.g., "💬 Analyste Crypto [Marie]")
    const groupName = `💬 ${agent.role} [${agent.name}]`;
    log(`[AGENT-WHATSAPP] Creating group "${groupName}" for agent ${agent.id} (${agent.name})`);

    const group = await whatsapp.client.groupCreate(groupName, []);
    const groupId = group.id;
    log(`[AGENT-WHATSAPP] ✓ Created group: ${groupId}`);

    // Save to DB
    await setAgentWhatsAppGroup(agent.id, groupId, groupName);

    // Create conversation for this agent
    const { getOrCreateAgentConversation } = await import("../db/queries/conversations.js");
    const conversationId = await getOrCreateAgentConversation(agent.id);

    // Create thread binding
    const { getThreadManager} = await import("../lib/channels/thread-binding-manager.js");
    const threadManager = getThreadManager("whatsapp", "main");
    const sessionKey = `agent-thread:${agent.id}`;

    await threadManager.bindThread({
      threadId: groupId,
      conversationId,
      agentId: agent.id,
      sessionKey,
      metadata: {
        agent_name: agent.name,
        created_via: "auto_create_on_agent_creation",
        group_name: groupName
      }
    });

    log(`[AGENT-WHATSAPP] ✓ Created thread binding for agent ${agent.id}`);

    // Send welcome message
    await whatsapp.send(groupId, serverMsg().agentCreatedWelcome(agent.name, agent.role));

    return { groupId, groupName, conversationId };
  } catch (err) {
    log(`[AGENT-WHATSAPP] ❌ Failed to create thread for agent ${agent.id}:`, err.message);
    return null;
  }
}

// List agents (optionally filtered by project)
router.get("/api/agents", async (req, res) => {
  try {
    const agents = await listAgents(req.query.project_id || null);
    res.json({ agents });
  } catch (err) {
    log("[AGENTS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create standalone agent (not tied to a project)
//
// Dual behavior based on body:
//   - body has `project_id` (or alias) → silently delegates to
//     POST /api/projects/:id/agents (the canonical sub-agent path).
//     Mirrors the routing logic of `assign_agent` in routes/tools.js so a
//     direct curl gets the same outcome as going through the LLM tool.
//   - no project_id → standalone agent creation (original behavior,
//     creates dedicated WhatsApp/Telegram threads, etc.).
//
// This matters because LLM agents inside a project sometimes guess the
// wrong endpoint and end up at /api/agents with project_id in the body.
// Without this delegation, project_id was silently dropped and the agent
// landed standalone, polluting the channel surface with an orphan
// per-agent WhatsApp group.
router.post("/api/agents", async (req, res) => {
  const { name, role, role_instructions } = req.body;

  if (!name || !role || !role_instructions || !role_instructions.trim()) {
    return res.status(400).json({ error: "Missing required fields: name, role, role_instructions (non-empty)" });
  }

  // ─── Delegation: project_id present → forward to project sub-agent path ──
  // Alias-tolerant lookup so callers using camelCase / variant names land
  // on the right behavior without ceremony.
  const PROJECT_ID_ALIASES = ['project_id', 'projectId', 'project_name_or_id', 'project'];
  const PARENT_ALIASES = ['parent_agent_id', 'parentAgentId', 'parent', 'parent_id'];
  let projectIdAlias = null;
  let projectId = null;
  for (const k of PROJECT_ID_ALIASES) {
    if (req.body[k]) { projectId = req.body[k]; projectIdAlias = k; break; }
  }
  let parentAgentId = null;
  for (const k of PARENT_ALIASES) {
    if (req.body[k]) { parentAgentId = req.body[k]; break; }
  }
  const { is_lead, is_manager } = req.body;

  if (projectId) {
    try {
      log(`[AGENTS] POST /api/agents delegating to project sub-agent path (projectId=${projectId} via ${projectIdAlias})`);
      const port = process.env.PORT || 3000;
      const upstream = await fetch(`http://localhost:${port}/api/projects/${encodeURIComponent(projectId)}/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          role,
          role_instructions,
          is_lead: is_lead === true,
          is_manager: is_manager === true,
          parent_agent_id: parentAgentId,
        }),
      });
      const text = await upstream.text();
      let parsed = null;
      try { parsed = JSON.parse(text); } catch { /* keep raw on parse failure */ }
      // Mirror the upstream status code (404 if project not found, 409 on
      // duplicate name, 400 on bad input, 200 on success) so the caller
      // gets the same semantics as if they hit the project endpoint directly.
      return res.status(upstream.status).json(parsed ?? { raw: text });
    } catch (err) {
      log(`[AGENTS] Delegation to project sub-agent path failed: ${err.message}`);
      return res.status(500).json({ error: `Failed to delegate to project sub-agent path: ${err.message}` });
    }
  }

  // No project_id → standalone path. If is_manager / parent_agent_id were
  // passed without a project, log it (the fields are nonsensical for a
  // standalone agent and are simply dropped — same outcome as today, just
  // visible in logs for debugging).
  if (is_manager === true || parentAgentId) {
    log(`[AGENTS] POST /api/agents: ${is_manager === true ? 'is_manager=true ' : ''}${parentAgentId ? `parent_agent_id=${parentAgentId} ` : ''}ignored (no project_id) — creating standalone`);
  }

  try {
    // Check for duplicate name (enforced by DB constraint, but provide better error)
    const existing = await findAgentByExactName(name);
    if (existing) {
      return res.status(409).json({
        error: `Agent name "${name}" already exists. Agent names must be globally unique.`,
        existingAgent: {
          id: existing.id,
          name: existing.name,
          role: existing.role,
          projectId: existing.projectId,
          projectName: existing.projectId ? '(project agent)' : '(standalone agent)'
        }
      });
    }

    const agentId = genId();

    log(`[AGENTS] Building standalone prompts for ${name} with instructions:`, role_instructions);

    // Build BOTH prompts:
    // - systemPrompt: used by chat/channel handlers (gpt-5-mini with yabby_execute tools)
    // - cliSystemPrompt: used when spawning Claude Code CLI (native Bash/Read/Write tools,
    //   NO yabby_execute since the CLI IS the executor, not a delegator)
    const systemPrompt = buildStandaloneAgentPrompt(name, role, role_instructions, agentId);
    const cliSystemPrompt = buildStandaloneAgentCliPrompt(name, role, role_instructions, agentId);

    log(`[AGENTS] Generated prompts: chat=${systemPrompt?.length || 0} chars, cli=${cliSystemPrompt?.length || 0} chars`);

    const agent = await createAgent(agentId, null, name, role, systemPrompt, { isLead: false, cliSystemPrompt });

    log(`[AGENTS] Created standalone agent: ${agentId} (${name})`);

    // Auto-assign qa_browser_session skill for QA roles
    if (role && (role.toLowerCase().includes('qa') || role.toLowerCase().includes('test'))) {
      try {
        const { query } = await import("../db/pg.js");
        await query(
          'INSERT INTO agent_skills (agent_id, skill_id) SELECT $1, id FROM skills WHERE name = $2 ON CONFLICT DO NOTHING',
          [agentId, 'qa_browser_session']
        );
        log(`[AGENTS] ✅ Auto-assigned qa_browser_session skill to ${name} (${role})`);
      } catch (err) {
        log(`[AGENTS] ⚠️  Failed to auto-assign qa_browser_session:`, err.message);
      }
    }

    // Auto-create WhatsApp thread (if WhatsApp is connected)
    const threadInfo = await createWhatsAppThreadForAgent({
      id: agentId,
      name,
      role
    });

    if (threadInfo) {
      log(`[AGENTS] ✅ WhatsApp thread created automatically: ${threadInfo.groupId}`);
    } else {
      log(`[AGENTS] ⚠️  WhatsApp thread not created (WhatsApp not connected or error)`);
    }

    // Auto-create dedicated threads on Telegram/Discord/Slack when:
    //   - the channel adapter is running
    //   - a container has been paired (channel_containers row)
    //
    // Mirrors the WhatsApp auto-create above for consistency. Each creator is
    // best-effort and isolated: a failure on one channel does NOT prevent the
    // others from running. Failures are logged, not surfaced as HTTP errors —
    // agent creation already succeeded. Channels with no paired container
    // are silently skipped (the container is the operator's explicit opt-in
    // for that channel).
    const extraChannelThreads = [];
    try {
      const { getChannel } = await import("../lib/channels/index.js");
      const { getChannelContainer } = await import("../db/queries/channel-containers.js");
      const {
        createAgentTelegramTopic,
        createAgentDiscordChannel,
        createAgentSlackChannel,
      } = await import("../lib/channels/agent-thread-creator.js");

      const agentForCreator = { id: agentId, name, role };

      const channelHooks = [
        { name: "telegram", creator: createAgentTelegramTopic },
        { name: "discord",  creator: createAgentDiscordChannel },
        { name: "slack",    creator: createAgentSlackChannel },
      ];

      for (const { name: channelName, creator } of channelHooks) {
        const adapter = getChannel(channelName);
        if (!adapter?.running) continue;
        const container = await getChannelContainer(channelName);
        if (!container) continue;
        try {
          const result = await creator(agentForCreator);
          extraChannelThreads.push(result);
          log(`[AGENTS] ✅ ${channelName} thread auto-created: ${result.thread_id}`);

          // Send the same welcome message we send to WhatsApp, so the user
          // sees "Agent created successfully" on every paired surface
          // (Telegram topic, Discord private channel, Slack channel) the
          // moment the new thread is ready.
          try {
            await adapter.send(result.thread_id, serverMsg().agentCreatedWelcome(name, role));
          } catch (sendErr) {
            log(`[AGENTS] ⚠ ${channelName} welcome send failed (non-fatal): ${sendErr.message}`);
          }
        } catch (err) {
          log(`[AGENTS] ⚠ ${channelName} thread auto-create failed (non-fatal): ${err.message}`);
        }
      }
    } catch (err) {
      log(`[AGENTS] ⚠ Channel auto-create hook failed (non-fatal): ${err.message}`);
    }

    // Auto-enqueue INTELLIGENT setup instruction for standalone agent (persistent task system)
    if (role_instructions && role_instructions.trim()) {
      try {
        const { enqueueTask } = await import("../db/queries/agent-task-queue.js");
        const { processAgentQueue } = await import("../lib/agent-task-processor.js");

        // ✅ Generate intelligent setup instruction instead of raw role_instructions
        const setupInstruction = buildSetupInstruction(agentId, name, role, role_instructions);

        const queueItem = await enqueueTask(agentId, setupInstruction, 'agent_init', null, 50);
        log(`[AGENTS] ✅ Enqueued intelligent setup instruction for agent ${agentId} (queue_id: ${queueItem.id})`);

        // Trigger queue processor (creates persistent task or resumes existing)
        setImmediate(() => processAgentQueue(agentId));
      } catch (err) {
        log(`[AGENTS] ❌ Failed to enqueue setup instruction for agent ${agentId}:`, err.message);
      }
    }

    // Build a concise multi-channel summary so the CLI can announce every
    // surface the agent is now reachable on without a follow-up call.
    const channelSummary = [];
    if (threadInfo) channelSummary.push(`WhatsApp: "${threadInfo.groupName}"`);
    for (const t of extraChannelThreads) {
      channelSummary.push(`${t.channel}: ${t.name}`);
    }

    res.json({
      ...agent,
      whatsappThread: threadInfo ? {
        groupId: threadInfo.groupId,
        groupName: threadInfo.groupName
      } : null,
      channelThreads: extraChannelThreads,
      message: serverMsg().agentCreatedApiMsg(name, channelSummary)
    });
  } catch (err) {
    log("[AGENTS] Error creating standalone agent:", err.message);

    // Handle unique constraint violation
    if (err.message.includes('agents_name_unique') || err.code === '23505') {
      return res.status(409).json({
        error: `Agent name "${name}" already exists. Agent names must be globally unique.`
      });
    }

    res.status(500).json({ error: err.message });
  }
});

// Get agent detail
router.get("/api/agents/:id", async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    log(`[AGENTS] GET /api/agents/${req.params.id} - system_prompt length:`, agent.systemPrompt?.length || 0);
    res.json(agent);
  } catch (err) {
    log("[AGENT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update agent
router.put("/api/agents/:id", async (req, res) => {
  try {
    await updateAgent(req.params.id, req.body);
    const agent = await getAgent(req.params.id);
    res.json(agent);
  } catch (err) {
    log("[AGENT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Suspend agent
router.post("/api/agents/:id/suspend", async (req, res) => {
  try {
    await suspendAgent(req.params.id);
    await logEvent("agent_suspended", { agentId: req.params.id });
    res.json({ id: req.params.id, status: "suspended" });
  } catch (err) {
    log("[AGENT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Activate agent
router.post("/api/agents/:id/activate", async (req, res) => {
  try {
    await activateAgent(req.params.id);
    await logEvent("agent_activated", { agentId: req.params.id });
    res.json({ id: req.params.id, status: "active" });
  } catch (err) {
    log("[AGENT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete (archive) agent — supports ID or name
router.delete("/api/agents/:id", async (req, res) => {
  try {
    let agent = await getAgent(req.params.id);
    if (!agent) agent = await findAgentByName(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    // ⚠️ PROTECTION: Cannot delete super agents
    if (agent.isSuperAgent) {
      return res.status(403).json({
        error: "Cannot delete super agent",
        message: `${agent.name} is a system agent and cannot be deleted.`
      });
    }

    await deleteAgent(agent.id);
    await logEvent("agent_deleted", { agentId: agent.id, detail: { name: agent.name, role: agent.role } });
    log("[AGENT] Deleted:", agent.id, agent.name);
    res.json({ deleted: true, id: agent.id, name: agent.name, role: agent.role });
  } catch (err) {
    log("[AGENT] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Create WhatsApp thread for agent
router.post("/api/agents/whatsapp-thread", async (req, res) => {
  try {
    const { agent_id } = req.body;

    if (!agent_id) {
      return res.status(400).json({ error: "Missing agent_id" });
    }

    // Resolve agent (by ID or name)
    let agent = await getAgent(agent_id);
    if (!agent) agent = await findAgentByName(agent_id);
    if (!agent) {
      return res.status(404).json({ error: `Agent "${agent_id}" not found` });
    }

    // Check if group already exists
    const existing = await getAgentWhatsAppGroup(agent.id);
    if (existing) {
      log(`[AGENT-WHATSAPP] Group exists in DB for agent ${agent.id}: ${existing.group_id}`);

      // Get WhatsApp adapter to verify group still exists
      const { getChannel } = await import("../lib/channels/index.js");
      const whatsapp = getChannel("whatsapp");

      if (whatsapp && whatsapp.running) {
        // STEP 1: Verify the WhatsApp group still exists. ONLY this call is wrapped
        // in the destructive-cleanup catch — every other failure must surface as a
        // 500 instead of silently wiping the agent's history.
        let groupStillExists = true;
        try {
          await whatsapp.client.groupMetadata(existing.group_id);
          log(`[AGENT-WHATSAPP] ✓ Group verified in WhatsApp`);
        } catch (err) {
          groupStillExists = false;
          log(`[AGENT-WHATSAPP] ⚠️  Group ${existing.group_id} not found in WhatsApp (deleted manually?): ${err.message}`);
        }

        if (groupStillExists) {
          // STEP 2: Recover binding + conversation if missing. Errors here propagate
          // to the outer route handler (500) — they MUST NOT trigger DB cleanup.
          const { getOrCreateAgentConversation } = await import("../db/queries/conversations.js");
          const conversationId = await getOrCreateAgentConversation(agent.id);

          const { getThreadManager } = await import("../lib/channels/thread-binding-manager.js");
          const threadManager = getThreadManager("whatsapp", "main");
          const existingBinding = await threadManager.getByThreadId(existing.group_id);

          if (!existingBinding) {
            log(`[AGENT-WHATSAPP] Thread binding missing, creating it now...`);
            const sessionKey = `agent-thread:${agent.id}`;
            await threadManager.bindThread({
              threadId: existing.group_id,
              conversationId,
              agentId: agent.id,
              sessionKey,
              metadata: {
                agent_name: agent.name,
                created_via: "create_agent_thread_recovery",
                group_name: existing.group_name
              }
            });
            log(`[AGENT-WHATSAPP] ✓ Created missing thread binding`);
          }

          // Return existing thread info
          return res.json({
            success: true,
            agent_id: agent.id,
            agent_name: agent.name,
            group_id: existing.group_id,
            group_name: existing.group_name,
            message: `The WhatsApp thread with ${agent.name} already exists. Open WhatsApp to continue the conversation.`
          });
        }

        // STEP 3: Group is genuinely gone. Clean up DB rows and fall through to
        // create a fresh group below. (Same destructive cleanup as before, but now
        // ONLY runs when groupMetadata genuinely failed.)
        log(`[AGENT-WHATSAPP] Cleaning up orphaned entries...`);
        await query(`DELETE FROM agent_whatsapp_groups WHERE agent_id = $1`, [agent.id]);
        await query(`DELETE FROM channel_thread_bindings WHERE agent_id = $1`, [agent.id]);
        await query(`DELETE FROM conversations WHERE agent_id = $1`, [agent.id]);
        log(`[AGENT-WHATSAPP] ✓ Cleaned up orphaned entries, will create new group`);
        // Fall through to create new group
      }
    }

    // Get WhatsApp adapter from global channels
    const { getChannel } = await import("../lib/channels/index.js");
    const whatsapp = getChannel("whatsapp");

    if (!whatsapp || !whatsapp.running) {
      return res.status(503).json({
        error: "WhatsApp is not connected. Please start WhatsApp first."
      });
    }

    // Create WhatsApp group with descriptive name based on role + agent name
    // Format: "💬 [Role] [AgentName]" (e.g., "💬 Analyste Crypto [Marie]")
    const groupName = `💬 ${agent.role} [${agent.name}]`;
    log(`[AGENT-WHATSAPP] Creating group "${groupName}" for agent ${agent.id} (${agent.name})`);

    const group = await whatsapp.client.groupCreate(groupName, []);
    const groupId = group.id;

    log(`[AGENT-WHATSAPP] ✓ Created group: ${groupId}`);

    // Save to DB
    await setAgentWhatsAppGroup(agent.id, groupId, groupName);
    log(`[AGENT-WHATSAPP] ✓ Saved to DB`);

    // Create conversation for this agent thread
    const { getOrCreateAgentConversation } = await import("../db/queries/conversations.js");
    const conversationId = await getOrCreateAgentConversation(agent.id);
    log(`[AGENT-WHATSAPP] ✓ Created conversation: ${conversationId}`);

    // Create thread binding
    const threadManager = getThreadManager("whatsapp", "main");
    const sessionKey = `agent-thread:${agent.id}`;

    await threadManager.bindThread({
      threadId: groupId,
      conversationId,
      agentId: agent.id,
      sessionKey,
      metadata: {
        agent_name: agent.name,
        created_via: "create_agent_thread",
        group_name: groupName
      }
    });

    log(`[AGENT-WHATSAPP] ✓ Created thread binding: ${groupId} → agent ${agent.id}`);

    // Send welcome message to group
    await whatsapp.send(groupId, serverMsg().agentCreatedWelcome(agent.name, agent.role));

    res.json({
      success: true,
      agent_id: agent.id,
      agent_name: agent.name,
      group_id: groupId,
      group_name: groupName,
      conversation_id: conversationId,
      message: serverMsg().whatsappThreadCreatedMsg(groupName)
    });

  } catch (err) {
    log("[AGENT-WHATSAPP] Error creating thread:", err.message);
    log("[AGENT-WHATSAPP] Stack:", err.stack);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Multi-channel agent thread creation — Telegram / Discord / Slack.
 *
 * Each endpoint:
 *   - Verifies the channel container is paired (channel_containers row)
 *   - Verifies the adapter is running
 *   - Calls the channel-specific creator (lib/channels/agent-thread-creator.js)
 *     which handles platform API + binding upsert + owner_user_id propagation
 *
 * Returns { success, channel, thread_id, name, message } on success.
 *
 * Mirrors the WhatsApp thread route — the operator opt-in is the explicit
 * pairing step (`/pairforum`, `/pairserver`, `/yabbypair`), not a global
 * config flag. Without a paired container, the creator throws a clear error
 * telling the user to run the pairing slash command.
 */
function makeAgentThreadRoute(channelName, creator) {
  return async (req, res) => {
    try {
      const { agent_id } = req.body;
      if (!agent_id) return res.status(400).json({ error: "Missing agent_id" });

      let agent = await getAgent(agent_id);
      if (!agent) agent = await findAgentByName(agent_id);
      if (!agent) return res.status(404).json({ error: `Agent "${agent_id}" not found` });

      const result = await creator(agent);
      res.json(result);
    } catch (err) {
      log(`[AGENT-THREAD:${channelName}] failed:`, err.message);
      res.status(400).json({ error: err.message });
    }
  };
}

router.post("/api/agents/telegram-thread", async (req, res) => {
  const { createAgentTelegramTopic } = await import("../lib/channels/agent-thread-creator.js");
  return makeAgentThreadRoute("telegram", createAgentTelegramTopic)(req, res);
});

router.post("/api/agents/discord-thread", async (req, res) => {
  const { createAgentDiscordChannel } = await import("../lib/channels/agent-thread-creator.js");
  return makeAgentThreadRoute("discord", createAgentDiscordChannel)(req, res);
});

router.post("/api/agents/slack-thread", async (req, res) => {
  const { createAgentSlackChannel } = await import("../lib/channels/agent-thread-creator.js");
  return makeAgentThreadRoute("slack", createAgentSlackChannel)(req, res);
});

// List all WhatsApp threads (agent groups)
router.get("/api/whatsapp/threads", async (req, res) => {
  try {
    const { listAgentWhatsAppGroups } = await import("../db/queries/agent-whatsapp-groups.js");
    const threads = await listAgentWhatsAppGroups();

    // Enrich with agent info
    const enriched = await Promise.all(threads.map(async (t) => {
      const agent = await getAgent(t.agent_id);
      return {
        id: t.id,
        agent_id: t.agent_id,
        agent_name: agent?.name || 'Unknown',
        agent_role: agent?.role || '',
        agent_status: agent?.status || 'unknown',
        group_id: t.group_id,
        group_name: t.group_name,
        created_at: t.created_at,
        updated_at: t.updated_at
      };
    }));

    res.json({ threads: enriched });
  } catch (err) {
    log("[WHATSAPP-THREADS] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Delete WhatsApp thread (removes group from WhatsApp + DB)
router.delete("/api/whatsapp/threads/:agent_id", async (req, res) => {
  try {
    const { deleteAgentWhatsAppGroup } = await import("../db/queries/agent-whatsapp-groups.js");

    // Resolve agent (by ID or name)
    let agent = await getAgent(req.params.agent_id);
    if (!agent) agent = await findAgentByName(req.params.agent_id);
    if (!agent) {
      return res.status(404).json({ error: `Agent "${req.params.agent_id}" not found` });
    }

    // Get thread info before deleting
    const { getAgentWhatsAppGroup } = await import("../db/queries/agent-whatsapp-groups.js");
    const threadInfo = await getAgentWhatsAppGroup(agent.id);

    if (!threadInfo) {
      return res.status(404).json({ error: "No WhatsApp thread found for this agent" });
    }

    // Delete WhatsApp group via adapter
    const { getChannel } = await import("../lib/channels/index.js");
    const whatsapp = getChannel("whatsapp");

    if (whatsapp && whatsapp.running) {
      try {
        await whatsapp.client.groupLeave(threadInfo.group_id);
        log(`[WHATSAPP-THREADS] ✓ Left group: ${threadInfo.group_id}`);
      } catch (err) {
        log(`[WHATSAPP-THREADS] ⚠️  Failed to leave group (may not exist): ${err.message}`);
      }
    }

    // Delete from DB
    await deleteAgentWhatsAppGroup(agent.id);

    // Delete thread binding
    await query(`DELETE FROM channel_thread_bindings WHERE agent_id = $1`, [agent.id]);

    // Delete conversation
    await query(`DELETE FROM conversations WHERE agent_id = $1`, [agent.id]);

    log(`[WHATSAPP-THREADS] ✓ Deleted thread for agent ${agent.id} (${agent.name})`);

    res.json({
      deleted: true,
      agent_id: agent.id,
      agent_name: agent.name,
      group_id: threadInfo.group_id
    });
  } catch (err) {
    log("[WHATSAPP-THREADS] Delete error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Update WhatsApp thread name (renames group in WhatsApp + DB)
router.put("/api/whatsapp/threads/:agent_id", async (req, res) => {
  try {
    const { new_name } = req.body;

    if (!new_name || typeof new_name !== 'string') {
      return res.status(400).json({ error: "Missing new_name" });
    }

    // Resolve agent (by ID or name)
    let agent = await getAgent(req.params.agent_id);
    if (!agent) agent = await findAgentByName(req.params.agent_id);
    if (!agent) {
      return res.status(404).json({ error: `Agent "${req.params.agent_id}" not found` });
    }

    // Get thread info
    const { getAgentWhatsAppGroup, setAgentWhatsAppGroup } = await import("../db/queries/agent-whatsapp-groups.js");
    const threadInfo = await getAgentWhatsAppGroup(agent.id);

    if (!threadInfo) {
      return res.status(404).json({ error: "No WhatsApp thread found for this agent" });
    }

    // Update WhatsApp group name via adapter
    const { getChannel } = await import("../lib/channels/index.js");
    const whatsapp = getChannel("whatsapp");

    if (!whatsapp || !whatsapp.running) {
      return res.status(503).json({ error: "WhatsApp is not connected" });
    }

    await whatsapp.client.groupUpdateSubject(threadInfo.group_id, new_name);
    log(`[WHATSAPP-THREADS] ✓ Renamed group ${threadInfo.group_id} to "${new_name}"`);

    // Update DB
    await setAgentWhatsAppGroup(agent.id, threadInfo.group_id, new_name);

    res.json({
      success: true,
      agent_id: agent.id,
      agent_name: agent.name,
      group_id: threadInfo.group_id,
      old_name: threadInfo.group_name,
      new_name: new_name
    });
  } catch (err) {
    log("[WHATSAPP-THREADS] Update error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ──────────────────────────────────────────────────────────────────
// Agent Task Queue Management (for standalone agents)
// ──────────────────────────────────────────────────────────────────

// Get agent task queue
router.get("/api/agents/:id/queue", async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    if (!await isStandaloneAgent(req.params.id)) {
      return res.status(400).json({ error: "Only standalone agents have task queues" });
    }

    const tasks = await getQueuedTasks(req.params.id, 50);
    const queueLength = await getQueueLength(req.params.id);
    const activeTaskId = await getActiveTaskId(req.params.id);
    const taskStatus = await getAgentTaskStatus(req.params.id);

    res.json({
      agent_id: agent.id,
      agent_name: agent.name,
      active_task_id: activeTaskId,
      task_status: taskStatus,
      queue_length: queueLength,
      queued_tasks: tasks
    });
  } catch (err) {
    log("[QUEUE] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Cancel all pending tasks for agent
router.post("/api/agents/:id/queue/clear", async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    if (!await isStandaloneAgent(req.params.id)) {
      return res.status(400).json({ error: "Only standalone agents have task queues" });
    }

    await cancelPendingTasks(req.params.id);
    log(`[QUEUE] Cleared queue for agent ${agent.name}`);

    res.json({
      agent_id: agent.id,
      message: "All pending tasks cancelled"
    });
  } catch (err) {
    log("[QUEUE] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Resume agent after interrupt
router.post("/api/agents/:id/resume", async (req, res) => {
  try {
    const agent = await getAgent(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    if (!await isStandaloneAgent(req.params.id)) {
      return res.status(400).json({ error: "Only standalone agents have task queues" });
    }

    const taskStatus = await getAgentTaskStatus(req.params.id);
    if (taskStatus !== 'paused') {
      return res.status(400).json({
        error: `Agent is ${taskStatus}, not paused`
      });
    }

    await updateAgentTaskStatus(req.params.id, 'idle');
    setImmediate(() => processAgentQueue(req.params.id));

    res.json({
      agent_id: agent.id,
      message: "Agent resumed, processing queue"
    });
  } catch (err) {
    log("[QUEUE] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:id/change-workspace
 * Atomic: kill current persistent task → update workspace_path in DB →
 * respawn a fresh persistent task in the new CWD with previous session
 * history injected into the system prompt for context continuity.
 *
 * Body: { workspace_path: "/absolute/path", reason?: "..." }
 */
router.post("/api/agents/:id/change-workspace", async (req, res) => {
  try {
    const fs = await import("fs");
    const path = await import("path");
    const { workspace_path, reason } = req.body || {};

    // ── Step 1: Validation ────────────────────────────────────────────────
    if (!workspace_path || typeof workspace_path !== "string") {
      return res.status(400).json({ error: "Missing or invalid workspace_path" });
    }
    if (!path.isAbsolute(workspace_path)) {
      return res.status(400).json({ error: "workspace_path must be absolute" });
    }
    if (!fs.existsSync(workspace_path)) {
      return res.status(400).json({ error: `workspace_path does not exist: ${workspace_path}` });
    }
    const stat = fs.statSync(workspace_path);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: `workspace_path is not a directory: ${workspace_path}` });
    }

    // Resolve agent (by ID or name)
    let agent = await getAgent(req.params.id);
    if (!agent) agent = await findAgentByName(req.params.id);
    if (!agent) return res.status(404).json({ error: "Agent not found" });

    if (agent.isSuperAgent) {
      return res.status(403).json({ error: "Cannot change workspace of super agent" });
    }

    const oldWorkspace = agent.workspacePath || null;
    log(`[CHANGE-WS] 📥 Request received — agent=${agent.name} (${agent.id})`);
    log(`[CHANGE-WS]    oldWorkspace="${oldWorkspace}"`);
    log(`[CHANGE-WS]    workspace_path="${workspace_path}"`);
    log(`[CHANGE-WS]    reason="${reason || '(none)'}"`);

    // ── No-op detection: target already equals current workspace ─────────
    if (oldWorkspace) {
      let currentResolved = oldWorkspace;
      let targetResolved = workspace_path;
      try {
        currentResolved = fs.realpathSync(oldWorkspace);
        targetResolved = fs.realpathSync(workspace_path);
        log(`[CHANGE-WS]    realpath(old)="${currentResolved}"`);
        log(`[CHANGE-WS]    realpath(new)="${targetResolved}"`);
      } catch (err) {
        log(`[CHANGE-WS]    realpath failed (${err.message}), falling back to string comparison`);
      }
      if (currentResolved === targetResolved) {
        log(`[CHANGE-WS] ✅ NO-OP: target equals current workspace, returning unchanged without killing the task`);
        return res.json({
          unchanged: true,
          workspace_path: oldWorkspace,
          note: "Already in this workspace — no change applied. You can keep working with absolute paths from this directory.",
        });
      }
      log(`[CHANGE-WS] 🔀 Workspace will change: "${currentResolved}" → "${targetResolved}"`);
    } else {
      log(`[CHANGE-WS] 🆕 Agent had no workspace before, setting to "${workspace_path}"`);
    }

    // ── Step 2: Capture current task state + history summary ─────────────
    const { getTask, updateTaskStatus } = await import("../db/queries/tasks.js");
    const { releaseLock } = await import("../db/queries/guilock.js");
    const { processHandles } = await import("../lib/spawner.js");
    const { summarizeSessionHistory } = await import("../lib/session-history.js");
    const { enqueueTask } = await import("../db/queries/agent-task-queue.js");
    const { processAgentQueue } = await import("../lib/agent-task-processor.js");

    const currentTaskId = await getActiveTaskId(agent.id);
    let historySummary = null;
    let prevSessionId = null;

    let killedRunningTask = false;
    if (currentTaskId) {
      const entry = await getTask(currentTaskId);
      if (entry) {
        prevSessionId = entry.sessionId;
        historySummary = await summarizeSessionHistory(currentTaskId, { maxChars: 3000 });
        log(`[CHANGE-WS] Captured history from task ${currentTaskId} (${historySummary?.length || 0} chars)`);
      }

      // ── Step 3: Kill current task ──────────────────────────────────────
      if (entry && entry.status === "running") {
        killedRunningTask = true;
        // CRITICAL: mark the task killed BEFORE sending SIGTERM. The spawner's
        // child.on("close") handler reads the task status from the DB and
        // returns early when it sees "killed" — otherwise it falls into the
        // error branch and overwrites this with status="error".
        await updateTaskStatus(currentTaskId, "killed", "Terminated by change-workspace");
        await releaseLock(currentTaskId);

        const child = processHandles.get(currentTaskId);
        if (child) {
          log(`[CHANGE-WS] Killing running task ${currentTaskId} (PID ${child.pid})`);
          try { child.kill("SIGTERM"); } catch {}
          await new Promise((resolve) => {
            let done = false;
            const onExit = () => { if (!done) { done = true; resolve(); } };
            child.once("exit", onExit);
            setTimeout(onExit, 2000);
          });
          processHandles.delete(currentTaskId);
        }
      }
    }

    // ── Step 3.5: Notify user that the previous task was interrupted ────
    // Without this, the user sees the task-launched notification for the
    // killed task and then silence — they don't know the task was interrupted
    // before getting a result. We send an explicit interruption notification
    // so the conversation timeline is clear.
    if (killedRunningTask) {
      try {
        const { notifyTaskStatus } = await import("../lib/channels/notification-listener.js");
        const { getOrCreateAgentConversation } = await import("../db/queries/conversations.js");
        const { getAgentWhatsAppGroup } = await import("../db/queries/agent-whatsapp-groups.js");
        const { getChannel } = await import("../lib/channels/index.js");
        const agentConvId = await getOrCreateAgentConversation(agent.id);
        const whatsappAdapter = getChannel("whatsapp");
        const agentWhatsappGroup = await getAgentWhatsAppGroup(agent.id);
        const groupId = agentWhatsappGroup?.group_id;
        await notifyTaskStatus(
          `[Changing working directory...]`,
          agentConvId,
          whatsappAdapter,
          groupId,
          { systemMarker: true }
        );
        log(`[CHANGE-WS] ✅ Sent interruption notification to agent ${agent.id}`);
      } catch (err) {
        log(`[CHANGE-WS] Interruption notification failed (non-fatal): ${err.message}`);
      }
    }

    // ── Step 4: Update DB (workspace_path + history audit trail) ─────────
    const historyEntry = {
      path: workspace_path,
      changed_at: new Date().toISOString(),
      previous_path: oldWorkspace,
      previous_session_id: prevSessionId,
      previous_task_id: currentTaskId || null,
      reason: reason || null,
    };
    await query(
      `UPDATE agents
       SET workspace_path = $1,
           metadata = jsonb_set(
             COALESCE(metadata, '{}'::jsonb),
             '{workspace_history}',
             COALESCE(metadata->'workspace_history', '[]'::jsonb) || $2::jsonb
           )
       WHERE id = $3`,
      [workspace_path, JSON.stringify(historyEntry), agent.id]
    );
    // Clear active task so the next spawn creates a new persistent task.
    // We don't use setActiveTask(id, null) because it also sets status='running'
    // and writes null to Redis (crashes). Direct SQL + Redis delete instead.
    await query(
      `UPDATE agents SET active_task_id = NULL, task_status = 'idle' WHERE id = $1`,
      [agent.id]
    );
    const { redis, KEY } = await import("../db/redis.js");
    await redis.del(KEY(`agent:${agent.id}:active_task`));

    // ── Step 5: Build bootstrap instruction with history injection ──────
    // We inject the previous session history directly into the TASK
    // INSTRUCTION (not the system prompt) so the queue processor can handle
    // this task like any other — which means we get all the normal
    // notifications: task-launched on start and
    // task-completed on completion, plus
    // the reformulated follow-up.
    let bootstrapInstruction = `You have just changed your working directory. Your new persistent CWD is: ${workspace_path}

Reason for the change: ${reason || "(not specified)"}

Briefly explore this directory (pwd, ls, git status if it's a repo) and provide a very short summary of what you find. Then wait for the next instructions.`;

    if (historySummary) {
      bootstrapInstruction = `## PREVIOUS SESSION CONTEXT (in ${oldWorkspace || "the default workspace"})

${historySummary}

---

${bootstrapInstruction}`;
    }

    // ── Step 6: Enqueue bootstrap task — the queue processor will spawn it,
    // send start/end notifications, and handle the reformulated follow-up.
    const queueItem = await enqueueTask(agent.id, bootstrapInstruction, "change_workspace", null, 90);
    log(`[CHANGE-WS] Enqueued bootstrap task ${queueItem.id} for agent ${agent.id}`);
    setImmediate(() => processAgentQueue(agent.id));

    await logEvent("agent_workspace_changed", {
      agentId: agent.id,
      detail: {
        from: oldWorkspace,
        to: workspace_path,
        reason,
        old_task_id: currentTaskId || null,
        queue_id: queueItem.id,
      },
    });

    res.json({
      changed: true,
      agent_id: agent.id,
      agent_name: agent.name,
      old_workspace: oldWorkspace,
      new_workspace: workspace_path,
      old_task_id: currentTaskId || null,
      queue_id: queueItem.id,
      old_session_id: prevSessionId,
      history_transferred_chars: historySummary?.length || 0,
      reason: reason || null,
    });
  } catch (err) {
    log("[CHANGE-WS] Error:", err.message, err.stack);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/agents/:id/message
 * Send a message to an agent's web chat conversation
 * Uses the same channel handler logic as WhatsApp (agent.systemPrompt)
 */
router.post("/api/agents/:id/message", async (req, res) => {
  try {
    const { id } = req.params;
    const { text, mediaAssetIds } = req.body;

    if (!text?.trim() && (!mediaAssetIds || !mediaAssetIds.length)) {
      return res.status(400).json({ error: "Message text or media required" });
    }

    // 1. Get agent
    const agent = await getAgent(id);
    if (!agent) {
      return res.status(404).json({ error: "Agent not found" });
    }

    // 2. Get or create agent's conversation
    const { getOrCreateAgentConversation, getAllTurns } = await import("../db/queries/conversations.js");
    const conversationId = await getOrCreateAgentConversation(agent.id);

    // 3. Create normalized message (same format as WhatsApp)
    // Note: handleChannelMessage will save both user and assistant messages
    // Build attachments from mediaAssetIds (already in store)
    const attachments = [];
    if (Array.isArray(mediaAssetIds) && mediaAssetIds.length > 0) {
      for (const assetId of mediaAssetIds) {
        try {
          const { head } = await import("../lib/media/store.js");
          const meta = await head(assetId);
          if (meta) {
            attachments.push({
              kind: meta.row.kind,
              mime: meta.row.mime,
              platformRef: assetId,
              filename: meta.row.metadata?.originalName || null,
              sizeBytes: meta.row.size_bytes,
              assetId, // already in store, no download needed
            });
          }
        } catch {}
      }
    }

    const normalizedMessage = {
      channelName: "web",
      userId: req.user?.id || "anonymous",
      userName: req.user?.username || "User",
      text: (text || "").trim(),
      isGroup: false,
      targetAgentId: agent.id,
      conversationId: conversationId,
      attachments,
      timestamp: new Date()
    };

    // 4. Get web adapter and route to channel handler (SAME AS WHATSAPP - with tools & function calling)
    const { handleChannelMessage } = await import("../lib/channels/handler.js");
    const { getChannel } = await import("../lib/channels/index.js");
    const webAdapter = getChannel("web");

    if (!webAdapter) {
      throw new Error("Web channel adapter not initialized");
    }

    // Handler will: save user message → call LLM with tools → execute tools → save assistant response
    log(`[AGENT-MESSAGE] Calling handleChannelMessage for agent ${agent.id} (${agent.name})`);
    log(`[AGENT-MESSAGE]    - conversationId: ${conversationId}`);
    log(`[AGENT-MESSAGE]    - userId: ${normalizedMessage.userId}`);
    log(`[AGENT-MESSAGE]    - channelName: ${normalizedMessage.channelName}`);
    log(`[AGENT-MESSAGE]    - text: "${text.substring(0, 80)}..."`);
    const response = await handleChannelMessage(normalizedMessage, webAdapter);
    log(`[AGENT-MESSAGE] Handler returned: ${typeof response} = "${response?.substring(0, 100) || 'null'}..."`);

    // 5. Return response + full conversation
    const turns = await getAllTurns(conversationId);

    res.json({
      response,
      conversationId,
      turns
    });

  } catch (err) {
    log(`[AGENT-MESSAGE] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

export default router;
