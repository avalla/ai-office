begin;

create extension if not exists pgtap with schema extensions;
set local search_path = extensions, public, core;

select * from no_plan();

select has_schema('core', 'core authority schema exists');

select has_table('core', 'tenant', 'tenant authority exists');
select has_table('core', 'tenant_member', 'tenant membership authority exists');
select has_table('core', 'tenant_invite', 'tenant invitation authority exists');
select has_table('core', 'project', 'project authority exists');
select has_table('core', 'task', 'task authority exists');
select has_table('core', 'requirement', 'requirement authority exists');
select has_table('core', 'task_requirement', 'task-requirement linkage exists');
select has_table('core', 'milestone', 'milestone authority exists');
select has_table('core', 'architecture_decision', 'ADR authority exists');
select has_table('core', 'agent_run', 'agent_run governance projection exists');
select has_table('core', 'review', 'review authority exists');
select has_table('core', 'approval', 'approval authority exists');
select has_table('core', 'governance_event', 'governance event authority exists');

select has_column(
  'core',
  'project',
  'tenant_id',
  'project exposes staged shared-deployment tenant ownership'
);
select col_is_pk('core', 'project', 'id', 'project id is the primary key');
select col_is_pk('core', 'task', 'id', 'task id is the primary key');
select col_is_pk('core', 'requirement', 'id', 'requirement id is the primary key');
select col_is_pk('core', 'milestone', 'id', 'milestone id is the primary key');
select col_is_pk('core', 'review', 'id', 'review id is the primary key');
select col_is_pk('core', 'approval', 'id', 'approval id is the primary key');

select col_is_unique(
  'core',
  'requirement',
  array['project_id', 'requirement_key'],
  'requirement keys are unique within a project'
);
select col_is_unique(
  'core',
  'approval',
  'review_id',
  'a review can have only one approval'
);

select has_index(
  'core',
  'task',
  'task_project_priority_created_id_idx',
  'task project scheduling index exists'
);
select has_index(
  'core',
  'governance_event',
  'governance_event_project_sequence_idx',
  'governance events have deterministic project ordering index'
);

select has_trigger(
  'core',
  'project',
  'project_tenant_assignment_once',
  'project tenant assignment guard exists'
);
select has_trigger(
  'core',
  'requirement',
  'requirement_milestone_ownership',
  'requirement milestone ownership trigger exists'
);
select has_trigger(
  'core',
  'review',
  'review_subject_ownership',
  'review subject ownership trigger exists'
);
select has_trigger(
  'core',
  'review',
  'review_terminal_status_requires_approval',
  'review terminal-state guard exists'
);
select has_trigger(
  'core',
  'approval',
  'approval_finalize_review',
  'approval finalizes its review'
);
select has_trigger(
  'core',
  'approval',
  'approval_prevent_update',
  'approval update guard exists'
);
select has_trigger(
  'core',
  'governance_event',
  'governance_event_prevent_delete',
  'governance event delete guard exists'
);

select has_function(
  'core',
  'enforce_project_tenant_assignment_once'::name,
  'project tenant immutability function exists'
);
select has_function(
  'core',
  'enforce_review_terminal_status'::name,
  'review integrity function exists'
);
select has_function(
  'core',
  'prevent_review_subject_mutation'::name,
  'review-subject immutability function exists'
);

select * from finish();
rollback;
