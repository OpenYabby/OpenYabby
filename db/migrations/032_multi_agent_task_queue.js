/* ═══════════════════════════════════════════════════════
   Migration 032 — multi_agent_task_queue
   ═══════════════════════════════════════════════════════
   Orchestre une cascade de tâches réparties sur plusieurs
   agents, avec ordre par position. Même position = parallèle,
   position suivante = attend que toute la position courante
   soit terminée. Permet au lead de décrire un plan complet
   en un seul appel (`talk_to_agent` avec `next_tasks`).

   Deux champs ajoutés à agent_task_queue lient un item
   individuel à sa cascade parente pour permettre au
   orchestrator d'avancer étape par étape.
*/

import { query } from "../pg.js";

export const MIGRATION = `
  CREATE TABLE IF NOT EXISTS multi_agent_task_queue (
    id SERIAL PRIMARY KEY,
    owner_agent_id VARCHAR(12) NOT NULL,
    project_id VARCHAR(12),
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    current_position INTEGER NOT NULL DEFAULT 0,
    items JSONB NOT NULL,
    on_error VARCHAR(16) NOT NULL DEFAULT 'stop',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ
  );

  CREATE INDEX IF NOT EXISTS idx_multi_agent_queue_owner
    ON multi_agent_task_queue (owner_agent_id);
  CREATE INDEX IF NOT EXISTS idx_multi_agent_queue_project
    ON multi_agent_task_queue (project_id);
  CREATE INDEX IF NOT EXISTS idx_multi_agent_queue_status
    ON multi_agent_task_queue (status);

  ALTER TABLE agent_task_queue
    ADD COLUMN IF NOT EXISTS multi_agent_task_id INTEGER,
    ADD COLUMN IF NOT EXISTS multi_agent_position INTEGER;

  DO $$
  BEGIN
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'agent_task_queue_multi_agent_task_id_fkey'
    ) THEN
      ALTER TABLE agent_task_queue
        ADD CONSTRAINT agent_task_queue_multi_agent_task_id_fkey
        FOREIGN KEY (multi_agent_task_id)
        REFERENCES multi_agent_task_queue(id)
        ON DELETE SET NULL;
    END IF;
  END $$;

  CREATE INDEX IF NOT EXISTS idx_task_queue_multi_agent
    ON agent_task_queue (multi_agent_task_id, multi_agent_position);
`;

export async function run() {
  await query(MIGRATION);
}
