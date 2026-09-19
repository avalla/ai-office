begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;

select * from no_plan();

insert into core.tenant(id, name, created_at, updated_at)
values
  ('project-tenant-a', 'Tenant A', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('project-tenant-b', 'Tenant B', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.tenant_member(tenant_id, user_id, role, created_at)
values
  ('project-tenant-a', '11111111-1111-1111-1111-111111111111', 'owner', '2026-09-19T00:00:00Z'),
  ('project-tenant-b', '11111111-1111-1111-1111-111111111111', 'member', '2026-09-19T00:00:00Z'),
  ('project-tenant-b', '22222222-2222-2222-2222-222222222222', 'owner', '2026-09-19T00:00:00Z');

insert into core.project(id, name, tenant_id, created_at, updated_at)
values
  ('project-a1', 'Project A1', 'project-tenant-a', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('project-a2', 'Project A2', 'project-tenant-a', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('project-b1', 'Project B1', 'project-tenant-b', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('project-null', 'Legacy project', null, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.task(id, project_id, title, status, priority, created_at, updated_at)
values
  ('task-a1', 'project-a1', 'Task A1', 'pending', 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('task-b1', 'project-b1', 'Task B1', 'pending', 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('task-null', 'project-null', 'Legacy task', 'pending', 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.requirement(id, project_id, requirement_key, title, description, status, created_at, updated_at)
values
  ('requirement-reparent', 'project-a1', 'REQ-REPARENT', 'Reparent', 'Reparent', 'proposed', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('requirement-b1', 'project-b1', 'REQ-B1', 'Requirement B1', 'B1', 'proposed', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.task_requirement(project_id, task_id, requirement_id, created_at)
values ('project-b1', 'task-b1', 'requirement-b1', '2026-09-19T00:00:00Z');

set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;

select is((select count(*)::integer from core.project), 3, 'user A sees assigned projects in both member tenants');
select is((select count(*)::integer from core.project where tenant_id is null), 0, 'NULL-tenant projects are invisible');
select is((select count(*)::integer from core.task), 2, 'user A sees project-owned rows in both member tenants');
select is((select count(*)::integer from core.task where project_id = 'project-null'), 0, 'NULL-tenant data is invisible');

select lives_ok(
  $$ insert into core.project(id, name, tenant_id, created_at, updated_at)
     values ('project-a-new', 'Project A new', 'project-tenant-a', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  'owner can create a project in the managed tenant'
);
select throws_ok(
  $$ insert into core.project(id, name, tenant_id, created_at, updated_at)
     values ('project-b-new', 'Project B new', 'project-tenant-b', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'member cannot create a project in a tenant'
);
select throws_ok(
  $$ insert into core.project(id, name, tenant_id, created_at, updated_at)
     values ('project-null-new', 'Legacy new', null, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'authenticated project creation cannot create a NULL-tenant project'
);

select lives_ok(
  $$ update core.project set name = 'Project A1 renamed' where id = 'project-a1' $$,
  'owner can update a managed project'
);
select is(
  (select count(*)::integer from core.project where id = 'project-b1' and name = 'Project B1'),
  1,
  'foreign project remains unchanged when member attempts update'
);
update core.project set name = 'Project B1 changed' where id = 'project-b1';
select is((select name from core.project where id = 'project-b1'), 'Project B1', 'foreign project update affects no visible row');

select lives_ok(
  $$ delete from core.project where id = 'project-a-new' $$,
  'owner can delete a managed project'
);
select is((select count(*)::integer from core.project where id = 'project-a-new'), 0, 'managed project was deleted');
delete from core.project where id = 'project-b1';
select is((select count(*)::integer from core.project where id = 'project-b1'), 1, 'member cannot delete a foreign project');

select lives_ok(
  $$ insert into core.task(id, project_id, title, status, priority, created_at, updated_at)
     values ('task-a-new', 'project-a1', 'Task A new', 'pending', 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  'member can insert a task in an accessible project'
);
select throws_ok(
  $$ insert into core.task(id, project_id, title, status, priority, created_at, updated_at)
     values ('task-cannot-insert', 'project-null', 'Task null', 'pending', 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'member cannot insert project-owned data into a NULL-tenant project'
);
select lives_ok(
  $$ update core.task set title = 'Task A1 renamed' where id = 'task-a1' $$,
  'member can update an accessible task'
);
set local role postgres;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set local role authenticated;
update core.task set title = 'Task A1 changed by foreign tenant' where id = 'task-a1';
set local role postgres;
select is((select title from core.task where id = 'task-a1'), 'Task A1 renamed', 'foreign tenant task update affects no row');
set local request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
set local role authenticated;
select lives_ok($$ delete from core.task where id = 'task-a-new' $$, 'member can delete an accessible task');

select throws_ok(
  $$ update core.task set project_id = 'project-b1' where id = 'task-a1' $$,
  '23514',
  'project-owned row cannot change tenant through project reassignment',
  'cross-tenant task reassignment fails even for a user who can access both tenants'
);
select lives_ok(
  $$ update core.task set project_id = 'project-a2' where id = 'task-a1' $$,
  'same-tenant task reparenting is not blocked by the tenant invariant'
);
select lives_ok(
  $$ update core.requirement set project_id = 'project-a2' where id = 'requirement-reparent' $$,
  'same-tenant requirement reparenting is not blocked by the tenant invariant'
);

select is(
  (select count(*)::integer
   from core.project as project
   join core.task as task on task.project_id = project.id),
  2,
  'joins return only rows visible through both RLS-protected relations'
);

set local role postgres;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set local role authenticated;
select is((select count(*)::integer from core.project), 1, 'user B sees only tenant B project');
select lives_ok(
  $$ insert into core.project(id, name, tenant_id, created_at, updated_at)
     values ('project-b-new', 'Project B new', 'project-tenant-b', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  'tenant B owner can create a project in tenant B'
);

select * from finish();
rollback;
