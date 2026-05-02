/* ═══════════════════════════════════════════════════════
   YABBY — Central Tool Registry
   ═══════════════════════════════════════════════════════
   Manages voice tools (base + plugin + MCP). Used by
   /session endpoint to build the tools array.
*/

import { log } from "../logger.js";
import { getConfig } from "../config.js";

// Plugin-registered tools (name → definition)
const pluginTools = new Map();

// MCP-bridged tools (name → definition)
const mcpTools = new Map();

// ── Base tools (extracted from server.js) ──

const BASE_TOOLS = [
  // === TASK TOOLS ===
  {
    type: "function", name: "start_task",
    description: "Start a brand NEW independent task on the computer. Returns a task_id. The task runs ASYNCHRONOUSLY — it is NOT done yet when this returns. You MUST call check_tasks later to get the result. ONLY use for tasks unrelated to previous ones. Only call this when you have a CLEAR, DETAILED task description. If the user's request is vague, ask clarifying questions first.",
    parameters: { type: "object", properties: { task: { type: "string", description: "The task to execute." } }, required: ["task"] },
  },
  {
    type: "function", name: "check_tasks",
    description: "Check status and get results of tasks. Waits automatically until done.",
    parameters: { type: "object", properties: { task_ids: { type: "array", items: { type: "string" }, description: "Task IDs to check." } }, required: ["task_ids"] },
  },
  {
    type: "function", name: "continue_task",
    description: "PREFERRED for follow-ups. Continue an existing task with full context. Also resumes PAUSED tasks.",
    parameters: { type: "object", properties: { task_id: { type: "string" }, task: { type: "string" } }, required: ["task_id", "task"] },
  },
  {
    type: "function", name: "pause_task",
    description: "Pause a running task. Keeps session context for later resume.",
    parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
  },
  {
    type: "function", name: "kill_task",
    description: "Kill/cancel a task permanently.",
    parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
  },
  {
    type: "function", name: "sleep_mode",
    description: "Put Yabby into sleep mode.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function", name: "yabby_execute",
    description: "DEFAULT TOOL for ANY concrete action requested by the user. Delegates to the persistent CLI agent which has full Mac access: files & folders, scripts (bash/python/node), application control (AppleScript, GUI, click, keyboard), web browsing & scraping, searches, code (read/write/edit/commit), audio/video/image conversions, emails, calendar, Spotify, terminal, installations, git, etc. Use it whenever the user asks for something concrete to be done on the computer OR when no task is currently running. The agent does NOT see the conversation: your instruction must be self-sufficient. The task is queued; the runtime will inject the actual completion marker into the chat when it finishes. After calling this tool, reply with a short natural acknowledgement (e.g. 'Launched, I'll update you...') — do NOT write bracketed system markers like '[Task X completed]' yourself.",
    parameters: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "The user's request copied WORD FOR WORD (verbatim) in natural language. Do not paraphrase, do not summarize, do not rephrase — copy what the user said. Only add essential context the agent cannot guess: absolute paths, file names mentioned earlier, decisions already made in the conversation. If the request is vague ('go ahead', 'do it'), make it explicit from context. Do NOT dictate which tools to use — the agent chooses. Be CONCISE: 1-3 sentences for a simple task. No bullet lists, no numbered plans, no plan B."
        }
      },
      required: ["instruction"]
    }
  },
  {
    type: "function", name: "yabby_intervention",
    description: "ONLY for interrupting a task CURRENTLY RUNNING. Requires an active task. If no task is running, use yabby_execute instead (it switches automatically). Typical user triggers: 'wait', 'stop', 'no, actually...', 'change to...', 'also add...', 'not in Python but in TypeScript'. The agent's session is preserved (history + files + context), only the direction changes. Copy the correction/addition verbatim.",
    parameters: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "The correction or change requested by the user, copied verbatim. Be clear about what changes compared to the current task."
        },
        agent_id: {
          type: "string",
          description: "ID or NAME of the agent to interrupt (optional). If omitted, targets the agent from the current context or Yabby by default."
        }
      },
      required: ["instruction"]
    }
  },
  {
    type: "function", name: "yabby_status",
    description: "Show Yabby's current state: running tasks (agent, duration, latest logs), paused tasks, queue. Use this tool when the user asks 'status', 'what's running', 'what's the status', 'where are we at'. No parameters required.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function", name: "get_task_detail",
    description: "Get full details of a task: result, activity logs, tools used. Use this when the user asks for details about what an agent did.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string", description: "Task ID" } },
      required: ["task_id"],
    },
  },
  {
    type: "function", name: "search_tasks",
    description: "Search tasks by title or content. Returns matching tasks with their status, results, and metadata. Use this when the user asks to find tasks by keywords or description.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query (searches in task title and result)" },
        status: { type: "string", enum: ["running", "done", "error", "paused", "killed"], description: "Filter by task status (optional)" },
        project_id: { type: "string", description: "Filter by project ID (optional)" },
        agent_id: { type: "string", description: "Filter by agent ID (optional)" },
        limit: { type: "number", description: "Maximum number of results (default: 20, max: 100)", default: 20 }
      },
      required: ["query"]
    }
  },
  {
    type: "function", name: "list_recent_tasks",
    description: "Get tasks created in the last N hours. Returns tasks in chronological order. Use when the user asks 'what are my recent tasks', 'show the last 24h', etc.",
    parameters: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Number of hours to look back (default: 24)", default: 24 },
        status: { type: "string", enum: ["running", "done", "error", "paused", "killed"], description: "Filter by status (optional)" },
        project_id: { type: "string", description: "Filter by project (optional)" },
        limit: { type: "number", description: "Max results (default: 50)", default: 50 }
      }
    }
  },
  {
    type: "function", name: "list_llm_limit_tasks",
    description: "List tasks currently paused due to an LLM limit being reached (usage window exhausted). Useful for informing the user how many tasks are waiting to be resumed before restarting them. Use when the user asks 'how many tasks are paused at the limit', 'what's blocked by the quota limit', etc.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function", name: "resume_llm_limit_tasks",
    description: "Resume all tasks that were paused due to an LLM limit being reached (usage window exhausted). Use this function when the user says 'resume the LLM-limited tasks', 'restart the quota-paused tasks', 'continue the tasks blocked by the limit', 'resume all tasks that were at the LLM limit', or similar. Resumes each task with its original context (session_id + instruction).",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    type: "function", name: "get_task_stats",
    description: "Get task statistics (total, running, completed, failed). Use when the user asks 'how many tasks', 'task summary', 'what's the status'.",
    parameters: {
      type: "object",
      properties: {
        hours: { type: "number", description: "Only count tasks from the last N hours (optional, default: all)" },
        project_id: { type: "string", description: "Filter by project (optional)" },
        agent_id: { type: "string", description: "Filter by agent (optional)" }
      }
    }
  },
  {
    type: "function", name: "get_task_logs",
    description: "Smart task log reader — multiple modes to inspect a task's activity without loading the whole file. Modes: 'summary' (tool counts + exit info, no raw content — cheapest), 'tools' (structured list of tool calls), 'errors' (only stderr/error lines), 'search' (grep-like with context), 'tail' (last N lines, default), 'head' (first N lines). Always start with 'summary' to understand what happened, then drill into 'errors' or 'search' if needed.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "Task ID" },
        mode: { type: "string", enum: ["summary", "tools", "errors", "search", "tail", "head"], description: "Read mode. Default: tail. Use summary first — it costs almost zero tokens." },
        lines: { type: "number", description: "Number of lines for tail/head modes (default 100, max 2000)" },
        q: { type: "string", description: "Search query (required for mode=search). Case-insensitive." },
        context: { type: "number", description: "Lines of context around each search match (default 2, max 10)" }
      },
      required: ["task_id"]
    }
  },

  // === PROJECT & AGENT TOOLS ===
  {
    type: "function", name: "create_project",
    description: "Create a new project with an automatic lead agent (director). For complex, multi-step requests.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Short project name" },
        description: { type: "string", description: "Description and objectives" },
        project_type: { type: "string", description: "Type: dev, marketing, book, event, design, startup..." },
        context: { type: "string", description: "Detailed context, constraints, deliverables" },
        lead_name: {
          type: "string",
          description: "Name of the director/lead agent (e.g. Director, Sophie, Pierre). Required to automatically create the lead agent."
        },
        lead_role: {
          type: "string",
          description: "Role of the director (e.g. Project Manager, Technical Director). Default: Project Manager"
        },
      },
      required: ["name", "description", "lead_name"],
    },
  },
  {
    type: "function", name: "list_projects",
    description: "List active projects.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function", name: "assign_agent",
    description: "Create an agent with a free-form role and instructions. STANDALONE (no project): for general-purpose assistants. Dedicated threads will be created AUTOMATICALLY on every channel that has been paired (WhatsApp always, plus Telegram / Discord / Slack when a container has been paired via /pairforum, /pairserver, or /yabbypair). PROJECT: for agents linked to a specific project. You can pass the project NAME or its ID, or omit to create a standalone agent. BEST PRACTICE: Use a HUMAN FIRST NAME for the name (e.g. Marie, Lucas, Sophie, Karim) rather than a project name or technical term. IMPORTANT: Call list_agents first to see which names are already taken, since agent names must be globally unique.\n\n⚠️ POST-CREATION WORKFLOW:\nWhen a STANDALONE agent is created, the response includes:\n  - `whatsappThread`: { groupId, groupName } if WhatsApp is connected\n  - `channelThreads`: array of { channel, thread_id, name, message } for any other paired channel (telegram / discord / slack)\n  - `message`: a pre-built one-line summary like 'Dedicated thread(s) created automatically: WhatsApp: \"💬 Crypto Analyst\", telegram: yabby_a3f9c1b2.'\n\nYou MUST relay the `message` field verbatim (or paraphrase it lightly in the user's language) so the user knows where to find their new agent. Example: if WhatsApp + Telegram threads were created, tell them about BOTH — do not pretend only WhatsApp exists.\n\nNO THREAD CREATED CASES:\n  - WhatsApp adapter not running → no whatsappThread; mention the agent is reachable via the web chat instead.\n  - No paired containers for Telegram/Discord/Slack → no channelThreads on those; tell the user how to pair if they want one (\"To get a dedicated Telegram topic, create a forum group, add me, and run /pairforum\").\n\nEXACT EXAMPLE:\nUser (from Telegram): \"Create agent Bitcoin crypto analyst\"\nYabby: [calls assign_agent]\n→ Receives: { id: \"abc-123\", name: \"Bitcoin\", whatsappThread: { groupName: \"💬 Crypto Analyst\" }, channelThreads: [{ channel: \"telegram\", name: \"yabby_a3f9c1b2\" }], message: \"Agent Bitcoin created successfully! ✅\\n\\nDedicated thread(s) created automatically: WhatsApp: \\\"💬 Crypto Analyst\\\", telegram: yabby_a3f9c1b2.\" }\nYabby: \"Agent Bitcoin created ✅. WhatsApp group '💬 Crypto Analyst' and a private Telegram topic 'yabby_a3f9c1b2' (in the paired forum group) have been set up — open either one to chat directly with him.\"\n\nIMPORTANT:\n- Threads are created AUTOMATICALLY for every paired channel\n- DO NOT offer to create a thread, they already exist\n- DO NOT call create_agent_thread, it's done automatically\n- For PROJECT agents: no thread (they collaborate together)",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "ID or NAME of the project. OPTIONAL: If omitted, creates a standalone agent (independent, not linked to a project)." },
        name: { type: "string", description: "Unique agent name. RECOMMENDED: a human first name (Marie, Lucas, Sophie, Karim, Jean-Pierre...) with initial capital. Avoid project names (DataBot), technical terms (Manager), or acronyms (API)." },
        role: { type: "string", description: "Free-form role (Email Assistant, Calendar Manager, Developer, Writer...)" },
        role_instructions: { type: "string", description: "Detailed instructions for this role" },
        is_lead: { type: "boolean", description: "True if main person responsible for the project (only for project agents)" },
      },
      required: ["name", "role", "role_instructions"],
    },
  },
  {
    type: "function", name: "talk_to_agent",
    description: "Dispatch a task to an agent. The instruction is queued on the target agent and executed; when done the lead is notified automatically. Three modes:\n  • NEW task (default): a brand new runner session is spawned — the agent starts fresh.\n  • RESUME: pass `resume_task_id` to continue an existing task's runner session with full conversational context preserved (history, reasoning chain, open files). Use this when you want the agent to PICK UP exactly where it left off on a previous task rather than start over.\n  • CASCADE: pass `next_tasks` to create a multi-agent cascade — items sharing the same `position` run in parallel; `position+1` only starts once ALL items at `position` are done.\nFor a live voice chat with an agent, use switch_to_agent. To correct a task ACTIVELY RUNNING, use agent_intervention.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent id OR human name for step 0 (the first agent to start)." },
        title: { type: "string", description: "Short human-readable title, 3–6 words (e.g. 'Homepage hero + navbar', 'Fondation Astro+Tailwind')." },
        instruction: { type: "string", description: "Self-sufficient instruction. Include paths, constraints, acceptance criteria. The agent doesn't see your conversation with the user — give them everything they need." },
        resume_task_id: {
          type: "string",
          description: "Optional. The 8-char task id of a previous task (status done / error / killed) belonging to this same agent. When set, the new instruction is delivered by resuming the ORIGINAL runner session (--resume same session_id), so the agent keeps full conversational context. Use for follow-ups that build directly on a previous task's reasoning (e.g. 'continue where you left off', 'now add the tests for what you just built'). If the task doesn't exist, doesn't belong to this agent, or its session is unavailable, falls back to a fresh task with an explanatory notice."
        },
        next_tasks: {
          type: "array",
          description: "Optional cascade of follow-up steps. Each item has { position, agent_id, title, instruction }. position is a positive integer; same position = parallel fan-out, position+1 waits for position to complete entirely. Example — Léa initializes (step 0), then Hugo+Sofia run in parallel (position 1), then Lucas does the final integration (position 2).",
          items: {
            type: "object",
            properties: {
              position: { type: "integer", minimum: 1, description: "Execution order within the cascade (1 = after step 0). Same value = parallel." },
              agent_id: { type: "string", description: "Agent id OR name for this step." },
              title: { type: "string", description: "Short title (3–6 words)." },
              instruction: { type: "string", description: "Self-sufficient instruction for this step." }
            },
            required: ["position", "agent_id", "instruction"]
          }
        },
        fork_session: {
          type: "boolean",
          description: "Optional. Fork the agent's current runner session instead of resuming it. Creates a new independent session that inherits the agent's full history (identity, habits, project knowledge) but starts fresh for the new topic. Use sparingly — only for domain shifts where the previous conversation context is irrelevant (e.g. switching from frontend QA to backend security audit). Default: false (normal resume, context preserved)."
        },
        on_error: {
          type: "string",
          enum: ["stop", "continue"],
          description: "Cascade behavior when an item fails. 'stop' (default) halts the cascade; 'continue' advances to the next position anyway."
        }
      },
      required: ["agent_id", "title", "instruction"],
    },
  },
  {
    type: "function", name: "agent_intervention",
    description: "Interrupt a sub-agent's ACTIVELY RUNNING task and redirect it with a new instruction. The agent's session is preserved (history, open files, context) — only the current instruction changes. Use when the user (or you) want to correct course mid-flight: 'actually make the hero sticky', 'also add a dark-mode toggle', 'wait, use TypeScript instead'. If the agent has no task running, the instruction is automatically queued instead (graceful fallback). Mirrors yabby_intervention but scoped to a sub-agent you manage.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent id OR human name to intervene on." },
        instruction: { type: "string", description: "The correction/addition. Copy the user's words verbatim when possible. Be explicit about what changes vs what stays." },
      },
      required: ["agent_id", "instruction"],
    },
  },
  {
    type: "function", name: "agent_queue_status",
    description: "View the queue status of a standalone agent: active task, number of pending tasks, status. Useful to know if an agent is busy before sending it an instruction.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "ID or NAME of the agent" }
      },
      required: ["agent_id"]
    }
  },
  {
    type: "function", name: "create_agent_thread",
    description: "Create a dedicated discussion thread with an EXISTING agent on a specific channel (whatsapp / telegram / discord / slack).\n\n⚠️ PREREQUISITES:\n- The agent must exist BEFORE (created via assign_agent)\n- You must have received EXPLICIT confirmation from the user (\"yes\", \"ok\", \"go ahead\")\n- The `channel` parameter is REQUIRED. Do NOT guess. If the user did not say which channel, ASK them, or pick from the response's `currently_available` list when this tool returns 'Missing required parameter: channel'.\n\nCHANNEL MECHANICS:\n- whatsapp: Yabby creates a private WhatsApp group (name '💬 [role]') and binds it to the agent. Always available when the WhatsApp adapter is up.\n- telegram: Yabby creates a private FORUM TOPIC inside a paired forum group container (set up once via /pairforum in a Telegram forum group).\n- discord:  Yabby creates a private text CHANNEL inside a paired Discord server (set up once via /pairserver in the server). Channel is invisible to @everyone.\n- slack:    Yabby creates a private CHANNEL inside a paired Slack workspace (set up once via /yabbypair). Owner is invited automatically.\n\nERROR HANDLING:\n- If the channel is missing/invalid, the tool returns { error, currently_available, supported_channels, example } — relay this to the user so they can pick.\n- If the container is not paired, the tool returns an error explaining the pairing slash command — instruct the user to run it.\n\nEFFECT:\n1. Creates the platform thread/topic/channel\n2. Records a single-owner channel_thread_binding so any non-owner who finds the thread is silently rejected + audit-logged\n3. All messages in the thread are routed ONLY to this agent; the agent responds ONLY there\n\nEXPECTED RETURN (success):\n{\n  \"success\": true,\n  \"channel\": \"telegram\",\n  \"thread_id\": \"<chat_id>:<topic_id>\",\n  \"name\": \"yabby_a3f9c1b2\",\n  \"message\": \"Telegram forum topic created. Open the forum group and look for the new topic.\"\n}",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "ID or NAME of the EXISTING agent to create the thread with" },
        channel: { type: "string", enum: ["whatsapp", "telegram", "discord", "slack"], description: "REQUIRED. The channel to create the thread on. Do NOT guess — ask the user if not specified." },
      },
      required: ["agent_id", "channel"],
    },
  },
  {
    type: "function", name: "switch_to_agent",
    description: "HAND OVER THE VOICE to an agent. The agent takes control of the voice and speaks directly to the user. Use when the user says 'talk to Marco', 'put me through to Lucia', 'I want to speak to the developer'.",
    parameters: {
      type: "object",
      properties: { agent_id: { type: "string", description: "ID or NAME of the agent" } },
      required: ["agent_id"],
    },
  },
  {
    type: "function", name: "back_to_yabby",
    description: "Hand the voice back to Yabby (the main assistant). Called by an agent when its mission is finished or the user wants to return.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function", name: "project_status",
    description: "Status of a project: agents, tasks, progress. You can pass the project NAME or its ID.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "ID or NAME of the project (e.g. 'Italy Trip' or 'a1b2c3d4')" } },
      required: ["project_id"],
    },
  },
  {
    type: "function", name: "list_agents",
    description: "List agents of a project or all agents (if project_id omitted). Shows names already in use — useful BEFORE assign_agent to avoid duplicates. You can pass the project NAME or its ID.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "ID or NAME of the project (optional)" } },
    },
  },

  // === PROJECT/AGENT MANAGEMENT ===
  {
    type: "function", name: "delete_project",
    description: "Delete (archive) a project. You can pass the NAME or ID.",
    parameters: {
      type: "object",
      properties: { project_id: { type: "string", description: "ID or NAME of the project to delete" } },
      required: ["project_id"],
    },
  },
  {
    type: "function", name: "rename_project",
    description: "Rename a project. You can pass the current NAME or ID.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "ID or NAME of the project" },
        new_name: { type: "string", description: "New project name" },
      },
      required: ["project_id", "new_name"],
    },
  },
  {
    type: "function", name: "remove_agent",
    description: "Remove an agent from a project. You can pass the agent NAME or ID.",
    parameters: {
      type: "object",
      properties: { agent_id: { type: "string", description: "ID or NAME of the agent to remove" } },
      required: ["agent_id"],
    },
  },

  // === PLAN REVIEW (Voice Control) ===
  {
    type: "function", name: "approve_plan",
    description: "Approve the plan currently displayed on screen. Use this tool when the user says 'approve the plan', 'ok for the plan', 'validate the plan', etc.",
    parameters: {
      type: "object",
      properties: {
        review_id: {
          type: "string",
          description: "Plan review ID (provided in the global state activePlanReviewId)"
        }
      },
      required: ["review_id"]
    }
  },
  {
    type: "function", name: "revise_plan",
    description: "Request modifications to the plan. Use this tool when the user wants to adjust the plan. IMPORTANT: Always ask 'Is there anything else to modify?' before submitting the revisions, to collect ALL feedback at once.",
    parameters: {
      type: "object",
      properties: {
        review_id: {
          type: "string",
          description: "Plan review ID"
        },
        feedback: {
          type: "string",
          description: "All user feedback, formatted as a clear list of requested changes. Example: '- Use React instead of Vue\n- Add OAuth authentication\n- Reduce the timeline to 2 weeks'"
        }
      },
      required: ["review_id", "feedback"]
    }
  },
  {
    type: "function", name: "cancel_plan",
    description: "Cancel the project. Use this tool ONLY if the user explicitly says they want to cancel the project. Ask for confirmation before calling this tool.",
    parameters: {
      type: "object",
      properties: {
        review_id: {
          type: "string",
          description: "Plan review ID"
        }
      },
      required: ["review_id"]
    }
  },
  {
    type: "function", name: "defer_plan_review",
    description: "Postpone the plan review for later. Use this tool when the user says 'I'll look at the plan later', 'I'll check it later', 'not now', etc. The plan remains available in notifications.",
    parameters: {
      type: "object",
      properties: {
        review_id: {
          type: "string",
          description: "Plan review ID (provided in the global state activePlanReviewId)"
        }
      },
      required: ["review_id"]
    }
  },
  {
    type: "function", name: "open_plan_modal",
    description: "Open the modal for a pending plan. Use this tool when the user asks 'open the plan', 'show the plan', 'display the plan', 'I want to see the plan', etc. If no review_id is provided, retrieves the most recent pending plan.",
    parameters: {
      type: "object",
      properties: {
        review_id: {
          type: "string",
          description: "Plan review ID to open (optional, if omitted uses the most recent pending plan)"
        }
      },
      required: []
    }
  },

  // === SCHEDULING TOOLS ===
  {
    type: "function", name: "create_scheduled_task",
    description: "Create a scheduled task that will run automatically on a schedule (daily, weekly, cron, interval). Use this when the user asks 'schedule a task', 'run every day', 'launch every week', etc. IMPORTANT: For daily times (e.g. '11am'), use a cron expression.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "Short descriptive name for the scheduled task (e.g. 'Daily AI Watch', 'Weekly Backup')"
        },
        task_template: {
          type: "string",
          description: "Template of the task to execute (can contain variables). Clearly describe what the task should do."
        },
        schedule_type: {
          type: "string",
          enum: ["interval", "cron", "manual"],
          description: "Schedule type: 'interval' (every X seconds), 'cron' (cron expression for precise times like '0 11 * * *' for 11am every day), 'manual' (manual trigger only)"
        },
        schedule_config: {
          type: "object",
          description: "Configuration based on schedule_type. For 'interval': {intervalMs: number}. For 'cron': {cronExpression: string, timezone: 'Europe/Paris'}. For 'manual': {}",
          properties: {
            intervalMs: { type: "number", description: "Interval in milliseconds (e.g. 3600000 for 1h). Only for schedule_type='interval'" },
            cronExpression: { type: "string", description: "Cron expression (e.g. '0 11 * * *' = every day at 11am, '0 9 * * 1' = every Monday at 9am). Only for schedule_type='cron'" },
            timezone: { type: "string", description: "Timezone for the cron (e.g. 'Europe/Paris', 'America/New_York'). Default: 'Europe/Paris'" }
          }
        },
        agent_id: {
          type: "string",
          description: "ID or NAME of the agent that will execute the task (optional). If omitted, Yabby will execute it directly."
        },
        project_id: {
          type: "string",
          description: "ID or NAME of the project to link this scheduled task to (optional)"
        },
        description: {
          type: "string",
          description: "Detailed description of what this scheduled task does (optional)"
        }
      },
      required: ["name", "task_template", "schedule_type", "schedule_config"]
    }
  },
  {
    type: "function", name: "list_scheduled_tasks",
    description: "List all scheduled tasks with their status, next execution, and history. Use to see 'what are my scheduled tasks', 'list automated tasks', etc.",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Filter by agent (ID or NAME, optional)" },
        project_id: { type: "string", description: "Filter by project (ID or NAME, optional)" }
      }
    }
  },
  {
    type: "function", name: "delete_scheduled_task",
    description: "Delete a scheduled task. It will no longer execute. Use when the user says 'stop the daily watch', 'delete this schedule', etc.",
    parameters: {
      type: "object",
      properties: {
        scheduled_task_id: { type: "string", description: "ID of the scheduled task to delete" }
      },
      required: ["scheduled_task_id"]
    }
  },
  {
    type: "function", name: "trigger_scheduled_task",
    description: "Manually trigger a scheduled task immediately (without waiting for the next execution). Use when the user says 'run the watch now', 'execute the backup right away', etc.",
    parameters: {
      type: "object",
      properties: {
        scheduled_task_id: { type: "string", description: "ID of the scheduled task to trigger" }
      },
      required: ["scheduled_task_id"]
    }
  },

  // === CONNECTOR TOOLS ===
  {
    type: "function", name: "list_connectors",
    description: "List available and connected connectors (GitHub, Slack, Gmail, etc.) with their tools.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    type: "function", name: "link_connector_to_project",
    description: "Link an existing connector to a project so that agents can use it.",
    parameters: {
      type: "object",
      properties: {
        connector_name_or_id: { type: "string", description: "Name or ID of the connector" },
        project_name_or_id: { type: "string", description: "Name or ID of the project" },
      },
      required: ["connector_name_or_id", "project_name_or_id"],
    },
  },
  {
    type: "function", name: "request_connector",
    description: "Request the addition of a connector. Creates a request that the user can approve. Used by lead agents.",
    parameters: {
      type: "object",
      properties: {
        catalog_id: { type: "string", description: "Connector ID in the catalog (github, slack, gmail, notion, linear, etc.)" },
        project_name_or_id: { type: "string", description: "Name or ID of the project" },
        reason: { type: "string", description: "Reason for the request" },
      },
      required: ["catalog_id", "project_name_or_id", "reason"],
    },
  },

  // === INTER-AGENT & SKILLS ===
  {
    type: "function", name: "send_agent_message",
    description: "Send a message from one agent to another (handoff, review, notification).",
    parameters: {
      type: "object",
      properties: {
        from_agent: { type: "string", description: "ID of the sender agent" },
        to_agent: { type: "string", description: "ID of the recipient agent" },
        project_id: { type: "string", description: "Project ID" },
        content: { type: "string", description: "Message content" },
        msg_type: { type: "string", description: "Type: message, handoff, review, approval, notification" },
      },
      required: ["from_agent", "to_agent", "content"],
    },
  },
  {
    type: "function", name: "add_skill_to_agent",
    description: "Add a skill to an agent (web search, programming, writing, SEO, etc.).",
    parameters: {
      type: "object",
      properties: {
        agent_id: { type: "string", description: "Agent ID" },
        skill_id: { type: "string", description: "Skill ID" },
      },
      required: ["agent_id", "skill_id"],
    },
  },
  {
    type: "function", name: "list_skills",
    description: "List available skills.",
    parameters: { type: "object", properties: {}, required: [] },
  },

  // === PROJECT QUESTIONS ===
  {
    type: "function", name: "list_pending_questions",
    description: "List all pending questions asked by project leads. Use this tool when the user asks to see pending questions.",
    parameters: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project ID (optional, to filter by project)" },
      },
    },
  },
  {
    type: "function", name: "answer_project_question",
    description: "Answer a discovery question asked by the project lead. IMPORTANT: Only use this tool when the user has provided a clear verbal answer to the question. Do NOT use it if the user has not answered yet.",
    parameters: {
      type: "object",
      properties: {
        question_id: { type: "string", description: "Question ID (provided in the project question notification)" },
        answer: { type: "string", description: "The user's exact answer, as they spoke it" },
      },
      required: ["question_id", "answer"],
    },
  },

  // === MEDIA TOOLS ===
  {
    type: "function", name: "web_screenshot",
    description: "Capture a screenshot of a public webpage. Returns a media asset id; the screenshot is automatically attached to your reply on the current channel. Use for product pages, news articles, dashboards — anything visible at a URL.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The URL to screenshot (must start with http:// or https://)." },
        fullPage: { type: "boolean", description: "If true, captures the entire scrollable page; default false (just the viewport)." },
      },
      required: ["url"],
    },
  },
  {
    type: "function", name: "html_screenshot",
    description: "Render arbitrary HTML and return a screenshot as a media asset. You can include CDN scripts (Chart.js, Mermaid, D3, Excalidraw, etc.) for rich visualizations — use the waitMs parameter (e.g. 2000) to let async scripts load before capture. Use for charts, diagrams, tables, styled reports, or any web content.",
    parameters: {
      type: "object",
      properties: {
        html: { type: "string", description: "Complete HTML document or fragment to render." },
        widthPx: { type: "integer", description: "Render viewport width in pixels (default 1200)." },
        waitMs: { type: "integer", description: "Extra ms to wait after setContent for fonts/async (default 0)." },
        fullPage: { type: "boolean", description: "If true, capture the full scroll height." },
      },
      required: ["html"],
    },
  },
  {
    type: "function", name: "search_images",
    description: "Search the web for images matching a query. Returns up to N media asset ids with source URLs; the images are automatically attached to your reply. Use when the user asks to see what something looks like.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        count: { type: "integer", description: "Number of images to return (1-8, default 4)." },
        safe: { type: "boolean", description: "Safe-search filter (default true)." },
      },
      required: ["query"],
    },
  },
  {
    type: "function", name: "send_media",
    description: "Re-send a previously-stored media asset (e.g. an earlier upload or a screenshot you took). The asset is attached to your reply on the current channel.",
    parameters: {
      type: "object",
      properties: {
        asset_id: { type: "string", description: "12-hex media asset id." },
        caption: { type: "string", description: "Optional caption to send with the media." },
      },
      required: ["asset_id"],
    },
  },
  {
    type: "function", name: "store_file",
    description: "Store a local file into the media system and send it as a document on the current channel (WhatsApp/webchat). Use this when you have created a file (CSV, PDF, JSON, ZIP, etc.) and want to deliver it to the user. The file must be under the workspace root or /tmp.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the file (must be under workspace or /tmp). Example: /tmp/report.csv" },
        filename: { type: "string", description: "Display name for the recipient (optional, defaults to basename of path)" },
        caption: { type: "string", description: "Short caption sent alongside the document (optional)" },
      },
      required: ["path"],
    },
  },
  {
    type: "function", name: "get_channel_files",
    description: "List files and images received from users on channels (WhatsApp, Telegram, Discord, etc.). Returns asset IDs, filenames, local paths, and metadata. Use this to find a file the user sent earlier so you can process it (analyze, modify, summarize, etc.).",
    parameters: {
      type: "object",
      properties: {
        conversation_id: { type: "string", description: "Conversation ID to search in (optional — defaults to the agent's own conversation)" },
        filename: { type: "string", description: "Search by filename (optional, partial match)" },
        kind: { type: "string", enum: ["image", "pdf", "file", "audio", "video"], description: "Filter by file type (optional)" },
        limit: { type: "integer", description: "Max results (default 20, max 100)" },
      },
    },
  },
  {
    type: "function", name: "generate_image",
    description: "Generate an image from a text prompt using the local AI image generation model. Returns a media asset id; the image is automatically attached to your reply. Only available on macOS with Apple Silicon.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Text description of the image to generate." },
        model: { type: "string", description: "Model to use (default: stabilityai/sdxl-turbo)." },
        size: { type: "string", description: "Image dimensions as 'WxH' (default: 512x512)." },
        steps: { type: "integer", description: "Number of inference steps (1-50, default 4 for turbo models)." },
        negative_prompt: { type: "string", description: "Things to avoid in the image." },
        seed: { type: "integer", description: "Random seed for reproducible results." },
      },
      required: ["prompt"],
    },
  },

  // === PRESENTATIONS ===
  {
    type: "function", name: "create_presentation",
    description: "Create the project's final presentation. Must be called only ONCE per project — errors out if one already exists (use presentation_status / presentation_detail / presentation_update instead). Requires that you've created a working start.sh at the sandbox root that brings the whole project up end-to-end.",
    parameters: {
      type: "object",
      properties: {
        project_name_or_id: {
          type: "string",
          description: "Name or ID of the project"
        },
        agent_id: {
          type: "string",
          description: "Creator agent id (optional — auto-injected from caller context)"
        },
        title: {
          type: "string",
          description: "Presentation title (e.g. 'FlashLearn — Final Report')"
        },
        summary: {
          type: "string",
          description: "Executive summary in 2-3 sentences: objective, key achievements, current status"
        },
        content: {
          type: "string",
          description: "Full markdown recap (objective, features, team progress, QA results, success criteria)"
        },
        script_path: {
          type: "string",
          description: "Absolute path to the start.sh you created at the sandbox root. The script must be idempotent, start all services (docker-compose up, npm run dev, etc.), wait for them to respond, then exit 0. Used by the 'Lancer la présentation' button."
        },
        test_accesses: {
          type: "array",
          description: "Test users / URLs the user can try (rendered in the webapp modal). Each entry: {label, url, username, password, notes}. Use [] if there's nothing to log into.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Human label, e.g. 'Pro user'" },
              url: { type: "string", description: "Where to use this access" },
              username: { type: "string" },
              password: { type: "string" },
              notes: { type: "string", description: "Optional clarifying note" },
            }
          }
        },
        demo_steps: {
          type: "array",
          items: { type: "string" },
          description: "Ordered demo steps (optional)",
        },
        slides: {
          type: "array",
          items: { type: "object" },
          description: "Structured slides (optional)"
        },
        sandbox_path: {
          type: "string",
          description: "Project sandbox path (optional, auto-detected if omitted)"
        }
      },
      required: ["project_name_or_id", "title", "summary", "content", "script_path"],
    },
  },
  {
    type: "function", name: "presentation_status",
    description: "Check whether a project already has a presentation. Call this FIRST when the project is re-completed so you can decide between create_presentation and presentation_update. Returns { exists, presentationId?, title?, status?, scriptPath?, lastRunStatus?, createdAt? }.",
    parameters: {
      type: "object",
      properties: {
        project_name_or_id: { type: "string", description: "Name or ID of the project" }
      },
      required: ["project_name_or_id"],
    },
  },
  {
    type: "function", name: "presentation_detail",
    description: "Read the full content of an existing presentation (by project or by presentation id). Returns title, summary, content, slides, demoSteps, scriptPath, testAccesses, status, lastRunStatus, agentId, createdAt.",
    parameters: {
      type: "object",
      properties: {
        project_name_or_id: { type: "string", description: "Name or ID of the project (used if presentation_id is omitted)" },
        presentation_id: { type: "string", description: "Optional — if known. Otherwise the active presentation for the project is returned." }
      },
    },
  },
  {
    type: "function", name: "presentation_update",
    description: "Update an existing presentation. Pass only the fields you want to change (partial patch). Use this instead of create_presentation when one already exists. Also used to report run results: pass last_run_status='passed'|'failed' + last_run_log.",
    parameters: {
      type: "object",
      properties: {
        presentation_id: { type: "string", description: "Optional — defaults to the active presentation for the project" },
        project_name_or_id: { type: "string", description: "Required if presentation_id is not provided" },
        title: { type: "string" },
        summary: { type: "string" },
        content: { type: "string" },
        script_path: { type: "string" },
        test_accesses: {
          type: "array",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              url: { type: "string" },
              username: { type: "string" },
              password: { type: "string" },
              notes: { type: "string" },
            }
          }
        },
        slides: { type: "array", items: { type: "object" } },
        demo_steps: { type: "array", items: { type: "string" } },
        last_run_status: { type: "string", enum: ["passed", "failed", "not_run", "requested"] },
        last_run_log: { type: "string", description: "Short stdout/stderr summary (last ~30 lines) from running start.sh" }
      }
    },
  },
];

