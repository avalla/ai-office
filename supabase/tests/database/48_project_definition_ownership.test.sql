begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;
select * from no_plan();

select has_table('core', 'project_definition_head', 'definition revision head exists');
select has_table('core', 'project_owned_definition', 'project-owned definitions exist');
select has_table('core', 'project_definition_override', 'exact pack-source overrides exist');
select ok((select relrowsecurity from pg_class where oid='core.project_definition_head'::regclass), 'definition head has RLS');
select ok((select relrowsecurity from pg_class where oid='core.project_owned_definition'::regclass), 'owned definitions have RLS');
select ok((select relrowsecurity from pg_class where oid='core.project_definition_override'::regclass), 'overrides have RLS');

insert into core.tenant(id, name, created_at, updated_at) values
  ('gp07-tenant-a', 'GP07 A', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z'),
  ('gp07-tenant-b', 'GP07 B', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z');
insert into core.tenant_member(tenant_id, user_id, role, created_at) values
  ('gp07-tenant-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner', '2026-10-03T00:00:00Z'),
  ('gp07-tenant-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner', '2026-10-03T00:00:00Z');
insert into core.project(id, name, tenant_id, created_at, updated_at) values
  ('gp07-project-a', 'GP07 A', 'gp07-tenant-a', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z'),
  ('gp07-project-b', 'GP07 B', 'gp07-tenant-b', '2026-10-03T00:00:00Z', '2026-10-03T00:00:00Z');
insert into core.project_definition_head(project_id, tenant_id) values
  ('gp07-project-a', 'gp07-tenant-a'), ('gp07-project-b', 'gp07-tenant-b');
insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at) values
  ('gp07-project-a','gp07-tenant-a','roles','custom',1,true,'{"id":"custom"}','operator','2026-10-03T00:00:00Z'),
  ('gp07-project-b','gp07-tenant-b','roles','custom',1,true,'{"id":"custom"}','operator','2026-10-03T00:00:00Z');
insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at) values
  ('gp07-project-a','gp07-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','counsel','replace',1,'{"id":"counsel"}','operator','2026-10-03T00:00:00Z');

select throws_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('gp07-project-a','gp07-tenant-b','roles','cross',1,true,'{"id":"cross"}','operator','2026-10-03T00:00:00Z')$$,
  '23503', null, 'composite ownership FK blocks cross-tenant project-owned rows');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp07-project-a','gp07-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','counsel','replace',1,'{"id":"counsel"}','operator','2026-10-03T00:00:00Z')$$,
  '23505', null, 'duplicate exact override target is rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp07-project-a','gp07-tenant-a','org.example.legal','invalid','sha256:' || repeat('a',64),'roles','other','replace',1,'{"id":"other"}','operator','2026-10-03T00:00:00Z')$$,
  '23514', null, 'malformed exact version fails');

set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;
select is((select count(*)::integer from core.project_definition_head), 1, 'tenant A sees only its head');
select is((select count(*)::integer from core.project_owned_definition), 1, 'tenant A sees only its owned definition');
select is((select count(*)::integer from core.project_definition_override), 1, 'tenant A sees only its override');
with changed as (update core.project_definition_head set revision=9 where project_id='gp07-project-b' returning project_id)
select is((select count(*)::integer from changed), 0, 'tenant A cannot change B head');
with removed as (delete from core.project_owned_definition where project_id='gp07-project-b' returning local_id)
select is((select count(*)::integer from removed), 0, 'tenant A cannot delete B definition');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp07-project-b','gp07-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('b',64),'roles','other','replace',1,'{"id":"other"}','operator','2026-10-03T00:00:00Z')$$,
  '42501', null, 'tenant A cannot insert B override');
select * from finish();
rollback;
