begin;
create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;
select * from no_plan();

select col_type_is('core', 'project_owned_definition', 'payload_json', 'jsonb', 'owned payloads stay jsonb');
select col_not_null('core', 'project_owned_definition', 'payload_json', 'an owned payload stays mandatory');
select col_type_is('core', 'project_definition_override', 'payload_json', 'jsonb', 'override payloads stay jsonb');
select col_is_null('core', 'project_definition_override', 'payload_json', 'an override payload stays nullable for a disable');
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid='core.project_owned_definition'::regclass and conname='project_owned_definition_payload_json_check'),
  'CHECK ((jsonb_typeof(payload_json) = ''object''::text))',
  'an owned payload must be a jsonb object');
select is(
  (select pg_get_constraintdef(oid) from pg_constraint
    where conrelid='core.project_definition_override'::regclass and conname='project_definition_override_payload_json_check'),
  'CHECK (((payload_json IS NULL) OR (jsonb_typeof(payload_json) = ''object''::text)))',
  'an override payload must be SQL NULL or a jsonb object');
select is(
  (select array_agg(conname::text order by conname) from pg_constraint
    where conrelid='core.project_owned_definition'::regclass and contype='c'),
  array[
    'project_owned_definition_actor_id_check',
    'project_owned_definition_kind_check',
    'project_owned_definition_local_id_check',
    'project_owned_definition_payload_json_check',
    'project_owned_definition_revision_check'
  ], 'every earlier owned-definition check is preserved under its name');
select is(
  (select array_agg(conname::text order by conname) from pg_constraint
    where conrelid='core.project_definition_override'::regclass and contype='c'),
  array[
    'project_definition_override_actor_id_check',
    'project_definition_override_kind_check',
    'project_definition_override_local_id_check',
    'project_definition_override_manifest_digest_check',
    'project_definition_override_operation_check',
    'project_definition_override_operation_kind_payload_check',
    'project_definition_override_pack_id_check',
    'project_definition_override_pack_version_check',
    'project_definition_override_payload_json_check',
    'project_definition_override_revision_check'
  ], 'every earlier override check is preserved under its name');
select ok(
  (select pg_get_constraintdef(oid) like '%payload_json IS NULL%' and pg_get_constraintdef(oid) like '%payload_json IS NOT NULL%'
      and pg_get_constraintdef(oid) like '%workflows%' from pg_constraint
    where conrelid='core.project_definition_override'::regclass
      and conname='project_definition_override_operation_kind_payload_check'),
  'the operation/kind/payload rule still reasons about SQL NULL only');
select ok(
  (select pg_get_constraintdef(oid) like '%workflows%' and pg_get_constraintdef(oid) like '%taskTypes%' from pg_constraint
    where conrelid='core.project_definition_override'::regclass
      and conname='project_definition_override_kind_check'),
  'the override kind rule is unchanged');
select has_pk('core', 'project_owned_definition', 'owned primary key is preserved');
select has_pk('core', 'project_definition_override', 'override primary key is preserved');
select is(
  (select count(*)::integer from pg_constraint
    where conrelid in ('core.project_owned_definition'::regclass, 'core.project_definition_override'::regclass) and contype='f'),
  2, 'both tenant ownership foreign keys are preserved');
select ok(
  (select bool_and(relrowsecurity) from pg_class
    where oid in ('core.project_owned_definition'::regclass, 'core.project_definition_override'::regclass)),
  'both tables keep RLS');
select is(
  (select array_agg(tablename || ':' || policyname || ':' || cmd order by tablename, policyname) from pg_policies
    where schemaname='core' and tablename in ('project_owned_definition','project_definition_override')),
  array[
    'project_definition_override:project_definition_override_delete:DELETE',
    'project_definition_override:project_definition_override_insert:INSERT',
    'project_definition_override:project_definition_override_select:SELECT',
    'project_definition_override:project_definition_override_update:UPDATE',
    'project_owned_definition:project_owned_definition_delete:DELETE',
    'project_owned_definition:project_owned_definition_insert:INSERT',
    'project_owned_definition:project_owned_definition_select:SELECT',
    'project_owned_definition:project_owned_definition_update:UPDATE'
  ], 'the eight RLS policies are preserved');

