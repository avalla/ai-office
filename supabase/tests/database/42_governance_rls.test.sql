begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;

select * from no_plan();

insert into core.tenant(id, name, created_at, updated_at)
values
  ('governance-tenant-a', 'Tenant A', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('governance-tenant-b', 'Tenant B', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.tenant_member(tenant_id, user_id, role, created_at)
values
  ('governance-tenant-a', '11111111-1111-1111-1111-111111111111', 'owner', '2026-09-19T00:00:00Z'),
  ('governance-tenant-b', '22222222-2222-2222-2222-222222222222', 'owner', '2026-09-19T00:00:00Z');

insert into core.project(id, name, tenant_id, created_at, updated_at)
values
  ('governance-project-a', 'Project A', 'governance-tenant-a', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('governance-project-b', 'Project B', 'governance-tenant-b', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.task(id, project_id, title, status, priority, created_at, updated_at)
values
  ('governance-task-a', 'governance-project-a', 'Task A', 'pending', 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('governance-task-b', 'governance-project-b', 'Task B', 'pending', 0, '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.milestone(id, project_id, title, status, created_at, updated_at)
values
  ('governance-milestone-a', 'governance-project-a', 'Milestone A', 'planned', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('governance-milestone-b', 'governance-project-b', 'Milestone B', 'planned', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.requirement(id, project_id, requirement_key, title, description, status, created_at, updated_at)
values
  ('governance-requirement-a', 'governance-project-a', 'REQ-A', 'Requirement A', 'A', 'proposed', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('governance-requirement-b', 'governance-project-b', 'REQ-B', 'Requirement B', 'B', 'proposed', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.architecture_decision(id, project_id, title, context, decision, consequences, status, created_at, updated_at)
values
  ('governance-adr-a', 'governance-project-a', 'ADR A', 'Context', 'Decision', 'Consequences', 'proposed', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('governance-adr-b', 'governance-project-b', 'ADR B', 'Context', 'Decision', 'Consequences', 'proposed', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.agent_run(id, project_id)
values ('governance-agent-a', 'governance-project-a'), ('governance-agent-b', 'governance-project-b');

insert into core.review(id, project_id, subject_type, subject_id, reviewer_actor_type, reviewer_actor_id, status, created_at)
values
  ('governance-review-a', 'governance-project-a', 'task', 'governance-task-a', 'user', 'reviewer-a', 'pending', '2026-09-19T00:00:00Z'),
  ('governance-review-b', 'governance-project-b', 'task', 'governance-task-b', 'user', 'reviewer-b', 'pending', '2026-09-19T00:00:00Z');

insert into core.approval(id, project_id, review_id, decision, actor_type, actor_id, created_at)
values
  ('governance-approval-a', 'governance-project-a', 'governance-review-a', 'approved', 'user', 'approver-a', '2026-09-19T00:00:00Z'),
  ('governance-approval-b', 'governance-project-b', 'governance-review-b', 'approved', 'user', 'approver-b', '2026-09-19T00:00:00Z');

insert into core.governance_event(id, project_id, event_type, aggregate_id, metadata_json, occurred_at)
values
  ('governance-event-a', 'governance-project-a', 'review.decided', 'governance-review-a', '{}', '2026-09-19T00:00:00Z'),
  ('governance-event-b', 'governance-project-b', 'review.decided', 'governance-review-b', '{}', '2026-09-19T00:00:00Z');

set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set local role authenticated;

select is((select count(*)::integer from core.task), 1, 'member sees only own-tenant tasks');
select is((select count(*)::integer from core.milestone), 1, 'member sees only own-tenant milestones');
select is((select count(*)::integer from core.requirement), 1, 'member sees only own-tenant requirements');
select is((select count(*)::integer from core.architecture_decision), 1, 'member sees only own-tenant ADRs');
select is((select count(*)::integer from core.agent_run), 1, 'agent_run projection is tenant-isolated');
select is((select count(*)::integer from core.review), 1, 'member sees only own-tenant reviews');
select is((select count(*)::integer from core.approval), 1, 'member sees only own-tenant approvals');
select is((select count(*)::integer from core.governance_event), 1, 'member sees only own-tenant governance events');

select lives_ok(
  $$ insert into core.milestone(id, project_id, title, status, created_at, updated_at)
     values ('governance-milestone-b-new', 'governance-project-b', 'New milestone', 'planned', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  'authenticated user can insert an own-project governance row'
);
select throws_ok(
  $$ insert into core.milestone(id, project_id, title, status, created_at, updated_at)
     values ('governance-milestone-a-new', 'governance-project-a', 'Foreign milestone', 'planned', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'authenticated user cannot insert a foreign-project governance row'
);
select lives_ok(
  $$ update core.milestone set title = 'Milestone B renamed' where id = 'governance-milestone-b' $$,
  'authenticated user can update an own-project governance row'
);
update core.milestone set title = 'Milestone A changed' where id = 'governance-milestone-a';
set local role postgres;
select is((select title from core.milestone where id = 'governance-milestone-a'), 'Milestone A', 'foreign governance row is not updated');
set local role authenticated;
select lives_ok($$ delete from core.milestone where id = 'governance-milestone-b-new' $$, 'authenticated user can delete an own-project governance row');
set local role postgres;
select is((select count(*)::integer from core.milestone where id = 'governance-milestone-a'), 1, 'foreign governance row is not deleted');
set local role authenticated;

select lives_ok(
  $$ insert into core.architecture_decision(id, project_id, title, context, decision, consequences, status, created_at, updated_at)
     values ('governance-adr-b-new', 'governance-project-b', 'New ADR', 'Context', 'Decision', 'Consequences', 'proposed', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  'authenticated user can insert an own-project ADR'
);
select throws_ok(
  $$ insert into core.architecture_decision(id, project_id, title, context, decision, consequences, status, created_at, updated_at)
     values ('governance-adr-a-new', 'governance-project-a', 'Foreign ADR', 'Context', 'Decision', 'Consequences', 'proposed', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'authenticated user cannot insert a foreign-project ADR'
);

select lives_ok(
  $$ insert into core.review(id, project_id, subject_type, subject_id, reviewer_actor_type, reviewer_actor_id, status, created_at)
     values ('governance-review-b-new', 'governance-project-b', 'requirement', 'governance-requirement-b', 'user', 'reviewer-new', 'pending', '2026-09-19T00:00:00Z') $$,
  'authenticated user can insert an own-project review'
);
select lives_ok(
  $$ insert into core.approval(id, project_id, review_id, decision, actor_type, actor_id, created_at)
     values ('governance-approval-b-new', 'governance-project-b', 'governance-review-b-new', 'approved', 'user', 'approver-new', '2026-09-19T00:00:00Z') $$,
  'approval RLS permits own-project approval and its review finalization'
);
select lives_ok(
  $$ insert into core.governance_event(id, project_id, event_type, aggregate_id, metadata_json, occurred_at)
     values ('governance-event-b-new', 'governance-project-b', 'review.decided', 'governance-review-b-new', '{}', '2026-09-19T00:00:00Z') $$,
  'authenticated user can insert an own-project governance event'
);

set local role postgres;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select is((select count(*)::integer from core.task), 0, 'non-member sees no project-owned task rows');
select is((select count(*)::integer from core.review), 0, 'non-member sees no governance review rows');
select is((select count(*)::integer from core.governance_event), 0, 'non-member sees no governance events');
select throws_ok(
  $$ insert into core.requirement(id, project_id, requirement_key, title, description, status, created_at, updated_at)
     values ('governance-requirement-denied', 'governance-project-b', 'REQ-DENIED', 'Denied', 'Denied', 'proposed', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'non-member cannot insert project-owned rows'
);

select * from finish();
rollback;
