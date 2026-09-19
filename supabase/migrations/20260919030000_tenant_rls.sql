-- PostgreSQL/Supabase human tenant authorization and row-level isolation.
--
-- The migration remains valid on ordinary PostgreSQL. Supabase Auth is used
-- only when auth.uid() exists; otherwise the human identity is NULL and all
-- helper decisions fail closed. The PostgreSQL Runtime continues to use its
-- existing server-side trust boundary as the table owner.

CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.authenticated_user_id()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  user_id uuid;
BEGIN
  IF pg_catalog.to_regprocedure('auth.uid()') IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE 'SELECT auth.uid()' INTO user_id;
  RETURN user_id;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION private.is_tenant_member(p_tenant_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  user_id uuid;
BEGIN
  IF p_tenant_id IS NULL THEN
    RETURN false;
  END IF;

  user_id := private.authenticated_user_id();
  IF user_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM core.tenant_member AS membership
    WHERE membership.tenant_id = p_tenant_id
      AND membership.user_id = private.authenticated_user_id()
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.has_tenant_role(
  p_tenant_id text,
  p_roles text[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  user_id uuid;
BEGIN
  IF p_tenant_id IS NULL
     OR p_roles IS NULL
     OR pg_catalog.cardinality(p_roles) = 0 THEN
    RETURN false;
  END IF;

  user_id := private.authenticated_user_id();
  IF user_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM core.tenant_member AS membership
    WHERE membership.tenant_id = p_tenant_id
      AND membership.user_id = private.authenticated_user_id()
      AND membership.role = ANY(p_roles)
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.can_access_project(p_project_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
BEGIN
  IF p_project_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN EXISTS (
    SELECT 1
    FROM core.project AS project
    WHERE project.id = p_project_id
      AND project.tenant_id IS NOT NULL
      AND private.is_tenant_member(project.tenant_id)
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.can_manage_project(p_project_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
DECLARE
  tenant_id text;
BEGIN
  IF p_project_id IS NULL THEN
    RETURN false;
  END IF;

  SELECT project.tenant_id
  INTO tenant_id
  FROM core.project AS project
  WHERE project.id = p_project_id;

  RETURN private.has_tenant_role(tenant_id, ARRAY['owner', 'admin']::text[]);
END;
$$;

CREATE OR REPLACE FUNCTION core.enforce_project_tenant_reparenting()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  old_tenant_id text;
  new_tenant_id text;
BEGIN
  IF OLD.project_id IS NOT DISTINCT FROM NEW.project_id THEN
    RETURN NEW;
  END IF;

  SELECT project.tenant_id
  INTO old_tenant_id
  FROM core.project AS project
  WHERE project.id = OLD.project_id;

  SELECT project.tenant_id
  INTO new_tenant_id
  FROM core.project AS project
  WHERE project.id = NEW.project_id;

  IF old_tenant_id IS DISTINCT FROM new_tenant_id THEN
    RAISE EXCEPTION 'project-owned row cannot change tenant through project reassignment'
      USING ERRCODE = '23514', CONSTRAINT = 'project_tenant_reparenting';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION core.enforce_tenant_member_tenant_immutable()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'tenant membership cannot move between tenants'
      USING ERRCODE = '23514', CONSTRAINT = 'tenant_member_tenant_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenant_member_tenant_immutable
BEFORE UPDATE OF tenant_id ON core.tenant_member
FOR EACH ROW EXECUTE FUNCTION core.enforce_tenant_member_tenant_immutable();

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'task',
    'requirement',
    'task_requirement',
    'milestone',
    'architecture_decision',
    'review',
    'approval',
    'governance_event',
    'agent_run'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE TRIGGER %I BEFORE UPDATE OF project_id ON core.%I FOR EACH ROW EXECUTE FUNCTION core.enforce_project_tenant_reparenting()',
      table_name || '_project_tenant_reparenting',
      table_name
    );
  END LOOP;
END;
$$;

ALTER TABLE core.tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.tenant_member ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.tenant_invite ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.project ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.task ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.requirement ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.task_requirement ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.architecture_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.agent_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.review ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.approval ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.governance_event ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA private FROM PUBLIC;
REVOKE ALL ON SCHEMA core FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA core FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA core FROM PUBLIC;

DO $$
DECLARE
  table_name text;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON SCHEMA core, private FROM anon';
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA core FROM anon';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA core FROM anon';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'
  ) THEN
    RETURN;
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA core, private TO authenticated';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON core.tenant TO authenticated';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON core.tenant_member TO authenticated';
  EXECUTE 'GRANT INSERT, DELETE ON core.tenant_invite TO authenticated';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON core.project TO authenticated';

  FOREACH table_name IN ARRAY ARRAY[
    'task',
    'requirement',
    'task_requirement',
    'milestone',
    'architecture_decision',
    'agent_run',
    'review',
    'approval',
    'governance_event'
  ] LOOP
    EXECUTE pg_catalog.format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON core.%I TO authenticated',
      table_name
    );
  END LOOP;

  -- Invitations are readable by members without granting the secret token_hash.
  EXECUTE 'GRANT SELECT (id, tenant_id, invited_email, role, invited_by, expires_at, accepted_at, created_at) ON core.tenant_invite TO authenticated';
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION private.authenticated_user_id() TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION private.is_tenant_member(text) TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION private.has_tenant_role(text, text[]) TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION private.can_access_project(text) TO authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION private.can_manage_project(text) TO authenticated';

  EXECUTE 'CREATE POLICY tenant_select_member ON core.tenant FOR SELECT TO authenticated USING (private.is_tenant_member(id))';
  EXECUTE 'CREATE POLICY tenant_update_owner ON core.tenant FOR UPDATE TO authenticated USING (private.has_tenant_role(id, ARRAY[''owner'']::text[])) WITH CHECK (private.has_tenant_role(id, ARRAY[''owner'']::text[]))';
  EXECUTE 'CREATE POLICY tenant_delete_owner ON core.tenant FOR DELETE TO authenticated USING (private.has_tenant_role(id, ARRAY[''owner'']::text[]))';

  EXECUTE 'CREATE POLICY tenant_member_select_member ON core.tenant_member FOR SELECT TO authenticated USING (private.is_tenant_member(tenant_id))';
  EXECUTE 'CREATE POLICY tenant_member_insert_managed ON core.tenant_member FOR INSERT TO authenticated WITH CHECK ((role IN (''admin'', ''member'') AND private.has_tenant_role(tenant_id, ARRAY[''owner'']::text[])) OR (role = ''member'' AND private.has_tenant_role(tenant_id, ARRAY[''admin'']::text[])))';
  EXECUTE 'CREATE POLICY tenant_member_update_managed ON core.tenant_member FOR UPDATE TO authenticated USING ((role <> ''owner'' AND private.has_tenant_role(tenant_id, ARRAY[''owner'']::text[])) OR (role = ''member'' AND private.has_tenant_role(tenant_id, ARRAY[''admin'']::text[]))) WITH CHECK ((role IN (''admin'', ''member'') AND private.has_tenant_role(tenant_id, ARRAY[''owner'']::text[])) OR (role = ''member'' AND private.has_tenant_role(tenant_id, ARRAY[''admin'']::text[])))';
  EXECUTE 'CREATE POLICY tenant_member_delete_managed ON core.tenant_member FOR DELETE TO authenticated USING ((role <> ''owner'' AND private.has_tenant_role(tenant_id, ARRAY[''owner'']::text[])) OR (role = ''member'' AND private.has_tenant_role(tenant_id, ARRAY[''admin'']::text[])))';

  EXECUTE 'CREATE POLICY tenant_invite_select_member ON core.tenant_invite FOR SELECT TO authenticated USING (private.is_tenant_member(tenant_id))';
  EXECUTE 'CREATE POLICY tenant_invite_insert_managed ON core.tenant_invite FOR INSERT TO authenticated WITH CHECK ((((role IN (''admin'', ''member'') AND private.has_tenant_role(tenant_id, ARRAY[''owner'']::text[])) OR (role = ''member'' AND private.has_tenant_role(tenant_id, ARRAY[''admin'']::text[]))) AND invited_by = private.authenticated_user_id()))';
  EXECUTE 'CREATE POLICY tenant_invite_delete_managed ON core.tenant_invite FOR DELETE TO authenticated USING (private.has_tenant_role(tenant_id, ARRAY[''owner'', ''admin'']::text[]))';

  EXECUTE 'CREATE POLICY project_select_member ON core.project FOR SELECT TO authenticated USING (private.can_access_project(id))';
  EXECUTE 'CREATE POLICY project_insert_manager ON core.project FOR INSERT TO authenticated WITH CHECK (tenant_id IS NOT NULL AND private.has_tenant_role(tenant_id, ARRAY[''owner'', ''admin'']::text[]))';
  EXECUTE 'CREATE POLICY project_update_manager ON core.project FOR UPDATE TO authenticated USING (private.can_manage_project(id)) WITH CHECK (tenant_id IS NOT NULL AND private.has_tenant_role(tenant_id, ARRAY[''owner'', ''admin'']::text[]))';
  EXECUTE 'CREATE POLICY project_delete_manager ON core.project FOR DELETE TO authenticated USING (private.can_manage_project(id))';

  FOREACH table_name IN ARRAY ARRAY[
    'task',
    'requirement',
    'task_requirement',
    'milestone',
    'architecture_decision',
    'review',
    'approval',
    'governance_event'
  ] LOOP
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON core.%I FOR SELECT TO authenticated USING (private.can_access_project(project_id))',
      table_name || '_select_project_member',
      table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON core.%I FOR INSERT TO authenticated WITH CHECK (private.can_access_project(project_id))',
      table_name || '_insert_project_member',
      table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON core.%I FOR UPDATE TO authenticated USING (private.can_access_project(project_id)) WITH CHECK (private.can_access_project(project_id))',
      table_name || '_update_project_member',
      table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON core.%I FOR DELETE TO authenticated USING (private.can_access_project(project_id))',
      table_name || '_delete_project_member',
      table_name
    );
  END LOOP;

  EXECUTE 'CREATE POLICY agent_run_select_project_member ON core.agent_run FOR SELECT TO authenticated USING (private.can_access_project(project_id))';
END;
$$;

COMMENT ON SCHEMA private IS
  'Non-Data-API authorization helpers. Human identity comes from Supabase auth.uid() when available; database membership remains authoritative.';

COMMENT ON FUNCTION private.authenticated_user_id() IS
  'Resolves auth.uid() only when Supabase Auth is installed; returns NULL on ordinary PostgreSQL or any identity-resolution error.';

COMMENT ON FUNCTION private.is_tenant_member(text) IS
  'Fail-closed membership lookup backed by core.tenant_member, never JWT tenant claims.';

COMMENT ON FUNCTION private.has_tenant_role(text, text[]) IS
  'Fail-closed tenant-local role lookup backed by core.tenant_member, never JWT tenant claims.';

COMMENT ON FUNCTION private.can_access_project(text) IS
  'Allows authenticated human access only to assigned projects in a tenant where core membership exists.';

COMMENT ON FUNCTION private.can_manage_project(text) IS
  'Allows project management only to owner/admin membership of the project tenant.';
