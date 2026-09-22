begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;

select * from no_plan();

insert into core.tenant(id, name, created_at, updated_at)
values ('pipeline-integrity-tenant', 'Pipeline Integrity Tenant', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.project(id, name, tenant_id, created_at, updated_at)
values ('pipeline-integrity-project', 'Pipeline Integrity', 'pipeline-integrity-tenant', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.task(id, project_id, title, status, priority, created_at, updated_at)
select task_id, 'pipeline-integrity-project', task_id, 'pending', 0,
       '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
from unnest(ARRAY[
  'task-active', 'task-completed', 'task-cancelled', 'task-completed-cancel',
  'task-stage-completed', 'task-stage-cancelled', 'task-stage-awaiting',
  'task-stage-active', 'task-assignment', 'task-approval', 'task-legacy'
]) AS task_id;

insert into core.role(
  id, project_id, role_key, name, version, capabilities_json, tools_json,
  model_policy, limits_json, source_path, guidance_text, guidance_version,
  created_at, updated_at
)
values
  ('pipeline-integrity-role', 'pipeline-integrity-project', 'developer', 'Developer',
   1, '[]', '[]', 'default',
   '{"maxIterations":1,"maxCostMicros":"0","timeoutSeconds":60}',
   'test', '', 1, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.agent(
  id, project_id, role_id, name, enabled, created_at, updated_at
)
values
  ('pipeline-integrity-agent-1', 'pipeline-integrity-project',
   'pipeline-integrity-role', 'Agent 1', true,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('pipeline-integrity-agent-2', 'pipeline-integrity-project',
   'pipeline-integrity-role', 'Agent 2', true,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.office_manifest_revision(
  id, project_id, revision, schema_version, manifest_json,
  source_host, source_skill, source_skill_version, applied_at
)
values (
  'pipeline-integrity-manifest-1', 'pipeline-integrity-project', 1, 1,
  jsonb_build_object(
    'schemaVersion', 1,
    'provenance', jsonb_build_object(
      'host', 'codex', 'skill', 'ai-office', 'skillVersion', '1'
    )
  ),
  'codex', 'ai-office', '1', '2026-09-22T00:00:00Z'
);

insert into core.pipeline_run(
  id, project_id, task_id, manifest_revision_id, manifest_revision,
  definition_json, status, current_stage_index, started_by, version,
  created_at, updated_at, completed_at, cancelled_at
)
values
  ('run-active', 'pipeline-integrity-project', 'task-active',
   'pipeline-integrity-manifest-1', 1, '{}', 'active', 0, 'runtime', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', null, null),
  ('run-completed', 'pipeline-integrity-project', 'task-completed',
   'pipeline-integrity-manifest-1', 1, '{}', 'completed', 0, 'runtime', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z',
   '2026-09-22T00:00:01Z', null),
  ('run-cancelled', 'pipeline-integrity-project', 'task-cancelled',
   'pipeline-integrity-manifest-1', 1, '{}', 'cancelled', 0, 'runtime', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z',
   null, '2026-09-22T00:00:01Z'),
  ('run-completed-cancel', 'pipeline-integrity-project', 'task-completed-cancel',
   'pipeline-integrity-manifest-1', 1, '{}', 'completed', 0, 'runtime', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z',
   '2026-09-22T00:00:01Z', null),
  ('run-stage-completed', 'pipeline-integrity-project', 'task-stage-completed',
   'pipeline-integrity-manifest-1', 1, '{}', 'active', 0, 'runtime', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', null, null),
  ('run-stage-cancelled', 'pipeline-integrity-project', 'task-stage-cancelled',
   'pipeline-integrity-manifest-1', 1, '{}', 'active', 0, 'runtime', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', null, null),
  ('run-stage-awaiting', 'pipeline-integrity-project', 'task-stage-awaiting',
   'pipeline-integrity-manifest-1', 1, '{}', 'active', 0, 'runtime', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', null, null),
  ('run-stage-active', 'pipeline-integrity-project', 'task-stage-active',
   'pipeline-integrity-manifest-1', 1, '{}', 'active', 0, 'runtime', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', null, null),
  ('run-assignment', 'pipeline-integrity-project', 'task-assignment',
   'pipeline-integrity-manifest-1', 1, '{}', 'active', 0, 'runtime', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', null, null),
  ('run-approval', 'pipeline-integrity-project', 'task-approval',
   'pipeline-integrity-manifest-1', 1, '{}', 'active', 0, 'runtime', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z', null, null);

insert into core.pipeline_stage_run(
  id, pipeline_run_id, project_id, stage_id, stage_index, role_id, status,
  assigned_agent_id, assigned_at, completed_at,
  approved_by, approval_decision, approval_rationale, approved_at
)
values
  ('stage-completed', 'run-stage-completed', 'pipeline-integrity-project',
   'build', 0, 'developer', 'completed', null, null,
   '2026-09-22T00:00:01Z', null, null, null, null),
  ('stage-cancelled', 'run-stage-cancelled', 'pipeline-integrity-project',
   'build', 0, 'developer', 'cancelled', null, null, null, null, null, null, null),
  ('stage-awaiting', 'run-stage-awaiting', 'pipeline-integrity-project',
   'build', 0, 'developer', 'awaiting_approval', null, null, null, null, null, null, null),
  ('stage-active', 'run-stage-active', 'pipeline-integrity-project',
   'build', 0, 'developer', 'active', null, null, null, null, null, null, null),
  ('stage-assignment', 'run-assignment', 'pipeline-integrity-project',
   'build', 0, 'developer', 'active', null, null, null, null, null, null, null),
  ('stage-approval', 'run-approval', 'pipeline-integrity-project',
   'build', 0, 'developer', 'awaiting_approval', null, null, null, null, null, null, null);

select throws_ok(
  $$ update core.pipeline_run
     set status = 'active', version = 2, updated_at = '2026-09-22T00:00:02Z',
         completed_at = null
     where id = 'run-completed' $$,
  '55000', null, 'completed pipeline cannot become active'
);

select throws_ok(
  $$ update core.pipeline_run
     set status = 'active', version = 2, updated_at = '2026-09-22T00:00:02Z',
         cancelled_at = null
     where id = 'run-cancelled' $$,
  '55000', null, 'cancelled pipeline cannot become active'
);

select throws_ok(
  $$ update core.pipeline_run
     set status = 'cancelled', version = 2, updated_at = '2026-09-22T00:00:02Z',
         completed_at = null, cancelled_at = '2026-09-22T00:00:02Z'
     where id = 'run-completed-cancel' $$,
  '55000', null, 'completed pipeline cannot become cancelled'
);

select throws_ok(
  $$ update core.pipeline_stage_run
     set status = 'active', completed_at = null
     where id = 'stage-completed' $$,
  '55000', null, 'completed stage cannot become active'
);

select throws_ok(
  $$ update core.pipeline_stage_run
     set status = 'active'
     where id = 'stage-cancelled' $$,
  '55000', null, 'cancelled stage cannot become active'
);

select throws_ok(
  $$ update core.pipeline_stage_run
     set status = 'pending'
     where id = 'stage-awaiting' $$,
  '55000', null, 'awaiting stage cannot become pending'
);

select throws_ok(
  $$ update core.pipeline_stage_run
     set status = 'pending'
     where id = 'stage-active' $$,
  '55000', null, 'active stage cannot become pending'
);

select lives_ok(
  $$ update core.pipeline_stage_run
     set assigned_agent_id = 'pipeline-integrity-agent-1',
         assigned_at = '2026-09-22T00:00:01Z'
     where id = 'stage-assignment' $$,
  'first stage assignment is allowed'
);

select throws_ok(
  $$ update core.pipeline_stage_run
     set assigned_agent_id = 'pipeline-integrity-agent-2',
         assigned_at = '2026-09-22T00:00:02Z'
     where id = 'stage-assignment' $$,
  '55000', null, 'stage assignment cannot be replaced'
);

select throws_ok(
  $$ update core.pipeline_stage_run
     set assigned_agent_id = null, assigned_at = null
     where id = 'stage-assignment' $$,
  '55000', null, 'stage assignment cannot be removed'
);

select throws_ok(
  $$ update core.pipeline_stage_run
     set assigned_at = '2026-09-22T00:00:02Z'
     where id = 'stage-assignment' $$,
  '55000', null, 'stage assignment timestamp cannot be rewritten'
);

select lives_ok(
  $$ update core.pipeline_stage_run
     set status = 'completed', completed_at = '2026-09-22T00:00:01Z',
         approved_by = 'reviewer', approval_decision = 'approved',
         approval_rationale = 'Looks good', approved_at = '2026-09-22T00:00:01Z'
     where id = 'stage-approval' $$,
  'first stage approval is allowed'
);

select throws_ok(
  $$ update core.pipeline_stage_run
     set approved_by = 'replacement'
     where id = 'stage-approval' $$,
  '55000', null, 'approval actor cannot be replaced'
);

select throws_ok(
  $$ update core.pipeline_stage_run
     set approval_decision = 'rejected'
     where id = 'stage-approval' $$,
  '55000', null, 'approval decision cannot be replaced'
);

select throws_ok(
  $$ update core.pipeline_stage_run
     set approved_by = null, approval_decision = null,
         approval_rationale = null, approved_at = null
     where id = 'stage-approval' $$,
  '55000', null, 'approval cannot be removed'
);

select throws_ok(
  $$ insert into core.pipeline_run(
       id, project_id, task_id, manifest_revision_id, manifest_revision,
       definition_json, status, current_stage_index, started_by, version,
       created_at, updated_at
     ) values (
       'run-manifest-mismatch', 'pipeline-integrity-project', 'task-legacy',
       'pipeline-integrity-manifest-1', 2, '{}', 'active', 0, 'runtime', 1,
       '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
     ) $$,
  '23503', null, 'manifest revision tuple cannot be forged'
);

insert into core.pipeline_run(
  id, project_id, task_id, status, current_stage_index, version,
  created_at, updated_at
)
values (
  'legacy-run', 'pipeline-integrity-project', 'task-legacy', 'active', 0, 1,
  '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
);

insert into core.pipeline_stage_run(
  id, pipeline_run_id, project_id, stage_id, stage_index, role_id,
  status, assigned_agent_id
)
values (
  'legacy-stage', 'legacy-run', 'pipeline-integrity-project',
  'build', 0, 'developer', 'active', 'pipeline-integrity-agent-1'
);

select lives_ok(
  $$ update core.pipeline_run
     set current_stage_index = 1, version = 2, updated_at = '2026-09-22T00:00:01Z'
     where id = 'legacy-run' $$,
  'legacy pipeline projection remains writable for worker fences'
);

select lives_ok(
  $$ update core.pipeline_stage_run
     set assigned_agent_id = null
     where id = 'legacy-stage' $$,
  'legacy stage projection remains writable without authoritative fields'
);

select is(
  (select version from core.pipeline_run where id = 'legacy-run'),
  2::integer,
  'legacy pipeline projection update persisted'
);

select * from finish();
rollback;
