-- PostgreSQL/Supabase governance authority boundary.
--
-- Tenant visibility and governance authority are separate concerns. Authenticated
-- humans may read project-owned governance projections for tenants they belong
-- to, but authoritative governance writes remain on the Runtime/server-side
-- table-owner path until a bound RPC/API authority is designed.

DO $$
DECLARE
  table_name text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = 'authenticated'
  ) THEN
    RETURN;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'review',
    'approval',
    'governance_event',
    'agent_run'
  ] LOOP
    EXECUTE pg_catalog.format(
      'REVOKE INSERT, UPDATE, DELETE ON core.%I FROM authenticated',
      table_name
    );
    EXECUTE pg_catalog.format(
      'GRANT SELECT ON core.%I TO authenticated',
      table_name
    );
  END LOOP;

  -- Authenticated users have no direct insert path for the only identity
  -- sequence-backed core table. Do not expose broad sequence privileges.
  EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA core FROM authenticated';

  FOREACH table_name IN ARRAY ARRAY[
    'review',
    'approval',
    'governance_event'
  ] LOOP
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS %I ON core.%I',
      table_name || '_insert_project_member',
      table_name
    );
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS %I ON core.%I',
      table_name || '_update_project_member',
      table_name
    );
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS %I ON core.%I',
      table_name || '_delete_project_member',
      table_name
    );
    EXECUTE pg_catalog.format(
      'DROP POLICY IF EXISTS %I ON core.%I',
      table_name || '_select_project_member',
      table_name
    );
    EXECUTE pg_catalog.format(
      'CREATE POLICY %I ON core.%I FOR SELECT TO authenticated USING (private.can_access_project(project_id))',
      table_name || '_select_project_member',
      table_name
    );
  END LOOP;

  EXECUTE 'DROP POLICY IF EXISTS agent_run_select_project_member ON core.agent_run';
  EXECUTE 'CREATE POLICY agent_run_select_project_member ON core.agent_run FOR SELECT TO authenticated USING (private.can_access_project(project_id))';
END;
$$;

COMMENT ON TABLE core.review IS
  'Authoritative review provenance and state. Authenticated humans have tenant-scoped SELECT only; writes use the Runtime/server-side authority.';

COMMENT ON TABLE core.approval IS
  'Authoritative review decisions. Authenticated humans have tenant-scoped SELECT only; approval writes use the Runtime/server-side authority.';

COMMENT ON TABLE core.governance_event IS
  'Authoritative governance audit events. Authenticated humans have tenant-scoped SELECT only; event writes use the Runtime/server-side authority.';

COMMENT ON TABLE core.agent_run IS
  'Runtime-owned agent-run projection. Authenticated humans have tenant-scoped SELECT only.';
