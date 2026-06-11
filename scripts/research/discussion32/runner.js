import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

import { createAgent, deleteAgent } from "../../../db/queries/agents.js";
import { getTask } from "../../../db/queries/tasks.js";
import { setConfigValue } from "../../../db/queries/config.js";
import { spawnClaudeTask } from "../../../lib/spawner.js";
import { onTaskCompleted } from "../../../lib/task-completion-bus.js";
import { storeExperience } from "../../../lib/experience/client.js";

import { getScenarios } from "./scenarios.js";

const ABLATIONS = [
  { id: "A", name: "Baseline (No CogniCore)", useCognicore: false },
  { id: "B", name: "CogniCore Memory Enabled", useCognicore: true }
];

async function setCognicoreState(enabled) {
  // Update the global configuration in PostgreSQL
  await setConfigValue("experience.enabled", enabled);
}

async function waitForTask(taskId) {
  return new Promise((resolve) => {
    onTaskCompleted(taskId, async (event) => {
      setTimeout(async () => {
        const taskRecord = await getTask(taskId);
        resolve({ status: event.status, record: taskRecord });
      }, 500);
    });
  });
}

async function runBenchmark() {
  console.log("==================================================");
  console.log("   COGNICORE DISCUSSION #32 REAL BENCHMARK        ");
  console.log("==================================================\n");

  const scenarios = getScenarios();
  const results = [];
  const rawLogPath = path.join(process.cwd(), "benchmarks", "results", "discussion32_raw_runs.jsonl");

  if (!fs.existsSync(path.dirname(rawLogPath))) {
    fs.mkdirSync(path.dirname(rawLogPath), { recursive: true });
  }

  // Clear log file
  fs.writeFileSync(rawLogPath, "");

  for (const ablation of ABLATIONS) {
    console.log(`\n--- ABLATION ${ablation.id}: ${ablation.name} ---`);

    // Toggle memory natively via Postgres config, NO ENV VARIABLES
    await setCognicoreState(ablation.useCognicore);

    for (const scenario of scenarios) {
      console.log(`  Scenario: ${scenario.id} (${scenario.category})`);

      // We need two distinct agent profiles for Cross-Agent Transfer scenario
      const agentAId = randomUUID().slice(0, 12);
      const agentBId = randomUUID().slice(0, 12);
      await createAgent(agentAId, null, `AgentA_${ablation.id}`, "Worker", "You are Agent A.", { isLead: false });
      await createAgent(agentBId, null, `AgentB_${ablation.id}`, "Worker", "You are Agent B.", { isLead: false });

      const sandboxDir = path.join(process.cwd(), "benchmarks", "sandbox", `d32_${scenario.id}_${ablation.id}`);
      const { task1Instruction, task2Instruction } = scenario.setup(sandboxDir);

      // ----------------------------------------------------
      // RUN 1: The Initial Task (Executed by Agent A)
      // ----------------------------------------------------
      console.log(`    [Task 1] Spawning task for Agent A...`);
      const taskId1 = randomUUID().slice(0, 8);
      
      const startTime1 = Date.now();
      await spawnClaudeTask(taskId1, randomUUID(), task1Instruction, false, { agentId: agentAId });
      const { status: status1, record: record1 } = await waitForTask(taskId1);
      const duration1 = Date.now() - startTime1;
      
      const success1 = scenario.evaluate(sandboxDir, 1, record1);
      console.log(`    [Task 1] Success: ${success1}, Tokens: ${record1?.metrics?.total_tokens || 0}`);

      // Manually store experience if CogniCore is active
      if (ablation.useCognicore) {
        await storeExperience({
          task_id: taskId1,
          agent_id: agentAId,
          action_taken: task1Instruction,
          outcome: success1 ? "success" : "failure",
          failure_reason: success1 ? null : (record1?.error || "Failed to pass evaluation")
        });
      }

      // ----------------------------------------------------
      // RUN 2: The Follow-Up Task (Executed by Agent B)
      // ----------------------------------------------------
      console.log(`    [Task 2] Spawning follow-up task for Agent B...`);
      const taskId2 = randomUUID().slice(0, 8);

      const startTime2 = Date.now();
      // Notice this uses agentBId. If CogniCore cross-agent memory works, Agent B will retrieve Agent A's failure.
      await spawnClaudeTask(taskId2, randomUUID(), task2Instruction, false, { agentId: agentBId });
      const { status: status2, record: record2 } = await waitForTask(taskId2);
      const duration2 = Date.now() - startTime2;

      const success2 = scenario.evaluate(sandboxDir, 2, record2);
      console.log(`    [Task 2] Success: ${success2}, Tokens: ${record2?.metrics?.total_tokens || 0}`);

      // Record result
      const resultObj = {
        ablationId: ablation.id,
        ablationName: ablation.name,
        scenarioId: scenario.id,
        category: scenario.category,
        task1: {
          success: success1,
          tokens: record1?.metrics?.total_tokens || 0,
          durationMs: duration1,
          status: status1
        },
        task2: {
          success: success2,
          tokens: record2?.metrics?.total_tokens || 0,
          durationMs: duration2,
          status: status2
        }
      };

      results.push(resultObj);
      fs.appendFileSync(rawLogPath, JSON.stringify(resultObj) + "\n");

      // Cleanup agents
      await deleteAgent(agentAId);
      await deleteAgent(agentBId);
    }
  }

  console.log(`\nDiscussion #32 benchmark complete. Results saved to ${rawLogPath}`);
  process.exit(0);
}

runBenchmark().catch(console.error);
