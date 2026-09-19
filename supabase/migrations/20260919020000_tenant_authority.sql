-- PostgreSQL/Supabase tenant authority foundation.
--
-- This slice introduces shared-deployment tenancy without changing the portable
-- Project domain used by SQLite/Lite. Project tenant ownership is PostgreSQL
-- infrastructure metadata. The column is intentionally nullable during the
-- migration phase so existing PostgreSQL repository contracts remain valid;
-- future authenticated/RLS slices must deny unassigned projects and tenant-aware
-- project creation can then make the association mandatory.

CREATE TABLE core.tenant (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (length(trim(name)) > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE core.tenant_member (
  tenant_id text NOT NULL REFERENCES core.tenant(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE INDEX tenant_member_user_tenant_idx
ON core.tenant_member(user_id, tenant_id);

COMMENT ON COLUMN core.tenant_member.user_id IS
  'Authenticated human principal UUID. Core authority stays portable PostgreSQL and intentionally does not foreign-key Supabase auth.users.';

CREATE TABLE core.tenant_invite (
  id text PRIMARY KEY,
  tenant_id text NOT NULL REFERENCES core.tenant(id) ON DELETE CASCADE,
  invited_email text NOT NULL CHECK (
    length(trim(invited_email)) > 0
    AND invited_email = btrim(invited_email)
  ),
  role text NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash text NOT NULL UNIQUE CHECK (length(trim(token_hash)) > 0),
  invited_by uuid NOT NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL,
  CHECK (expires_at > created_at),
  CHECK (
    accepted_at IS NULL
    OR (accepted_at >= created_at AND accepted_at <= expires_at)
  )
);

CREATE UNIQUE INDEX tenant_invite_active_email_unique
ON core.tenant_invite(tenant_id, lower(invited_email))
WHERE accepted_at IS NULL;

CREATE INDEX tenant_invite_tenant_expires_idx
ON core.tenant_invite(tenant_id, expires_at, id);

COMMENT ON COLUMN core.tenant_invite.invited_by IS
  'Authenticated human principal UUID. Supabase Auth integration is enforced by the later API/RLS slice, not by core schema coupling.';

ALTER TABLE core.project
  ADD COLUMN tenant_id text;

ALTER TABLE core.project
  ADD CONSTRAINT project_tenant_fk
  FOREIGN KEY (tenant_id)
  REFERENCES core.tenant(id)
  ON DELETE RESTRICT;

-- The primary key already makes project.id globally unique. This explicit
-- composite identity exists so future tenant-denormalized tables can bind
-- (project_id, tenant_id) without inventing weaker trigger-only ownership.
ALTER TABLE core.project
  ADD CONSTRAINT project_id_tenant_unique
  UNIQUE (id, tenant_id);

CREATE INDEX project_tenant_id_idx
ON core.project(tenant_id, id)
WHERE tenant_id IS NOT NULL;

COMMENT ON COLUMN core.project.tenant_id IS
  'Shared-deployment tenant ownership. Nullable only for the staged PostgreSQL migration/runtime compatibility period; authenticated Pro access must fail closed for NULL ownership.';

CREATE OR REPLACE FUNCTION core.enforce_project_tenant_assignment_once()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.tenant_id IS NOT NULL
     AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
    RAISE EXCEPTION 'project tenant assignment is immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'project_tenant_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER project_tenant_assignment_once
BEFORE UPDATE OF tenant_id ON core.project
FOR EACH ROW EXECUTE FUNCTION core.enforce_project_tenant_assignment_once();
