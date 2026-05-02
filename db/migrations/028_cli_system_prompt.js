/* ═══════════════════════════════════════════════════════
   YABBY — Migration 028: Separate CLI system prompt for agents
   ═══════════════════════════════════════════════════════
   Agents have two execution contexts with different tool sets:

   1. Chat/WhatsApp/webchat (gpt-5-mini): uses yabby_execute, yabby_intervention,
      send_message function-calling tools → stored in `system_prompt`.

   2. Claude Code CLI (tasks spawned by yabby_execute): uses native Bash/Read/Write/
      Edit tools → needs a separate prompt WITHOUT yabby_execute mentions, otherwise
      the CLI agent tries to "delegate" tasks to a tool that doesn't exist and
      replies "this message is not for me".

   This migration adds `cli_system_prompt TEXT` to the agents table.
   - NULL for existing agents (fallback handled in spawner.js)
   - Filled for new agents in routes/agents.js POST /api/agents
*/

export const MIGRATION = `
ALTER TABLE agents ADD COLUMN IF NOT EXISTS cli_system_prompt TEXT;
`;

export async function run() {
  const { query } = await import("../pg.js");
  await query(MIGRATION);
  console.log('[MIGRATION 028] ✅ Added cli_system_prompt column to agents');
}
