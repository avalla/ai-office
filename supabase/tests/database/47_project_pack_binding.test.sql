begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;
select * from no_plan();

select has_table('core', 'project_pack_binding', 'project binding revision is stored in core');
select has_table('core', 'project_pack_binding_pack', 'exact selected tuples are stored in core');
select col_is_pk('core', 'project_pack_binding', 'project_id', 'one binding head per project');
select col_is_pk('core', 'project_pack_binding_pack', array['project_id', 'pack_id'], 'one active version per pack ID and project');
select has_column('core', 'project_pack_binding', 'tenant_id', 'binding head carries tenant ownership');
select has_column('core', 'project_pack_binding_pack', 'tenant_id', 'selected tuple carries tenant ownership');
select ok((select relrowsecurity from pg_class where oid='core.project_pack_binding'::regclass), 'binding head uses RLS');
select ok((select relrowsecurity from pg_class where oid='core.project_pack_binding_pack'::regclass), 'binding tuples use RLS');

insert into core.tenant(id, name, created_at, updated_at) values
  ('gp05-tenant-a', 'GP05 A', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'),
  ('gp05-tenant-b', 'GP05 B', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z');
insert into core.tenant_member(tenant_id, user_id, role, created_at) values
  ('gp05-tenant-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner', '2026-10-02T00:00:00Z'),
  ('gp05-tenant-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner', '2026-10-02T00:00:00Z');
insert into core.project(id, name, tenant_id, created_at, updated_at) values
  ('gp05-project-a', 'GP05 A', 'gp05-tenant-a', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z'),
  ('gp05-project-b', 'GP05 B', 'gp05-tenant-b', '2026-10-02T00:00:00Z', '2026-10-02T00:00:00Z');
insert into core.project_pack_binding(project_id, tenant_id) values
  ('gp05-project-a', 'gp05-tenant-a'), ('gp05-project-b', 'gp05-tenant-b');
insert into core.project_pack_binding_pack(project_id, tenant_id, pack_id, pack_version, manifest_digest) values
  ('gp05-project-a', 'gp05-tenant-a', 'org.example.alpha', '1.0.0', 'sha256:' || repeat('a', 64)),
  ('gp05-project-b', 'gp05-tenant-b', 'org.example.beta', '2.0.0', 'sha256:' || repeat('b', 64));

select is((select count(*)::integer from core.project_pack_binding_pack), 2, 'both tenant tuples exist');
select throws_ok(
  $$insert into core.project_pack_binding_pack(project_id, tenant_id, pack_id, pack_version, manifest_digest)
    values ('gp05-project-a', 'gp05-tenant-b', 'org.example.cross', '1.0.0', 'sha256:' || repeat('c',64))$$,
  '23503', null, 'cross-tenant tuple fails composite ownership foreign key');
select throws_ok(
  $$insert into core.project_pack_binding_pack(project_id, tenant_id, pack_id, pack_version, manifest_digest)
    values ('gp05-project-a', 'gp05-tenant-a', 'org.example.alpha', '9.0.0', 'sha256:' || repeat('d',64))$$,
  '23505', null, 'a second active version of one pack ID is rejected');

set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;
select is((select count(*)::integer from core.project_pack_binding), 1, 'tenant A sees only its binding head');
select is((select count(*)::integer from core.project_pack_binding_pack), 1, 'tenant A sees only its selected tuple');

set local role postgres;
select * from finish();
rollback;
