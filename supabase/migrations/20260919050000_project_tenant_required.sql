-- PostgreSQL project ownership completion.
--
-- Existing rows must be assigned by an authoritative operator before this
-- migration can apply. Guessing a tenant would create cross-tenant authority.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM core.project
    WHERE tenant_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'cannot make core.project.tenant_id NOT NULL while NULL-tenant projects exist';
  END IF;
END;
$$;

ALTER TABLE core.project
  ALTER COLUMN tenant_id SET NOT NULL;

COMMENT ON COLUMN core.project.tenant_id IS
  'Mandatory PostgreSQL shared-deployment tenant ownership. Portable Project identity and repository identity remain tenant-agnostic.';
