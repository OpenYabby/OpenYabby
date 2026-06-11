import fs from "fs";
import path from "path";

function calculateMetrics(records) {
  const total = records.length;
  if (total === 0) return null;

  const repeatedFailures = records.filter(r => !r.run2.success).length;
  const recovered = records.filter(r => r.run2.success).length;
  const totalTokens = records.reduce((sum, r) => sum + r.run1.tokens + r.run2.tokens, 0);
  const totalDuration = records.reduce((sum, r) => sum + r.run1.durationMs + r.run2.durationMs, 0);

  return {
    repeatedFailureRate: (repeatedFailures / total) * 100,
    recoverySuccessRate: (recovered / total) * 100,
    totalTokens: totalTokens,
    avgTokens: totalTokens / total,
    avgDurationSecs: (totalDuration / total) / 1000
  };
}

function analyze() {
  console.log("Analyzing Real Benchmark Results...");
  const rawPath = path.join(process.cwd(), "benchmarks", "results", "real_raw_runs.jsonl");
  if (!fs.existsSync(rawPath)) {
    console.error("No raw runs found. Run real-benchmark-runner.js first.");
    return;
  }

  const lines = fs.readFileSync(rawPath, "utf8").split("\n").filter(l => l.trim() !== "");
  const data = lines.map(l => JSON.parse(l));
  
  const ablations = ["A", "B", "C", "D", "E"];
  const ablationNames = {
    "A": "Baseline",
    "B": "Memory Only",
    "C": "Reflection Only",
    "D": "Memory + Reflection",
    "E": "Memory + Reflection + Replay"
  };

  let mdReport = "# CogniCore Real Execution Benchmark Report\n\n";
  mdReport += "**Objective**: Test whether failure-aware memory reduces repeated mistakes using REAL LLM executions.\n\n";

  let csvReport = "Ablation,Repeated Failure Rate (%),Recovery Success Rate (%),Avg Tokens,Avg Duration (s)\n";

  mdReport += "## Summary Metrics\n\n";
  mdReport += "| Ablation | Repeated Failure Rate | Recovery Success Rate | Avg Tokens | Avg Duration (s) |\n";
  mdReport += "| :--- | :--- | :--- | :--- | :--- |\n";

  const resultsByAblation = {};

  for (const id of ablations) {
    const records = data.filter(r => r.ablationId === id);
    const metrics = calculateMetrics(records);
    if (!metrics) continue;

    resultsByAblation[id] = metrics;
    
    mdReport += `| **${id}. ${ablationNames[id]}** | ${metrics.repeatedFailureRate.toFixed(1)}% | ${metrics.recoverySuccessRate.toFixed(1)}% | ${Math.round(metrics.avgTokens)} | ${metrics.avgDurationSecs.toFixed(1)}s |\n`;
    csvReport += `"${id}. ${ablationNames[id]}",${metrics.repeatedFailureRate.toFixed(1)},${metrics.recoverySuccessRate.toFixed(1)},${Math.round(metrics.avgTokens)},${metrics.avgDurationSecs.toFixed(1)}\n`;
  }

  const resultsDir = path.dirname(rawPath);
  fs.writeFileSync(path.join(resultsDir, "REAL_FINAL_REPORT.md"), mdReport);
  fs.writeFileSync(path.join(resultsDir, "metrics.csv"), csvReport);
  
  console.log(`Report generated: ${path.join(resultsDir, "REAL_FINAL_REPORT.md")}`);
  console.log(`CSV generated: ${path.join(resultsDir, "metrics.csv")}`);
}

analyze();
