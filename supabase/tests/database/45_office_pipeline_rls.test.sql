begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;

select * from no_plan();

insert into core.tenant(id, name, created_at, updated_at)
values
  ('office-pipeline-rls-tenant-a', 'Office Pipeline Tenant A', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('office-pipeline-rls-tenant-b', 'Office Pipeline Tenant B', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.tenant_member(tenant_id, user_id, role, created_at)
values
  ('office-pipeline-rls-tenant-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner', '2026-09-22T00:00:00Z'),
  ('office-pipeline-rls-tenant-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner', '2026-09-22T00:00:00Z');

insert into core.project(id, name, tenant_id, created_at, updated_at)
values
  ('office-pipeline-rls-project-a', 'Office Pipeline A', 'office-pipeline-rls-tenant-a', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('office-pipeline-rls-project-b', 'Office Pipeline B', 'office-pipeline-rls-tenant-b', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.task(id, project_id, title, status, priority, created_at, updated_at)
values
  ('office-pipeline-rls-task-a', 'office-pipeline-rls-project-a', 'Task A', 'pending', 0, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('office-pipeline-rls-task-b', 'office-pipeline-rls-project-b', 'Task B', 'pending', 0, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.office_manifest_revision(
  id, project_id, revision, schema_version, manifest_json,
  source_host, source_skill, source_skill_version, applied_at
)
values
  ('office-pipeline-rls-manifest-a', 'office-pipeline-rls-project-a', 1, 1,
   jsonb_build_object(
     'schemaVersion', 1,
     'provenance', jsonb_build_object('host', 'codex', 'skill', 'ai-office', 'skillVersion', '1'),
     'project', jsonb_build_object('mission', 'm', 'goals', jsonb_build_array('g'), 'constraints', '[]'::jsonb, 'preferences', '[]'::jsonb, 'permissionPreferences', '[]'::jsonb),
     'office', jsonb_build_object('name', 'o', 'roles', jsonb_build_array()),
     'pipelines', jsonb_build_array()
   ),
   'codex', 'ai-office', '1', '2026-09-22T00:00:00Z'),
  ('office-pipeline-rls-manifest-b', 'office-pipeline-rls-project-b', 1, 1,
   jsonb_build_object(
     'schemaVersion', 1,
     'provenance', jsonb_build_object('host', 'codex', 'skill', 'ai-office', 'skillVersion', '1'),
     'project', jsonb_build_object('mission', 'm', 'goals', jsonb_build_array('g'), 'constraints', '[]'::jsonb, 'preferences', '[]'::jsonb, 'permissionPreferences', '[]'::jsonb),
     'office', jsonb_build_object('name', 'o', 'roles', jsonb_build_array()),
     'pipelines', jsonb_build_array()
   ),
   'codex', 'ai-office', '1', '2026-09-22T00:00:00Z');

insert into core.pipeline_run(
  id, project_id, task_id, manifest_revision_id, manifest_revision,
  definition_json, status, current_stage_index, started_by, version,
  created_at, updated_at
)
values
  ('office-pipeline-rls-run-a', 'office-pipeline-rls-project-a', 'office-pipeline-rls-task-a',
   'office-pipeline-rls-manifest-a', 1,
   '{"id":"delivery","name":"Delivery","description":"d","defaultFor":["feature"],"stages":[{"id":"build","name":"Build","roleId":"developer","objective":"Build","checks":[],"requiresApproval":false}]}',
   'active', 0, 'runtime', 1, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('office-pipeline-rls-run-b', 'office-pipeline-rls-project-b', 'office-pipeline-rls-task-b',
   'office-pipeline-rls-manifest-b', 1,
   '{"id":"delivery","name":"Delivery","description":"d","defaultFor":["feature"],"stages":[{"id":"build","name":"Build","roleId":"developer","objective":"Build","checks":[],"requiresApproval":false}]}',
   'active', 0, 'runtime', 1, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.pipeline_stage_run(
  id, pipeline_run_id, project_id, stage_id, stage_index, role_id, status
)
values
  ('office-pipeline-rls-stage-a', 'office-pipeline-rls-run-a', 'office-pipeline-rls-project-a', 'build', 0, 'developer', 'active'),
  ('office-pipeline-rls-stage-b', 'office-pipeline-rls-run-b', 'office-pipeline-rls-project-b', 'build', 0, 'developer', 'active');

insert into core.pipeline_override(
  id, project_id, pipeline_run_id, stage_run_id, actor_id, reason,
  previous_rule, resulting_authorization, created_at
)
values
  ('office-pipeline-rls-override-a', 'office-pipeline-rls-project-a',
   'office-pipeline-rls-run-a', 'office-pipeline-rls-stage-a', 'runtime',
   'test', 'rule', 'stage_completed', '2026-09-22T00:00:00Z');

select ok(has_table_privilege('authenticated', 'core.office_manifest_revision', 'SELECT'), 'authenticated can read manifest revisions');
select ok(not has_table_privilege('authenticated', 'core.office_manifest_revision', 'INSERT'), 'authenticated cannot insert manifest revisions');
select ok(has_table_privilege('authenticated', 'core.pipeline_run', 'SELECT'), 'authenticated can read pipeline runs');
select ok(not has_table_privilege('authenticated', 'core.pipeline_run', 'UPDATE'), 'authenticated cannot update pipeline runs');
select ok(has_table_privilege('authenticated', 'core.pipeline_override', 'SELECT'), 'authenticated can read pipeline overrides');
select ok(not has_table_privilege('authenticated', 'core.pipeline_override', 'INSERT'), 'authenticated cannot append overrides');

set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;

select is((select count(*)::integer from core.office_manifest_revision), 1, 'tenant A sees only tenant A manifest revisions');
select is((select count(*)::integer from core.pipeline_run), 1, 'tenant A sees only tenant A pipeline runs');
select is((select count(*)::integer from core.pipeline_stage_run), 1, 'tenant A sees only tenant A stage runs');
select is((select count(*)::integer from core.pipeline_override), 1, 'tenant A sees only tenant A overrides');

select throws_ok(
  $$ insert into core.pipeline_run(
       id, project_id, task_id, manifest_revision_id, manifest_revision,
       definition_json, status, current_stage_index, started_by, version,
       created_at, updated_at
     ) values (
       'office-pipeline-rls-forged', 'office-pipeline-rls-project-a',
       'office-pipeline-rls-task-a', 'office-pipeline-rls-manifest-a', 1,
       '{"id":"delivery","name":"Delivery","description":"d","defaultFor":["feature"],"stages":[{"id":"build","name":"Build","roleId":"developer","objective":"Build","checks":[],"requiresApproval":false}]}',
       'active', 0, 'forged', 1, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
     ) $$,
  '42501', null, 'authenticated cannot mutate pipeline authority'
);

set local role postgres;

select throws_ok(
  $$ insert into core.pipeline_run(
       id, project_id, task_id, manifest_revision_id, manifest_revision,
       definition_json, status, current_stage_index, started_by, version,
       created_at, updated_at, completed_at
     ) values (
       'office-pipeline-rls-cross-run', 'office-pipeline-rls-project-a',
       'office-pipeline-rls-task-a', 'office-pipeline-rls-manifest-b', 1,
       '{"id":"delivery","name":"Delivery","description":"d","defaultFor":["feature"],"stages":[{"id":"build","name":"Build","roleId":"developer","objective":"Build","checks":[],"requiresApproval":false}]}',
       'completed', 0, 'runtime', 1, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
     ) $$,
  '23503', null, 'cross-project manifest linkage is rejected'
);

select throws_ok(
  $$ insert into core.pipeline_override(
       id, project_id, pipeline_run_id, stage_run_id, actor_id, reason,
       previous_rule, resulting_authorization, created_at
     ) values (
       'office-pipeline-rls-cross-override', 'office-pipeline-rls-project-a',
       'office-pipeline-rls-run-a', 'office-pipeline-rls-stage-b', 'runtime',
       'test', 'rule', 'stage_completed', '2026-09-22T00:00:00Z'
     ) $$,
  '23503', null, 'cross-project override linkage is rejected'
);

select throws_ok(
  $$ update core.office_manifest_revision
     set project_id = 'office-pipeline-rls-project-b'
     where id = 'office-pipeline-rls-manifest-a' $$,
  '55000', null, 'manifest ownership is immutable'
);

select throws_ok(
  $$ update core.pipeline_run
     set project_id = 'office-pipeline-rls-project-b'
     where id = 'office-pipeline-rls-run-a' $$,
  '55000', null, 'pipeline ownership is immutable'
);

select throws_ok(
  $$ update core.pipeline_override
     set project_id = 'office-pipeline-rls-project-b'
     where id = 'office-pipeline-rls-override-a' $$,
  '55000', null, 'override ownership is append-only'
);

select * from finish();
rollback;
