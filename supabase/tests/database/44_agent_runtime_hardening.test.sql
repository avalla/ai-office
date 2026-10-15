begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;
select * from no_plan();

insert into core.tenant(id, name, created_at, updated_at)
values ('runtime-hardening-tenant', 'Runtime hardening', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');
insert into core.project(id, name, tenant_id, created_at, updated_at)
values ('runtime-hardening-project', 'Runtime hardening', 'runtime-hardening-tenant', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');
insert into core.task(id, project_id, title, status, priority, created_at, updated_at)
values ('runtime-hardening-task', 'runtime-hardening-project', 'Task', 'pending', 0, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');
insert into core.role(
  id, project_id, role_key, name, version, capabilities_json, tools_json,
  model_policy, limits_json, source_path, guidance_text, guidance_version,
  created_at, updated_at
) values (
  'runtime-hardening-role', 'runtime-hardening-project', 'hardening', 'Hardening',
  9007199254740991, '[]', '[]', 'mock',
  '{"maxIterations":9007199254740991,"maxCostMicros":"123456789012345678901234567890","timeoutSeconds":9007199254740991}',
  'hardening.yaml', repeat('A', 65536), 9007199254740991,
  '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
);
insert into core.agent(id, project_id, role_id, name, enabled, created_at, updated_at)
values ('runtime-hardening-agent', 'runtime-hardening-project', 'runtime-hardening-role', 'Hardening', true, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z');

select ok(exists (select 1 from core.role where id = 'runtime-hardening-role'), 'safe integer role and unbounded max cost are accepted');
select throws_ok($$
  insert into core.role(
    id, project_id, role_key, name, version, capabilities_json, tools_json, model_policy,
    limits_json, source_path, guidance_text, guidance_version, created_at, updated_at
  ) values (
    'runtime-hardening-role-overflow', 'runtime-hardening-project', 'overflow', 'Overflow',
    9007199254740992, '[]', '[]', 'mock',
    '{"maxIterations":1,"maxCostMicros":"0","timeoutSeconds":1}',
    'overflow.yaml', '', 1, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
  )
$$, '23514', null, 'role version rejects values outside Number.isSafeInteger domain');
select throws_ok($$
  insert into core.role(
    id, project_id, role_key, name, version, capabilities_json, tools_json, model_policy,
    limits_json, source_path, guidance_text, guidance_version, created_at, updated_at
  ) values (
    'runtime-hardening-guidance-overflow', 'runtime-hardening-project', 'guidance-overflow', 'Overflow',
    1, '[]', '[]', 'mock', '{"maxIterations":1,"maxCostMicros":"0","timeoutSeconds":1}',
    'overflow.yaml', repeat('é', 32769), 1, '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z'
  )
$$, '23514', null, 'guidance uses UTF-8 byte length');

insert into core.agent_run(id, project_id)
values ('runtime-hardening-identity', 'runtime-hardening-project');
select lives_ok($$
  insert into core.agent_run(id, project_id, status) values ('runtime-hardening-identity-ok', 'runtime-hardening-project', null)
$$, 'identity-only governance row remains compatible');
select throws_ok($$
  insert into core.agent_run(id, project_id, result_json) values ('runtime-hardening-identity-contaminated', 'runtime-hardening-project', '{}')
$$, '23514', null, 'identity-only row rejects runtime result state');
select throws_ok($$
  insert into core.agent_run(
    id, project_id, task_id, agent_id, status, created_at, updated_at, role_guidance_json
  ) values (
    'runtime-hardening-invalid-guidance', 'runtime-hardening-project', 'runtime-hardening-task',
    'runtime-hardening-agent', 'queued', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z',
    jsonb_build_object('version', 1, 'text', repeat('é', 32769))
  )
$$, '23514', null, 'run guidance uses UTF-8 byte length');
select throws_ok($$
  insert into core.agent_run(
    id, project_id, task_id, agent_id, status, created_at, updated_at, execution_json
  ) values (
    'runtime-hardening-invalid-execution', 'runtime-hardening-project', 'runtime-hardening-task',
    'runtime-hardening-agent', 'queued', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z',
    '{"kind":"simulation","adapterId":"sim","adapterVersion":"1","extra":true}'
  )
$$, '23514', null, 'execution provenance rejects unknown fields');

select throws_ok($$
  insert into core.agent_run(
    id, project_id, task_id, agent_id, status, created_at, updated_at, role_guidance_json
  ) values (
    'runtime-hardening-extra-guidance', 'runtime-hardening-project', 'runtime-hardening-task',
    'runtime-hardening-agent', 'queued', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z',
    '{"version":1,"text":"ok","extra":true}'
  )
$$, '23514', null, 'run guidance rejects unknown fields');
select throws_ok($$
  insert into core.agent_run(
    id, project_id, task_id, agent_id, status, created_at, updated_at, execution_json
  ) values (
    'runtime-hardening-null-input-hash', 'runtime-hardening-project', 'runtime-hardening-task',
    'runtime-hardening-agent', 'queued', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z',
    '{"kind":"simulation","adapterId":"sim","adapterVersion":"1","inputHash":null}'
  )
$$, '23514', null, 'execution provenance rejects null input hash');
select throws_ok($$
  insert into core.agent_run(
    id, project_id, task_id, agent_id, status, created_at, updated_at, model_routing_json
  ) values (
    'runtime-hardening-invalid-routing', 'runtime-hardening-project', 'runtime-hardening-task',
    'runtime-hardening-agent', 'queued', '2026-09-22T00:00:00Z', '2026-09-22T00:00:00Z',
    '{"status":"unrouted","extra":true}'
  )
$$, '23514', null, 'model routing rejects unknown fields');

select * from finish();
rollback;