// ── Public API ──

export function registerTool(def) {
  if (!def.name || !def.type) {
    log("[TOOL-REGISTRY] Invalid tool definition — missing name or type");
    return false;
  }
  pluginTools.set(def.name, def);
  log(`[TOOL-REGISTRY] Registered plugin tool: ${def.name}`);
  return true;
}

export function removeTool(name) {
  const deleted = pluginTools.delete(name);
  if (deleted) log(`[TOOL-REGISTRY] Removed plugin tool: ${name}`);
  return deleted;
}

export function registerMcpTool(def) {
  if (!def.name || !def.type) return false;
  mcpTools.set(def.name, def);
  log(`[TOOL-REGISTRY] Registered MCP tool: ${def.name}`);
  return true;
}

export function removeMcpTool(name) {
  return mcpTools.delete(name);
}

export function clearMcpTools() {
  const count = mcpTools.size;
  mcpTools.clear();
  return count;
}

export function getAllTools() {
  const imagegenCfg = getConfig("imagegen") || {};
  const imagegenEnabled = imagegenCfg.enabled ?? (process.platform === "darwin");
  return [
    ...BASE_TOOLS.filter(t => {
      if (t.name === "generate_image" && !imagegenEnabled) return false;
      return true;
    }),
    ...pluginTools.values(),
    ...[...mcpTools.values()].map(({ _mcp, ...rest }) => rest),
  ];
}

