import "dotenv/config";
import { query } from "../pg.js";

const MIGRATION = `
-- Skills: reusable prompt fragments that can be composed into agent prompts
CREATE TABLE IF NOT EXISTS skills (
    id          VARCHAR(12) PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    description TEXT,
    prompt_fragment TEXT NOT NULL,
    category    VARCHAR(50),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Agent-skill mapping (many-to-many)
CREATE TABLE IF NOT EXISTS agent_skills (
    agent_id    VARCHAR(12) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    skill_id    VARCHAR(12) NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, skill_id)
);

-- Agent templates: pre-configured agent blueprints per project type
CREATE TABLE IF NOT EXISTS agent_templates (
    id              VARCHAR(12) PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    role            VARCHAR(100) NOT NULL,
    base_prompt     TEXT NOT NULL,
    default_skills  JSONB NOT NULL DEFAULT '[]',
    project_type    VARCHAR(50),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_type ON agent_templates (project_type);

-- Agent messages: inter-agent communication
CREATE TABLE IF NOT EXISTS agent_messages (
    id          BIGSERIAL PRIMARY KEY,
    from_agent  VARCHAR(12) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    to_agent    VARCHAR(12) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    project_id  VARCHAR(12) REFERENCES projects(id) ON DELETE CASCADE,
    msg_type    VARCHAR(30) NOT NULL DEFAULT 'message'
                CHECK (msg_type IN ('message', 'handoff', 'review', 'approval', 'notification')),
    content     TEXT NOT NULL,
    status      VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'read', 'processed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_msgs_to ON agent_messages (to_agent, status);
CREATE INDEX IF NOT EXISTS idx_agent_msgs_project ON agent_messages (project_id, created_at DESC);

-- Sub-tasks and dependencies
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_task_id VARCHAR(8);
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depends_on JSONB DEFAULT '[]';

DO $$ BEGIN
    ALTER TABLE tasks ADD CONSTRAINT fk_tasks_parent FOREIGN KEY (parent_task_id) REFERENCES tasks(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks (parent_task_id);

-- Project sandbox config
ALTER TABLE projects ADD COLUMN IF NOT EXISTS sandbox_config JSONB DEFAULT '{}';

-- Seed some default skills
INSERT INTO skills (id, name, description, prompt_fragment, category) VALUES
  ('sk-web', 'Recherche web', 'Capable de chercher sur internet via le navigateur',
   'Tu peux effectuer des recherches web. Utilise le navigateur Chrome pour chercher des informations actualisées. Ouvre Google et fais tes recherches.', 'research'),
  ('sk-code', 'Programmation', 'Développeur capable d''écrire et modifier du code',
   'Tu es un développeur expérimenté. Tu écris du code propre, testé et documenté. Tu utilises les bonnes pratiques du langage.', 'dev'),
  ('sk-write', 'Rédaction', 'Rédacteur capable d''écrire du contenu de qualité',
   'Tu es un rédacteur professionnel. Tu écris du contenu clair, structuré et engageant. Tu adaptes ton ton au public cible.', 'content'),
  ('sk-analyze', 'Analyse de données', 'Capable d''analyser des données et produire des insights',
   'Tu analyses des données avec rigueur. Tu utilises Python/pandas si nécessaire. Tu produis des visualisations claires et des insights actionnables.', 'analysis'),
  ('sk-design', 'Design', 'Capable de créer des maquettes et du design visuel',
   'Tu conçois des interfaces utilisateur intuitives et esthétiques. Tu utilises les principes de design (hiérarchie visuelle, espacement, couleurs).', 'design'),
  ('sk-seo', 'SEO', 'Optimisation pour les moteurs de recherche',
   'Tu optimises le contenu pour le référencement. Mots-clés pertinents, méta-descriptions, structure des titres, liens internes.', 'marketing'),
  ('sk-test', 'Tests', 'Capable d''écrire et exécuter des tests',
   'Tu écris des tests unitaires et d''intégration. Tu couvres les cas limites. Tu utilises le framework de test adapté au projet.', 'dev')
ON CONFLICT (id) DO NOTHING;
`;

export async function run() {
  console.log("[MIGRATE-003] Running skills & dependencies migration...");
  await query(MIGRATION);
  console.log("[MIGRATE-003] Done.");
}

// Allow direct execution
if (process.argv[1]?.endsWith("003_skills_deps.js")) {
  run()
    .then(() => process.exit(0))
    .catch((err) => { console.error("[MIGRATE-003] Failed:", err.message); process.exit(1); });
}
