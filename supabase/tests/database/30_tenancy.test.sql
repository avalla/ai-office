begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;

select * from no_plan();

select has_table('core', 'tenant', 'tenant authority exists');
select has_table('core', 'tenant_member', 'tenant membership authority exists');
select has_table('core', 'tenant_invite', 'tenant invitation authority exists');
select has_column('core', 'project', 'tenant_id', 'project carries shared-deployment tenant ownership');
select has_trigger(
  'core',
  'project',
  'project_tenant_assignment_once',
  'project tenant ownership has an assign-once guard'
);
select has_function(
  'core',
  'enforce_project_tenant_assignment_once'::name,
  'project tenant immutability function exists'
);
select col_is_pk(
  'core',
  'tenant_member',
  array['tenant_id', 'user_id'],
  'membership is unique per tenant and human principal'
);
select col_is_unique(
  'core',
  'project',
  array['id', 'tenant_id'],
  'project exposes a composite tenant identity for future foreign keys'
);
select has_index(
  'core',
  'tenant_member',
  'tenant_member_user_tenant_idx',
  'membership lookup by user is indexed'
);
select has_index(
  'core',
  'project',
  'project_tenant_id_idx',
  'tenant project lookup is indexed'
);

insert into core.tenant(id, name, created_at, updated_at)
values
  ('pgtap-tenant-a', 'Tenant A', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('pgtap-tenant-b', 'Tenant B', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

select lives_ok(
  $$
    insert into core.tenant_member(tenant_id, user_id, role, created_at)
    values
      ('pgtap-tenant-a', '11111111-1111-1111-1111-111111111111', 'owner', '2026-09-19T00:00:00Z'),
      ('pgtap-tenant-b', '11111111-1111-1111-1111-111111111111', 'member', '2026-09-19T00:00:00Z')
  $$,
  'one authenticated principal may belong to multiple tenants'
);

select throws_ok(
  $$
    insert into core.tenant_member(tenant_id, user_id, role, created_at)
    values ('pgtap-tenant-a', '11111111-1111-1111-1111-111111111111', 'member', '2026-09-19T00:00:00Z')
  $$,
  '23505',
  null,
  'the same principal cannot have duplicate membership in one tenant'
);

select throws_ok(
  $$
    insert into core.tenant_member(tenant_id, user_id, role, created_at)
    values ('pgtap-tenant-a', '22222222-2222-2222-2222-222222222222', 'superadmin', '2026-09-19T00:00:00Z')
  $$,
  '23514',
  null,
  'membership roles are constrained to owner/admin/member'
);

select is(
  (select is_nullable from information_schema.columns
   where table_schema = 'core' and table_name = 'project' and column_name = 'tenant_id'),
  'NO',
  'project tenant ownership is mandatory after migration'
);

select throws_ok(
  $$
    insert into core.project(id, name, created_at, updated_at)
    values ('pgtap-null-project', 'Invalid project', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z')
  $$,
  '23502',
  null,
  'project creation without tenant ownership is rejected'
);

insert into core.project(id, name, tenant_id, created_at, updated_at)
values
  ('pgtap-owned-project', 'Owned project', 'pgtap-tenant-a', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('pgtap-other-project', 'Other project', 'pgtap-tenant-b', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

select throws_ok(
  $$
    update core.project
    set tenant_id = 'pgtap-tenant-b'
    where id = 'pgtap-owned-project'
  $$,
  '23514',
  'project tenant assignment is immutable',
  'project cannot be moved between tenants through an ordinary update'
);

select throws_ok(
  $$
    update core.project
    set tenant_id = null
    where id = 'pgtap-owned-project'
  $$,
  '23514',
  'project tenant assignment is immutable',
  'assigned project cannot be detached from its tenant'
);

insert into core.task(id, project_id, title, status, created_at, updated_at)
values ('pgtap-owned-task', 'pgtap-owned-project', 'Owned task', 'pending', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

select throws_ok(
  $$ update core.task set project_id = 'pgtap-other-project' where id = 'pgtap-owned-task' $$,
  '23514',
  'project-owned row cannot change tenant through project reassignment',
  'project-owned records cannot be reparented across tenants'
);

select throws_ok(
  $$ delete from core.tenant where id = 'pgtap-tenant-a' $$,
  '23503',
  null,
  'tenant deletion is restricted while it still owns a project'
);

-- Free tenant B for the cascade checks below after using it as the cross-tenant target.
delete from core.project where id = 'pgtap-other-project';

select lives_ok(
  $$
    insert into core.tenant_invite(
      id, tenant_id, invited_email, role, token_hash, invited_by,
      expires_at, created_at
    ) values (
      'pgtap-invite-a', 'pgtap-tenant-b', 'member@example.test', 'member',
      'hash-a', '11111111-1111-1111-1111-111111111111',
      '2026-09-20T00:00:00Z', '2026-09-19T00:00:00Z'
    )
  $$,
  'a tenant member invitation can be created'
);

select throws_ok(
  $$
    insert into core.tenant_invite(
      id, tenant_id, invited_email, role, token_hash, invited_by,
      expires_at, created_at
    ) values (
      'pgtap-invite-duplicate', 'pgtap-tenant-b', 'MEMBER@example.test', 'member',
      'hash-b', '11111111-1111-1111-1111-111111111111',
      '2026-09-20T00:00:00Z', '2026-09-19T00:00:00Z'
    )
  $$,
  '23505',
  null,
  'only one active invitation per tenant/email is allowed case-insensitively'
);

select throws_ok(
  $$
    insert into core.tenant_invite(
      id, tenant_id, invited_email, role, token_hash, invited_by,
      expires_at, created_at
    ) values (
      'pgtap-whitespace-invite', 'pgtap-tenant-b', ' member@example.test ', 'member',
      'hash-whitespace', '11111111-1111-1111-1111-111111111111',
      '2026-09-20T00:00:00Z', '2026-09-19T00:00:00Z'
    )
  $$,
  '23514',
  null,
  'invitation emails must not contain leading or trailing whitespace'
);

select throws_ok(
  $$
    insert into core.tenant_invite(
      id, tenant_id, invited_email, role, token_hash, invited_by,
      expires_at, created_at
    ) values (
      'pgtap-owner-invite', 'pgtap-tenant-b', 'owner@example.test', 'owner',
      'hash-owner', '11111111-1111-1111-1111-111111111111',
      '2026-09-20T00:00:00Z', '2026-09-19T00:00:00Z'
    )
  $$,
  '23514',
  null,
  'owner authority is not granted through an ordinary invitation'
);

select throws_ok(
  $$
    update core.tenant_invite
    set accepted_at = '2026-09-18T23:59:59Z'
    where id = 'pgtap-invite-a'
  $$,
  '23514',
  null,
  'an invitation cannot be accepted before it was created'
);

select lives_ok(
  $$
    update core.tenant_invite
    set accepted_at = '2026-09-19T01:00:00Z'
    where id = 'pgtap-invite-a'
  $$,
  'an invitation can be accepted between creation and expiry'
);

select lives_ok(
  $$
    update core.tenant_invite
    set accepted_at = '2026-09-20T00:00:00Z'
    where id = 'pgtap-invite-a'
  $$,
  'an invitation can be accepted exactly at expiry'
);

select throws_ok(
  $$
    update core.tenant_invite
    set accepted_at = '2026-09-20T00:00:01Z'
    where id = 'pgtap-invite-a'
  $$,
  '23514',
  null,
  'an invitation cannot be accepted after expiry'
);

select lives_ok(
  $$
    insert into core.tenant_invite(
      id, tenant_id, invited_email, role, token_hash, invited_by,
      expires_at, created_at
    ) values (
      'pgtap-invite-after-accept', 'pgtap-tenant-b', 'member@example.test', 'admin',
      'hash-c', '11111111-1111-1111-1111-111111111111',
      '2026-09-21T00:00:00Z', '2026-09-19T02:00:00Z'
    )
  $$,
  'a new invitation may be issued after the previous one is accepted'
);

select lives_ok(
  $$ delete from core.tenant where id = 'pgtap-tenant-b' $$,
  'tenant without projects can be deleted and cascades membership/invites'
);

select is(
  (
    select count(*)::bigint
    from core.tenant_member
    where tenant_id = 'pgtap-tenant-b'
  ),
  0::bigint,
  'tenant membership rows cascade on tenant deletion'
);

select is(
  (
    select count(*)::bigint
    from core.tenant_invite
    where tenant_id = 'pgtap-tenant-b'
  ),
  0::bigint,
  'tenant invitation rows cascade on tenant deletion'
);

select * from finish();
rollback;
