import { query } from "../pg.js";

const MIGRATION = `
-- Add task queue management columns to agents table
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS active_task_id VARCHAR(8) REFERENCES tasks(id),
  ADD COLUMN IF NOT EXISTS task_status VARCHAR(20) DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_agents_active_task ON agents(active_task_id);
CREATE INDEX IF NOT EXISTS idx_agents_task_status ON agents(task_status);

-- Create agent task queue table
CREATE TABLE IF NOT EXISTS agent_task_queue (
  id SERIAL PRIMARY KEY,
  agent_id VARCHAR(12) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  instruction TEXT NOT NULL,
  source VARCHAR(50) NOT NULL,
  source_id VARCHAR(50),
  status VARCHAR(20) DEFAULT 'pending',
  priority INTEGER DEFAULT 50,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  result TEXT,
  error TEXT
);

-- Add indexes for agent task queue
CREATE INDEX IF NOT EXISTS idx_task_queue_agent_status ON agent_task_queue(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_task_queue_created ON agent_task_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_task_queue_priority ON agent_task_queue(priority DESC, created_at ASC);

-- Add use_continue flag to scheduled_tasks
ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS use_continue BOOLEAN DEFAULT false;

COMMENT ON COLUMN scheduled_tasks.use_continue IS
  'Si true, utilise continue_task au lieu de start_task (pour agents avec tâche persistante)';

COMMENT ON TABLE agent_task_queue IS
  'File d''attente des instructions pour agents standalone. Garantit l''exécution séquentielle.';

COMMENT ON COLUMN agents.active_task_id IS
  'ID de la tâche CLI persistante de l''agent (pour agents standalone uniquement)';

COMMENT ON COLUMN agents.task_status IS
  'Statut de la tâche active: idle, running, paused, stopped';
`;

export async function run() {
  await query(MIGRATION);
  console.log("[MIGRATION 017] ✓ Agent task queue tables created");
}
