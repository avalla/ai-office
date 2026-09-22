begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;

select * from no_plan();

insert into core.tenant(id, name, created_at, updated_at)
values
  ('runtime-rls-tenant-a', 'Runtime Tenant A', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('runtime-rls-tenant-b', 'Runtime Tenant B', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.tenant_member(tenant_id, user_id, role, created_at)
values
  ('runtime-rls-tenant-a', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'owner', '2026-09-22T00:00:00Z'),
  ('runtime-rls-tenant-b', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'owner', '2026-09-22T00:00:00Z');

insert into core.project(id, name, tenant_id, created_at, updated_at)
values
  ('runtime-rls-project-a', 'Runtime Project A', 'runtime-rls-tenant-a', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('runtime-rls-project-b', 'Runtime Project B', 'runtime-rls-tenant-b', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.task(id, project_id, title, status, priority, created_at, updated_at)
values
  ('runtime-rls-task-a', 'runtime-rls-project-a', 'Task A', 'pending', 0, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('runtime-rls-task-b', 'runtime-rls-project-b', 'Task B', 'pending', 0, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.role(
  id, project_id, role_key, name, version, capabilities_json, tools_json,
  model_policy, limits_json, source_path, guidance_text, guidance_version,
  created_at, updated_at
)
values
  ('runtime-rls-role-a', 'runtime-rls-project-a', 'developer', 'Developer', 1, '[]', '[]',
   'mock', '{"maxIterations":1,"maxCostMicros":"0","timeoutSeconds":1}', 'role.yaml', '', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('runtime-rls-role-b', 'runtime-rls-project-b', 'developer', 'Developer', 1, '[]', '[]',
   'mock', '{"maxIterations":1,"maxCostMicros":"0","timeoutSeconds":1}', 'role.yaml', '', 1,
   '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.agent(id, project_id, role_id, name, enabled, created_at, updated_at)
values
  ('runtime-rls-agent-a', 'runtime-rls-project-a', 'runtime-rls-role-a', 'Agent A', true, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'),
  ('runtime-rls-agent-b', 'runtime-rls-project-b', 'runtime-rls-role-b', 'Agent B', true, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

insert into core.agent_run(id, project_id)
values
  ('runtime-rls-run-a', 'runtime-rls-project-a'),
  ('runtime-rls-run-b', 'runtime-rls-project-b');

insert into core.agent_run_event(id, run_id, project_id, status, payload_json, occurred_at)
values
  ('runtime-rls-event-a', 'runtime-rls-run-a', 'runtime-rls-project-a', 'queued', '{}', '2026-09-22T00:00:00Z'),
  ('runtime-rls-event-b', 'runtime-rls-run-b', 'runtime-rls-project-b', 'queued', '{}', '2026-09-22T00:00:00Z');

insert into core.audit_event(
  id, project_id, event_type, actor_type, actor_id, aggregate_type,
  aggregate_id, payload_json, occurred_at
)
values
  ('runtime-rls-audit-a', 'runtime-rls-project-a', 'runtime.test', 'system', 'test', 'run',
   'runtime-rls-run-a', '{}', '2026-09-22T00:00:00Z'),
  ('runtime-rls-audit-b', 'runtime-rls-project-b', 'runtime.test', 'system', 'test', 'run',
   'runtime-rls-run-b', '{}', '2026-09-22T00:00:00Z'),
  ('runtime-rls-audit-host', null, 'runtime.host.test', 'system', 'test', null,
   null, '{}', '2026-09-22T00:00:00Z');

select ok(has_table_privilege('authenticated', 'core.role', 'SELECT'), 'authenticated can read role projections');
select ok(not has_table_privilege('authenticated', 'core.role', 'INSERT'), 'authenticated cannot insert roles');
select ok(not has_table_privilege('authenticated', 'core.agent', 'INSERT'), 'authenticated cannot insert agents');
select ok(not has_table_privilege('authenticated', 'core.agent_run_event', 'INSERT'), 'authenticated cannot insert run events');
select ok(not has_table_privilege('authenticated', 'core.task_lock', 'INSERT'), 'authenticated cannot insert task locks');
select ok(not has_table_privilege('authenticated', 'core.audit_event', 'INSERT'), 'authenticated cannot append audit events');

set local request.jwt.claim.sub = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
set local role authenticated;

select is((select count(*)::integer from core.role), 1, 'tenant A reads only tenant A roles');
select is((select count(*)::integer from core.agent), 1, 'tenant A reads only tenant A agents');
select is((select count(*)::integer from core.agent_run), 1, 'tenant A reads only tenant A runs');
select is((select count(*)::integer from core.agent_run_event), 1, 'tenant A reads only tenant A run events');
select is((select count(*)::integer from core.audit_event), 1, 'tenant A reads only tenant A audit events');
select is((select count(*)::integer from core.audit_event where project_id is null), 0, 'host-global audit is not exposed as project audit');

select throws_ok(
  $$ insert into core.role(
       id, project_id, role_key, name, version, capabilities_json, tools_json,
       model_policy, limits_json, source_path, guidance_text, guidance_version,
       created_at, updated_at
     ) values (
       'runtime-rls-role-forged', 'runtime-rls-project-a', 'forged', 'Forged', 1, '[]', '[]',
       'mock', '{"maxIterations":1,"maxCostMicros":"0","timeoutSeconds":1}', 'forged.yaml', '', 1,
       '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
     ) $$,
  '42501', null, 'authenticated cannot mutate runtime roles'
);
select throws_ok(
  $$ insert into core.audit_event(
       id, project_id, event_type, actor_type, payload_json, occurred_at
     ) values (
       'runtime-rls-audit-forged', 'runtime-rls-project-a', 'forged', 'system', '{}',
       '2026-09-22T00:00:00Z'
     ) $$,
  '42501', null, 'authenticated cannot append authoritative audit events'
);

set local role anon;
select throws_ok($$ select count(*) from core.role $$, '42501', null, 'anon cannot read runtime roles');
select throws_ok($$ select count(*) from core.agent_run_event $$, '42501', null, 'anon cannot read run events');
select throws_ok($$ select count(*) from core.audit_event $$, '42501', null, 'anon cannot read audit events');

set local role postgres;
select * from finish();
rollback;
