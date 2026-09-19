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
  ('governance-tenant-b', '22222222-2222-2222-2222-222222222222', 'owner', '2026-09-19T00:00:00Z'),
  ('governance-tenant-b', '33333333-3333-3333-3333-333333333333', 'admin', '2026-09-19T00:00:00Z'),
  ('governance-tenant-b', '44444444-4444-4444-4444-444444444444', 'member', '2026-09-19T00:00:00Z');

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

-- Catalog-level contract: visibility is SELECT-only for human clients.
select ok(has_table_privilege('authenticated', 'core.review', 'SELECT'), 'authenticated has SELECT on review');
select ok(not has_table_privilege('authenticated', 'core.review', 'INSERT'), 'authenticated has no INSERT on review');
select ok(not has_table_privilege('authenticated', 'core.review', 'UPDATE'), 'authenticated has no UPDATE on review');
select ok(not has_table_privilege('authenticated', 'core.review', 'DELETE'), 'authenticated has no DELETE on review');
select ok(has_table_privilege('authenticated', 'core.approval', 'SELECT'), 'authenticated has SELECT on approval');
select ok(not has_table_privilege('authenticated', 'core.approval', 'INSERT'), 'authenticated has no INSERT on approval');
select ok(not has_table_privilege('authenticated', 'core.approval', 'UPDATE'), 'authenticated has no UPDATE on approval');
select ok(not has_table_privilege('authenticated', 'core.approval', 'DELETE'), 'authenticated has no DELETE on approval');
select ok(has_table_privilege('authenticated', 'core.governance_event', 'SELECT'), 'authenticated has SELECT on governance_event');
select ok(not has_table_privilege('authenticated', 'core.governance_event', 'INSERT'), 'authenticated has no INSERT on governance_event');
select ok(not has_table_privilege('authenticated', 'core.governance_event', 'UPDATE'), 'authenticated has no UPDATE on governance_event');
select ok(not has_table_privilege('authenticated', 'core.governance_event', 'DELETE'), 'authenticated has no DELETE on governance_event');
select ok(has_table_privilege('authenticated', 'core.agent_run', 'SELECT'), 'authenticated has SELECT on agent_run');
select ok(not has_table_privilege('authenticated', 'core.agent_run', 'INSERT'), 'authenticated has no INSERT on agent_run');
select ok(not has_table_privilege('authenticated', 'core.agent_run', 'UPDATE'), 'authenticated has no UPDATE on agent_run');
select ok(not has_table_privilege('authenticated', 'core.agent_run', 'DELETE'), 'authenticated has no DELETE on agent_run');
select is((select count(*)::integer from information_schema.role_usage_grants where grantee = 'authenticated' and object_schema = 'core' and object_type = 'SEQUENCE'), 0, 'authenticated has no broad core sequence privileges');

select is((select count(*)::integer from pg_catalog.pg_policies where schemaname = 'core' and tablename = 'review' and cmd <> 'SELECT'), 0, 'review has no write policies');
select is((select count(*)::integer from pg_catalog.pg_policies where schemaname = 'core' and tablename = 'approval' and cmd <> 'SELECT'), 0, 'approval has no write policies');
select is((select count(*)::integer from pg_catalog.pg_policies where schemaname = 'core' and tablename = 'governance_event' and cmd <> 'SELECT'), 0, 'governance_event has no write policies');
select is((select count(*)::integer from pg_catalog.pg_policies where schemaname = 'core' and tablename = 'agent_run' and cmd <> 'SELECT'), 0, 'agent_run has no write policies');
select ok((select 'authenticated' = any(roles) from pg_catalog.pg_policies where schemaname = 'core' and tablename = 'review' and policyname = 'review_select_project_member'), 'review SELECT policy is for authenticated');
select ok((select 'authenticated' = any(roles) from pg_catalog.pg_policies where schemaname = 'core' and tablename = 'approval' and policyname = 'approval_select_project_member'), 'approval SELECT policy is for authenticated');
select ok((select 'authenticated' = any(roles) from pg_catalog.pg_policies where schemaname = 'core' and tablename = 'governance_event' and policyname = 'governance_event_select_project_member'), 'governance_event SELECT policy is for authenticated');
select ok((select 'authenticated' = any(roles) from pg_catalog.pg_policies where schemaname = 'core' and tablename = 'agent_run' and policyname = 'agent_run_select_project_member'), 'agent_run SELECT policy is for authenticated');

