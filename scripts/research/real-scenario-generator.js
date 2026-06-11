import fs from "fs";
import path from "path";

export function getScenarios() {
  return [
    {
      id: "missing_dependency_01",
      category: "Missing Dependencies",
      setup: (sandboxDir) => {
        // Create a script that relies on lodash
        if (!fs.existsSync(sandboxDir)) {
          fs.mkdirSync(sandboxDir, { recursive: true });
        }
        
        // Ensure clean node_modules and package.json
        const packageJsonPath = path.join(sandboxDir, "package.json");
        fs.writeFileSync(packageJsonPath, JSON.stringify({ name: "test-env", version: "1.0.0" }, null, 2));

        const nmPath = path.join(sandboxDir, "node_modules");
        if (fs.existsSync(nmPath)) {
          fs.rmSync(nmPath, { recursive: true, force: true });
        }

        const scriptPath = path.join(sandboxDir, "index.js");
        fs.writeFileSync(scriptPath, `
const _ = require('lodash');
const result = _.camelCase('hello world');
if (result === 'helloWorld') {
  console.log('SUCCESS');
} else {
  console.error('FAILURE');
  process.exit(1);
}
        `);
        return scriptPath;
      },
      instruction: (scriptPath) => `Run the script at ${scriptPath} using Node.js. If it succeeds, exit cleanly. Ensure the output 'SUCCESS' is achieved.`,
      evaluate: (sandboxDir, taskRecord) => {
        // Verify task is done
        if (taskRecord.status !== "done") return false;
        
        // Verify lodash is actually installed
        const isInstalled = fs.existsSync(path.join(sandboxDir, "node_modules", "lodash"));
        return isInstalled;
      }
    }
  ];
}