/**
 * Get tools scoped to a project.
 * Returns base tools + plugin tools + only connector/MCP tools
 * that belong to connectors linked to the project (or global).
 * @param {string[]} allowedToolNames — tool names the project can access
 */
export function getToolsForProject(allowedToolNames) {
  if (!allowedToolNames) return getAllTools();

  const allowed = new Set(allowedToolNames);
  return [
    ...BASE_TOOLS,
    ...[...pluginTools.values()].filter(t => !t._connector || allowed.has(t.name)),
    ...[...mcpTools.values()]
      .filter(t => allowed.has(t.name))
      .map(({ _mcp, ...rest }) => rest),
  ];
}

/**
 * ═══════════════════════════════════════════════════════════════
 * TOOL EXPOSURE POLICY — MINIMAL user-facing surface
 * ═══════════════════════════════════════════════════════════════
 *
 * Voice, webchat, and channels (WhatsApp/Slack/Discord/Telegram) can
 * ONLY call three tools:
 *   - yabby_execute        → delegate any concrete action to the CLI
 *   - yabby_intervention   → interrupt/redirect a running CLI task
 *   - sleep_mode           → voice-only session termination
 *
 * EVERYTHING else (projects, agents, connectors, scheduling, plans,
 * discovery questions, presentations, task introspection, skills,
 * inter-agent messaging, voice routing) is handled by the persistent
 * Yabby CLI agent (`yabby-000000`) through yabby_execute. The CLI
 * agent has full BASE_TOOLS access and HTTP APIs for those flows.
 *
 * UI-triggered flows (plan review modal, discovery question modal,
 * agent detail page) remain functional — they call backend APIs
 * directly, not LLM tools.
 */

