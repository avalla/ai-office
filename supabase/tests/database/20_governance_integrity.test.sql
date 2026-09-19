begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;

select * from no_plan();

insert into core.tenant(id, name, created_at, updated_at)
values ('pgtap-governance-tenant', 'Governance Tenant', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.project(id, name, tenant_id, created_at, updated_at)
values
  ('pgtap-gov-a', 'Governance A', 'pgtap-governance-tenant', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'),
  ('pgtap-gov-b', 'Governance B', 'pgtap-governance-tenant', '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z');

insert into core.milestone(
  id, project_id, title, status, created_at, updated_at
) values (
  'pgtap-milestone-a', 'pgtap-gov-a', 'Milestone A', 'planned',
  '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'
);

insert into core.requirement(
  id, project_id, milestone_id, requirement_key, title, description,
  status, created_at, updated_at
) values (
  'pgtap-gov-req-a', 'pgtap-gov-a', 'pgtap-milestone-a', 'GOV-REQ-A',
  'Requirement A', 'A', 'proposed',
  '2026-09-19T00:00:00Z', '2026-09-19T00:00:00Z'
);

select throws_ok(
  $$
    update core.milestone
    set project_id = 'pgtap-gov-b'
    where id = 'pgtap-milestone-a'
  $$,
  '23503',
  null,
  'referenced milestone ownership cannot move to another project'
);

select lives_ok(
  $$ delete from core.milestone where id = 'pgtap-milestone-a' $$,
  'deleting an unreviewed milestone is allowed'
);

select is(
  (select milestone_id from core.requirement where id = 'pgtap-gov-req-a'),
  null::text,
  'milestone delete nulls only requirement.milestone_id'
);
select is(
  (select project_id from core.requirement where id = 'pgtap-gov-req-a'),
  'pgtap-gov-a',
  'milestone delete preserves requirement project ownership'
);

select throws_ok(
  $$
    insert into core.review(
      id, project_id, subject_type, subject_id,
      reviewer_actor_type, reviewer_actor_id,
      status, created_at, completed_at
    ) values (
      'pgtap-terminal-review', 'pgtap-gov-a', 'requirement', 'pgtap-gov-req-a',
      'user', 'reviewer', 'approved',
      '2026-09-19T01:00:00Z', '2026-09-19T01:00:00Z'
    )
  $$,
  '23514',
  'new review must be pending without completion',
  'terminal review cannot be inserted without an approval'
);

select throws_ok(
  $$
    insert into core.review(
      id, project_id, subject_type, subject_id,
      reviewer_actor_type, reviewer_actor_id,
      status, created_at, completed_at
    ) values (
      'pgtap-completed-pending', 'pgtap-gov-a', 'requirement', 'pgtap-gov-req-a',
      'user', 'reviewer', 'pending',
      '2026-09-19T01:00:00Z', '2026-09-19T01:00:00Z'
    )
  $$,
  '23514',
  'new review must be pending without completion',
  'new pending review cannot already have completed_at'
);

select lives_ok(
  $$
    insert into core.review(
      id, project_id, subject_type, subject_id,
      reviewer_actor_type, reviewer_actor_id,
      status, created_at
    ) values (
      'pgtap-review-a', 'pgtap-gov-a', 'requirement', 'pgtap-gov-req-a',
      'user', 'reviewer', 'pending', '2026-09-19T01:00:00Z'
    )
  $$,
  'pending same-project review is accepted'
);

select throws_ok(
  $$
    update core.requirement
    set project_id = 'pgtap-gov-b'
    where id = 'pgtap-gov-req-a'
  $$,
  '23514',
  'review subject ownership is immutable after review',
  'reviewed subject ownership cannot move to another project'
);

select throws_ok(
  $$ delete from core.requirement where id = 'pgtap-gov-req-a' $$,
  '23514',
  'review subject ownership is immutable after review',
  'reviewed subject cannot be deleted'
);

select lives_ok(
  $$
    insert into core.approval(
      id, project_id, review_id, decision,
      actor_type, actor_id, rationale, created_at
    ) values (
      'pgtap-approval-a', 'pgtap-gov-a', 'pgtap-review-a', 'approved',
      'user', 'approver', 'Looks good', '2026-09-19T02:00:00Z'
    )
  $$,
  'approval atomically finalizes its pending review'
);

select is(
  (select status from core.review where id = 'pgtap-review-a'),
  'approved',
  'review status matches approval decision'
);
select is(
  (select completed_at from core.review where id = 'pgtap-review-a'),
  '2026-09-19T02:00:00Z'::timestamptz,
  'review completion timestamp matches approval timestamp'
);

select throws_ok(
  $$
    update core.review
    set completed_at = '2026-09-19T03:00:00Z'
    where id = 'pgtap-review-a'
  $$,
  '23514',
  'review terminal state requires its matching approval',
  'terminal review completion timestamp cannot drift from approval'
);

select throws_ok(
  $$
    update core.approval
    set rationale = 'rewritten history'
    where id = 'pgtap-approval-a'
  $$,
  '55000',
  'approval is append-only',
  'approval rows are append-only'
);

insert into core.governance_event(
  id, project_id, event_type, aggregate_id, metadata_json, occurred_at
) values (
  'pgtap-event-a', 'pgtap-gov-a', 'requirement.created',
  'pgtap-gov-req-a', '{}'::jsonb, '2026-09-19T00:00:00Z'
);

select throws_ok(
  $$
    delete from core.governance_event
    where id = 'pgtap-event-a'
  $$,
  '55000',
  'governance_event is append-only',
  'governance events cannot be deleted'
);

select * from finish();
rollback;