insert into core.tenant(id, name, created_at, updated_at) values
  ('pgjsonb-tenant-a', 'Payload A', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z'),
  ('pgjsonb-tenant-b', 'Payload B', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
insert into core.tenant_member(tenant_id, user_id, role, created_at) values
  ('pgjsonb-tenant-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner', '2026-10-06T00:00:00Z'),
  ('pgjsonb-tenant-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner', '2026-10-06T00:00:00Z');
insert into core.project(id, name, tenant_id, created_at, updated_at) values
  ('pgjsonb-project-a', 'Payload A', 'pgjsonb-tenant-a', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z'),
  ('pgjsonb-project-b', 'Payload B', 'pgjsonb-tenant-b', '2026-10-06T00:00:00Z', '2026-10-06T00:00:00Z');
insert into core.project_definition_head(project_id, tenant_id) values
  ('pgjsonb-project-a', 'pgjsonb-tenant-a'), ('pgjsonb-project-b', 'pgjsonb-tenant-b');

select lives_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','roles','custom',1,true,'{"id":"custom","title":"Custom"}','operator','2026-10-06T00:00:00Z'),
           ('pgjsonb-project-a','pgjsonb-tenant-a','knowledge','empty',1,true,'{}','operator','2026-10-06T00:00:00Z'),
           ('pgjsonb-project-b','pgjsonb-tenant-b','roles','custom',1,true,'{"id":"custom","title":"Other"}','operator','2026-10-06T00:00:00Z')$$,
  'an owned definition with an object payload is accepted');
select lives_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','counsel','extend',1,'{"id":"counsel","title":"Ours"}','operator','2026-10-06T00:00:00Z'),
           ('pgjsonb-project-a','pgjsonb-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'workflows','review','replace',1,'{"id":"review","taskType":"matter","stages":[{"id":"z-last","role":"paralegal"},{"id":"a-first","role":"counsel"}]}','operator','2026-10-06T00:00:00Z'),
           ('pgjsonb-project-a','pgjsonb-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'prompts','greeting','disable',1,null,'operator','2026-10-06T00:00:00Z'),
           ('pgjsonb-project-b','pgjsonb-tenant-b','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','counsel','extend',1,'{"id":"counsel","title":"Theirs"}','operator','2026-10-06T00:00:00Z')$$,
  'object overrides and a disable with SQL NULL are accepted');
select is(
  (select payload_json->>'title' from core.project_owned_definition where project_id='pgjsonb-project-a' and local_id='custom'),
  'Custom', 'SQL reads a member of an owned payload');
select is(
  (select array_agg(stage->>'id' order by position) from core.project_definition_override,
      jsonb_array_elements(payload_json->'stages') with ordinality as stages(stage, position)
    where project_id='pgjsonb-project-a' and local_id='review'),
  array['z-last','a-first'], 'SQL reads the ordered stage list of an override payload');
select ok(
  (select payload_json is null from core.project_definition_override where project_id='pgjsonb-project-a' and local_id='greeting'),
  'a disable stores SQL NULL');

-- The legacy shape: JSON text held in a jsonb string scalar.
select throws_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','roles','legacy',1,true,to_jsonb('{"id":"legacy"}'::text),'operator','2026-10-06T00:00:00Z')$$,
  '23514', 'new row for relation "project_owned_definition" violates check constraint "project_owned_definition_payload_json_check"',
  'an owned payload stored as a jsonb string is rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','legacy','extend',1,to_jsonb('{"id":"legacy"}'::text),'operator','2026-10-06T00:00:00Z')$$,
  '23514', 'new row for relation "project_definition_override" violates check constraint "project_definition_override_payload_json_check"',
  'an override payload stored as a jsonb string is rejected');
select throws_ok(
  $$update core.project_owned_definition set payload_json = to_jsonb(payload_json::text) where project_id='pgjsonb-project-a' and local_id='custom'$$,
  '23514', null, 'an owned payload cannot be turned back into a jsonb string');
select throws_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','roles','array',1,true,'[{"id":"array"}]','operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'an owned array payload is rejected');
select throws_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','roles','json-null',1,true,'null','operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'an owned JSON null payload is rejected');
select throws_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','roles','sql-null',1,true,null,'operator','2026-10-06T00:00:00Z')$$,
  '23502', null, 'an owned SQL NULL payload is still rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','number','replace',1,'7','operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'an override number payload is rejected');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'prompts','json-null','disable',1,'null','operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'a disable cannot carry JSON null in place of SQL NULL');
select throws_ok(
  $$insert into core.project_definition_override(project_id,tenant_id,pack_id,pack_version,manifest_digest,kind,local_id,operation,revision,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','org.example.legal','1.0.0','sha256:' || repeat('a',64),'roles','missing','replace',1,null,'operator','2026-10-06T00:00:00Z')$$,
  '23514', 'new row for relation "project_definition_override" violates check constraint "project_definition_override_operation_kind_payload_check"',
  'a replacement without a payload is still rejected by the named constraint');
select throws_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','roles','nul',1,true,'{"id":"nul","title":"a\u0000b"}','operator','2026-10-06T00:00:00Z')$$,
  '22P05', 'unsupported Unicode escape sequence', 'a jsonb payload cannot hold U+0000');
select throws_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-b','roles','cross',1,true,'{"id":"cross"}','operator','2026-10-06T00:00:00Z')$$,
  '23503', null, 'composite ownership FK still blocks a cross-tenant owned definition');

set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;
select is(
  (select array_agg(payload_json->>'title' order by local_id) from core.project_owned_definition where local_id='custom'),
  array['Custom'], 'tenant A reads only its own owned payload');
select is(
  (select array_agg(payload_json->>'title' order by local_id) from core.project_definition_override where local_id='counsel'),
  array['Ours'], 'tenant A reads only its own override payload');
with changed as (update core.project_owned_definition set payload_json = '{"id":"custom","title":"Stolen"}' where project_id='pgjsonb-project-b' returning local_id)
select is((select count(*)::integer from changed), 0, 'tenant A cannot update B owned payload');
with changed as (update core.project_definition_override set payload_json = '{"id":"counsel","title":"Stolen"}' where project_id='pgjsonb-project-b' returning local_id)
select is((select count(*)::integer from changed), 0, 'tenant A cannot update B override payload');
select throws_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-b','pgjsonb-tenant-b','roles','foreign',1,true,'{"id":"foreign"}','operator','2026-10-06T00:00:00Z')$$,
  '42501', null, 'tenant A cannot insert an owned definition for B');
select throws_ok(
  $$insert into core.project_owned_definition(project_id,tenant_id,kind,local_id,revision,enabled,payload_json,actor_id,changed_at)
    values ('pgjsonb-project-a','pgjsonb-tenant-a','roles','member-legacy',1,true,to_jsonb('{"id":"member-legacy"}'::text),'operator','2026-10-06T00:00:00Z')$$,
  '23514', null, 'the object check also binds an authenticated member');
select * from finish();
rollback;
