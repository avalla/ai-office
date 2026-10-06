begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;
select * from no_plan();

select ok((select relrowsecurity from pg_class where oid='core.project_definition_override'::regclass), 'overrides keep RLS after the workflow override migration');
select is(
  (select count(*)::integer from pg_policies where schemaname='core' and tablename='project_definition_override'),
  4, 'override RLS policies are preserved');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='c'
      and conname='project_definition_override_kind_check'),
  1, 'the kind constraint exists under its original name');
select ok(
  (select pg_get_constraintdef(oid) like '%workflows%' from pg_constraint
    where conrelid='core.project_definition_override'::regclass
      and conname='project_definition_override_kind_check'),
  'the kind constraint admits workflows');
select ok(
  (select bool_and(pg_get_constraintdef(oid) like '%' || kind || '%') from pg_constraint,
      unnest(array['roles','taskTypes','agents','artifactTypes','evidenceTypes','knowledge','prompts']) as kind
    where conrelid='core.project_definition_override'::regclass
      and conname='project_definition_override_kind_check'),
  'the kind constraint still admits every earlier kind');
select ok(
  (select not (pg_get_constraintdef(oid) like '%policies%' or pg_get_constraintdef(oid) like '%capabilities%' or pg_get_constraintdef(oid) like '%validators%') from pg_constraint
    where conrelid='core.project_definition_override'::regclass
      and conname='project_definition_override_kind_check'),
  'the kind constraint admits no kind without an override contract');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%taskTypes%'),
  1, 'exactly one kind constraint remains');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='c'
      and conname='project_definition_override_operation_kind_payload_check'),
  1, 'the disable constraint exists under its GP-11 name');
select ok(
  (select pg_get_constraintdef(oid) like '%workflows%' from pg_constraint
    where conrelid='core.project_definition_override'::regclass
      and conname='project_definition_override_operation_kind_payload_check'),
  'the disable constraint admits workflows');
select ok(
  (select pg_get_constraintdef(oid) like '%roles%' and pg_get_constraintdef(oid) like '%prompts%' and pg_get_constraintdef(oid) like '%agents%' from pg_constraint
    where conrelid='core.project_definition_override'::regclass
      and conname='project_definition_override_operation_kind_payload_check'),
  'the disable constraint still admits roles, prompts and agents');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='c'
      and pg_get_constraintdef(oid) like '%disable%' and pg_get_constraintdef(oid) like '%payload_json%'),
  1, 'exactly one operation/kind/payload constraint remains');
select is(
  (select array_agg(conname::text order by conname) from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='c'
      and conname not in ('project_definition_override_kind_check','project_definition_override_operation_kind_payload_check')),
  array[
    'project_definition_override_actor_id_check',
    'project_definition_override_local_id_check',
    'project_definition_override_manifest_digest_check',
    'project_definition_override_operation_check',
    'project_definition_override_pack_id_check',
    'project_definition_override_pack_version_check',
    'project_definition_override_revision_check'
  ], 'every other column check is preserved under its name');
select has_pk('core', 'project_definition_override', 'override primary key is preserved');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='f'),
  1, 'tenant ownership foreign key is preserved');

