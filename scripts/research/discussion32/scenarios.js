import fs from "fs";
import path from "path";

export function getScenarios() {
  return [
    {
      id: "repeated_failure_recovery",
      category: "Single Agent Recovery",
      setup: (sandboxDir) => {
        if (!fs.existsSync(sandboxDir)) {
          fs.mkdirSync(sandboxDir, { recursive: true });
        }
        
        // Mock MCP server endpoint logic via a local CLI script
        const mockMcpPath = path.join(sandboxDir, "mock-mcp.js");
        fs.writeFileSync(mockMcpPath, `
const args = process.argv.slice(2);
if (args[0] !== '--payload') {
  console.error("Missing --payload flag");
  process.exit(1);
}
try {
  const payload = JSON.parse(args[1]);
  if (!Array.isArray(payload)) {
    console.error("MCP_ERROR: Payload must be a strict JSON Array, not an object.");
    process.exit(1);
  }
  console.log("MCP_SUCCESS: Data processed.");
} catch(e) {
  console.error("MCP_ERROR: Invalid JSON");
  process.exit(1);
}
        `);

        // Task 1 involves hitting the endpoint
        const task1Instruction = `Write a script 'run1.js' in ${sandboxDir} that executes 'node mock-mcp.js --payload' passing a JSON payload with a single key 'test' and value 'ok'. Run your script and ensure the output says MCP_SUCCESS.`;
        
        // Task 2 is similar
        const task2Instruction = `Write a script 'run2.js' in ${sandboxDir} that executes 'node mock-mcp.js --payload' passing a JSON payload with the string 'second_test'. Run your script and ensure the output says MCP_SUCCESS.`;

        return { task1Instruction, task2Instruction, sandboxDir };
      },
      evaluate: (sandboxDir, runNum, taskRecord) => {
        if (taskRecord.status !== "done") return false;
        const scriptOutput = path.join(sandboxDir, `run${runNum}.js`);
        return fs.existsSync(scriptOutput);
      }
    },
    {
      id: "cross_agent_transfer",
      category: "Multi-Agent Knowledge Transfer",
      setup: (sandboxDir) => {
        if (!fs.existsSync(sandboxDir)) {
          fs.mkdirSync(sandboxDir, { recursive: true });
        }
        
        // Task 1 File
        const data1Path = path.join(sandboxDir, "data1.json");
        fs.writeFileSync(data1Path, `
// This is a comment that breaks standard JSON.parse
{
  "key1": "value1"
}
        `);

        // Task 2 File
        const data2Path = path.join(sandboxDir, "data2.json");
        fs.writeFileSync(data2Path, `
// Another comment that breaks standard JSON.parse
{
  "key2": "value2"
}
        `);

        const task1Instruction = `Read the file ${data1Path}, parse the JSON, and write the value of 'key1' to a file called 'output1.txt' in the same directory. Note: the file may contain comments. Ensure your script handles it.`;
        
        const task2Instruction = `Read the file ${data2Path}, parse the JSON, and write the value of 'key2' to a file called 'output2.txt' in the same directory. Note: the file may contain comments. Ensure your script handles it.`;

        return { task1Instruction, task2Instruction, sandboxDir };
      },
      evaluate: (sandboxDir, runNum, taskRecord) => {
        if (taskRecord.status !== "done") return false;
        const outPath = path.join(sandboxDir, `output${runNum}.txt`);
        if (!fs.existsSync(outPath)) return false;
        const content = fs.readFileSync(outPath, "utf8").trim();
        return runNum === 1 ? content === "value1" : content === "value2";
      }
    }
  ];
}
