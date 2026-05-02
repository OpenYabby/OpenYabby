import { query } from "../pg.js";

const MIGRATION = `
-- Performance indexes for frequently queried columns
CREATE INDEX IF NOT EXISTS idx_tasks_agent_status ON tasks(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_messages_to_status ON agent_messages(to_agent, status);
CREATE INDEX IF NOT EXISTS idx_agents_parent_status ON agents(parent_agent_id, status) WHERE status != 'archived';
CREATE INDEX IF NOT EXISTS idx_agents_project_lead ON agents(project_id, is_lead) WHERE status != 'archived';
`;

export async function run() {
  await query(MIGRATION);
}
