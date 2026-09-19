begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;

select * from no_plan();

select has_schema('private', 'private authorization schema exists');
select has_function('private', 'authenticated_user_id'::name, 'portable identity helper exists');
select has_function('private', 'is_tenant_member'::name, 'tenant membership helper exists');
select has_function('private', 'has_tenant_role'::name, 'tenant role helper exists');
select has_function('private', 'can_access_project'::name, 'project access helper exists');
select has_function('private', 'can_manage_project'::name, 'project management helper exists');

select is(
  (select prosecdef from pg_proc where oid = 'private.authenticated_user_id()'::regprocedure),
  true,
  'identity helper is security definer'
);
select is(
  (select prosecdef from pg_proc where oid = 'private.is_tenant_member(text)'::regprocedure),
  true,
  'membership helper is security definer'
);
select is(
  (select prosecdef from pg_proc where oid = 'private.has_tenant_role(text,text[])'::regprocedure),
  true,
  'role helper is security definer'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'core.tenant'::regclass),
  'tenant RLS is enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'core.tenant_member'::regclass),
  'tenant membership RLS is enabled'
);
select ok(
  (select relrowsecurity from pg_class where oid = 'core.tenant_invite'::regclass),
  'tenant invite RLS is enabled'
);

select ok(
  has_schema_privilege('authenticated', 'private', 'USAGE'),
  'authenticated can reach private helpers'
);
select ok(
  not has_function_privilege('public', 'private.is_tenant_member(text)', 'EXECUTE'),
  'PUBLIC cannot execute authorization helpers'
);
select ok(
  not has_column_privilege('authenticated', 'core.tenant_invite', 'token_hash', 'SELECT'),
  'authenticated cannot read invitation token hashes'
);
select ok(
  has_column_privilege('authenticated', 'core.tenant_invite', 'invited_email', 'SELECT'),
  'authenticated can read safe invitation columns'
);

