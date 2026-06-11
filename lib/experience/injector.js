
/* ═══════════════════════════════════════════════════════
   YABBY — CogniCore Context Injector
   ═══════════════════════════════════════════════════════
   Queries CogniCore for relevant past experiences and
   injects them into an agent's system prompt before
   task execution.

   Flow:
     1. Agent gets a new task
     2. Injector queries CogniCore for similar failures
     3. CogniCore returns experiences + reflection hints
     4. Injector appends context block to system prompt
     5. Agent sees: "Last time you tried X, it failed because Y"
*/

import { log } from "../logger.js";
import { queryExperience, generateReflection, replayTrajectory } from "./client.js";

/**
 * Inject CogniCore experience context into an agent's system prompt.
 *
 * Called from spawner.js before spawning a Claude CLI task.
 *
 * @param {string} systemPrompt - The agent's current system prompt
 * @param {string} taskInstruction - What the agent is about to do
 * @param {string} agentId - Agent ID
 * @param {string} [projectId] - Project ID (for scoped search)
 * @returns {Promise<string>} - The augmented system prompt
 */
export async function injectExperienceContext(systemPrompt, taskInstruction, agentId, projectId = null) {
  try {
    // Extract a category hint from the task instruction
    const category = _inferCategory(taskInstruction);

    // Query CogniCore for similar past experiences
    const [experienceResult, reflectionResult] = await Promise.all([
      queryExperience(taskInstruction, {
        agentId,
        projectId,
        includeFixes: true,
        limit: 3,
      }),
      generateReflection(agentId, category, taskInstruction),
    ]);

    if (!experienceResult && !reflectionResult) return systemPrompt;

    const experiences = experienceResult?.results || [];
    const fixes = experienceResult?.fixes || [];
    const hints = reflectionResult?.hints || [];
    const override = reflectionResult?.override || null;

    // Nothing to inject
    if (experiences.length === 0 && hints.length === 0) return systemPrompt;

    // Build experience context block
    let block = "\n\n## ⚡ EXPERIENCE CONTEXT (from CogniCore)\n\n";
    block += "Relevant experiences from past workflows — use them to avoid repeating mistakes:\n\n";

    for (const exp of experiences) {
      const icon = exp.correct ? "✅" : "❌";
      block += `### ${icon} ${exp.action || "Unknown action"}\n`;
      if (exp.tool) block += `- **Tool**: ${exp.tool}\n`;
      block += `- **Outcome**: ${exp.outcome || (exp.correct ? "success" : "failure")}\n`;
      if (exp.failure_reason) block += `- **Failure**: ${exp.failure_reason}\n`;
      if (exp.recovery_strategy) block += `- **Fix**: ${exp.recovery_strategy}\n`;
      block += "\n";
    }

    // Inject fixes
    if (fixes.length > 0) {
      block += "### 🔧 Known Fixes\n\n";
      for (const f of fixes) {
        const fix = f.fix;
        if (fix?.recovery_strategy) {
          block += `- ${fix.recovery_strategy}`;
          if (fix.tool) block += ` (via \`${fix.tool}\`)`;
          block += "\n";
        }
      }
      block += "\n";
    }

    // Inject CogniCore reflection hints
    if (hints.length > 0) {
      block += "### 💡 CogniCore Reflection\n\n";
      for (const h of hints) {
        if (h.hint) {
          block += `- ${h.hint}`;
          if (h.n_similar) block += ` (based on ${h.n_similar} similar cases)`;
          block += "\n";
        }
      }
      block += "\n";
    }

    // Inject override suggestion
    if (override?.suggested_action) {
      block += `> **⚠️ CogniCore suggests**: ${override.suggested_action}`;
      if (override.confidence) {
        block += ` (confidence: ${(override.confidence * 100).toFixed(0)}%)`;
      }
      block += "\n\n";
    }

    // Inject replay if enabled
    if (process.env.COGNICORE_REPLAY_ENABLED !== "false" && experiences.length > 0) {
      // Find the most relevant failed experience with a trajectory
      const targetExp = experiences.find(e => !e.correct && e.metadata?.trajectory_id);
      if (targetExp) {
        const replayData = await replayTrajectory(targetExp.metadata.trajectory_id);
        if (replayData && replayData.steps) {
          block += "### ⏪ Replay of Previous Failure\n\n";
          block += "Here is the exact sequence of steps from the failed run:\n```\n";
          for (const step of replayData.steps) {
            block += `[${step.step_type}] ${step.tool_name ? step.tool_name : ''} => ${step.tool_result ? 'Result: ' + step.tool_result : ''}\n`;
          }
          block += "```\n\n";
        }
      }
    }

    log(`[COGNICORE] Injected ${experiences.length} experiences + ${hints.length} hints for agent ${agentId}`);
    return systemPrompt + block;
  } catch (err) {
    log(`[COGNICORE] Context injection failed (non-fatal): ${err.message}`);
    return systemPrompt; // Never block task execution
  }
}

/**
 * Infer a category from the task instruction for CogniCore lookup.
 */
function _inferCategory(instruction) {
  if (!instruction) return "general";
  const lower = instruction.toLowerCase();

  if (lower.includes("npm") || lower.includes("package")) return "npm_dependency";
  if (lower.includes("test")) return "testing";
  if (lower.includes("build") || lower.includes("compile")) return "build";
  if (lower.includes("deploy")) return "deployment";
  if (lower.includes("database") || lower.includes("migration")) return "database";
  if (lower.includes("api") || lower.includes("endpoint")) return "api";
  if (lower.includes("bug") || lower.includes("fix")) return "bugfix";
  if (lower.includes("review")) return "code_review";
  if (lower.includes("design") || lower.includes("css")) return "design";
  return "general";
}
