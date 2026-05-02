import { query } from "../pg.js";

const MIGRATION = `
-- Connector instances (configured by user)
CREATE TABLE IF NOT EXISTS connectors (
  id                    VARCHAR(12) PRIMARY KEY,
  catalog_id            TEXT NOT NULL,
  label                 TEXT NOT NULL,
  backend               TEXT NOT NULL DEFAULT 'builtin',
  status                TEXT DEFAULT 'disconnected',
  auth_type             TEXT NOT NULL DEFAULT 'none',
  credentials_encrypted JSONB DEFAULT '{}',
  mcp_config            JSONB DEFAULT '{}',
  is_global             BOOLEAN DEFAULT false,
  created_by            TEXT DEFAULT 'user',
  error_message         TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_connectors_catalog ON connectors(catalog_id);
CREATE INDEX IF NOT EXISTS idx_connectors_status ON connectors(status);

-- Links connectors to projects
CREATE TABLE IF NOT EXISTS project_connectors (
  id            VARCHAR(12) PRIMARY KEY,
  project_id    VARCHAR(12) NOT NULL REFERENCES projects(id),
  connector_id  VARCHAR(12) NOT NULL REFERENCES connectors(id),
  enabled       BOOLEAN DEFAULT true,
  linked_by     TEXT DEFAULT 'user',
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, connector_id)
);

CREATE INDEX IF NOT EXISTS idx_pc_project ON project_connectors(project_id);
CREATE INDEX IF NOT EXISTS idx_pc_connector ON project_connectors(connector_id);

-- Agent requests for connectors (pending user approval)
CREATE TABLE IF NOT EXISTS connector_requests (
  id          VARCHAR(12) PRIMARY KEY,
  project_id  VARCHAR(12) NOT NULL REFERENCES projects(id),
  agent_id    VARCHAR(12) NOT NULL REFERENCES agents(id),
  catalog_id  TEXT NOT NULL,
  reason      TEXT NOT NULL,
  status      TEXT DEFAULT 'pending',
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cr_status ON connector_requests(status);
CREATE INDEX IF NOT EXISTS idx_cr_project ON connector_requests(project_id);
`;

export async function run() {
  await query(MIGRATION);
}
