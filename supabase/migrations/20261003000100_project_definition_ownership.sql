-- GP-07 project semantic authority; never an installed-pack catalog.
CREATE TABLE core.project_definition_head (
  project_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  changed_at timestamptz,
  UNIQUE (project_id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES core.project(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE core.project_owned_definition (
  project_id text NOT NULL,
  tenant_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('roles','taskTypes','workflows','agents','artifactTypes','evidenceTypes','knowledge','prompts')),
  local_id text NOT NULL CHECK (length(local_id) > 0),
  revision integer NOT NULL CHECK (revision > 0),
  enabled boolean NOT NULL,
  payload_json jsonb NOT NULL,
  actor_id text NOT NULL CHECK (length(actor_id) > 0),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, kind, local_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES core.project_definition_head(project_id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE core.project_definition_override (
  project_id text NOT NULL,
  tenant_id text NOT NULL,
  pack_id text NOT NULL CHECK (pack_id ~ '^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$'),
  pack_version text NOT NULL CHECK (pack_version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  kind text NOT NULL CHECK (kind IN ('roles','taskTypes','agents','artifactTypes','evidenceTypes','knowledge','prompts')),
  local_id text NOT NULL CHECK (length(local_id) > 0),
  operation text NOT NULL CHECK (operation IN ('replace','extend','disable')),
  revision integer NOT NULL CHECK (revision > 0),
  payload_json jsonb,
  actor_id text NOT NULL CHECK (length(actor_id) > 0),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, pack_id, pack_version, manifest_digest, kind, local_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES core.project_definition_head(project_id, tenant_id) ON DELETE CASCADE,
  CHECK ((operation = 'disable' AND kind = 'prompts' AND payload_json IS NULL)
    OR (operation IN ('replace','extend') AND payload_json IS NOT NULL))
);

ALTER TABLE core.project_definition_head ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_owned_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_definition_override ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.project_definition_head, core.project_owned_definition, core.project_definition_override FROM PUBLIC;

DO $$
DECLARE table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    FOREACH table_name IN ARRAY ARRAY['project_definition_head', 'project_owned_definition', 'project_definition_override'] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON core.%I TO authenticated', table_name);
      EXECUTE format('CREATE POLICY %I ON core.%I FOR SELECT TO authenticated USING (private.can_access_project(project_id))', table_name || '_select', table_name);
      EXECUTE format('CREATE POLICY %I ON core.%I FOR INSERT TO authenticated WITH CHECK (private.can_access_project(project_id))', table_name || '_insert', table_name);
      EXECUTE format('CREATE POLICY %I ON core.%I FOR UPDATE TO authenticated USING (private.can_access_project(project_id)) WITH CHECK (private.can_access_project(project_id))', table_name || '_update', table_name);
      EXECUTE format('CREATE POLICY %I ON core.%I FOR DELETE TO authenticated USING (private.can_access_project(project_id))', table_name || '_delete', table_name);
    END LOOP;
  END IF;
END;
$$;