insert into core.tenant(id, name, created_at, updated_at)
values
  ('rls-tenant-a', 'Tenant A', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('rls-tenant-b', 'Tenant B', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.tenant_member(tenant_id, user_id, role, created_at)
values
  ('rls-tenant-a', '11111111-1111-1111-1111-111111111111', 'owner', '2026-09-19T00:00:00Z'),
  ('rls-tenant-b', '11111111-1111-1111-1111-111111111111', 'member', '2026-09-19T00:00:00Z'),
  ('rls-tenant-b', '22222222-2222-2222-2222-222222222222', 'owner', '2026-09-19T00:00:00Z'),
  ('rls-tenant-a', '33333333-3333-3333-3333-333333333333', 'admin', '2026-09-19T00:00:00Z'),
  ('rls-tenant-a', '44444444-4444-4444-4444-444444444444', 'member', '2026-09-19T00:00:00Z');

insert into core.project(id, name, tenant_id, created_at, updated_at)
values
  ('rls-project-a', 'Project A', 'rls-tenant-a', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('rls-project-b', 'Project B', 'rls-tenant-b', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('rls-project-legacy', 'Legacy project', null, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;

select is(auth.uid(), '11111111-1111-1111-1111-111111111111'::uuid, 'Supabase Auth resolves the fixture user');
select is((select count(*)::integer from core.tenant), 2, 'user A sees both member tenants');
select is((select count(*)::integer from core.project), 2, 'user A sees projects in both member tenants');
select is(private.is_tenant_member('rls-tenant-a'), true, 'user A is a member of tenant A');
select is(private.is_tenant_member('rls-tenant-b'), true, 'user A is a member of tenant B');
select is(private.has_tenant_role('rls-tenant-a', array['owner']::text[]), true, 'user A is owner in tenant A');
select is(private.has_tenant_role('rls-tenant-b', array['owner']::text[]), false, 'user A is not owner in tenant B');
select is(private.can_access_project('rls-project-a'), true, 'user A can access project A');
select is(private.can_access_project('rls-project-b'), true, 'user A can access project B');
select is(private.can_access_project('rls-project-legacy'), false, 'NULL-tenant project access fails closed');
select is(private.can_manage_project('rls-project-a'), true, 'user A can manage project A');
select is(private.can_manage_project('rls-project-b'), false, 'user A cannot manage project B as a member');
select lives_ok(
  $$ update core.tenant set name = 'Tenant A renamed' where id = 'rls-tenant-a' $$,
  'owner can administer its tenant'
);
update core.tenant set name = 'Tenant B changed' where id = 'rls-tenant-b';
select is((select name from core.tenant where id = 'rls-tenant-b'), 'Tenant B', 'member cannot administer a tenant');
select lives_ok(
  $$ insert into core.tenant_invite(id, tenant_id, invited_email, role, token_hash, invited_by, expires_at, created_at)
     values ('rls-invite-a', 'rls-tenant-a', 'invitee@example.test', 'member', 'secret-hash', '11111111-1111-1111-1111-111111111111', '2026-09-20T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  'owner can create a member invitation with its own actor identity'
);
select is((select invited_email from core.tenant_invite where id = 'rls-invite-a'), 'invitee@example.test', 'authenticated can read safe invitation columns');
select throws_ok(
  $$ select token_hash from core.tenant_invite where id = 'rls-invite-a' $$,
  '42501', null, 'authenticated cannot select invitation token_hash'
);
select throws_ok(
  $$ insert into core.tenant_invite(id, tenant_id, invited_email, role, token_hash, invited_by, expires_at, created_at)
     values ('rls-invite-forged', 'rls-tenant-a', 'forged@example.test', 'member', 'forged-hash', '99999999-9999-9999-9999-999999999999', '2026-09-20T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'invitation actor identity must match auth.uid()'
);

select lives_ok(
  $$ insert into core.tenant_member(tenant_id, user_id, role, created_at)
     values ('rls-tenant-a', '55555555-5555-5555-5555-555555555555', 'member', '2026-09-19T00:00:00Z') $$,
  'owner can add a normal member'
);
select throws_ok(
  $$ insert into core.tenant_member(tenant_id, user_id, role, created_at)
     values ('rls-tenant-a', '66666666-6666-6666-6666-666666666666', 'owner', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'owner cannot create another owner through ordinary membership CRUD'
);
select throws_ok(
  $$ update core.tenant_member set role = 'owner'
     where tenant_id = 'rls-tenant-a' and user_id = '33333333-3333-3333-3333-333333333333' $$,
  '42501', null, 'owner role cannot be assigned through ordinary membership CRUD'
);
delete from core.tenant_member
where tenant_id = 'rls-tenant-a' and user_id = '11111111-1111-1111-1111-111111111111';
select is(
  (select count(*)::integer from core.tenant_member
   where tenant_id = 'rls-tenant-a' and user_id = '11111111-1111-1111-1111-111111111111'),
  1,
  'owner membership is not visible for deletion through ordinary membership CRUD'
);
select throws_ok(
  $$ update core.tenant_member set tenant_id = 'rls-tenant-b'
     where tenant_id = 'rls-tenant-a' and user_id = '33333333-3333-3333-3333-333333333333' $$,
  '23514', 'tenant membership cannot move between tenants', 'membership cannot be moved across tenants'
);

set local role postgres;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select is(private.has_tenant_role('rls-tenant-a', array['admin']::text[]), true, 'admin role is tenant-local');
select lives_ok(
  $$ insert into core.tenant_member(tenant_id, user_id, role, created_at)
     values ('rls-tenant-a', '77777777-7777-7777-7777-777777777777', 'member', '2026-09-19T00:00:00Z') $$,
  'admin can add a normal member'
);
select throws_ok(
  $$ insert into core.tenant_member(tenant_id, user_id, role, created_at)
     values ('rls-tenant-a', '88888888-8888-8888-8888-888888888888', 'admin', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'admin cannot create an admin through conservative member management'
);
select throws_ok(
  $$ update core.tenant_member set role = 'admin'
     where tenant_id = 'rls-tenant-a' and user_id = '44444444-4444-4444-4444-444444444444' $$,
  '42501', null, 'admin cannot promote a member to admin'
);

set local role postgres;
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
set local role authenticated;
select is(private.is_tenant_member('rls-tenant-a'), true, 'member helper recognizes a member');
select is(private.has_tenant_role('rls-tenant-a', array['admin', 'owner']::text[]), false, 'member cannot claim elevated roles');
select throws_ok(
  $$ insert into core.tenant_member(tenant_id, user_id, role, created_at)
     values ('rls-tenant-a', '99999999-9999-9999-9999-999999999999', 'member', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'member cannot manage membership'
);

set local role postgres;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set local role authenticated;
select is((select count(*)::integer from core.tenant), 1, 'user B sees only tenant B');
select is((select count(*)::integer from core.project), 1, 'user B sees only project B');
select lives_ok(
  $$ insert into core.project(id, name, tenant_id, created_at, updated_at)
     values ('rls-project-b-new', 'Project B new', 'rls-tenant-b', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  'tenant B owner can create a project in tenant B'
);

set local role postgres;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select is((select count(*)::integer from core.project), 1, 'admin sees only the managed tenant project');
select is(private.can_manage_project('rls-project-a'), true, 'admin can manage its tenant project');
select is(private.can_manage_project('rls-project-b'), false, 'admin role does not leak across tenants');

set local role postgres;
set local request.jwt.claim.sub = '99999999-9999-9999-9999-999999999999';
set local request.jwt.claims = '{"sub":"99999999-9999-9999-9999-999999999999","tenant_id":"rls-tenant-a","tenant_role":"owner"}';
set local role authenticated;
select is((select count(*)::integer from core.tenant), 0, 'fake JWT tenant claims do not grant tenant access');
select is((select count(*)::integer from core.project), 0, 'fake JWT tenant claims do not grant project access');
select is(private.is_tenant_member('rls-tenant-a'), false, 'membership helper ignores fake JWT tenant claims');

set local role postgres;
delete from core.tenant_member
where user_id = '11111111-1111-1111-1111-111111111111';
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
select is((select count(*)::integer from core.tenant), 0, 'revoked membership removes access immediately');
select is((select count(*)::integer from core.project), 0, 'revoked membership removes project access without JWT refresh');

set local role postgres;
reset request.jwt.claim.sub;
reset request.jwt.claims;
select is(private.authenticated_user_id(), null::uuid, 'missing Supabase identity resolves to NULL');
select is(private.is_tenant_member('rls-tenant-a'), false, 'missing identity fails closed for membership');
select is(private.can_access_project('rls-project-a'), false, 'missing identity fails closed for project access');

set local role anon;
select throws_ok(
  $$ select count(*) from core.project $$,
  '42501', null, 'anon cannot read core authority'
);

select * from finish();
rollback;
