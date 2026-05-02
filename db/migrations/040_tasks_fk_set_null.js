/* ═══════════════════════════════════════════════════════
   YABBY — Migration 040: tasks FKs → ON DELETE SET NULL
   ═══════════════════════════════════════════════════════
   The original migration 002 created fk_tasks_agent and fk_tasks_project
   without an ON DELETE clause, which defaults to NO ACTION. That blocks
   project archival (deleteProject in db/queries/projects.js) whenever any
   task still references the project's agents — Postgres raises:

     update or delete on table "agents" violates foreign key constraint
     "fk_tasks_agent" on table "tasks"

   The intent has always been: tasks are append-only execution history. When
   a project is archived or an agent is removed, the tasks should keep their
   audit-log rows but lose the dangling reference. Switching both FKs to
   ON DELETE SET NULL preserves the history (tasks.agent_id and
   tasks.project_id are already nullable — see migration 002 lines 37-38)
   and unblocks deleteProject.

   This migration is idempotent: it drops the old constraints if they exist,
   then re-creates them with the SET NULL clause.
*/

import { query } from "../pg.js";

export const MIGRATION = `
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS fk_tasks_agent;
ALTER TABLE tasks
  ADD CONSTRAINT fk_tasks_agent
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE SET NULL;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS fk_tasks_project;
ALTER TABLE tasks
  ADD CONSTRAINT fk_tasks_project
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL;
`;

export async function run() {
  await query(MIGRATION);
}
