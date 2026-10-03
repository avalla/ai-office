-- Portable GP-05 project selection; host-local installation is separate.
CREATE TABLE core.project_pack_binding (
  project_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  configuration_revision integer NOT NULL DEFAULT 0 CHECK (configuration_revision >= 0),
  changed_at timestamptz,
  UNIQUE (project_id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES core.project(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE core.project_pack_binding_pack (
  project_id text NOT NULL,
  tenant_id text NOT NULL,
  pack_id text NOT NULL CHECK (length(pack_id) > 0),
  pack_version text NOT NULL CHECK (length(pack_version) > 0),
  manifest_digest text NOT NULL CHECK (manifest_digest ~ '^sha256:[0-9a-f]{64}$'),
  PRIMARY KEY (project_id, pack_id),
  FOREIGN KEY (project_id, tenant_id)
    REFERENCES core.project_pack_binding(project_id, tenant_id) ON DELETE CASCADE
);

INSERT INTO core.project_pack_binding(project_id, tenant_id)
SELECT id, tenant_id FROM core.project;

ALTER TABLE core.project_pack_binding ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project_pack_binding_pack ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON core.project_pack_binding, core.project_pack_binding_pack FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON core.project_pack_binding, core.project_pack_binding_pack TO authenticated;
    CREATE POLICY project_pack_binding_select ON core.project_pack_binding
      FOR SELECT TO authenticated USING (private.can_access_project(project_id));
    CREATE POLICY project_pack_binding_insert ON core.project_pack_binding
      FOR INSERT TO authenticated WITH CHECK (private.can_access_project(project_id));
    CREATE POLICY project_pack_binding_update ON core.project_pack_binding
      FOR UPDATE TO authenticated USING (private.can_access_project(project_id))
      WITH CHECK (private.can_access_project(project_id));
    CREATE POLICY project_pack_binding_delete ON core.project_pack_binding
      FOR DELETE TO authenticated USING (private.can_access_project(project_id));
    CREATE POLICY project_pack_binding_pack_select ON core.project_pack_binding_pack
      FOR SELECT TO authenticated USING (private.can_access_project(project_id));
    CREATE POLICY project_pack_binding_pack_insert ON core.project_pack_binding_pack
      FOR INSERT TO authenticated WITH CHECK (private.can_access_project(project_id));
    CREATE POLICY project_pack_binding_pack_update ON core.project_pack_binding_pack
      FOR UPDATE TO authenticated USING (private.can_access_project(project_id))
      WITH CHECK (private.can_access_project(project_id));
    CREATE POLICY project_pack_binding_pack_delete ON core.project_pack_binding_pack
      FOR DELETE TO authenticated USING (private.can_access_project(project_id));
  END IF;
END;
$$;
