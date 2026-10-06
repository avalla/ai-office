begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;
select * from no_plan();

select ok((select relrowsecurity from pg_class where oid='core.project_definition_override'::regclass), 'overrides keep RLS after the agent disable migration');
select is(
  (select count(*)::integer from pg_policies where schemaname='core' and tablename='project_definition_override'),
  4, 'override RLS policies are preserved');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='c'
      and conname='project_definition_override_operation_kind_payload_check'),
  1, 'the disable constraint exists under its GP-11 name');
select ok(
  (select pg_get_constraintdef(oid) like '%agents%' from pg_constraint
    where conrelid='core.project_definition_override'::regclass
      and conname='project_definition_override_operation_kind_payload_check'),
  'the disable constraint admits agents');
select ok(
  (select pg_get_constraintdef(oid) like '%roles%' and pg_get_constraintdef(oid) like '%prompts%' from pg_constraint
    where conrelid='core.project_definition_override'::regclass
      and conname='project_definition_override_operation_kind_payload_check'),
  'the disable constraint still admits roles and prompts');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%disable%' and pg_get_constraintdef(oid) like '%payload_json%'),
  1, 'exactly one operation/kind/payload constraint remains');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='c'
      and conname='project_definition_override_operation_check'),
  1, 'the column check on operation is preserved');
select has_pk('core', 'project_definition_override', 'override primary key is preserved');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='f'),
  1, 'tenant ownership foreign key is preserved');

insert into core.tenant(id, name, created_at, updated_at) values
  ('gp12-tenant-a', 'GP12 A', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z'),
  ('gp12-tenant-b', 'GP12 B', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
insert into core.tenant_member(tenant_id, user_id, role, created_at) values
  ('gp12-tenant-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner', '2026-10-06T00:00:00Z'),
  ('gp12-tenant-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner', '2026-10-06T00:00:00Z');
insert into core.project(id, name, tenant_id, created_at, updated_at) values
  ('gp12-project-a', 'GP12 A', 'gp12-tenant-a', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z'),
  ('gp12-project-b', 'GP12 B', 'gp12-tenant-b', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
insert into core.project_definition_head(project_id, tenant_id) values
  ('gp12-project-a', 'gp12-tenant-a'), ('gp12-project-b', 'gp12-tenant-b');

select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'agents','drafter','disable',1,null,'operator','2026-10-06T00:00:00Z'),
           ('gp12-project-b','gp12-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('a',64),'agents','drafter','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  'an agent disable is accepted');
select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','clerk','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  'a role omission is still accepted');
select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'prompts','greeting','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  'a prompt disable is still accepted');
select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'agents','filer','replace',1,'{"id":"filer","role":"counsel","prompts":["brief"],"knowledge":["statutes"],"capabilities":["draft"]}','operator','2026-10-06T00:00:00Z')$$,
  'an agent replacement with reference fields is accepted');
select is(
  (select payload_json from core.project_definition_override where project_id='gp12-project-a' and kind='agents' and local_id='filer'),
  '{"id":"filer","role":"counsel","prompts":["brief"],"knowledge":["statutes"],"capabilities":["draft"]}'::jsonb,
  'the agent reference fields are stored unchanged');
select lives_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','agents','helper',1,true,'{"id":"helper","role":"auditor","prompts":["house"],"knowledge":["handbook"]}','operator','2026-10-06T00:00:00Z')$$,
  'a project-owned agent with reference fields is accepted');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'agents','researcher','merge',1,'{"id":"researcher"}','operator','2026-10-06T00:00:00Z')$$,
  '23514', 'new row for relation "project_definition_override" violates check constraint "project_definition_override_operation_check"',
  'an unknown operation is still rejected by the column check');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'taskTypes','matter','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', 'new row for relation "project_definition_override" violates check constraint "project_definition_override_operation_kind_payload_check"',
  'a disable on a task type is still rejected by the named constraint');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'knowledge','handbook','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a disable on a knowledge entry is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'artifactTypes','memo','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a disable on an artifact type is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'evidenceTypes','receipt','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a disable on an evidence type is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'agents','researcher','disable',1,'{"id":"researcher"}','operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'an agent disable cannot carry a payload');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'agents','researcher','replace',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a replacement still needs a payload');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-a','gp12-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('a',64),'agents','cross','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23503', null, 'composite ownership FK still blocks a cross-tenant agent disable');

set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;
select is(
  (select count(*)::integer from core.project_definition_override where operation='disable' and kind='agents'),
  1, 'tenant A sees only its own agent disable');
with removed as (delete from core.project_definition_override where project_id='gp12-project-b' returning local_id)
select is((select count(*)::integer from removed), 0, 'tenant A cannot delete B agent disable');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp12-project-b','gp12-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('b',64),'agents','other','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '42501', null, 'tenant A cannot insert an agent disable for B');
select * from finish();
rollback;
