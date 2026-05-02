export const MIGRATION = `
-- Ajouter contexte speaker aux tâches
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS conversation_id UUID;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS created_by_speaker BOOLEAN DEFAULT FALSE;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS speaker_metadata JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_conversation_turn_id BIGINT;

-- Foreign keys
ALTER TABLE tasks ADD CONSTRAINT fk_tasks_conversation
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;

-- Indexes pour recherche rapide
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON tasks(conversation_id);
CREATE INDEX IF NOT EXISTS idx_tasks_created_by_speaker ON tasks(created_by_speaker)
  WHERE created_by_speaker = TRUE;
`;

export async function run() {
  const { query } = await import('../pg.js');
  await query(MIGRATION);
  console.log('[Migration 022] Task speaker context columns added');
}
