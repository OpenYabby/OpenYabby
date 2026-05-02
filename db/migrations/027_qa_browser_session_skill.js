/* ═══════════════════════════════════════════════════════
   YABBY — Migration 027: QA Browser Session Skill
   ═══════════════════════════════════════════════════════
   Adds qa_browser_session skill for Chrome DevTools MCP automation.
*/

export const MIGRATION = `
-- Add qa_browser_session skill for Chrome DevTools MCP automation
INSERT INTO skills (id, name, description, prompt_fragment, category)
VALUES (
  'qa_browser_1',
  'qa_browser_session',
  'Persistent Chrome DevTools MCP session for accessibility testing',
  '', -- Will be loaded from lib/skills/qa-browser-session.js
  'testing'
)
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category;
`;

export async function run() {
  const { query } = await import("../pg.js");
  await query(MIGRATION);
  console.log('[MIGRATION 027] ✅ Added qa_browser_session skill');
}
