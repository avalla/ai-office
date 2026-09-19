begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;

select * from no_plan();

insert into core.tenant(id, name, created_at, updated_at)
values ('pgtap-project-tenant', 'Project Tenant', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.project(id, name, tenant_id, created_at, updated_at)
values
  ('pgtap-project-a', 'Project A', 'pgtap-project-tenant', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('pgtap-project-b', 'Project B', 'pgtap-project-tenant', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.task(
  id, project_id, title, status, priority, created_at, updated_at
) values (
  'pgtap-task-a', 'pgtap-project-a', 'Task A', 'pending', 0,
  '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'
);

insert into core.requirement(
  id, project_id, requirement_key, title, description, status, created_at, updated_at
) values
  (
    'pgtap-req-a', 'pgtap-project-a', 'REQ-A', 'Requirement A', 'A', 'proposed',
    '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'
  ),
  (
    'pgtap-req-b', 'pgtap-project-b', 'REQ-B', 'Requirement B', 'B', 'proposed',
    '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'
  );

select throws_ok(
  $$
    insert into core.requirement(
      id, project_id, requirement_key, title, description, status, created_at, updated_at
    ) values (
      'pgtap-req-a-duplicate', 'pgtap-project-a', 'REQ-A', 'Duplicate', 'Duplicate',
      'proposed', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'
    )
  $$,
  '23505',
  null,
  'duplicate requirement keys are rejected within one project'
);

select lives_ok(
  $$
    insert into core.task_requirement(project_id, task_id, requirement_id, created_at)
    values ('pgtap-project-a', 'pgtap-task-a', 'pgtap-req-a', '2026-09-19T00:00:00Z')
  $$,
  'same-project task/requirement linkage is accepted'
);

select throws_ok(
  $$
    insert into core.task_requirement(project_id, task_id, requirement_id, created_at)
    values ('pgtap-project-a', 'pgtap-task-a', 'pgtap-req-b', '2026-09-19T00:00:00Z')
  $$,
  '23503',
  null,
  'task/requirement linkage cannot cross project ownership'
);

select is(
  (select count(*)::bigint from core.task_requirement),
  1::bigint,
  'only the valid task/requirement link was persisted'
);

select * from finish();
rollback;