insert into core.tenant(id, name, created_at, updated_at) values
  ('gp13-tenant-a', 'GP13 A', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z'),
  ('gp13-tenant-b', 'GP13 B', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
insert into core.tenant_member(tenant_id, user_id, role, created_at) values
  ('gp13-tenant-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner', '2026-10-06T00:00:00Z'),
  ('gp13-tenant-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner', '2026-10-06T00:00:00Z');
insert into core.project(id, name, tenant_id, created_at, updated_at) values
  ('gp13-project-a', 'GP13 A', 'gp13-tenant-a', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z'),
  ('gp13-project-b', 'GP13 B', 'gp13-tenant-b', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
insert into core.project_definition_head(project_id, tenant_id) values
  ('gp13-project-a', 'gp13-tenant-a'), ('gp13-project-b', 'gp13-tenant-b');

select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','audit','disable',1,null,'operator','2026-10-06T00:00:00Z'),
           ('gp13-project-b','gp13-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','audit','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  'a workflow disable is accepted');
select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','intake','extend',1,'{"title":"Our intake"}','operator','2026-10-06T00:00:00Z')$$,
  'a workflow extension is accepted');
select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','review','replace',1,'{"id":"review","title":"Our review","taskType":"matter","stages":[{"id":"z-last","role":"paralegal"},{"id":"a-first","role":"counsel"},{"id":"m-middle","role":"auditor"}]}','operator','2026-10-06T00:00:00Z')$$,
  'a workflow replacement with its stage list is accepted');
select is(
  (select payload_json from core.project_definition_override where project_id='gp13-project-a' and kind='workflows' and local_id='review'),
  '{"id":"review","title":"Our review","taskType":"matter","stages":[{"id":"z-last","role":"paralegal"},{"id":"a-first","role":"counsel"},{"id":"m-middle","role":"auditor"}]}'::jsonb,
  'the workflow envelope is stored unchanged');
select is(
  (select array_agg(stage->>'id' order by position) from core.project_definition_override,
      jsonb_array_elements(payload_json->'stages') with ordinality as stages(stage, position)
    where project_id='gp13-project-a' and kind='workflows' and local_id='review'),
  array['z-last','a-first','m-middle'], 'the stage order is stored as given');
select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'agents','drafter','disable',1,null,'operator','2026-10-06T00:00:00Z'),
           ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','clerk','disable',1,null,'operator','2026-10-06T00:00:00Z'),
           ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'prompts','greeting','disable',1,null,'operator','2026-10-06T00:00:00Z'),
           ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'taskTypes','matter','replace',1,'{"id":"matter"}','operator','2026-10-06T00:00:00Z'),
           ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'knowledge','handbook','extend',1,'{"title":"Handbook"}','operator','2026-10-06T00:00:00Z')$$,
  'the earlier disable kinds and descriptive overrides are still accepted');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'policies','retention','replace',1,'{"id":"retention"}','operator','2026-10-06T00:00:00Z')$$,
  '23514', 'new row for relation "project_definition_override" violates check constraint "project_definition_override_kind_check"',
  'an override on a policy is still rejected by the kind constraint');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'capabilities','draft','extend',1,'{"title":"Draft"}','operator','2026-10-06T00:00:00Z')$$,
  '23514', 'new row for relation "project_definition_override" violates check constraint "project_definition_override_kind_check"',
  'an override on a capability is still rejected by the kind constraint');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'validators','citations','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'an override on a validator is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'pipelines','delivery','replace',1,'{"id":"delivery"}','operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'an unknown kind is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','merged','merge',1,'{"id":"merged"}','operator','2026-10-06T00:00:00Z')$$,
  '23514', 'new row for relation "project_definition_override" violates check constraint "project_definition_override_operation_check"',
  'an unknown operation is still rejected by the column check');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'taskTypes','filing','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', 'new row for relation "project_definition_override" violates check constraint "project_definition_override_operation_kind_payload_check"',
  'a disable on a task type is still rejected by the named constraint');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'knowledge','statutes','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a disable on a knowledge entry is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'artifactTypes','memo','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a disable on an artifact type is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'evidenceTypes','receipt','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a disable on an evidence type is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','archive','disable',1,'{"id":"archive"}','operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a workflow disable cannot carry a payload');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','archive','replace',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a workflow replacement still needs a payload');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','archive','extend',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a workflow extension still needs a payload');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','review','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23505', null, 'one override per exact workflow source');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-a','gp13-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','cross','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23503', null, 'composite ownership FK still blocks a cross-tenant workflow override');

set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;
select is(
  (select count(*)::integer from core.project_definition_override where kind='workflows'),
  3, 'tenant A sees only its own workflow overrides');
with removed as (delete from core.project_definition_override where project_id='gp13-project-b' returning local_id)
select is((select count(*)::integer from removed), 0, 'tenant A cannot delete B workflow override');
with changed as (update core.project_definition_override set revision = 2 where project_id='gp13-project-b' returning local_id)
select is((select count(*)::integer from changed), 0, 'tenant A cannot update B workflow override');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('gp13-project-b','gp13-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('b',64),'workflows','other','disable',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '42501', null, 'tenant A cannot insert a workflow override for B');
select * from finish();
rollback;