// Voice: only 3 tools.
const VOICE_ALLOWED_TOOLS = new Set([
  'yabby_execute',
  'yabby_intervention',
  'yabby_status',
  'sleep_mode',
]);

// Channels (text surfaces): delegation only. sleep_mode is voice-only.
const CHANNEL_ALLOWED_TOOLS = new Set([
  'yabby_execute',
  'yabby_intervention',
  'yabby_status',
  'store_file',
]);

/**
 * Tools for voice sessions (OpenAI Realtime API).
 * Strict 3-tool whitelist. All concrete work is delegated to the
 * persistent CLI agent via yabby_execute.
 */
export function getToolsForUser() {
  // Strict: only the 3 allowed base tools. No plugin / MCP tools — the CLI
  // agent (Yabby/lead/etc.) has its own MCP access via .mcp.json when spawned,
  // so the voice surface doesn't need to expose them. Keeping voice narrow
  // forces delegation through yabby_execute.
  return BASE_TOOLS.filter(t => VOICE_ALLOWED_TOOLS.has(t.name));
}

/**
 * Tools for channel handlers (Discord, Slack, Telegram, WhatsApp, webchat).
 * Strict 2-tool whitelist (no sleep_mode in text channels), same reasoning
 * as voice — the CLI agent handles any concrete MCP work.
 */
export function getToolsForChannel() {
  return BASE_TOOLS.filter(t => CHANNEL_ALLOWED_TOOLS.has(t.name));
}

export function getBaseTools() {
  const imagegenCfg = getConfig("imagegen") || {};
  const imagegenEnabled = imagegenCfg.enabled ?? (process.platform === "darwin");
  return BASE_TOOLS.filter(t => {
    if (t.name === "generate_image" && !imagegenEnabled) return false;
    return true;
  });
}

export function getPluginTools() {
  return [...pluginTools.values()];
}

export function getMcpTools() {
  return [...mcpTools.values()];
}

export function getToolCount() {
  return {
    base: BASE_TOOLS.length,
    plugin: pluginTools.size,
    mcp: mcpTools.size,
    total: BASE_TOOLS.length + pluginTools.size + mcpTools.size,
  };
}
