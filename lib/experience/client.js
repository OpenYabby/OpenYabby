/* ═══════════════════════════════════════════════════════
   YABBY — CogniCore Experience Client
   ═══════════════════════════════════════════════════════
   Node.js HTTP client for the CogniCore Python sidecar.

   OpenYabby calls this module — it forwards to CogniCore service:
     store_experience()  → POST /store_experience
     query_experience()  → POST /query_experience
     generate_reflection() → POST /generate_reflection
     record_trajectory_step() → POST /record_trajectory_step
     replay_trajectory() → POST /replay_trajectory

   Architecture:
     OpenYabby (Node.js)  →  this client  →  CogniCore (Python, port 3003)
                                                ↓ import cognicore
                                              Memory / ReflectionEngine / Runtime
*/

import { log } from "../logger.js";
import { getConfig } from "../config.js";

const COGNICORE_PORT = process.env.COGNICORE_PORT || "3003";
const COGNICORE_BASE = `http://localhost:${COGNICORE_PORT}`;

let _available = null; // null = unknown, true/false = cached

/**
 * Check if the CogniCore service is running.
 * Caches result for 30s to avoid spamming health checks.
 */
async function isAvailable() {
  if (_available !== null) return _available;
  try {
    const resp = await fetch(`${COGNICORE_BASE}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    _available = resp.ok;
  } catch {
    _available = false;
  }
  // Re-check after 30s
  setTimeout(() => { _available = null; }, 30_000);
  return _available;
}

/**
 * Internal: POST to CogniCore service.
 */
async function _post(path, body) {
  if (!await isAvailable()) {
    log("[COGNICORE] Service unavailable, skipping");
    return null;
  }

  try {
    const resp = await fetch(`${COGNICORE_BASE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      log(`[COGNICORE] ${path} failed: ${resp.status} ${text.slice(0, 200)}`);
      return null;
    }

    return await resp.json();
  } catch (err) {
    log(`[COGNICORE] ${path} error: ${err.message}`);
    return null;
  }
}

/**
 * Internal: GET from CogniCore service.
 */
async function _get(path) {
  if (!await isAvailable()) return null;

  try {
    const resp = await fetch(`${COGNICORE_BASE}${path}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (err) {
    log(`[COGNICORE] GET ${path} error: ${err.message}`);
    return null;
  }
}

// ─── Public API ──────────────────────────────────────────

/**
 * Store a failure or success experience into CogniCore.
 *
 * Called from spawner.js onClose and agent-task-processor handleTaskTerminal.
 *
 * @param {object} experience
 * @param {string} experience.task_id
 * @param {string} experience.agent_id
 * @param {string} experience.action_taken
 * @param {string} experience.outcome - 'success' | 'failure' | 'partial' | 'timeout'
 * @param {string} [experience.tool_used]
 * @param {string} [experience.failure_type]
 * @param {string} [experience.failure_reason]
 * @param {string} [experience.recovery_strategy]
 * @param {string} [experience.category]
 * @param {string[]} [experience.tags]
 */
export async function storeExperience(experience) {
  const config = getConfig("experience");
  if (config?.enabled === false || process.env.COGNICORE_ENABLED === "false") return null;
  // Ablation check
  if (process.env.COGNICORE_MEMORY_ENABLED === "false") return null;

  return _post("/store_experience", {
    task_id: experience.task_id,
    agent_id: experience.agent_id,
    project_id: experience.project_id || null,
    workflow_id: experience.workflow_id || null,
    action_taken: experience.action_taken,
    tool_used: experience.tool_used || null,
    tool_args: experience.tool_args || null,
    category: experience.category || _categorize(experience),
    outcome: experience.outcome,
    failure_type: experience.failure_type || null,
    failure_reason: experience.failure_reason || null,
    error_code: experience.error_code || null,
    recovery_strategy: experience.recovery_strategy || null,
    recovery_tool: experience.recovery_tool || null,
    channel_name: experience.channel_name || null,
    source_id: experience.source_id || null,
    tags: experience.tags || [],
    metadata: experience.metadata || {},
  });
}

/**
 * Query CogniCore for similar past experiences.
 *
 * Called before task execution to inject relevant context.
 *
 * @param {string} query - Description of what the agent is about to do
 * @param {object} [options]
 * @param {string} [options.agentId]
 * @param {string} [options.projectId]
 * @param {string} [options.category]
 * @param {string} [options.outcomeFilter] - 'failure', 'success', or null
 * @param {boolean} [options.includeFixes=true]
 * @param {number} [options.limit=5]
 * @returns {Promise<object|null>}
 */
export async function queryExperience(query, options = {}) {
  const config = getConfig("experience");
  if (config?.enabled === false || process.env.COGNICORE_ENABLED === "false") return null;
  // Ablation check
  if (process.env.COGNICORE_MEMORY_ENABLED === "false") return null;

  return _post("/query_experience", {
    query,
    agent_id: options.agentId || null,
    project_id: options.projectId || null,
    category: options.category || null,
    outcome_filter: options.outcomeFilter || null,
    include_fixes: options.includeFixes !== false,
    limit: options.limit || 5,
    min_confidence: options.minConfidence || 0.3,
  });
}

/**
 * Generate a CogniCore reflection hint for an agent.
 *
 * Returns hints like: "You failed at npm test 8 times — try pinning deps."
 *
 * @param {string} agentId
 * @param {string} category
 * @param {string} [taskContext]
 * @returns {Promise<object|null>}
 */
export async function generateReflection(agentId, category, taskContext = null) {
  const config = getConfig("experience");
  if (config?.enabled === false || process.env.COGNICORE_ENABLED === "false") return null;
  // Ablation check
  if (process.env.COGNICORE_REFLECTION_ENABLED === "false") return null;

  return _post("/generate_reflection", {
    agent_id: agentId,
    category,
    task_context: taskContext,
  });
}

/**
 * Record a single execution step for trajectory/replay.
 *
 * Called from spawner.js stream parser for every tool call, LLM turn, etc.
 *
 * @param {object} step
 * @param {string} step.trajectoryId
 * @param {string} step.taskId
 * @param {string} step.agentId
 * @param {number} step.stepIndex
 * @param {string} step.stepType - 'tool_call', 'tool_result', 'llm_turn', etc.
 * @param {string} [step.toolName]
 * @param {object} [step.toolArgs]
 * @param {string} [step.toolResult]
 * @param {number} [step.durationMs]
 * @param {boolean} [step.isBranchPoint=false]
 * @param {string} [step.branchLabel]
 */
export async function recordTrajectoryStep(step) {
  const config = getConfig("experience");
  if (config?.enabled === false || process.env.COGNICORE_ENABLED === "false") return null;
  // Ablation check for replay (trajectory is recorded for replay purposes)
  if (process.env.COGNICORE_REPLAY_ENABLED === "false") return null;

  return _post("/record_trajectory_step", {
    trajectory_id: step.trajectoryId,
    task_id: step.taskId,
    agent_id: step.agentId,
    step_index: step.stepIndex,
    step_type: step.stepType,
    tool_name: step.toolName || null,
    tool_args: step.toolArgs || null,
    tool_result: step.toolResult || null,
    duration_ms: step.durationMs || null,
    is_branch_point: step.isBranchPoint || false,
    branch_label: step.branchLabel || null,
    metadata: step.metadata || {},
  });
}

/**
 * Replay a full execution trajectory.
 *
 * @param {string} trajectoryId
 * @param {object} [options]
 * @param {boolean} [options.includeToolResults=true]
 * @param {number} [options.maxSteps=500]
 * @returns {Promise<object|null>}
 */
export async function replayTrajectory(trajectoryId, options = {}) {
  const config = getConfig("experience");
  if (config?.enabled === false || process.env.COGNICORE_ENABLED === "false") return null;
  // Ablation check
  if (process.env.COGNICORE_REPLAY_ENABLED === "false") return null;

  return _post("/replay_trajectory", {
    trajectory_id: trajectoryId,
    include_tool_results: options.includeToolResults !== false,
    max_steps: options.maxSteps || 500,
  });
}

/**
 * Get CogniCore stats for an agent.
 */
export async function getAgentStats(agentId) {
  return _get(`/agent/${agentId}/stats`);
}

/**
 * Get global CogniCore stats.
 */
export async function getGlobalStats() {
  return _get("/stats");
}

/**
 * Check if CogniCore service is healthy.
 */
export async function checkHealth() {
  return _get("/health");
}

// ─── Helpers ─────────────────────────────────────────────

/**
 * Auto-categorize an experience based on tool and context.
 */
function _categorize(exp) {
  if (exp.tool_used) {
    if (exp.tool_used === "Bash") return "bash_command";
    if (exp.tool_used.startsWith("mcp__")) return "mcp_tool";
    if (exp.tool_used === "Write" || exp.tool_used === "Edit") return "file_edit";
    return `tool_${exp.tool_used.toLowerCase()}`;
  }
  if (exp.failure_type === "retry_loop") return "retry_loop";
  if (exp.failure_type === "llm_limit") return "llm_limit";
  return "general";
}