-- member
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
set local role authenticated;

select is((select count(*)::integer from core.task), 1, 'member sees own-tenant tasks');
select is((select count(*)::integer from core.milestone), 1, 'member sees own-tenant milestones');
select is((select count(*)::integer from core.requirement), 1, 'member sees own-tenant requirements');
select is((select count(*)::integer from core.architecture_decision), 1, 'member sees own-tenant ADRs');
select is((select count(*)::integer from core.agent_run), 1, 'member reads own-tenant agent_run projection');
select is((select count(*)::integer from core.review), 1, 'member reads own-tenant reviews');
select is((select count(*)::integer from core.approval), 1, 'member reads own-tenant approvals');
select is((select count(*)::integer from core.governance_event), 1, 'member reads own-tenant governance events');

select lives_ok(
  $$ insert into core.milestone(id, project_id, title, status, created_at, updated_at)
     values ('governance-milestone-b-new', 'governance-project-b', 'New milestone', 'planned', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  'member can write ordinary collaboration data in own tenant'
);
select throws_ok(
  $$ insert into core.milestone(id, project_id, title, status, created_at, updated_at)
     values ('governance-milestone-a-new', 'governance-project-a', 'Foreign milestone', 'planned', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'member cannot write foreign-tenant collaboration data'
);
select lives_ok($$ update core.milestone set title = 'Milestone B renamed' where id = 'governance-milestone-b' $$, 'member can update own-tenant collaboration data');
select lives_ok($$ delete from core.milestone where id = 'governance-milestone-b-new' $$, 'member can delete own-tenant collaboration data');

select throws_ok(
  $$ insert into core.review(id, project_id, subject_type, subject_id, reviewer_actor_type, reviewer_actor_id, status, created_at)
     values ('governance-review-b-new', 'governance-project-b', 'requirement', 'governance-requirement-b', 'user', 'forged-reviewer', 'pending', '2026-09-19T00:00:00Z') $$,
  '42501', null, 'member cannot create review provenance'
);
select throws_ok(
  $$ update core.review
     set reviewer_actor_type = 'user', reviewer_actor_id = 'forged-reviewer'
     where id = 'governance-review-b' $$,
  '42501', null, 'member cannot mutate review provenance'
);
select throws_ok(
  $$ insert into core.approval(id, project_id, review_id, decision, actor_type, actor_id, created_at)
     values ('governance-approval-b-new', 'governance-project-b', 'governance-review-b', 'rejected', 'user', 'forged-user', '2026-09-19T00:00:01Z') $$,
  '42501', null, 'member cannot approve or reject by impersonating another user'
);
select throws_ok(
  $$ insert into core.approval(id, project_id, review_id, decision, actor_type, actor_id, created_at)
     values ('governance-approval-b-agent', 'governance-project-b', 'governance-review-b', 'approved', 'agent', 'agent-1', '2026-09-19T00:00:01Z') $$,
  '42501', null, 'member cannot use actor_type agent'
);
select throws_ok(
  $$ insert into core.approval(id, project_id, review_id, decision, actor_type, actor_id, created_at)
     values ('governance-approval-b-system', 'governance-project-b', 'governance-review-b', 'approved', 'system', 'system-1', '2026-09-19T00:00:01Z') $$,
  '42501', null, 'member cannot use actor_type system'
);
select throws_ok(
  $$ insert into core.governance_event(id, project_id, event_type, aggregate_id, metadata_json, occurred_at)
     values ('governance-event-b-new', 'governance-project-b', 'review.decided', 'governance-review-b', '{}', '2026-09-19T00:00:01Z') $$,
  '42501', null, 'member cannot manufacture governance events'
);
select throws_ok(
  $$ insert into core.governance_event(id, project_id, event_type, aggregate_id, metadata_json, occurred_at)
     values ('governance-event-a-new', 'governance-project-a', 'review.decided', 'governance-review-a', '{}', '2026-09-19T00:00:01Z') $$,
  '42501', null, 'member cannot write foreign-tenant governance events'
);

-- admin
set local role postgres;
set local request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
set local role authenticated;
select is((select count(*)::integer from core.review), 1, 'admin reads own-tenant reviews');
select throws_ok(
  $$ insert into core.approval(id, project_id, review_id, decision, actor_type, actor_id, created_at)
     values ('governance-approval-admin', 'governance-project-b', 'governance-review-b', 'approved', 'user', '33333333-3333-3333-3333-333333333333', '2026-09-19T00:00:01Z') $$,
  '42501', null, 'admin cannot bypass Runtime approval authority'
);

-- owner
set local role postgres;
set local request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
set local role authenticated;
select is((select count(*)::integer from core.governance_event), 1, 'owner reads own-tenant governance events');
select throws_ok(
  $$ insert into core.governance_event(id, project_id, event_type, aggregate_id, metadata_json, occurred_at)
     values ('governance-event-owner', 'governance-project-b', 'review.decided', 'governance-review-b', '{}', '2026-09-19T00:00:01Z') $$,
  '42501', null, 'owner cannot bypass Runtime governance authority'
);

-- non-member
set local role postgres;
set local request.jwt.claim.sub = '55555555-5555-5555-5555-555555555555';
reset request.jwt.claims;
set local role authenticated;
select is((select count(*)::integer from core.review), 0, 'non-member reads no reviews');
select is((select count(*)::integer from core.approval), 0, 'non-member reads no approvals');
select is((select count(*)::integer from core.governance_event), 0, 'non-member reads no governance events');
select throws_ok(
  $$ insert into core.approval(id, project_id, review_id, decision, actor_type, actor_id, created_at)
     values ('governance-approval-nonmember', 'governance-project-b', 'governance-review-b', 'approved', 'user', '55555555-5555-5555-5555-555555555555', '2026-09-19T00:00:01Z') $$,
  '42501', null, 'non-member cannot write governance authority'
);

-- fake JWT tenant/role claims
set local role postgres;
set local request.jwt.claim.sub = '66666666-6666-6666-6666-666666666666';
set local request.jwt.claims = '{"sub":"66666666-6666-6666-6666-666666666666","tenant_id":"governance-tenant-b","tenant_role":"owner"}';
set local role authenticated;
select is((select count(*)::integer from core.review), 0, 'fake JWT claims do not grant governance visibility');
select throws_ok(
  $$ insert into core.governance_event(id, project_id, event_type, aggregate_id, metadata_json, occurred_at)
     values ('governance-event-fake-claims', 'governance-project-b', 'review.decided', 'governance-review-b', '{}', '2026-09-19T00:00:01Z') $$,
  '42501', null, 'fake JWT claims do not grant governance writes'
);

-- revocation is immediately effective
set local role postgres;
delete from core.tenant_member
where tenant_id = 'governance-tenant-b'
  and user_id = '44444444-4444-4444-4444-444444444444';
set local request.jwt.claim.sub = '44444444-4444-4444-4444-444444444444';
reset request.jwt.claims;
set local role authenticated;
select is((select count(*)::integer from core.review), 0, 'revoked member loses governance visibility immediately');
select throws_ok(
  $$ insert into core.governance_event(id, project_id, event_type, aggregate_id, metadata_json, occurred_at)
     values ('governance-event-revoked', 'governance-project-b', 'review.decided', 'governance-review-b', '{}', '2026-09-19T00:00:01Z') $$,
  '42501', null, 'revoked member cannot write governance authority immediately'
);

-- anon
set local role anon;
select throws_ok($$ select count(*) from core.review $$, '42501', null, 'anon cannot read governance reviews');

set local role postgres;

select * from finish();
rollback;
