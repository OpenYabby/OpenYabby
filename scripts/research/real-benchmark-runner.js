import "dotenv/config";
import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { createAgent, deleteAgent } from "../../db/queries/agents.js";
import { getTask } from "../../db/queries/tasks.js";
import { spawnClaudeTask } from "../../lib/spawner.js";
import { onTaskCompleted } from "../../lib/task-completion-bus.js";
import { storeExperience } from "../../lib/experience/client.js";

import { getScenarios } from "./real-scenario-generator.js";

const ABLATIONS = [
  { id: "A", name: "Baseline", memory: false, reflection: false, replay: false },
  { id: "B", name: "Memory Only", memory: true, reflection: false, replay: false },
  { id: "C", name: "Reflection Only", memory: false, reflection: true, replay: false },
  { id: "D", name: "Memory + Reflection", memory: true, reflection: true, replay: false },
  { id: "E", name: "Memory + Reflection + Replay", memory: true, reflection: true, replay: true }
];

async function waitForTask(taskId) {
  return new Promise((resolve) => {
    onTaskCompleted(taskId, async (event) => {
      // Small delay to ensure DB write finishes
      setTimeout(async () => {
        const taskRecord = await getTask(taskId);
        resolve({ status: event.status, record: taskRecord });
      }, 500);
    });
  });
}

async function runBenchmark() {
  console.log("=========================================");
  console.log("   COGNICORE REAL BENCHMARK DRY RUN      ");
  console.log("=========================================\n");

  const scenarios = getScenarios();
  const results = [];
  const rawLogPath = path.join(process.cwd(), "benchmarks", "results", "real_raw_runs.jsonl");

  if (!fs.existsSync(path.dirname(rawLogPath))) {
    fs.mkdirSync(path.dirname(rawLogPath), { recursive: true });
  }

  // Clear log file if we want a fresh run
  fs.writeFileSync(rawLogPath, "");

  for (const ablation of ABLATIONS) {
    console.log(`\n--- ABLATION ${ablation.id}: ${ablation.name} ---`);

    // Set environment flags for experience client & injector
    process.env.COGNICORE_ENABLED = (ablation.memory || ablation.reflection || ablation.replay) ? "true" : "false";
    process.env.COGNICORE_MEMORY_ENABLED = ablation.memory ? "true" : "false";
    process.env.COGNICORE_REFLECTION_ENABLED = ablation.reflection ? "true" : "false";
    process.env.COGNICORE_REPLAY_ENABLED = ablation.replay ? "true" : "false";

    for (const scenario of scenarios) {
      console.log(`  Scenario: ${scenario.id} (${scenario.category})`);

      // We need a fresh agent for each ablation so they don't share experience between ablations
      const agentId = randomUUID().slice(0, 12);
      await createAgent(agentId, null, `Bench_${ablation.id}`, "Tester", "You are a software engineer executing tasks.", { isLead: false });

      // Run 1: The Initial Attempt
      const sandboxDir = path.join(process.cwd(), "benchmarks", "sandbox", `${scenario.id}_${ablation.id}`);
      const scriptPath = scenario.setup(sandboxDir);
      const instruction = scenario.instruction(scriptPath);

      console.log(`    [Run 1] Spawning task...`);
      const taskId1 = randomUUID().slice(0, 8);
      const sessionId1 = randomUUID();
      
      const startTime1 = Date.now();
      await spawnClaudeTask(taskId1, sessionId1, instruction, false, { agentId });
      const { status: status1, record: record1 } = await waitForTask(taskId1);
      const duration1 = Date.now() - startTime1;
      
      const success1 = scenario.evaluate(sandboxDir, record1);
      console.log(`    [Run 1] Status: ${status1}, Success: ${success1}, Tokens: ${record1?.metrics?.total_tokens || 0}`);

      // Store experience manually since we are bypassing the agent-task-processor completion loop
      if (process.env.COGNICORE_ENABLED === "true") {
        await storeExperience({
          task_id: taskId1,
          agent_id: agentId,
          action_taken: instruction,
          outcome: success1 ? "success" : "failure",
          failure_reason: success1 ? null : (record1?.error || "Failed to pass evaluation")
        });
      }

      // We always run Attempt 2 to measure recovery, even if Attempt 1 accidentally succeeded
      // But we must reset the environment so Attempt 2 faces the same challenge
      scenario.setup(sandboxDir);

      console.log(`    [Run 2] Spawning task...`);
      const taskId2 = randomUUID().slice(0, 8);
      const sessionId2 = randomUUID();

      const startTime2 = Date.now();
      await spawnClaudeTask(taskId2, sessionId2, instruction, false, { agentId });
      const { status: status2, record: record2 } = await waitForTask(taskId2);
      const duration2 = Date.now() - startTime2;

      const success2 = scenario.evaluate(sandboxDir, record2);
      console.log(`    [Run 2] Status: ${status2}, Success: ${success2}, Tokens: ${record2?.metrics?.total_tokens || 0}`);

      // Record result
      const resultObj = {
        ablationId: ablation.id,
        ablationName: ablation.name,
        scenarioId: scenario.id,
        category: scenario.category,
        run1: {
          success: success1,
          tokens: record1?.metrics?.total_tokens || 0,
          durationMs: duration1,
          status: status1
        },
        run2: {
          success: success2,
          tokens: record2?.metrics?.total_tokens || 0,
          durationMs: duration2,
          status: status2
        }
      };

      results.push(resultObj);
      fs.appendFileSync(rawLogPath, JSON.stringify(resultObj) + "\\n");

      // Cleanup agent
      await deleteAgent(agentId);
    }
  }

  console.log(`\nDry run complete. Results saved to ${rawLogPath}`);
  process.exit(0);
}

runBenchmark().catch(console.error);
