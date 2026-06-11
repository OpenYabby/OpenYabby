/**
 * CogniCore Hypothesis Benchmark Scenarios
 * Generates 50 paired scenarios across 10 distinct categories.
 */

const categories = [
  "Code Debugging",
  "Missing Dependencies",
  "API Failures",
  "Security Reviews",
  "File System Mistakes",
  "Build Failures",
  "Documentation Generation",
  "Multi-Agent Coordination",
  "Tool Misuse",
  "Legal Document Review"
];

const templates = {
  "Code Debugging": [
    { failure: "Null pointer exception on line 42", fix: "Add null check before accessing user.profile" },
    { failure: "Infinite loop in array traversal", fix: "Update loop counter to avoid OOM" },
    { failure: "Off-by-one error in substring", fix: "Use length - 1 instead of length" },
    { failure: "Callback fired multiple times", fix: "Add debounce or once modifier" },
    { failure: "Race condition in state update", fix: "Use functional state update" }
  ],
  "Missing Dependencies": [
    { failure: "Cannot find module 'lodash'", fix: "Run npm install lodash" },
    { failure: "Command 'pytest' not found", fix: "pip install pytest" },
    { failure: "ImportError: No module named requests", fix: "pip install requests" },
    { failure: "Module not found: error: Can't resolve 'react'", fix: "npm install react" },
    { failure: "command not found: jq", fix: "brew install jq" }
  ],
  "API Failures": [
    { failure: "429 Too Many Requests", fix: "Implement exponential backoff" },
    { failure: "401 Unauthorized", fix: "Refresh OAuth token before retry" },
    { failure: "500 Internal Server Error", fix: "Check request payload formatting" },
    { failure: "404 Not Found", fix: "Update endpoint URL to v2 API" },
    { failure: "Timeout error", fix: "Increase HTTP timeout to 30s" }
  ],
  "Security Reviews": [
    { failure: "Missed SQL injection vulnerability", fix: "Use parameterized queries" },
    { failure: "Hardcoded API key in repo", fix: "Move secrets to environment variables" },
    { failure: "XSS vulnerability in user input", fix: "Sanitize HTML input before render" },
    { failure: "Insecure direct object reference", fix: "Check user authorization for resource ID" },
    { failure: "Exposed debugging endpoint", fix: "Disable /debug routes in production" }
  ],
  "File System Mistakes": [
    { failure: "Typo in file path hiden_config", fix: "Use ls to verify hidden_config exists" },
    { failure: "Permission denied writing to /root", fix: "Write to /tmp instead" },
    { failure: "File locked by another process", fix: "Wait for lock release or use temporary file" },
    { failure: "Directory does not exist", fix: "Run mkdir -p before writing" },
    { failure: "Disk full error", fix: "Clear /tmp caches before proceeding" }
  ],
  "Build Failures": [
    { failure: "TypeScript compilation error", fix: "Update tsconfig target to ES2022" },
    { failure: "Webpack memory limit exceeded", fix: "Increase Node max_old_space_size" },
    { failure: "Docker image build failed", fix: "Use multi-stage build to reduce size" },
    { failure: "Missing C++ build tools for node-gyp", fix: "Install build-essential package" },
    { failure: "Circular dependency detected", fix: "Refactor imports to a shared module" }
  ],
  "Documentation Generation": [
    { failure: "Forgot to document return types", fix: "Add @returns tag to JSDoc" },
    { failure: "Markdown table malformed", fix: "Align pipe characters properly" },
    { failure: "Missing architecture diagram", fix: "Include Mermaid.js block" },
    { failure: "Outdated API example", fix: "Update curl example to match v2 API" },
    { failure: "Broken relative links", fix: "Verify links point to .md files" }
  ],
  "Multi-Agent Coordination": [
    { failure: "Invalid JSON format output", fix: "Ensure exact JSON string compliance without markdown" },
    { failure: "Agent blocked waiting for input", fix: "Implement timeout or fallback" },
    { failure: "Duplicated work by two agents", fix: "Assign distinct scopes before execution" },
    { failure: "Failed to parse sub-agent response", fix: "Use robust regex to extract fields" },
    { failure: "Parent agent ignoring sub-agent failure", fix: "Bubble up errors explicitly" }
  ],
  "Tool Misuse": [
    { failure: "Used cat for 10,000 line file", fix: "Use head or grep instead" },
    { failure: "Passed object to string-only tool", fix: "JSON.stringify arguments first" },
    { failure: "Tried to click unrendered element", fix: "Wait for selector before clicking" },
    { failure: "Git commit without staging", fix: "Run git add before git commit" },
    { failure: "Failed to specify branch in git checkout", fix: "Include branch name argument" }
  ],
  "Legal Document Review": [
    { failure: "Missed termination for convenience clause", fix: "Explicitly search for 'convenience' keywords" },
    { failure: "Failed to flag non-compete duration", fix: "Highlight durations longer than 12 months" },
    { failure: "Ignored governing law jurisdiction", fix: "Extract 'Governing Law' section" },
    { failure: "Missed indemnification carve-outs", fix: "Analyze 'Exceptions' sub-clauses" },
    { failure: "Overlooked auto-renewal terms", fix: "Search for 'renew' or 'term'" }
  ]
};

export function generateScenarios() {
  const scenarios = [];
  let id = 1;
  for (const cat of categories) {
    const list = templates[cat];
    for (const item of list) {
      scenarios.push({
        id: id++,
        category: cat,
        initial_task: `Perform task related to ${cat}`,
        failure_type: item.failure,
        recovery_strategy: item.fix,
        followup_task: `Perform similar task related to ${cat}`
      });
    }
  }
  return scenarios;
}
