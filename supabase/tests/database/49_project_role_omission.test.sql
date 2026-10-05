begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;
select * from no_plan();

select ok((select relrowsecurity from pg_class where oid='core.project_definition_override'::regclass), 'overrides keep RLS after the role omission migration');
select is(
  (select count(*)::integer from pg_policies where schemaname='core' and tablename='project_definition_override'),
  4, 'override RLS policies are preserved');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%disable%' and pg_get_constraintdef(oid) like '%payload_json%'),
  1, 'exactly one operation/kind/payload constraint remains');
select has_pk('core', 'project_definition_override', 'override primary key is preserved');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='f'),
  1, 'tenant ownership foreign key is preserved');

insert into core.tenant(id, name, created_at, updated_at) values
  ('gp11-tenant-a', 'GP11 A', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z'),
  ('gp11-tenant-b', 'GP11 B', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z');
insert into core.tenant_member(tenant_id, user_id, role, created_at) values
  ('gp11-tenant-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner', '2026-10-05T00:00:00Z'),
  ('gp11-tenant-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner', '2026-10-05T00:00:00Z');
insert into core.project(id, name, tenant_id, created_at, updated_at) values
  ('gp11-project-a', 'GP11 A', 'gp11-tenant-a', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z'),
  ('gp11-project-b', 'GP11 B', 'gp11-tenant-b', '2026-10-05T00:00:00Z', '2026-10-05T00:00:00Z');
insert into core.project_definition_head(project_id, tenant_id) values
  ('gp11-project-a', 'gp11-tenant-a'), ('gp11-project-b', 'gp11-tenant-b');

select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp11-project-a','gp11-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','clerk','disable',1,null,'operator','2026-10-05T00:00:00Z'),
           ('gp11-project-b','gp11-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','clerk','disable',1,null,'operator','2026-10-05T00:00:00Z')$$,
  'a role omission is accepted');
select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp11-project-a','gp11-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'prompts','greeting','disable',1,null,'operator','2026-10-05T00:00:00Z')$$,
  'a prompt disable is still accepted');
select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp11-project-a','gp11-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','counsel','replace',1,'{"id":"counsel"}','operator','2026-10-05T00:00:00Z')$$,
  'a role replacement is still accepted');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp11-project-a','gp11-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'taskTypes','matter','disable',1,null,'operator','2026-10-05T00:00:00Z')$$,
  '23514', null, 'a disable on a task type is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp11-project-a','gp11-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'agents','drafter','disable',1,null,'operator','2026-10-05T00:00:00Z')$$,
  '23514', null, 'a disable on an agent is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp11-project-a','gp11-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','paralegal','disable',1,'{"id":"paralegal"}','operator','2026-10-05T00:00:00Z')$$,
  '23514', null, 'a role omission cannot carry a payload');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp11-project-a','gp11-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','paralegal','replace',1,null,'operator','2026-10-05T00:00:00Z')$$,
  '23514', null, 'a replacement still needs a payload');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp11-project-a','gp11-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','cross','disable',1,null,'operator','2026-10-05T00:00:00Z')$$,
  '23503', null, 'composite ownership FK still blocks a cross-tenant omission');

set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;
select is(
  (select count(*)::integer from core.project_definition_override where operation='disable' and kind='roles'),
  1, 'tenant A sees only its own role omission');
with removed as (delete from core.project_definition_override where project_id='gp11-project-b' returning local_id)
select is((select count(*)::integer from removed), 0, 'tenant A cannot delete B role omission');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp11-project-b','gp11-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('b',64),'roles','other','disable',1,null,'operator','2026-10-05T00:00:00Z')$$,
  '42501', null, 'tenant A cannot insert a role omission for B');
select * from finish();
rollback;
