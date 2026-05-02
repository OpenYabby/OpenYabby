# CLI Runners

OpenYabby is **runner-agnostic**. The default is Anthropic's Claude CLI, but you can swap in any of six supported runners — all of them are real CLI tools you install separately and Yabby drives them as child processes.

Runners are defined in [lib/runner-profiles.js](../lib/runner-profiles.js).

---

## Quick comparison

| Runner | License (CLI) | Local model? | Streaming JSON | Resume | Tool-calling shape | Best for |
|---|---|---|---|---|---|---|
| **Claude Code** *(default)* | Anthropic ToS | No (Claude API) | Yes (`stream-json`) | Yes (session id) | First-party Anthropic tool format | Best out-of-the-box quality, deepest tool integration |
| **Codex** (OpenAI) | OpenAI ToS | No (OpenAI API) | Yes | Yes (thread id) | OpenAI function-calling | Strong if you're already in the OpenAI ecosystem |
| **Aider** | Apache-2.0 | Yes (any LLM) | Partial | Limited | Aider-specific edit format | Local models, repo-edit-heavy work |
| **Goose** | Apache-2.0 | Yes (any LLM) | Yes | Yes | MCP-native | MCP-first workflows, Block's stack |
| **Cline** | Apache-2.0 | Yes (any LLM) | Yes | Yes | OpenAI/Anthropic compatible | Long autonomous runs, plan-mode oriented |
| **Continue** | Apache-2.0 | Yes (any LLM) | Yes | Yes | Per-provider | Flexible provider matrix |

Pick the one whose **license, model access, and budget** match your needs. Yabby's prompts and orchestration logic don't change.

---

## Switching runners

In your config:

```json
{
  "tasks": {
    "runnerId": "codex"
  }
}
```

Or via the SPA: Settings → Tasks → Runner.

Yabby will use the new runner for **new tasks**. Already-running tasks finish on whatever runner spawned them.

---

## Per-runner notes

### Claude Code (default)

```bash
npm i -g @anthropic-ai/claude-code
which claude
```

Yabby spawns:

```
claude -p --dangerously-skip-permissions \
       --verbose --output-format stream-json \
       --session-id {uuid} \
       --system-prompt {prompt} \
       {task}
```

`--dangerously-skip-permissions` is required because Yabby's tasks have full Mac access (bash, AppleScript, GUI). The session id is what enables resume.

### Codex

OpenAI's CLI uses a `thread_id` instead of a session id. Yabby persists this in `tasks.runner_thread_id` ([migration 035](../db/migrations/035_runner_session_parity.js)) and `agents.runner_sessions` ([migration 036](../db/migrations/036_agent_runner_sessions.js)) so resume reaches the right thread.

### Aider

```bash
pip install aider-chat
```

Aider edits files via diffs rather than emitting tool calls in the same shape as Claude/Codex. The runner profile parses Aider's output format. Resume is limited to the same chat session in the same process.

### Goose

```bash
brew install block-goose-cli
```

Goose is MCP-native, so it benefits the most from Yabby's auto-generated `.mcp.json` in the task CWD.

### Cline

```bash
npm i -g @cline/cli
```

Cline's plan-mode is well-aligned with Yabby's planning phase. Long autonomous runs with periodic checkpoints work well.

### Continue

```bash
npm i -g @continuedev/cli
```

Continue can target many provider matrices — set the provider via your Continue config, Yabby just drives the process.

---

## Resume mechanics

When a task pauses (LLM quota, manual pause, crash recovery) and later resumes, Yabby needs to point the runner at the **same conversation/session** so context isn't lost.

This used to be tricky because runners disagree on what to call the conversation handle:

- Claude calls it `session_id`
- Codex calls it `thread_id`
- Aider has no first-class session concept

[Migration 035](../db/migrations/035_runner_session_parity.js) added `tasks.runner_id` + `tasks.runner_thread_id` so the spawner can record whichever native handle the runner emits.

[Migration 036](../db/migrations/036_agent_runner_sessions.js) added `agents.runner_sessions` (JSONB) so an agent can be resumed even when the task-local context is missing — the per-agent map looks like:

```json
{
  "claude": "8c3a-...",
  "codex": "thread_abc123",
  "aider": null
}
```

---

## Adding a new runner

See [CONTRIBUTING.md → Adding a CLI runner](../CONTRIBUTING.md#adding-a-cli-runner).

Short version: implement a profile in [lib/runner-profiles.js](../lib/runner-profiles.js) with `buildArgs()`, `parseStdoutLine()`, and `capabilities`. Persist any non-standard session handle through the `runner_sessions` map.
