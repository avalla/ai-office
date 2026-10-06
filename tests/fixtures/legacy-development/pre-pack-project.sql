PRAGMA foreign_keys=OFF;
BEGIN;
CREATE TABLE schema_migration (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0001_initial.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0002_project_import.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0003_project_import_idempotency.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0004_project_onboarding.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0005_audit_event.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0006_agent_runtime.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0007_llm_cost.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0008_governance.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0009_agent_runtime_hardening.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0010_llm_cost_hardening.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0011_governance_hardening.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0012_capability_policy.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0013_filesystem_connector.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0014_trusted_local_execution.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0015_llm_assisted_onboarding.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0016_agent_controlled_actions.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0017_skill_first_office.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0018_reusable_memory_references.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0019_repository_identity.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0020_pipeline_enforcement.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0021_agent_action_provenance.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0022_project_portability.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0023_project_snapshot_observations.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0024_project_revision_identity.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0025_audit_event_aggregate_index.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0026_task_requirement_linkage.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0027_agent_execution_provenance.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0028_agent_run_memory_provenance.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0029_agent_run_memory_query_digests.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0030_agent_run_model_routing.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0031_cost_event_charge_basis.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0032_job_outbox.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0033_role_execution_guidance.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0034_exact_pipeline_stage_bindings.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0035_pipeline_manifest_revision_tuple.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0036_milestone_title_changed_event.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0037_task_dependencies.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0038_milestone_description_changed_event.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0039_task_dependency_immutable_edges.sql','2026-09-01T00:00:00.000Z');
INSERT INTO "schema_migration"("version","applied_at") VALUES ('0040_task_execution_history.sql','2026-09-01T00:00:00.000Z');
CREATE TABLE project (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO "project"("id","name","description","created_at","updated_at") VALUES ('legacy-project','Legacy development project',NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
CREATE TABLE task (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'assigned',
      'running',
      'blocked',
      'waiting_review',
      'completed',
      'failed',
      'cancelled'
    )
  ),
  priority INTEGER NOT NULL DEFAULT 0 CHECK (typeof(priority) = 'integer'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO "task"("id","project_id","title","description","status","priority","created_at","updated_at") VALUES ('task-pending','legacy-project','Pending task',NULL,'pending',0,'2026-09-01T00:00:12.000Z','2026-09-01T00:00:12.000Z');
INSERT INTO "task"("id","project_id","title","description","status","priority","created_at","updated_at") VALUES ('task-blocked','legacy-project','Blocked task',NULL,'blocked',0,'2026-09-01T00:00:13.000Z','2026-09-01T00:00:15.000Z');
INSERT INTO "task"("id","project_id","title","description","status","priority","created_at","updated_at") VALUES ('task-cancelled','legacy-project','Cancelled task',NULL,'cancelled',0,'2026-09-01T00:00:16.000Z','2026-09-01T00:00:17.000Z');
INSERT INTO "task"("id","project_id","title","description","status","priority","created_at","updated_at") VALUES ('task-approved-pipeline','legacy-project','Approved feature',NULL,'running',0,'2026-09-01T00:00:21.000Z','2026-09-01T00:00:22.000Z');
INSERT INTO "task"("id","project_id","title","description","status","priority","created_at","updated_at") VALUES ('task-active-pipeline','legacy-project','Active feature',NULL,'running',0,'2026-09-01T00:00:50.000Z','2026-09-01T00:00:51.000Z');
CREATE TABLE project_source (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  local_path TEXT,
  remote_url TEXT,
  default_branch TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE project_scan (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scan_type TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  source_revision TEXT,
  summary_json TEXT,
  error_json TEXT
);
CREATE TABLE project_profile_entry (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('detected', 'inferred', 'user')),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  source_reference TEXT,
  confirmed_at TEXT,
  superseded_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE project_question (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scan_id TEXT REFERENCES project_scan(id) ON DELETE SET NULL,
  key TEXT NOT NULL,
  question TEXT NOT NULL,
  reason TEXT NOT NULL,
  answer_json TEXT,
  answered_at TEXT
, answer_category TEXT NOT NULL DEFAULT 'preference'
CHECK (answer_category IN ('goal', 'preference', 'constraint', 'permission')), source TEXT NOT NULL DEFAULT 'deterministic'
CHECK (source IN ('deterministic', 'llm')), generation_id TEXT REFERENCES onboarding_generation(id) ON DELETE CASCADE, answer_type TEXT NOT NULL DEFAULT 'text'
CHECK (answer_type IN ('text', 'boolean', 'single_select', 'multi_select')), options_json TEXT, priority INTEGER NOT NULL DEFAULT 50
CHECK (priority >= 1 AND priority <= 100), normalized_question TEXT NOT NULL DEFAULT '');
CREATE TABLE audit_event (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES project(id),
  event_type TEXT NOT NULL CHECK (length(trim(event_type)) > 0),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('daemon', 'cli', 'system')),
  actor_id TEXT,
  aggregate_type TEXT,
  aggregate_id TEXT,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL
);
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0002','legacy-project','office.manifest.applied','cli','codex','office_manifest_revision','legacy-id-0001','{"revision":1,"schemaVersion":1,"skill":"ai-office","skillVersion":"1","roles":4,"pipelines":4}','2026-09-01T00:00:03.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0014','legacy-project','pipeline.started','cli','local-operator','pipeline_run','legacy-id-0009','{"taskId":"task-approved-pipeline","pipelineId":"delivery","manifestRevision":1}','2026-09-01T00:00:23.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0015','legacy-project','pipeline.stage_activated','cli','local-operator','pipeline_run','legacy-id-0009','{"stageId":"design"}','2026-09-01T00:00:24.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0017','legacy-project','pipeline.override_issued','cli','local-operator','pipeline_run','legacy-id-0009','{"stageId":"design","reason":"Design agreed before the office existed","previousRule":"pipeline_agent_not_assigned","resultingAuthorization":"stage_completed"}','2026-09-01T00:00:26.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0018','legacy-project','pipeline.stage_completed','cli','local-operator','pipeline_run','legacy-id-0009','{"stageId":"design"}','2026-09-01T00:00:27.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0019','legacy-project','pipeline.stage_activated','cli','local-operator','pipeline_run','legacy-id-0009','{"stageId":"implement"}','2026-09-01T00:00:28.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0020','legacy-project','pipeline.agent_assigned','cli','local-operator','pipeline_run','legacy-id-0009','{"stageId":"implement","agentId":"agent:legacy-project:developer"}','2026-09-01T00:00:30.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0022','legacy-project','pipeline.stage_completed','system','agent:legacy-project:developer','pipeline_run','legacy-id-0009','{"stageId":"implement"}','2026-09-01T00:00:36.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0023','legacy-project','pipeline.stage_activated','system','agent:legacy-project:developer','pipeline_run','legacy-id-0009','{"stageId":"review"}','2026-09-01T00:00:37.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0024','legacy-project','pipeline.agent_assigned','cli','local-operator','pipeline_run','legacy-id-0009','{"stageId":"review","agentId":"agent:legacy-project:reviewer"}','2026-09-01T00:00:39.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0026','legacy-project','pipeline.approval_requested','system','agent:legacy-project:reviewer','pipeline_run','legacy-id-0009','{"stageId":"review"}','2026-09-01T00:00:45.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0027','legacy-project','pipeline.approval_granted','cli','local-operator','pipeline_run','legacy-id-0009','{"stageId":"review","rationale":"Review accepted"}','2026-09-01T00:00:47.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0028','legacy-project','pipeline.stage_completed','cli','local-operator','pipeline_run','legacy-id-0009','{"stageId":"review"}','2026-09-01T00:00:48.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0029','legacy-project','pipeline.stage_activated','cli','local-operator','pipeline_run','legacy-id-0009','{"stageId":"verify"}','2026-09-01T00:00:49.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0035','legacy-project','pipeline.started','cli','local-operator','pipeline_run','legacy-id-0030','{"taskId":"task-active-pipeline","pipelineId":"delivery","manifestRevision":1}','2026-09-01T00:00:52.000Z');
INSERT INTO "audit_event"("id","project_id","event_type","actor_type","actor_id","aggregate_type","aggregate_id","payload_json","occurred_at") VALUES ('legacy-id-0036','legacy-project','pipeline.stage_activated','cli','local-operator','pipeline_run','legacy-id-0030','{"stageId":"design"}','2026-09-01T00:00:53.000Z');
CREATE TABLE role (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  role_key TEXT NOT NULL,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  capabilities_json TEXT NOT NULL CHECK (json_valid(capabilities_json)),
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json)),
  model_policy TEXT NOT NULL,
  limits_json TEXT NOT NULL CHECK (json_valid(limits_json)),
  source_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, guidance_text TEXT NOT NULL DEFAULT ''
  CHECK (length(guidance_text) <= 65536), guidance_version INTEGER NOT NULL DEFAULT 1
  CHECK (guidance_version > 0),
  UNIQUE(project_id, role_key)
);
INSERT INTO "role"("id","project_id","role_key","name","version","capabilities_json","tools_json","model_policy","limits_json","source_path","created_at","updated_at","guidance_text","guidance_version") VALUES ('role:legacy-project:architect','legacy-project','architect','software-architect',1,'["inspect_project","propose_adr","decompose_work","assess_tradeoffs"]','["project.search","project.get_active_adrs","code.get_dependencies","tasks.create"]','high_reasoning','{"maxIterations":8,"maxCostMicros":"3000000","timeoutSeconds":1800}','agents/architect/agent.yaml','2026-09-01T00:00:04.000Z','2026-09-01T00:00:04.000Z','# Software Architect

You own the technical coherence of the proposed change.
',1);
INSERT INTO "role"("id","project_id","role_key","name","version","capabilities_json","tools_json","model_policy","limits_json","source_path","created_at","updated_at","guidance_text","guidance_version") VALUES ('role:legacy-project:developer','legacy-project','developer','software-developer',1,'["inspect_code","modify_code","run_tests","create_patch"]','["project.search","code.get_symbol","code.get_dependencies","git.diff","shell.run"]','balanced','{"maxIterations":10,"maxCostMicros":"2000000","timeoutSeconds":1800}','agents/developer/agent.yaml','2026-09-01T00:00:04.000Z','2026-09-01T00:00:04.000Z','# Developer

You deliver the agreed change with focused tests.
',1);
INSERT INTO "role"("id","project_id","role_key","name","version","capabilities_json","tools_json","model_policy","limits_json","source_path","created_at","updated_at","guidance_text","guidance_version") VALUES ('role:legacy-project:reviewer','legacy-project','reviewer','code-reviewer',1,'["inspect_diff","inspect_tests","assess_security","approve_or_reject"]','["git.diff","code.get_dependencies","shell.run"]','balanced','{"maxIterations":5,"maxCostMicros":"1000000","timeoutSeconds":900}','agents/reviewer/agent.yaml','2026-09-01T00:00:04.000Z','2026-09-01T00:00:04.000Z','# Reviewer

You assess correctness, security and scope independently.
',1);
INSERT INTO "role"("id","project_id","role_key","name","version","capabilities_json","tools_json","model_policy","limits_json","source_path","created_at","updated_at","guidance_text","guidance_version") VALUES ('role:legacy-project:qa','legacy-project','qa','quality-assurance',1,'["derive_test_cases","run_tests","report_regressions"]','["project.get_task","shell.run","git.diff"]','economical','{"maxIterations":6,"maxCostMicros":"750000","timeoutSeconds":1200}','agents/qa/agent.yaml','2026-09-01T00:00:04.000Z','2026-09-01T00:00:04.000Z','# Quality Assurance

You produce reproducible evidence of acceptance behavior.
',1);
INSERT INTO "role"("id","project_id","role_key","name","version","capabilities_json","tools_json","model_policy","limits_json","source_path","created_at","updated_at","guidance_text","guidance_version") VALUES ('role:legacy-project:security-reviewer','legacy-project','security-reviewer','security-reviewer',1,'["inspect_diff","assess_threats","assess_security","recommend_mitigations"]','["project.search","project.get_active_adrs","code.get_dependencies","git.diff"]','high_reasoning','{"maxIterations":8,"maxCostMicros":"2000000","timeoutSeconds":1800}','agents/security/agent.yaml','2026-09-01T00:00:04.000Z','2026-09-01T00:00:04.000Z','# Security Reviewer

You assess threats and recommend mitigations.
',1);
INSERT INTO "role"("id","project_id","role_key","name","version","capabilities_json","tools_json","model_policy","limits_json","source_path","created_at","updated_at","guidance_text","guidance_version") VALUES ('role:legacy-project:release-engineer','legacy-project','release-engineer','release-engineer',1,'["inspect_project","assess_release_readiness","plan_rollout","plan_recovery"]','["project.search","project.get_task","git.diff"]','balanced','{"maxIterations":6,"maxCostMicros":"1000000","timeoutSeconds":1200}','agents/release/agent.yaml','2026-09-01T00:00:05.000Z','2026-09-01T00:00:05.000Z','',1);
CREATE TABLE agent (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL REFERENCES role(id),
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, name)
);
INSERT INTO "agent"("id","project_id","role_id","name","enabled","created_at","updated_at") VALUES ('agent:legacy-project:architect','legacy-project','role:legacy-project:architect','architect',1,'2026-09-01T00:00:04.000Z','2026-09-01T00:00:04.000Z');
INSERT INTO "agent"("id","project_id","role_id","name","enabled","created_at","updated_at") VALUES ('agent:legacy-project:developer','legacy-project','role:legacy-project:developer','developer',1,'2026-09-01T00:00:04.000Z','2026-09-01T00:00:04.000Z');
INSERT INTO "agent"("id","project_id","role_id","name","enabled","created_at","updated_at") VALUES ('agent:legacy-project:reviewer','legacy-project','role:legacy-project:reviewer','reviewer',1,'2026-09-01T00:00:04.000Z','2026-09-01T00:00:04.000Z');
INSERT INTO "agent"("id","project_id","role_id","name","enabled","created_at","updated_at") VALUES ('agent:legacy-project:qa','legacy-project','role:legacy-project:qa','qa',1,'2026-09-01T00:00:04.000Z','2026-09-01T00:00:04.000Z');
INSERT INTO "agent"("id","project_id","role_id","name","enabled","created_at","updated_at") VALUES ('agent:legacy-project:security','legacy-project','role:legacy-project:security-reviewer','security',1,'2026-09-01T00:00:04.000Z','2026-09-01T00:00:04.000Z');
CREATE TABLE agent_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES task(id),
  agent_id TEXT NOT NULL REFERENCES agent(id),
  status TEXT NOT NULL CHECK (status IN (
    'queued', 'preparing', 'running', 'reviewing', 'completed', 'failed', 'cancelled'
  )),
  worktree_path TEXT,
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  updated_at TEXT NOT NULL
, action_intent_json TEXT
CHECK (
  action_intent_json IS NULL OR (
    json_valid(action_intent_json)
    AND json_type(action_intent_json) = 'object'
    AND json_type(action_intent_json, '$.resourceId') = 'text'
    AND length(trim(json_extract(action_intent_json, '$.resourceId'))) > 0
    AND json_type(action_intent_json, '$.operation') = 'text'
    AND length(trim(json_extract(action_intent_json, '$.operation'))) > 0
    AND json_type(action_intent_json, '$.arguments') = 'object'
  )
), pipeline_run_id TEXT REFERENCES pipeline_run(id), execution_json TEXT
  CHECK (execution_json IS NULL OR (
    json_valid(execution_json) AND json_type(execution_json) = 'object'
  )), model_routing_json TEXT
  CHECK (model_routing_json IS NULL OR (
    json_valid(model_routing_json)
    AND json_type(model_routing_json) = 'object'
    AND json_extract(model_routing_json, '$.status') IN ('unrouted', 'resolved')
    AND (json_extract(model_routing_json, '$.status') = 'unrouted')
      = (json_type(model_routing_json, '$.selection') IS NULL)
  )), role_guidance_json TEXT
  CHECK (role_guidance_json IS NULL OR (
    json_valid(role_guidance_json)
    AND json_type(role_guidance_json) = 'object'
    AND json_type(role_guidance_json, '$.version') = 'integer'
    AND json_type(role_guidance_json, '$.text') = 'text'
    AND json_extract(role_guidance_json, '$.version') > 0
    AND length(json_extract(role_guidance_json, '$.text')) <= 65536
  )), pipeline_stage_run_id TEXT
  REFERENCES pipeline_stage_run(id));
INSERT INTO "agent_run"("id","project_id","task_id","agent_id","status","worktree_path","result_json","error_json","created_at","started_at","completed_at","updated_at","action_intent_json","pipeline_run_id","execution_json","model_routing_json","role_guidance_json","pipeline_stage_run_id") VALUES ('agent-run-failed','legacy-project','task-blocked','agent:legacy-project:security','failed',NULL,NULL,NULL,'2026-09-01T00:00:18.000Z',NULL,'2026-09-01T00:00:20.000Z','2026-09-01T00:00:20.000Z',NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "agent_run"("id","project_id","task_id","agent_id","status","worktree_path","result_json","error_json","created_at","started_at","completed_at","updated_at","action_intent_json","pipeline_run_id","execution_json","model_routing_json","role_guidance_json","pipeline_stage_run_id") VALUES ('legacy-id-0021','legacy-project','task-approved-pipeline','agent:legacy-project:developer','completed',NULL,NULL,NULL,'2026-09-01T00:00:31.000Z','2026-09-01T00:00:33.000Z','2026-09-01T00:00:34.000Z','2026-09-01T00:00:34.000Z',NULL,'legacy-id-0009',NULL,'{"status":"unrouted"}','{"version":1,"text":"# Developer\n\nYou deliver the agreed change with focused tests.\n"}','legacy-id-0011');
INSERT INTO "agent_run"("id","project_id","task_id","agent_id","status","worktree_path","result_json","error_json","created_at","started_at","completed_at","updated_at","action_intent_json","pipeline_run_id","execution_json","model_routing_json","role_guidance_json","pipeline_stage_run_id") VALUES ('legacy-id-0025','legacy-project','task-approved-pipeline','agent:legacy-project:reviewer','completed',NULL,NULL,NULL,'2026-09-01T00:00:40.000Z','2026-09-01T00:00:42.000Z','2026-09-01T00:00:43.000Z','2026-09-01T00:00:43.000Z',NULL,'legacy-id-0009',NULL,'{"status":"unrouted"}','{"version":1,"text":"# Reviewer\n\nYou assess correctness, security and scope independently.\n"}','legacy-id-0012');
CREATE TABLE task_lock (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL UNIQUE REFERENCES agent_run(id) ON DELETE CASCADE,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE TABLE agent_run_event (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES agent_run(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  occurred_at TEXT NOT NULL
);
INSERT INTO "agent_run_event"("id","run_id","status","payload_json","occurred_at") VALUES ('agent-run-failed:failed','agent-run-failed','failed','{"hasResult":false,"hasError":false}','2026-09-01T00:00:20.000Z');
INSERT INTO "agent_run_event"("id","run_id","status","payload_json","occurred_at") VALUES ('legacy-id-0021:queued','legacy-id-0021','queued','{"hasResult":false,"hasError":false,"modelRouting":{"status":"unrouted"}}','2026-09-01T00:00:31.000Z');
INSERT INTO "agent_run_event"("id","run_id","status","payload_json","occurred_at") VALUES ('legacy-id-0021:running','legacy-id-0021','running','{"hasResult":false,"hasError":false}','2026-09-01T00:00:33.000Z');
INSERT INTO "agent_run_event"("id","run_id","status","payload_json","occurred_at") VALUES ('legacy-id-0021:completed','legacy-id-0021','completed','{"hasResult":false,"hasError":false}','2026-09-01T00:00:34.000Z');
INSERT INTO "agent_run_event"("id","run_id","status","payload_json","occurred_at") VALUES ('legacy-id-0025:queued','legacy-id-0025','queued','{"hasResult":false,"hasError":false,"modelRouting":{"status":"unrouted"}}','2026-09-01T00:00:40.000Z');
INSERT INTO "agent_run_event"("id","run_id","status","payload_json","occurred_at") VALUES ('legacy-id-0025:running','legacy-id-0025','running','{"hasResult":false,"hasError":false}','2026-09-01T00:00:42.000Z');
INSERT INTO "agent_run_event"("id","run_id","status","payload_json","occurred_at") VALUES ('legacy-id-0025:completed','legacy-id-0025','completed','{"hasResult":false,"hasError":false}','2026-09-01T00:00:43.000Z');
CREATE TABLE pricing_version (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
  input_per_million_micros INTEGER NOT NULL CHECK (input_per_million_micros >= 0),
  cached_input_per_million_micros INTEGER NOT NULL CHECK (cached_input_per_million_micros >= 0),
  output_per_million_micros INTEGER NOT NULL CHECK (output_per_million_micros >= 0),
  reasoning_per_million_micros INTEGER NOT NULL CHECK (reasoning_per_million_micros >= 0),
  effective_from TEXT NOT NULL,
  effective_to TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(provider, model, effective_from)
);
CREATE TABLE budget (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('project', 'milestone', 'task', 'agent', 'agent_run')),
  scope_id TEXT NOT NULL,
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
  limit_micros INTEGER NOT NULL CHECK (limit_micros >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, scope_type, scope_id, currency)
);
CREATE TABLE budget_reservation (
  id TEXT PRIMARY KEY,
  budget_id TEXT NOT NULL REFERENCES budget(id) ON DELETE CASCADE,
  agent_run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'released')),
  created_at TEXT NOT NULL,
  finalized_at TEXT
, expires_at TEXT);
CREATE TABLE model_usage (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT REFERENCES task(id) ON DELETE SET NULL,
  agent_id TEXT REFERENCES agent(id) ON DELETE SET NULL,
  agent_run_id TEXT REFERENCES agent_run(id) ON DELETE SET NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  purpose TEXT NOT NULL,
  provider_request_id TEXT,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  cached_input_tokens INTEGER NOT NULL CHECK (cached_input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens INTEGER NOT NULL CHECK (reasoning_tokens >= 0),
  occurred_at TEXT NOT NULL
);
CREATE TABLE cost_event (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  usage_id TEXT NOT NULL UNIQUE REFERENCES model_usage(id),
  pricing_version_id TEXT NOT NULL REFERENCES pricing_version(id),
  reservation_id TEXT REFERENCES budget_reservation(id) ON DELETE SET NULL,
  estimated_micros INTEGER NOT NULL CHECK (estimated_micros >= 0),
  actual_micros INTEGER NOT NULL CHECK (actual_micros >= 0),
  currency TEXT NOT NULL CHECK (currency IN ('USD', 'EUR')),
  occurred_at TEXT NOT NULL
, reserved_micros INTEGER NOT NULL DEFAULT 0
CHECK (reserved_micros >= 0), overage_micros INTEGER NOT NULL DEFAULT 0
CHECK (overage_micros >= 0), charge_basis TEXT NOT NULL DEFAULT 'reported_usage'
  CHECK (charge_basis IN ('reported_usage', 'reserved_envelope')));
CREATE TABLE milestone (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'completed', 'cancelled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO "milestone"("id","project_id","title","description","status","created_at","updated_at") VALUES ('legacy-id-0003','legacy-project','Legacy milestone',NULL,'planned','2026-09-01T00:00:06.000Z','2026-09-01T00:00:06.000Z');
CREATE TABLE requirement (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  milestone_id TEXT REFERENCES milestone(id) ON DELETE SET NULL,
  requirement_key TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  description TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'implemented', 'verified', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, requirement_key)
);
INSERT INTO "requirement"("id","project_id","milestone_id","requirement_key","title","description","status","created_at","updated_at") VALUES ('legacy-id-0004','legacy-project','legacy-id-0003','LEG-1','Legacy requirement','Existing projects keep working.','proposed','2026-09-01T00:00:07.000Z','2026-09-01T00:00:07.000Z');
CREATE TABLE architecture_decision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  context TEXT NOT NULL,
  decision TEXT NOT NULL,
  consequences TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'accepted', 'rejected', 'deprecated', 'superseded')),
  superseded_by_id TEXT REFERENCES architecture_decision(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE "review" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  subject_type TEXT NOT NULL CHECK (subject_type IN ('task', 'agent_run', 'requirement', 'adr', 'milestone')),
  subject_id TEXT NOT NULL,
  reviewer_actor_type TEXT NOT NULL CHECK (reviewer_actor_type IN ('user', 'agent', 'system')),
  reviewer_actor_id TEXT NOT NULL CHECK (length(trim(reviewer_actor_id)) > 0),
  reviewer_display_name TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  summary TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE(project_id, id)
);
INSERT INTO "review"("id","project_id","subject_type","subject_id","reviewer_actor_type","reviewer_actor_id","reviewer_display_name","status","summary","created_at","completed_at") VALUES ('legacy-id-0005','legacy-project','requirement','legacy-id-0004','agent','reviewer',NULL,'approved',NULL,'2026-09-01T00:00:08.000Z','2026-09-01T00:00:09.000Z');
INSERT INTO "review"("id","project_id","subject_type","subject_id","reviewer_actor_type","reviewer_actor_id","reviewer_display_name","status","summary","created_at","completed_at") VALUES ('legacy-id-0007','legacy-project','milestone','legacy-id-0003','agent','reviewer',NULL,'rejected',NULL,'2026-09-01T00:00:10.000Z','2026-09-01T00:00:11.000Z');
CREATE TABLE "approval" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  review_id TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  display_name TEXT,
  rationale TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(review_id),
  FOREIGN KEY(project_id, review_id)
    REFERENCES "review"(project_id, id) ON DELETE CASCADE
);
INSERT INTO "approval"("id","project_id","review_id","decision","actor_type","actor_id","display_name","rationale","created_at") VALUES ('legacy-id-0006','legacy-project','legacy-id-0005','approved','user','owner',NULL,'Accepted','2026-09-01T00:00:09.000Z');
INSERT INTO "approval"("id","project_id","review_id","decision","actor_type","actor_id","display_name","rationale","created_at") VALUES ('legacy-id-0008','legacy-project','legacy-id-0007','rejected','user','owner',NULL,'Needs revision','2026-09-01T00:00:11.000Z');
CREATE TABLE "resources" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN (
    'filesystem_scope', 'github_repository', 'sqlite_database', 'shell_environment'
  )),
  provider TEXT NOT NULL CHECK (provider IN ('fake', 'filesystem')),
  external_ref TEXT,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  configuration_json TEXT NOT NULL CHECK (
    json_valid(configuration_json) AND json_type(configuration_json) = 'object'
  ),
  credential_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  CHECK (
    (provider = 'fake' AND type = 'filesystem_scope')
    OR (provider = 'filesystem' AND type = 'filesystem_scope'
      AND external_ref IS NOT NULL AND length(trim(external_ref)) > 0)
  )
);
CREATE TABLE "capability_grants" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  principal_type TEXT NOT NULL CHECK (principal_type IN (
    'user', 'agent', 'role', 'workflow', 'application'
  )),
  principal_id TEXT NOT NULL CHECK (length(trim(principal_id)) > 0),
  resource_id TEXT NOT NULL,
  actions_json TEXT NOT NULL CHECK (
    json_valid(actions_json)
    AND json_type(actions_json) = 'array'
    AND json_array_length(actions_json) > 0
  ),
  constraints_json TEXT NOT NULL CHECK (
    json_valid(constraints_json) AND json_type(constraints_json) = 'object'
  ),
  valid_from TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  granted_by TEXT NOT NULL CHECK (length(trim(granted_by)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  FOREIGN KEY(project_id, resource_id)
    REFERENCES "resources"(project_id, id) ON DELETE CASCADE,
  CHECK (expires_at IS NULL OR expires_at > valid_from),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);
CREATE TABLE "action_requests" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  agent_id TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  connector_version TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  normalized_arguments_json TEXT NOT NULL CHECK (
    json_valid(normalized_arguments_json) AND json_type(normalized_arguments_json) = 'object'
  ),
  effective_constraints_json TEXT NOT NULL CHECK (
    json_valid(effective_constraints_json) AND json_type(effective_constraints_json) = 'object'
  ),
  payload_hash TEXT NOT NULL CHECK (
    length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  decision TEXT NOT NULL CHECK (decision IN (
    'allow', 'deny', 'allow_with_approval', 'allow_simulation_only'
  )),
  risk_level TEXT NOT NULL CHECK (risk_level IN ('low', 'medium', 'high', 'critical')),
  matched_grant_ids_json TEXT NOT NULL CHECK (
    json_valid(matched_grant_ids_json) AND json_type(matched_grant_ids_json) = 'array'
  ),
  reasons_json TEXT NOT NULL CHECK (
    json_valid(reasons_json) AND json_type(reasons_json) = 'array'
  ),
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'authorized', 'denied', 'simulating', 'simulated',
    'approval_pending', 'rejected', 'executing', 'completed',
    'failed', 'execution_unknown', 'cancelled', 'expired'
  )),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, pipeline_run_id TEXT REFERENCES pipeline_run(id), pipeline_stage_run_id TEXT REFERENCES pipeline_stage_run(id), agent_run_id TEXT REFERENCES agent_run(id),
  UNIQUE(project_id, id),
  FOREIGN KEY(project_id, agent_id) REFERENCES agent(project_id, id),
  FOREIGN KEY(project_id, resource_id) REFERENCES resources(project_id, id),
  CHECK (
    (connector = 'fake' AND connector_version = '1')
    OR (connector = 'filesystem' AND connector_version IN ('1', '2'))
  )
);
CREATE TABLE "action_simulations" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  action_request_id TEXT NOT NULL,
  authorization_payload_hash TEXT NOT NULL CHECK (
    length(authorization_payload_hash) = 64
    AND authorization_payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  connector TEXT NOT NULL,
  connector_version TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (length(trim(operation)) > 0),
  preconditions_json TEXT NOT NULL CHECK (
    json_valid(preconditions_json) AND json_type(preconditions_json) = 'array'
  ),
  diff TEXT NOT NULL,
  diff_sha256 TEXT NOT NULL CHECK (
    length(diff_sha256) = 64 AND diff_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  artifact_sha256 TEXT NOT NULL CHECK (
    length(artifact_sha256) = 64 AND artifact_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  UNIQUE(project_id, action_request_id),
  FOREIGN KEY(project_id, action_request_id)
    REFERENCES "action_requests"(project_id, id)
);
CREATE TABLE action_approvals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  action_request_id TEXT NOT NULL,
  simulation_id TEXT NOT NULL,
  action_payload_hash TEXT NOT NULL CHECK (
    length(action_payload_hash) = 64 AND action_payload_hash NOT GLOB '*[^0-9a-f]*'
  ),
  simulation_artifact_hash TEXT NOT NULL CHECK (
    length(simulation_artifact_hash) = 64
    AND simulation_artifact_hash NOT GLOB '*[^0-9a-f]*'
  ),
  connector TEXT NOT NULL CHECK (connector = 'filesystem'),
  connector_version TEXT NOT NULL CHECK (connector_version = '2'),
  operation TEXT NOT NULL CHECK (operation IN (
    'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
  )),
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected')),
  requested_at TEXT NOT NULL,
  decided_at TEXT,
  actor TEXT,
  UNIQUE(project_id, id),
  UNIQUE(project_id, action_request_id),
  FOREIGN KEY(project_id, action_request_id)
    REFERENCES action_requests(project_id, id),
  FOREIGN KEY(project_id, simulation_id)
    REFERENCES action_simulations(project_id, id),
  CHECK (
    (status = 'pending' AND decided_at IS NULL AND actor IS NULL)
    OR (status IN ('approved', 'rejected') AND decided_at IS NOT NULL
      AND actor IS NOT NULL AND length(trim(actor)) > 0 AND decided_at >= requested_at)
  )
);
CREATE TABLE action_executions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  action_request_id TEXT NOT NULL,
  simulation_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('executing', 'completed', 'failed', 'execution_unknown')
  ),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  failure_code TEXT,
  result_hash TEXT CHECK (
    result_hash IS NULL OR (
      length(result_hash) = 64 AND result_hash NOT GLOB '*[^0-9a-f]*'
    )
  ),
  UNIQUE(project_id, id),
  UNIQUE(project_id, action_request_id),
  FOREIGN KEY(project_id, action_request_id)
    REFERENCES action_requests(project_id, id),
  FOREIGN KEY(project_id, simulation_id)
    REFERENCES action_simulations(project_id, id),
  FOREIGN KEY(project_id, approval_id)
    REFERENCES action_approvals(project_id, id),
  CHECK (
    (status = 'executing' AND completed_at IS NULL
      AND failure_code IS NULL AND result_hash IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND failure_code IS NULL)
    OR (status IN ('failed', 'execution_unknown') AND completed_at IS NOT NULL
      AND failure_code IS NOT NULL AND length(trim(failure_code)) > 0)
  )
);
CREATE TABLE onboarding_generation (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  round INTEGER NOT NULL CHECK (round > 0),
  status TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  batch_status TEXT CHECK (batch_status IN ('needs_more_context', 'ready')),
  failure_code TEXT,
  created_at TEXT NOT NULL,
  CHECK (
    (status = 'completed' AND batch_status IS NOT NULL AND failure_code IS NULL)
    OR (status = 'failed' AND batch_status IS NULL AND failure_code IS NOT NULL)
  )
);
CREATE TABLE office_manifest_revision (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (
    typeof(revision) = 'integer' AND revision > 0
  ),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  manifest_json TEXT NOT NULL CHECK (
    json_valid(manifest_json)
    AND json_extract(manifest_json, '$.schemaVersion') = schema_version
  ),
  source_host TEXT NOT NULL CHECK (length(trim(source_host)) > 0),
  source_skill TEXT NOT NULL CHECK (source_skill = 'ai-office'),
  source_skill_version TEXT NOT NULL CHECK (
    length(trim(source_skill_version)) > 0
  ),
  applied_at TEXT NOT NULL,
  CHECK (json_extract(manifest_json, '$.provenance.host') = source_host),
  CHECK (json_extract(manifest_json, '$.provenance.skill') = source_skill),
  CHECK (
    json_extract(manifest_json, '$.provenance.skillVersion') =
      source_skill_version
  ),
  UNIQUE(project_id, revision)
);
INSERT INTO "office_manifest_revision"("id","project_id","revision","schema_version","manifest_json","source_host","source_skill","source_skill_version","applied_at") VALUES ('legacy-id-0001','legacy-project',1,1,'{"office":{"name":"Software delivery office","roles":[{"id":"architect","purpose":"Turn the agreed outcome into a coherent, verifiable technical design","responsibilities":["Reconstruct affected flows, ownership boundaries, dependencies, and active architectural decisions","Compare viable approaches and choose the smallest solution that preserves project invariants","Define a bounded implementation plan with observable acceptance criteria and failure behavior","Identify compatibility, migration, security, and operational risks and unresolved decisions","Hand design and validation expectations to implementation and reassess invalidated assumptions"],"title":"Software Architect"},{"id":"developer","purpose":"Deliver a scoped, maintainable implementation backed by relevant validation","responsibilities":["Inspect existing behavior and implement the agreed design within assigned ownership","Reproduce defects and correct root causes while preserving contracts and unrelated changes","Maintain focused tests for acceptance behavior, failure modes, and representative upgrades","Run required checks and review the resulting diff and task-owned documentation","Report changes, validation evidence, unresolved risks, and review fixes without approving own work"],"title":"Developer"},{"id":"reviewer","purpose":"Independently assess correctness, security, scope, and architectural integrity","responsibilities":["Review the diff in the context of affected callers, contracts, tests, and acceptance criteria","Check architectural invariants, ownership, authorization, error handling, and compatibility","Assess whether validation evidence detects relevant regressions and supports implementation claims","Return actionable findings with locations, triggers, consequences, and severity","Disclose independence conflicts and distinguish review recommendations from Runtime approvals"],"title":"Reviewer"},{"id":"qa","purpose":"Produce reproducible evidence of acceptance behavior and regression safety","responsibilities":["Map acceptance criteria to risk-based checks of user journeys and affected integration boundaries","Exercise success, boundary, invalid-input, permission, and recovery paths as relevant","Run checks in isolated environments and distinguish product defects from environment limitations","Report reproducible failures with expected and actual behavior and verify fixes against them","Return passed, failed, and not-run results with artifact identity, evidence, and remaining coverage gaps"],"title":"Quality Assurance"}]},"pipelines":[{"defaultFor":["feature","maintenance"],"description":"Plan, implement, review, and verify product changes","enforcement":"enforced","id":"delivery","name":"Feature delivery","stages":[{"capabilities":[],"checks":["Dependencies and security boundaries are explicit"],"id":"design","name":"Design","objective":"Define the smallest coherent change and its acceptance criteria","requiresApproval":false,"roleId":"architect"},{"capabilities":[],"checks":["Relevant tests pass","Typecheck passes"],"id":"implement","name":"Implement","objective":"Implement the agreed change with focused tests","requiresApproval":false,"roleId":"developer"},{"capabilities":[],"checks":["No unresolved blocking findings remain"],"id":"review","name":"Review","objective":"Review correctness, security, and scope","requiresApproval":true,"roleId":"reviewer"},{"capabilities":[],"checks":["Full relevant check suite passes"],"id":"verify","name":"Verify","objective":"Validate acceptance criteria and regression safety","requiresApproval":false,"roleId":"qa"}]},{"defaultFor":["bugfix"],"description":"Reproduce, fix, review, and verify a defect","id":"bugfix","name":"Bug fix","stages":[{"checks":["The failure is reproduced before implementation"],"id":"reproduce","name":"Reproduce","objective":"Establish a deterministic failing case","requiresApproval":false,"roleId":"qa"},{"checks":["The regression test passes"],"id":"fix","name":"Fix","objective":"Correct the root cause and add regression coverage","requiresApproval":false,"roleId":"developer"},{"checks":["No unresolved blocking findings remain"],"id":"review","name":"Review","objective":"Confirm the root cause is addressed without scope creep","requiresApproval":true,"roleId":"reviewer"}]},{"defaultFor":["research"],"description":"Investigate a question and record an evidence-based recommendation","id":"discovery","name":"Research","stages":[{"checks":["Recommendation identifies evidence and uncertainty"],"id":"investigate","name":"Investigate","objective":"Collect relevant evidence and compare viable approaches","requiresApproval":false,"roleId":"architect"}]},{"defaultFor":["release"],"description":"Review readiness, verify the build, and require a release decision","id":"release","name":"Release","stages":[{"checks":["Release scope is explicit","Blocking findings are resolved"],"id":"readiness","name":"Readiness review","objective":"Confirm scope, risks, and unresolved findings","requiresApproval":false,"roleId":"reviewer"},{"checks":["Release check suite passes"],"id":"verification","name":"Release verification","objective":"Run the release checks and verify artifacts","requiresApproval":true,"roleId":"qa"}]}],"project":{"constraints":[],"goals":["Complete the next agreed project outcome"],"mission":"Deliver reliable, reviewable software changes","permissionPreferences":["read_files","modify_files","run_tests"],"preferences":["Prefer small changes with relevant automated tests"]},"provenance":{"host":"codex","skill":"ai-office","skillVersion":"1"},"schemaVersion":1}','codex','ai-office','1','2026-09-01T00:00:02.000Z');
CREATE TABLE project_memory_reference (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type = 'pattern'),
  target_id TEXT NOT NULL,
  target_version INTEGER NOT NULL CHECK (target_version >= 1),
  reference_type TEXT NOT NULL CHECK (reference_type = 'adopted'),
  query TEXT,
  usage_count INTEGER NOT NULL DEFAULT 1 CHECK (usage_count >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (
    project_id,
    target_type,
    target_id,
    target_version,
    reference_type
  )
);
CREATE TABLE project_repository_identity (
  repository_id TEXT PRIMARY KEY CHECK (length(trim(repository_id)) > 0),
  project_id TEXT NOT NULL UNIQUE REFERENCES project(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
INSERT INTO "project_repository_identity"("repository_id","project_id","created_at") VALUES ('repo_legacy-development-fixture','legacy-project','2026-09-01T00:00:01.000Z');
CREATE TABLE project_checkout_detachment (
  local_path TEXT PRIMARY KEY CHECK (length(trim(local_path)) > 0),
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  detached_at TEXT NOT NULL
);
CREATE TABLE pipeline_run (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES task(id),
  manifest_revision_id TEXT NOT NULL,
  manifest_revision INTEGER NOT NULL CHECK (manifest_revision > 0),
  definition_json TEXT NOT NULL CHECK (
    json_valid(definition_json) AND json_type(definition_json) = 'object'
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled')),
  current_stage_index INTEGER NOT NULL CHECK (current_stage_index >= 0),
  started_by TEXT NOT NULL CHECK (length(trim(started_by)) > 0),
  version INTEGER NOT NULL CHECK (version > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  cancelled_at TEXT,
  UNIQUE(project_id, id),
  FOREIGN KEY(project_id, manifest_revision_id)
    REFERENCES office_manifest_revision(project_id, id),
  CHECK (
    (status = 'active' AND completed_at IS NULL AND cancelled_at IS NULL)
    OR (status = 'completed' AND completed_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status = 'cancelled' AND completed_at IS NULL AND cancelled_at IS NOT NULL)
  )
);
INSERT INTO "pipeline_run"("id","project_id","task_id","manifest_revision_id","manifest_revision","definition_json","status","current_stage_index","started_by","version","created_at","updated_at","completed_at","cancelled_at") VALUES ('legacy-id-0009','legacy-project','task-approved-pipeline','legacy-id-0001',1,'{"defaultFor":["feature","maintenance"],"description":"Plan, implement, review, and verify product changes","enforcement":"enforced","id":"delivery","name":"Feature delivery","stages":[{"capabilities":[],"checks":["Dependencies and security boundaries are explicit"],"id":"design","name":"Design","objective":"Define the smallest coherent change and its acceptance criteria","requiresApproval":false,"roleId":"architect"},{"capabilities":[],"checks":["Relevant tests pass","Typecheck passes"],"id":"implement","name":"Implement","objective":"Implement the agreed change with focused tests","requiresApproval":false,"roleId":"developer"},{"capabilities":[],"checks":["No unresolved blocking findings remain"],"id":"review","name":"Review","objective":"Review correctness, security, and scope","requiresApproval":true,"roleId":"reviewer"},{"capabilities":[],"checks":["Full relevant check suite passes"],"id":"verify","name":"Verify","objective":"Validate acceptance criteria and regression safety","requiresApproval":false,"roleId":"qa"}]}','active',3,'local-operator',7,'2026-09-01T00:00:22.000Z','2026-09-01T00:00:46.000Z',NULL,NULL);
INSERT INTO "pipeline_run"("id","project_id","task_id","manifest_revision_id","manifest_revision","definition_json","status","current_stage_index","started_by","version","created_at","updated_at","completed_at","cancelled_at") VALUES ('legacy-id-0030','legacy-project','task-active-pipeline','legacy-id-0001',1,'{"defaultFor":["feature","maintenance"],"description":"Plan, implement, review, and verify product changes","enforcement":"enforced","id":"delivery","name":"Feature delivery","stages":[{"capabilities":[],"checks":["Dependencies and security boundaries are explicit"],"id":"design","name":"Design","objective":"Define the smallest coherent change and its acceptance criteria","requiresApproval":false,"roleId":"architect"},{"capabilities":[],"checks":["Relevant tests pass","Typecheck passes"],"id":"implement","name":"Implement","objective":"Implement the agreed change with focused tests","requiresApproval":false,"roleId":"developer"},{"capabilities":[],"checks":["No unresolved blocking findings remain"],"id":"review","name":"Review","objective":"Review correctness, security, and scope","requiresApproval":true,"roleId":"reviewer"},{"capabilities":[],"checks":["Full relevant check suite passes"],"id":"verify","name":"Verify","objective":"Validate acceptance criteria and regression safety","requiresApproval":false,"roleId":"qa"}]}','active',0,'local-operator',1,'2026-09-01T00:00:51.000Z','2026-09-01T00:00:51.000Z',NULL,NULL);
CREATE TABLE pipeline_stage_run (
  id TEXT PRIMARY KEY,
  pipeline_run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  stage_id TEXT NOT NULL CHECK (length(trim(stage_id)) > 0),
  stage_index INTEGER NOT NULL CHECK (stage_index >= 0),
  role_id TEXT NOT NULL CHECK (length(trim(role_id)) > 0),
  status TEXT NOT NULL CHECK (
    status IN ('pending', 'active', 'awaiting_approval', 'completed', 'cancelled')
  ),
  assigned_agent_id TEXT,
  assigned_at TEXT,
  completed_at TEXT,
  approved_by TEXT,
  approval_decision TEXT CHECK (approval_decision IN ('approved', 'rejected')),
  approval_rationale TEXT,
  approved_at TEXT,
  UNIQUE(project_id, id),
  UNIQUE(pipeline_run_id, stage_index),
  UNIQUE(pipeline_run_id, stage_id),
  FOREIGN KEY(project_id, pipeline_run_id)
    REFERENCES pipeline_run(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY(project_id, assigned_agent_id)
    REFERENCES agent(project_id, id),
  CHECK ((assigned_agent_id IS NULL) = (assigned_at IS NULL)),
  CHECK ((approved_by IS NULL) = (approved_at IS NULL)),
  CHECK ((approved_by IS NULL) = (approval_decision IS NULL)),
  CHECK (approval_rationale IS NULL OR approved_by IS NOT NULL),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL))
);
INSERT INTO "pipeline_stage_run"("id","pipeline_run_id","project_id","stage_id","stage_index","role_id","status","assigned_agent_id","assigned_at","completed_at","approved_by","approval_decision","approval_rationale","approved_at") VALUES ('legacy-id-0010','legacy-id-0009','legacy-project','design',0,'architect','completed',NULL,NULL,'2026-09-01T00:00:25.000Z',NULL,NULL,NULL,NULL);
INSERT INTO "pipeline_stage_run"("id","pipeline_run_id","project_id","stage_id","stage_index","role_id","status","assigned_agent_id","assigned_at","completed_at","approved_by","approval_decision","approval_rationale","approved_at") VALUES ('legacy-id-0011','legacy-id-0009','legacy-project','implement',1,'developer','completed','agent:legacy-project:developer','2026-09-01T00:00:29.000Z','2026-09-01T00:00:35.000Z',NULL,NULL,NULL,NULL);
INSERT INTO "pipeline_stage_run"("id","pipeline_run_id","project_id","stage_id","stage_index","role_id","status","assigned_agent_id","assigned_at","completed_at","approved_by","approval_decision","approval_rationale","approved_at") VALUES ('legacy-id-0012','legacy-id-0009','legacy-project','review',2,'reviewer','completed','agent:legacy-project:reviewer','2026-09-01T00:00:38.000Z','2026-09-01T00:00:46.000Z','local-operator','approved','Review accepted','2026-09-01T00:00:46.000Z');
INSERT INTO "pipeline_stage_run"("id","pipeline_run_id","project_id","stage_id","stage_index","role_id","status","assigned_agent_id","assigned_at","completed_at","approved_by","approval_decision","approval_rationale","approved_at") VALUES ('legacy-id-0013','legacy-id-0009','legacy-project','verify',3,'qa','active',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "pipeline_stage_run"("id","pipeline_run_id","project_id","stage_id","stage_index","role_id","status","assigned_agent_id","assigned_at","completed_at","approved_by","approval_decision","approval_rationale","approved_at") VALUES ('legacy-id-0031','legacy-id-0030','legacy-project','design',0,'architect','active',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "pipeline_stage_run"("id","pipeline_run_id","project_id","stage_id","stage_index","role_id","status","assigned_agent_id","assigned_at","completed_at","approved_by","approval_decision","approval_rationale","approved_at") VALUES ('legacy-id-0032','legacy-id-0030','legacy-project','implement',1,'developer','pending',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "pipeline_stage_run"("id","pipeline_run_id","project_id","stage_id","stage_index","role_id","status","assigned_agent_id","assigned_at","completed_at","approved_by","approval_decision","approval_rationale","approved_at") VALUES ('legacy-id-0033','legacy-id-0030','legacy-project','review',2,'reviewer','pending',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "pipeline_stage_run"("id","pipeline_run_id","project_id","stage_id","stage_index","role_id","status","assigned_agent_id","assigned_at","completed_at","approved_by","approval_decision","approval_rationale","approved_at") VALUES ('legacy-id-0034','legacy-id-0030','legacy-project','verify',3,'qa','pending',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
CREATE TABLE pipeline_override (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  pipeline_run_id TEXT NOT NULL,
  stage_run_id TEXT NOT NULL,
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  previous_rule TEXT NOT NULL CHECK (length(trim(previous_rule)) > 0),
  resulting_authorization TEXT NOT NULL CHECK (length(trim(resulting_authorization)) > 0),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  FOREIGN KEY(project_id, pipeline_run_id)
    REFERENCES pipeline_run(project_id, id),
  FOREIGN KEY(project_id, stage_run_id)
    REFERENCES pipeline_stage_run(project_id, id)
);
INSERT INTO "pipeline_override"("id","project_id","pipeline_run_id","stage_run_id","actor_id","reason","previous_rule","resulting_authorization","created_at") VALUES ('legacy-id-0016','legacy-project','legacy-id-0009','legacy-id-0010','local-operator','Design agreed before the office existed','pipeline_agent_not_assigned','stage_completed','2026-09-01T00:00:25.000Z');
CREATE TABLE project_state_revision_identity (
  revision_id TEXT PRIMARY KEY CHECK (length(trim(revision_id)) > 0),
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  UNIQUE(revision_id, project_id)
);
CREATE TABLE "project_state_revision" (
  id TEXT PRIMARY KEY CHECK (length(trim(id)) > 0),
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  parent_revision_id TEXT,
  state_checksum TEXT NOT NULL CHECK (
    length(state_checksum) = 64
    AND state_checksum NOT GLOB '*[^0-9a-f]*'
  ),
  origin TEXT NOT NULL CHECK (origin IN ('local_snapshot', 'portable_import')),
  created_at TEXT NOT NULL,
  UNIQUE(project_id, id),
  FOREIGN KEY(id, project_id)
    REFERENCES project_state_revision_identity(revision_id, project_id)
      ON DELETE CASCADE,
  FOREIGN KEY(parent_revision_id, project_id)
    REFERENCES project_state_revision_identity(revision_id, project_id)
      ON DELETE CASCADE
);
CREATE TABLE "project_state_head" (
  project_id TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  base_revision_id TEXT,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id, revision_id)
    REFERENCES "project_state_revision"(project_id, id)
      ON DELETE CASCADE,
  FOREIGN KEY(base_revision_id, project_id)
    REFERENCES project_state_revision_identity(revision_id, project_id)
      ON DELETE CASCADE
);
CREATE TABLE task_requirement (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  requirement_id TEXT NOT NULL REFERENCES requirement(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, requirement_id)
);
CREATE TABLE agent_run_memory_retrieval (
  run_id TEXT PRIMARY KEY REFERENCES agent_run(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (
    length(provider) BETWEEN 1 AND 64 AND provider NOT GLOB '*[^a-z0-9-]*'
  ),
  provider_version TEXT CHECK (
    provider_version IS NULL OR length(provider_version) BETWEEN 1 AND 64
  ),
  memory_project_id TEXT CHECK (
    memory_project_id IS NULL OR length(memory_project_id) BETWEEN 1 AND 64
  ),
  scope TEXT NOT NULL CHECK (scope = 'project'),
  outcome TEXT NOT NULL CHECK (outcome IN ('retrieved', 'empty', 'failed', 'skipped')),
  error_code TEXT CHECK (
    error_code IS NULL OR (
      length(error_code) BETWEEN 1 AND 64 AND error_code NOT GLOB '*[^A-Z0-9_]*'
    )
  ),
  context_query_sha256 TEXT CHECK (
    context_query_sha256 IS NULL OR (
      length(context_query_sha256) = 64 AND context_query_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  result_count INTEGER NOT NULL CHECK (result_count BETWEEN 0 AND 50),
  injected_count INTEGER NOT NULL CHECK (injected_count BETWEEN 0 AND result_count),
  injected_characters INTEGER NOT NULL CHECK (injected_characters >= 0),
  created_at TEXT NOT NULL, provider_query_sha256 TEXT CHECK (
  provider_query_sha256 IS NULL OR (
    length(provider_query_sha256) = 64
    AND provider_query_sha256 NOT GLOB '*[^0-9a-f]*'
  )
),
  -- A failure or skip never pretends that anything was retrieved.
  CHECK (
    (outcome = 'retrieved' AND error_code IS NULL AND injected_count > 0
      AND memory_project_id IS NOT NULL AND context_query_sha256 IS NOT NULL)
    OR (outcome = 'empty' AND error_code IS NULL AND injected_count = 0
      AND injected_characters = 0 AND memory_project_id IS NOT NULL
      AND context_query_sha256 IS NOT NULL)
    OR (outcome IN ('failed', 'skipped') AND error_code IS NOT NULL
      AND result_count = 0 AND injected_count = 0 AND injected_characters = 0)
  )
);
CREATE TABLE agent_run_memory_reference (
  run_id TEXT NOT NULL REFERENCES agent_run_memory_retrieval(run_id) ON DELETE CASCADE,
  rank INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 50),
  reference_id TEXT NOT NULL CHECK (length(reference_id) BETWEEN 1 AND 256),
  content_digest TEXT CHECK (
    content_digest IS NULL OR length(content_digest) BETWEEN 1 AND 256
  ),
  scope TEXT NOT NULL CHECK (length(scope) BETWEEN 1 AND 64),
  injected INTEGER NOT NULL CHECK (injected IN (0, 1)),
  truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
  PRIMARY KEY (run_id, rank)
);
CREATE TABLE job_outbox (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL CHECK (job_type IN ('orchestrate_pipeline', 'execute_agent_run')),
  aggregate_type TEXT NOT NULL CHECK (aggregate_type IN ('pipeline_run', 'agent_run')),
  aggregate_id TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (
    json_valid(payload_json) AND json_type(payload_json) = 'object'
    AND length(payload_json) <= 4096
  ),
  available_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  dispatched_at TEXT,
  created_at TEXT NOT NULL, pipeline_stage_run_id TEXT
  REFERENCES pipeline_stage_run(id),
  UNIQUE(project_id, dedupe_key)
);
CREATE TABLE task_dependency (
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depends_on_task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE TABLE "governance_event" (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'milestone.created', 'milestone.status_changed', 'milestone.title_changed',
    'milestone.description_changed',
    'requirement.created', 'requirement.status_changed',
    'adr.created', 'adr.status_changed',
    'review.created', 'review.decided'
  )),
  aggregate_id TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
  occurred_at TEXT NOT NULL
);
INSERT INTO "governance_event"("id","project_id","event_type","aggregate_id","metadata_json","occurred_at") VALUES ('milestone:legacy-id-0003:created','legacy-project','milestone.created','legacy-id-0003','{}','2026-09-01T00:00:06.000Z');
INSERT INTO "governance_event"("id","project_id","event_type","aggregate_id","metadata_json","occurred_at") VALUES ('requirement:legacy-id-0004:created','legacy-project','requirement.created','legacy-id-0004','{"key":"LEG-1"}','2026-09-01T00:00:07.000Z');
INSERT INTO "governance_event"("id","project_id","event_type","aggregate_id","metadata_json","occurred_at") VALUES ('review:legacy-id-0005:created','legacy-project','review.created','legacy-id-0005','{"subjectType":"requirement","subjectId":"legacy-id-0004"}','2026-09-01T00:00:08.000Z');
INSERT INTO "governance_event"("id","project_id","event_type","aggregate_id","metadata_json","occurred_at") VALUES ('review:legacy-id-0005:decided','legacy-project','review.decided','legacy-id-0005','{"decision":"approved"}','2026-09-01T00:00:09.000Z');
INSERT INTO "governance_event"("id","project_id","event_type","aggregate_id","metadata_json","occurred_at") VALUES ('review:legacy-id-0007:created','legacy-project','review.created','legacy-id-0007','{"subjectType":"milestone","subjectId":"legacy-id-0003"}','2026-09-01T00:00:10.000Z');
INSERT INTO "governance_event"("id","project_id","event_type","aggregate_id","metadata_json","occurred_at") VALUES ('review:legacy-id-0007:decided','legacy-project','review.decided','legacy-id-0007','{"decision":"rejected"}','2026-09-01T00:00:11.000Z');
CREATE TABLE task_execution_history (
  task_id TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('unknown', 'executed')),
  first_known_at TEXT,
  CHECK (state = 'executed' OR first_known_at IS NULL)
);
INSERT INTO "task_execution_history"("task_id","project_id","state","first_known_at") VALUES ('task-blocked','legacy-project','executed','2026-09-01T00:00:18.000Z');
INSERT INTO "task_execution_history"("task_id","project_id","state","first_known_at") VALUES ('task-approved-pipeline','legacy-project','executed','2026-09-01T00:00:22.000Z');
INSERT INTO "task_execution_history"("task_id","project_id","state","first_known_at") VALUES ('task-active-pipeline','legacy-project','executed','2026-09-01T00:00:51.000Z');
CREATE INDEX task_project_status_priority_idx
ON task(project_id, status, priority DESC);
CREATE INDEX project_profile_project_category_idx
ON project_profile_entry(project_id, category, key);
CREATE UNIQUE INDEX project_source_local_path_unique_idx
ON project_source(local_path)
WHERE local_path IS NOT NULL;
CREATE UNIQUE INDEX project_question_open_unique_idx
ON project_question(project_id, key)
WHERE answer_json IS NULL;
CREATE INDEX audit_event_occurred_at_idx
ON audit_event(occurred_at, id);
CREATE INDEX audit_event_project_occurred_at_idx
ON audit_event(project_id, occurred_at, id);
CREATE TRIGGER audit_event_prevent_update
BEFORE UPDATE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;
CREATE TRIGGER audit_event_prevent_delete
BEFORE DELETE ON audit_event
BEGIN
  SELECT RAISE(ABORT, 'audit_event is append-only');
END;
CREATE INDEX agent_run_project_status_idx
ON agent_run(project_id, status, created_at, id);
CREATE INDEX agent_run_event_run_idx ON agent_run_event(run_id, occurred_at, id);
CREATE TRIGGER agent_run_event_prevent_update BEFORE UPDATE ON agent_run_event
BEGIN SELECT RAISE(ABORT, 'agent_run_event is append-only'); END;
CREATE TRIGGER agent_run_event_prevent_delete BEFORE DELETE ON agent_run_event
BEGIN SELECT RAISE(ABORT, 'agent_run_event is append-only'); END;
CREATE INDEX budget_reservation_budget_status_idx
ON budget_reservation(budget_id, status);
CREATE INDEX cost_event_project_occurred_at_idx
ON cost_event(project_id, occurred_at, id);
CREATE INDEX governance_project_idx ON milestone(project_id, status, created_at);
CREATE INDEX requirement_project_idx ON requirement(project_id, status, requirement_key);
CREATE INDEX adr_project_idx ON architecture_decision(project_id, status, created_at);
CREATE INDEX agent_run_recovery_idx
ON agent_run(status, updated_at, id)
WHERE status IN ('preparing', 'running', 'reviewing');
CREATE INDEX task_lock_expiry_idx ON task_lock(expires_at, task_id);
CREATE TRIGGER agent_role_same_project_insert
BEFORE INSERT ON agent
WHEN NOT EXISTS (
  SELECT 1 FROM role
  WHERE role.id = NEW.role_id AND role.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent role must belong to the same project');
END;
CREATE TRIGGER agent_role_same_project_update
BEFORE UPDATE OF project_id, role_id ON agent
WHEN NOT EXISTS (
  SELECT 1 FROM role
  WHERE role.id = NEW.role_id AND role.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent role must belong to the same project');
END;
CREATE TRIGGER agent_run_ownership_insert
BEFORE INSERT ON agent_run
WHEN NOT EXISTS (
  SELECT 1 FROM task
  WHERE task.id = NEW.task_id AND task.project_id = NEW.project_id
) OR NOT EXISTS (
  SELECT 1 FROM agent
  WHERE agent.id = NEW.agent_id AND agent.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent run references must belong to the same project');
END;
CREATE TRIGGER agent_run_ownership_update
BEFORE UPDATE OF project_id, task_id, agent_id ON agent_run
WHEN NOT EXISTS (
  SELECT 1 FROM task
  WHERE task.id = NEW.task_id AND task.project_id = NEW.project_id
) OR NOT EXISTS (
  SELECT 1 FROM agent
  WHERE agent.id = NEW.agent_id AND agent.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'agent run references must belong to the same project');
END;
CREATE INDEX budget_reservation_expiry_idx
ON budget_reservation(status, expires_at, budget_id);
CREATE INDEX model_usage_task_cost_idx ON model_usage(project_id, task_id, occurred_at);
CREATE INDEX model_usage_agent_cost_idx ON model_usage(project_id, agent_id, occurred_at);
CREATE INDEX model_usage_run_cost_idx ON model_usage(project_id, agent_run_id, occurred_at);
CREATE TRIGGER pricing_version_no_overlap_insert
BEFORE INSERT ON pricing_version
WHEN EXISTS (
  SELECT 1 FROM pricing_version p
  WHERE p.provider = NEW.provider
    AND p.model = NEW.model
    AND p.currency = NEW.currency
    AND COALESCE(p.effective_to, '9999-12-31T23:59:59.999Z') > NEW.effective_from
    AND COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z') > p.effective_from
)
BEGIN SELECT RAISE(ABORT, 'pricing interval overlaps an existing version'); END;
CREATE TRIGGER pricing_version_no_overlap_update
BEFORE UPDATE OF provider, model, currency, effective_from, effective_to ON pricing_version
WHEN EXISTS (
  SELECT 1 FROM pricing_version p
  WHERE p.id <> NEW.id
    AND p.provider = NEW.provider
    AND p.model = NEW.model
    AND p.currency = NEW.currency
    AND COALESCE(p.effective_to, '9999-12-31T23:59:59.999Z') > NEW.effective_from
    AND COALESCE(NEW.effective_to, '9999-12-31T23:59:59.999Z') > p.effective_from
)
BEGIN SELECT RAISE(ABORT, 'pricing interval overlaps an existing version'); END;
CREATE TRIGGER budget_scope_valid_insert
BEFORE INSERT ON budget
WHEN NEW.scope_type = 'milestone'
  OR (NEW.scope_type = 'project' AND NEW.scope_id <> NEW.project_id)
  OR (NEW.scope_type = 'task' AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.scope_id AND project_id=NEW.project_id))
  OR (NEW.scope_type = 'agent' AND NOT EXISTS (SELECT 1 FROM agent WHERE id=NEW.scope_id AND project_id=NEW.project_id))
  OR (NEW.scope_type = 'agent_run' AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.scope_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'invalid or cross-project budget scope'); END;
CREATE TRIGGER budget_scope_valid_update
BEFORE UPDATE OF project_id, scope_type, scope_id ON budget
WHEN NEW.scope_type = 'milestone'
  OR (NEW.scope_type = 'project' AND NEW.scope_id <> NEW.project_id)
  OR (NEW.scope_type = 'task' AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.scope_id AND project_id=NEW.project_id))
  OR (NEW.scope_type = 'agent' AND NOT EXISTS (SELECT 1 FROM agent WHERE id=NEW.scope_id AND project_id=NEW.project_id))
  OR (NEW.scope_type = 'agent_run' AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.scope_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'invalid or cross-project budget scope'); END;
CREATE TRIGGER model_usage_ownership_insert
BEFORE INSERT ON model_usage
WHEN (NEW.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.task_id AND project_id=NEW.project_id))
  OR (NEW.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent WHERE id=NEW.agent_id AND project_id=NEW.project_id))
  OR (NEW.agent_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.agent_run_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'model usage references must belong to the same project'); END;
CREATE TRIGGER model_usage_ownership_update
BEFORE UPDATE OF project_id, task_id, agent_id, agent_run_id ON model_usage
WHEN (NEW.task_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.task_id AND project_id=NEW.project_id))
  OR (NEW.agent_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent WHERE id=NEW.agent_id AND project_id=NEW.project_id))
  OR (NEW.agent_run_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.agent_run_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'model usage references must belong to the same project'); END;
CREATE TRIGGER budget_reservation_expiry_required_insert
BEFORE INSERT ON budget_reservation
WHEN NEW.expires_at IS NULL
BEGIN SELECT RAISE(ABORT, 'budget reservation expiry is required'); END;
CREATE TRIGGER budget_reservation_expiry_required_update
BEFORE UPDATE OF expires_at ON budget_reservation
WHEN NEW.expires_at IS NULL
BEGIN SELECT RAISE(ABORT, 'budget reservation expiry is required'); END;
CREATE TRIGGER model_usage_provider_request_unique
BEFORE INSERT ON model_usage
WHEN NEW.provider_request_id IS NOT NULL AND EXISTS (
  SELECT 1 FROM model_usage
  WHERE provider=NEW.provider AND provider_request_id=NEW.provider_request_id
)
BEGIN SELECT RAISE(ABORT, 'duplicate provider usage'); END;
CREATE UNIQUE INDEX milestone_project_id_unique
ON milestone(project_id, id);
CREATE TRIGGER requirement_milestone_ownership_insert
BEFORE INSERT ON requirement
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM milestone
  WHERE id = NEW.milestone_id AND project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'requirement milestone must belong to the same project'); END;
CREATE TRIGGER requirement_milestone_ownership_update
BEFORE UPDATE OF project_id, milestone_id ON requirement
WHEN NEW.milestone_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM milestone
  WHERE id = NEW.milestone_id AND project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'requirement milestone must belong to the same project'); END;
CREATE INDEX review_project_idx ON review(project_id, status, created_at);
CREATE TRIGGER review_subject_valid_insert
BEFORE INSERT ON review
WHEN
  (NEW.subject_type = 'task' AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'agent_run' AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'requirement' AND NOT EXISTS (SELECT 1 FROM requirement WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'adr' AND NOT EXISTS (SELECT 1 FROM architecture_decision WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'milestone' AND NOT EXISTS (SELECT 1 FROM milestone WHERE id=NEW.subject_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'review subject does not exist in the same project'); END;
CREATE TRIGGER review_subject_valid_update
BEFORE UPDATE OF project_id, subject_type, subject_id ON review
WHEN
  (NEW.subject_type = 'task' AND NOT EXISTS (SELECT 1 FROM task WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'agent_run' AND NOT EXISTS (SELECT 1 FROM agent_run WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'requirement' AND NOT EXISTS (SELECT 1 FROM requirement WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'adr' AND NOT EXISTS (SELECT 1 FROM architecture_decision WHERE id=NEW.subject_id AND project_id=NEW.project_id))
  OR (NEW.subject_type = 'milestone' AND NOT EXISTS (SELECT 1 FROM milestone WHERE id=NEW.subject_id AND project_id=NEW.project_id))
BEGIN SELECT RAISE(ABORT, 'review subject does not exist in the same project'); END;
CREATE TRIGGER approval_finalize_review
AFTER INSERT ON approval
BEGIN
  UPDATE review
  SET status = NEW.decision,
      completed_at = NEW.created_at
  WHERE id = NEW.review_id
    AND project_id = NEW.project_id
    AND status = 'pending';
  SELECT CASE WHEN changes() <> 1
    THEN RAISE(ABORT, 'review is already finalized') END;
END;
CREATE TRIGGER review_terminal_status_requires_decision
BEFORE UPDATE OF status ON review
WHEN NEW.status IN ('approved', 'rejected') AND NOT EXISTS (
  SELECT 1 FROM approval
  WHERE review_id = NEW.id
    AND project_id = NEW.project_id
    AND decision = NEW.status
)
BEGIN SELECT RAISE(ABORT, 'review status requires a matching decision'); END;
CREATE TRIGGER review_pending_status_forbids_decision
BEFORE UPDATE OF status ON review
WHEN NEW.status = 'pending' AND EXISTS (
  SELECT 1 FROM approval
  WHERE review_id = NEW.id AND project_id = NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'decided review cannot return to pending'); END;
CREATE TRIGGER approval_prevent_update
BEFORE UPDATE ON approval
BEGIN SELECT RAISE(ABORT, 'approval is append-only'); END;
CREATE TRIGGER approval_prevent_delete
BEFORE DELETE ON approval
BEGIN SELECT RAISE(ABORT, 'approval is append-only'); END;
CREATE TRIGGER adr_superseded_ownership_insert
BEFORE INSERT ON architecture_decision
WHEN NEW.superseded_by_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM architecture_decision
  WHERE id=NEW.superseded_by_id AND project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'superseding ADR must belong to the same project'); END;
CREATE TRIGGER adr_superseded_ownership_update
BEFORE UPDATE OF project_id, superseded_by_id ON architecture_decision
WHEN NEW.superseded_by_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM architecture_decision
  WHERE id=NEW.superseded_by_id AND project_id=NEW.project_id
)
BEGIN SELECT RAISE(ABORT, 'superseding ADR must belong to the same project'); END;
CREATE UNIQUE INDEX role_project_id_unique
ON role(project_id, id);
CREATE UNIQUE INDEX agent_project_id_unique
ON agent(project_id, id);
CREATE TRIGGER agent_role_identity_guard_m6a
BEFORE UPDATE OF id, project_id ON role
WHEN EXISTS (SELECT 1 FROM agent WHERE role_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'role assigned to agents cannot change identity'); END;
CREATE TRIGGER capability_grant_agent_delete_guard
BEFORE DELETE ON agent
WHEN EXISTS (
  SELECT 1 FROM capability_grants
  WHERE principal_type = 'agent' AND principal_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'agent has capability grants'); END;
CREATE TRIGGER capability_grant_role_delete_guard
BEFORE DELETE ON role
WHEN EXISTS (
  SELECT 1 FROM capability_grants
  WHERE principal_type = 'role' AND principal_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'role has capability grants'); END;
CREATE TRIGGER capability_grant_agent_identity_guard
BEFORE UPDATE OF id, project_id ON agent
WHEN EXISTS (
  SELECT 1 FROM capability_grants
  WHERE principal_type = 'agent' AND principal_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'agent with capability grants cannot change identity'); END;
CREATE TRIGGER capability_grant_role_identity_guard
BEFORE UPDATE OF id, project_id ON role
WHEN EXISTS (
  SELECT 1 FROM capability_grants
  WHERE principal_type = 'role' AND principal_id = OLD.id
)
BEGIN SELECT RAISE(ABORT, 'role with capability grants cannot change identity'); END;
CREATE INDEX resources_project_status_idx
ON resources(project_id, status, created_at, id);
CREATE INDEX resources_project_created_idx
ON resources(project_id, created_at, id);
CREATE INDEX capability_grants_project_principal_idx
ON capability_grants(project_id, principal_type, principal_id, created_at, id);
CREATE INDEX capability_grants_project_resource_idx
ON capability_grants(project_id, resource_id, created_at, id);
CREATE INDEX capability_grants_validity_idx
ON capability_grants(project_id, revoked_at, expires_at, valid_from);
CREATE TRIGGER resources_configuration_safe_insert
BEFORE INSERT ON resources
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.configuration_json)
  WHERE key IS NOT NULL AND (
    key IN ('__proto__', 'constructor', 'prototype')
    OR lower(replace(replace(replace(key, '_', ''), '-', ''), ' ', '')) IN (
      'apikey', 'authorization', 'credential', 'credentialref', 'credentials',
      'password', 'secret', 'token'
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'resource configuration contains a forbidden field'); END;
CREATE TRIGGER resources_configuration_safe_update
BEFORE UPDATE OF configuration_json ON resources
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.configuration_json)
  WHERE key IS NOT NULL AND (
    key IN ('__proto__', 'constructor', 'prototype')
    OR lower(replace(replace(replace(key, '_', ''), '-', ''), ' ', '')) IN (
      'apikey', 'authorization', 'credential', 'credentialref', 'credentials',
      'password', 'secret', 'token'
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'resource configuration contains a forbidden field'); END;
CREATE TRIGGER resources_immutable_fields
BEFORE UPDATE OF id, project_id, type, provider, external_ref, display_name,
  configuration_json, credential_ref, created_at ON resources
BEGIN SELECT RAISE(ABORT, 'resource registration fields are immutable'); END;
CREATE TRIGGER resources_status_transition
BEFORE UPDATE OF status ON resources
WHEN NEW.status <> OLD.status
  AND NOT (OLD.status = 'active' AND NEW.status = 'disabled')
BEGIN SELECT RAISE(ABORT, 'invalid resource status transition'); END;
CREATE TRIGGER resources_timestamp_with_status
BEFORE UPDATE OF updated_at ON resources
WHEN NEW.status = OLD.status AND NEW.updated_at IS NOT OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'resource timestamp requires a status transition'); END;
CREATE TRIGGER resources_prevent_delete
BEFORE DELETE ON resources
BEGIN SELECT RAISE(ABORT, 'resource registry entries cannot be deleted'); END;
CREATE TRIGGER capability_grant_actions_valid_insert
BEFORE INSERT ON capability_grants
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.actions_json)
  WHERE type <> 'text' OR length(trim(value)) = 0
)
BEGIN SELECT RAISE(ABORT, 'capability actions must be non-empty strings'); END;
CREATE TRIGGER capability_grant_actions_valid_update
BEFORE UPDATE OF actions_json ON capability_grants
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.actions_json)
  WHERE type <> 'text' OR length(trim(value)) = 0
)
BEGIN SELECT RAISE(ABORT, 'capability actions must be non-empty strings'); END;
CREATE TRIGGER capability_grant_constraints_safe_insert
BEFORE INSERT ON capability_grants
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.constraints_json)
  WHERE key IN ('__proto__', 'constructor', 'prototype')
)
BEGIN SELECT RAISE(ABORT, 'capability constraints contain a forbidden field'); END;
CREATE TRIGGER capability_grant_constraints_safe_update
BEFORE UPDATE OF constraints_json ON capability_grants
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.constraints_json)
  WHERE key IN ('__proto__', 'constructor', 'prototype')
)
BEGIN SELECT RAISE(ABORT, 'capability constraints contain a forbidden field'); END;
CREATE TRIGGER capability_grant_principal_ownership_insert
BEFORE INSERT ON capability_grants
WHEN
  (NEW.principal_type = 'agent' AND NOT EXISTS (
    SELECT 1 FROM agent WHERE id=NEW.principal_id AND project_id=NEW.project_id
  )) OR
  (NEW.principal_type = 'role' AND NOT EXISTS (
    SELECT 1 FROM role WHERE id=NEW.principal_id AND project_id=NEW.project_id
  ))
BEGIN SELECT RAISE(ABORT, 'capability principal must belong to the same project'); END;
CREATE TRIGGER capability_grant_principal_ownership_update
BEFORE UPDATE OF project_id, principal_type, principal_id ON capability_grants
WHEN
  (NEW.principal_type = 'agent' AND NOT EXISTS (
    SELECT 1 FROM agent WHERE id=NEW.principal_id AND project_id=NEW.project_id
  )) OR
  (NEW.principal_type = 'role' AND NOT EXISTS (
    SELECT 1 FROM role WHERE id=NEW.principal_id AND project_id=NEW.project_id
  ))
BEGIN SELECT RAISE(ABORT, 'capability principal must belong to the same project'); END;
CREATE TRIGGER capability_grant_immutable_fields
BEFORE UPDATE OF id, project_id, principal_type, principal_id, resource_id,
  actions_json, constraints_json, valid_from, expires_at, granted_by, reason,
  created_at ON capability_grants
BEGIN SELECT RAISE(ABORT, 'capability grant fields are immutable'); END;
CREATE TRIGGER capability_grant_revocation_monotonic
BEFORE UPDATE OF revoked_at ON capability_grants
WHEN OLD.revoked_at IS NOT NULL
  OR NEW.revoked_at IS NULL
  OR NEW.revoked_at < OLD.created_at
BEGIN SELECT RAISE(ABORT, 'capability grant revocation is immutable'); END;
CREATE TRIGGER capability_grant_prevent_delete
BEFORE DELETE ON capability_grants
BEGIN SELECT RAISE(ABORT, 'capability grants cannot be deleted'); END;
CREATE INDEX action_requests_project_status_idx
ON action_requests(project_id, status, created_at, id);
CREATE INDEX action_requests_project_resource_idx
ON action_requests(project_id, resource_id, created_at, id);
CREATE INDEX action_requests_project_agent_idx
ON action_requests(project_id, agent_id, created_at, id);
CREATE INDEX action_requests_created_idx ON action_requests(created_at, id);
CREATE INDEX action_simulations_project_created_idx
ON action_simulations(project_id, created_at, id);
CREATE INDEX action_simulations_action_idx
ON action_simulations(action_request_id);
CREATE INDEX action_approvals_project_status_idx
ON action_approvals(project_id, status, requested_at, id);
CREATE INDEX action_approvals_action_idx ON action_approvals(action_request_id);
CREATE INDEX action_executions_project_status_idx
ON action_executions(project_id, status, started_at, id);
CREATE INDEX action_executions_action_idx ON action_executions(action_request_id);
CREATE TRIGGER action_request_json_safe_insert
BEFORE INSERT ON action_requests
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.normalized_arguments_json)
  WHERE key IS NOT NULL AND (
    key IN ('__proto__', 'constructor', 'prototype')
    OR lower(replace(replace(replace(key, '_', ''), '-', ''), ' ', '')) IN (
      'apikey', 'authorization', 'credential', 'credentialref', 'credentials',
      'password', 'secret', 'token'
    )
  )
) OR EXISTS (
  SELECT 1 FROM json_tree(NEW.effective_constraints_json)
  WHERE key IN ('__proto__', 'constructor', 'prototype')
)
BEGIN SELECT RAISE(ABORT, 'action request JSON contains a forbidden field'); END;
CREATE TRIGGER action_request_must_start_requested
BEFORE INSERT ON action_requests
WHEN NEW.status <> 'requested'
BEGIN SELECT RAISE(ABORT, 'action request must start requested'); END;
CREATE TRIGGER action_request_connector_matches_resource
BEFORE INSERT ON action_requests
WHEN NOT EXISTS (
  SELECT 1 FROM resources
  WHERE id=NEW.resource_id AND project_id=NEW.project_id AND provider=NEW.connector
)
BEGIN SELECT RAISE(ABORT, 'action connector must match resource provider'); END;
CREATE TRIGGER action_request_immutable_payload
BEFORE UPDATE OF id, project_id, agent_id, resource_id, connector,
  connector_version, operation, normalized_arguments_json,
  effective_constraints_json, payload_hash, decision, risk_level,
  matched_grant_ids_json, reasons_json, created_at ON action_requests
BEGIN SELECT RAISE(ABORT, 'action request payload is immutable'); END;
CREATE TRIGGER action_request_status_transition
BEFORE UPDATE OF status ON action_requests
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'requested' AND OLD.decision = 'deny' AND NEW.status = 'denied')
  OR (OLD.status = 'requested'
    AND OLD.decision IN ('allow', 'allow_simulation_only', 'allow_with_approval')
    AND NEW.status = 'authorized')
  OR (OLD.status = 'authorized' AND NEW.status = 'executing'
    AND OLD.decision = 'allow' AND OLD.connector = 'filesystem'
    AND OLD.connector_version IN ('1', '2')
    AND OLD.operation IN ('filesystem.list', 'filesystem.read', 'filesystem.search'))
  OR (OLD.status = 'authorized' AND NEW.status = 'simulating' AND (
    (OLD.connector = 'filesystem' AND OLD.connector_version = '1' AND (
      (OLD.decision = 'allow_simulation_only' AND OLD.operation IN (
        'filesystem.create', 'filesystem.write', 'filesystem.move'
      )) OR (OLD.decision = 'allow_with_approval' AND OLD.operation = 'filesystem.delete')
    ))
    OR (OLD.connector = 'filesystem' AND OLD.connector_version = '2'
      AND OLD.decision = 'allow_with_approval'
      AND OLD.operation IN (
        'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
      ))
    OR (OLD.connector = 'fake' AND OLD.connector_version = '1' AND (
      (OLD.decision = 'allow_simulation_only' AND OLD.operation = 'fake.write')
      OR (OLD.decision = 'allow_with_approval'
        AND OLD.operation IN ('fake.delete', 'fake.admin'))
    ))
  ))
  OR (OLD.status = 'simulating' AND NEW.status IN ('simulated', 'failed') AND (
    (OLD.connector = 'filesystem' AND OLD.connector_version IN ('1', '2')
      AND OLD.operation IN (
        'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
      ))
    OR (OLD.connector = 'fake' AND OLD.connector_version = '1'
      AND OLD.operation IN ('fake.write', 'fake.delete', 'fake.admin'))
  ))
  OR (OLD.status = 'simulated' AND NEW.status = 'approval_pending'
    AND OLD.decision = 'allow_with_approval' AND (
      (OLD.connector = 'filesystem' AND OLD.connector_version = '1'
        AND OLD.operation = 'filesystem.delete')
      OR (OLD.connector = 'fake' AND OLD.connector_version = '1'
        AND OLD.operation IN ('fake.delete', 'fake.admin'))
      OR (OLD.connector = 'filesystem' AND OLD.connector_version = '2'
        AND OLD.operation IN (
          'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
        ) AND EXISTS (
          SELECT 1 FROM action_approvals
          WHERE project_id=OLD.project_id AND action_request_id=OLD.id
            AND status='pending'
        ))
    ))
  OR (OLD.status = 'approval_pending' AND NEW.status = 'rejected'
    AND OLD.connector = 'filesystem' AND OLD.connector_version = '2'
    AND EXISTS (
      SELECT 1 FROM action_approvals
      WHERE project_id=OLD.project_id AND action_request_id=OLD.id
        AND status='rejected'
    ))
  OR (OLD.status = 'approval_pending' AND NEW.status = 'executing'
    AND OLD.connector = 'filesystem' AND OLD.connector_version = '2'
    AND OLD.decision = 'allow_with_approval'
    AND OLD.operation IN (
      'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
    )
    AND EXISTS (
      SELECT 1 FROM action_approvals
      WHERE project_id=OLD.project_id AND action_request_id=OLD.id
        AND status='approved'
    )
    AND EXISTS (
      SELECT 1 FROM action_executions
      WHERE project_id=OLD.project_id AND action_request_id=OLD.id
        AND status='executing'
    ))
  OR (OLD.status = 'executing' AND NEW.status IN ('completed', 'failed')
    AND OLD.connector = 'filesystem' AND OLD.connector_version IN ('1', '2')
    AND OLD.operation IN ('filesystem.list', 'filesystem.read', 'filesystem.search'))
  OR (OLD.status = 'executing'
    AND NEW.status IN ('completed', 'failed', 'execution_unknown')
    AND OLD.connector = 'filesystem' AND OLD.connector_version = '2'
    AND OLD.operation IN (
      'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
    )
    AND EXISTS (
      SELECT 1 FROM action_executions
      WHERE project_id=OLD.project_id AND action_request_id=OLD.id
        AND status=NEW.status
    ))
)
BEGIN SELECT RAISE(ABORT, 'invalid action request status transition'); END;
CREATE TRIGGER action_request_timestamp_monotonic
BEFORE UPDATE OF updated_at ON action_requests
WHEN NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'action request timestamp cannot move backwards'); END;
CREATE TRIGGER action_request_timestamp_with_transition
BEFORE UPDATE OF updated_at ON action_requests
WHEN NEW.status = OLD.status AND NEW.updated_at IS NOT OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'action request timestamp requires a status transition'); END;
CREATE TRIGGER action_request_prevent_delete
BEFORE DELETE ON action_requests
BEGIN SELECT RAISE(ABORT, 'action requests cannot be deleted'); END;
CREATE TRIGGER action_simulation_matches_action
BEFORE INSERT ON action_simulations
WHEN NOT EXISTS (
  SELECT 1 FROM action_requests
  WHERE id=NEW.action_request_id AND project_id=NEW.project_id
    AND payload_hash=NEW.authorization_payload_hash
    AND connector=NEW.connector AND connector_version=NEW.connector_version
    AND operation=NEW.operation AND status='simulating'
)
BEGIN SELECT RAISE(ABORT, 'simulation must match a simulating action request'); END;
CREATE TRIGGER action_simulation_preconditions_safe
BEFORE INSERT ON action_simulations
WHEN EXISTS (
  SELECT 1 FROM json_tree(NEW.preconditions_json)
  WHERE key IN ('__proto__', 'constructor', 'prototype')
)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.preconditions_json) AS item
  WHERE item.type <> 'object'
    OR typeof(json_extract(item.value, '$.kind')) <> 'text'
    OR json_extract(item.value, '$.kind') NOT IN ('absent', 'file')
    OR typeof(json_extract(item.value, '$.path')) <> 'text'
    OR length(json_extract(item.value, '$.path')) = 0
    OR EXISTS (
      SELECT 1 FROM json_each(item.value) AS field
      WHERE field.key NOT IN ('kind', 'path', 'sha256', 'size')
    )
    OR (json_extract(item.value, '$.kind') = 'absent' AND EXISTS (
      SELECT 1 FROM json_each(item.value) AS absent_field
      WHERE absent_field.key IN ('sha256', 'size')
    ))
    OR (json_extract(item.value, '$.kind') = 'file' AND (
      typeof(json_extract(item.value, '$.sha256')) <> 'text'
      OR length(json_extract(item.value, '$.sha256')) <> 64
      OR json_extract(item.value, '$.sha256') GLOB '*[^0-9a-f]*'
      OR typeof(json_extract(item.value, '$.size')) <> 'integer'
      OR json_extract(item.value, '$.size') < 0
    ))
)
OR EXISTS (
  SELECT 1 FROM json_each(NEW.preconditions_json) AS item
  GROUP BY json_extract(item.value, '$.path') HAVING count(*) > 1
)
BEGIN SELECT RAISE(ABORT, 'simulation preconditions contain a forbidden field'); END;
CREATE TRIGGER action_request_simulation_requires_artifact
BEFORE UPDATE OF status ON action_requests
WHEN OLD.status = 'simulating' AND NEW.status = 'simulated'
  AND NOT EXISTS (
    SELECT 1 FROM action_simulations
    WHERE action_request_id=OLD.id AND project_id=OLD.project_id
      AND authorization_payload_hash=OLD.payload_hash
      AND connector=OLD.connector AND connector_version=OLD.connector_version
      AND operation=OLD.operation
  )
BEGIN SELECT RAISE(ABORT, 'simulated action requires a matching artifact'); END;
CREATE TRIGGER action_simulation_immutable
BEFORE UPDATE ON action_simulations
BEGIN SELECT RAISE(ABORT, 'action simulations are immutable'); END;
CREATE TRIGGER action_simulation_prevent_delete
BEFORE DELETE ON action_simulations
BEGIN SELECT RAISE(ABORT, 'action simulations cannot be deleted'); END;
CREATE TRIGGER action_approval_matches_action
BEFORE INSERT ON action_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM action_requests AS request
  JOIN action_simulations AS simulation
    ON simulation.project_id=request.project_id
    AND simulation.action_request_id=request.id
  WHERE request.project_id=NEW.project_id AND request.id=NEW.action_request_id
    AND request.status='simulated' AND request.decision='allow_with_approval'
    AND request.payload_hash=NEW.action_payload_hash
    AND request.connector=NEW.connector
    AND request.connector_version=NEW.connector_version
    AND request.operation=NEW.operation
    AND simulation.id=NEW.simulation_id
    AND simulation.artifact_sha256=NEW.simulation_artifact_hash
)
BEGIN SELECT RAISE(ABORT, 'approval must match a simulated action artifact'); END;
CREATE TRIGGER action_approval_immutable_binding
BEFORE UPDATE OF id, project_id, action_request_id, simulation_id,
  action_payload_hash, simulation_artifact_hash, connector, connector_version,
  operation, requested_at ON action_approvals
BEGIN SELECT RAISE(ABORT, 'action approval binding is immutable'); END;
CREATE TRIGGER action_approval_status_transition
BEFORE UPDATE OF status, decided_at, actor ON action_approvals
WHEN NOT (
  OLD.status='pending' AND NEW.status IN ('approved', 'rejected')
  AND NEW.decided_at IS NOT NULL AND NEW.decided_at >= OLD.requested_at
  AND NEW.actor IS NOT NULL AND length(trim(NEW.actor)) > 0
)
BEGIN SELECT RAISE(ABORT, 'invalid action approval transition'); END;
CREATE TRIGGER action_approval_prevent_delete
BEFORE DELETE ON action_approvals
BEGIN SELECT RAISE(ABORT, 'action approvals cannot be deleted'); END;
CREATE TRIGGER action_execution_matches_approval
BEFORE INSERT ON action_executions
WHEN NOT EXISTS (
  SELECT 1 FROM action_requests AS request
  JOIN action_approvals AS approval
    ON approval.project_id=request.project_id
    AND approval.action_request_id=request.id
  WHERE request.project_id=NEW.project_id AND request.id=NEW.action_request_id
    AND request.status='approval_pending'
    AND request.connector='filesystem' AND request.connector_version='2'
    AND request.operation IN (
      'filesystem.create', 'filesystem.write', 'filesystem.move', 'filesystem.delete'
    )
    AND approval.id=NEW.approval_id AND approval.status='approved'
    AND approval.simulation_id=NEW.simulation_id
)
BEGIN SELECT RAISE(ABORT, 'execution must match an approved action'); END;
CREATE TRIGGER action_execution_immutable_binding
BEFORE UPDATE OF id, project_id, action_request_id, simulation_id, approval_id,
  started_at ON action_executions
BEGIN SELECT RAISE(ABORT, 'action execution binding is immutable'); END;
CREATE TRIGGER action_execution_status_transition
BEFORE UPDATE OF status, completed_at, failure_code, result_hash ON action_executions
WHEN NOT (
  OLD.status='executing'
  AND NEW.status IN ('completed', 'failed', 'execution_unknown')
  AND NEW.completed_at IS NOT NULL AND NEW.completed_at >= OLD.started_at
  AND (
    (NEW.status='completed' AND NEW.failure_code IS NULL)
    OR (NEW.status IN ('failed', 'execution_unknown')
      AND NEW.failure_code IS NOT NULL AND length(trim(NEW.failure_code)) > 0)
  )
)
BEGIN SELECT RAISE(ABORT, 'invalid action execution transition'); END;
CREATE TRIGGER action_execution_prevent_delete
BEFORE DELETE ON action_executions
BEGIN SELECT RAISE(ABORT, 'action executions cannot be deleted'); END;
CREATE UNIQUE INDEX onboarding_generation_completed_input_idx
ON onboarding_generation(project_id, input_hash)
WHERE status = 'completed';
CREATE INDEX onboarding_generation_project_round_idx
ON onboarding_generation(project_id, round, created_at, id);
CREATE UNIQUE INDEX project_question_normalized_unique_idx
ON project_question(project_id, normalized_question);
CREATE INDEX project_question_generation_idx
ON project_question(generation_id, priority, id);
CREATE TRIGGER project_question_llm_generation_required_insert
BEFORE INSERT ON project_question
WHEN (NEW.source = 'deterministic' AND NEW.generation_id IS NOT NULL)
  OR (
    NEW.source = 'llm'
    AND (
      NEW.generation_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM onboarding_generation generation
        WHERE generation.id = NEW.generation_id
          AND generation.project_id = NEW.project_id
          AND generation.status = 'completed'
      )
    )
  )
BEGIN SELECT RAISE(ABORT, 'question source and generation do not match'); END;
CREATE TRIGGER project_question_llm_generation_required_update
BEFORE UPDATE OF project_id, source, generation_id ON project_question
WHEN (NEW.source = 'deterministic' AND NEW.generation_id IS NOT NULL)
  OR (
    NEW.source = 'llm'
    AND (
      NEW.generation_id IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM onboarding_generation generation
        WHERE generation.id = NEW.generation_id
          AND generation.project_id = NEW.project_id
          AND generation.status = 'completed'
      )
    )
  )
BEGIN SELECT RAISE(ABORT, 'question source and generation do not match'); END;
CREATE TRIGGER onboarding_generation_question_ownership_update
BEFORE UPDATE OF project_id, status ON onboarding_generation
WHEN EXISTS (
  SELECT 1 FROM project_question question
  WHERE question.generation_id = NEW.id
    AND question.source = 'llm'
    AND (
      question.project_id <> NEW.project_id
      OR NEW.status <> 'completed'
    )
)
BEGIN SELECT RAISE(ABORT, 'generation update violates question ownership'); END;
CREATE TRIGGER agent_run_action_intent_immutable
BEFORE UPDATE OF action_intent_json ON agent_run
WHEN NEW.action_intent_json IS NOT OLD.action_intent_json
BEGIN SELECT RAISE(ABORT, 'agent run action intent is immutable'); END;
CREATE INDEX office_manifest_project_revision_idx
ON office_manifest_revision(project_id, revision DESC);
CREATE TRIGGER office_manifest_revision_prevent_update
BEFORE UPDATE ON office_manifest_revision
BEGIN
  SELECT RAISE(ABORT, 'office manifest revisions are immutable');
END;
CREATE INDEX project_memory_reference_project_idx
ON project_memory_reference(project_id, updated_at DESC, id);
CREATE UNIQUE INDEX office_manifest_project_id_unique
ON office_manifest_revision(project_id, id);
CREATE UNIQUE INDEX pipeline_run_active_task_idx
ON pipeline_run(project_id, task_id) WHERE status = 'active';
CREATE INDEX pipeline_run_project_status_idx
ON pipeline_run(project_id, status, created_at, id);
CREATE TRIGGER pipeline_run_immutable_definition
BEFORE UPDATE OF id, project_id, task_id, manifest_revision_id,
  manifest_revision, definition_json, started_by, created_at ON pipeline_run
BEGIN SELECT RAISE(ABORT, 'pipeline run definition is immutable'); END;
CREATE TRIGGER pipeline_run_status_transition
BEFORE UPDATE OF status ON pipeline_run
WHEN NEW.status <> OLD.status
  AND NOT (OLD.status = 'active' AND NEW.status IN ('completed', 'cancelled'))
BEGIN SELECT RAISE(ABORT, 'invalid pipeline run status transition'); END;
CREATE TRIGGER pipeline_run_version_transition
BEFORE UPDATE ON pipeline_run
WHEN NEW.version <> OLD.version + 1 OR NEW.updated_at < OLD.updated_at
BEGIN SELECT RAISE(ABORT, 'invalid pipeline run version transition'); END;
CREATE INDEX pipeline_stage_run_assignment_idx
ON pipeline_stage_run(project_id, assigned_agent_id, status, id);
CREATE UNIQUE INDEX pipeline_stage_run_one_active_idx
ON pipeline_stage_run(pipeline_run_id)
WHERE status IN ('active', 'awaiting_approval');
CREATE TRIGGER pipeline_stage_run_immutable_identity
BEFORE UPDATE OF id, pipeline_run_id, project_id, stage_id, stage_index, role_id
ON pipeline_stage_run
BEGIN SELECT RAISE(ABORT, 'pipeline stage identity is immutable'); END;
CREATE TRIGGER pipeline_stage_run_status_transition
BEFORE UPDATE OF status ON pipeline_stage_run
WHEN NEW.status <> OLD.status AND NOT (
  (OLD.status = 'pending' AND NEW.status IN ('active', 'cancelled'))
  OR (OLD.status = 'active' AND NEW.status IN (
    'awaiting_approval', 'completed', 'cancelled'
  ))
  OR (OLD.status = 'awaiting_approval' AND NEW.status IN ('completed', 'cancelled'))
)
BEGIN SELECT RAISE(ABORT, 'invalid pipeline stage status transition'); END;
CREATE TRIGGER pipeline_stage_run_assignment_once
BEFORE UPDATE OF assigned_agent_id, assigned_at ON pipeline_stage_run
WHEN (
  NEW.assigned_agent_id IS NOT OLD.assigned_agent_id
  OR NEW.assigned_at IS NOT OLD.assigned_at
) AND (
  OLD.assigned_agent_id IS NOT NULL
  OR NEW.assigned_agent_id IS NULL
  OR OLD.status <> 'active'
)
BEGIN SELECT RAISE(ABORT, 'pipeline stage assignment is immutable'); END;
CREATE TRIGGER pipeline_stage_run_approval_once
BEFORE UPDATE OF approved_by, approval_decision, approval_rationale, approved_at
ON pipeline_stage_run
WHEN (
  NEW.approved_by IS NOT OLD.approved_by
  OR NEW.approval_decision IS NOT OLD.approval_decision
  OR NEW.approval_rationale IS NOT OLD.approval_rationale
  OR NEW.approved_at IS NOT OLD.approved_at
) AND (
  OLD.approved_by IS NOT NULL
  OR NEW.approved_by IS NULL
  OR OLD.status <> 'awaiting_approval'
)
BEGIN SELECT RAISE(ABORT, 'pipeline stage approval is immutable'); END;
CREATE INDEX pipeline_override_run_idx
ON pipeline_override(project_id, pipeline_run_id, created_at, id);
CREATE TRIGGER pipeline_override_prevent_update BEFORE UPDATE ON pipeline_override
BEGIN SELECT RAISE(ABORT, 'pipeline overrides are immutable'); END;
CREATE TRIGGER pipeline_override_prevent_delete BEFORE DELETE ON pipeline_override
BEGIN SELECT RAISE(ABORT, 'pipeline overrides are append-only'); END;
CREATE TRIGGER agent_run_pipeline_binding_valid
BEFORE INSERT ON agent_run
WHEN NEW.pipeline_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM pipeline_run pr
  JOIN pipeline_stage_run psr
    ON psr.pipeline_run_id = pr.id AND psr.project_id = pr.project_id
  WHERE pr.id = NEW.pipeline_run_id
    AND pr.project_id = NEW.project_id
    AND pr.task_id = NEW.task_id
    AND pr.status = 'active'
    AND psr.stage_index = pr.current_stage_index
    AND psr.status = 'active'
    AND psr.assigned_agent_id = NEW.agent_id
)
BEGIN SELECT RAISE(ABORT, 'agent run pipeline binding is not currently assigned'); END;
CREATE TRIGGER agent_run_pipeline_binding_immutable
BEFORE UPDATE OF pipeline_run_id ON agent_run
WHEN NEW.pipeline_run_id IS NOT OLD.pipeline_run_id
BEGIN SELECT RAISE(ABORT, 'agent run pipeline binding is immutable'); END;
CREATE TRIGGER action_request_pipeline_binding_immutable
BEFORE UPDATE OF pipeline_run_id, pipeline_stage_run_id ON action_requests
WHEN NEW.pipeline_run_id IS NOT OLD.pipeline_run_id
  OR NEW.pipeline_stage_run_id IS NOT OLD.pipeline_stage_run_id
BEGIN SELECT RAISE(ABORT, 'action request pipeline binding is immutable'); END;
CREATE INDEX action_requests_agent_run_idx
ON action_requests(project_id, agent_run_id, created_at, id);
CREATE TRIGGER action_request_pipeline_binding_valid
BEFORE INSERT ON action_requests
WHEN (
  (NEW.pipeline_run_id IS NULL) <> (NEW.pipeline_stage_run_id IS NULL)
  OR (
    NEW.pipeline_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM pipeline_run pr
  JOIN pipeline_stage_run psr
    ON psr.pipeline_run_id = pr.id AND psr.project_id = pr.project_id
  WHERE pr.id = NEW.pipeline_run_id
    AND pr.project_id = NEW.project_id
    AND pr.status = 'active'
    AND psr.id = NEW.pipeline_stage_run_id
    AND psr.status IN ('active', 'awaiting_approval')
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'action request pipeline binding is inconsistent'); END;
CREATE TRIGGER action_request_agent_run_binding_valid
BEFORE INSERT ON action_requests
WHEN NEW.agent_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_run ar
  WHERE ar.id = NEW.agent_run_id
    AND ar.project_id = NEW.project_id
    AND ar.agent_id = NEW.agent_id
    AND (ar.pipeline_run_id IS NEW.pipeline_run_id)
)
BEGIN SELECT RAISE(ABORT, 'action request agent-run binding is inconsistent'); END;
CREATE TRIGGER action_request_agent_run_binding_immutable
BEFORE UPDATE OF agent_run_id ON action_requests
WHEN NEW.agent_run_id IS NOT OLD.agent_run_id
BEGIN SELECT RAISE(ABORT, 'action request agent-run binding is immutable'); END;
CREATE INDEX project_state_revision_identity_project_idx
ON project_state_revision_identity(project_id, revision_id);
CREATE INDEX project_state_revision_project_created_idx
ON project_state_revision(project_id, created_at, id);
CREATE TRIGGER project_state_revision_reserve_identity
BEFORE INSERT ON project_state_revision
BEGIN
  INSERT INTO project_state_revision_identity(revision_id, project_id)
  SELECT NEW.id, NEW.project_id
  WHERE NOT EXISTS (
    SELECT 1 FROM project_state_revision_identity WHERE revision_id = NEW.id
  );

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.id AND project_id <> NEW.project_id
  ) THEN RAISE(ABORT, 'project state revision identity belongs to another project') END;

  SELECT CASE WHEN NEW.parent_revision_id = NEW.id
    THEN RAISE(ABORT, 'project state revision cannot parent itself') END;

  INSERT INTO project_state_revision_identity(revision_id, project_id)
  SELECT NEW.parent_revision_id, NEW.project_id
  WHERE NEW.parent_revision_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM project_state_revision_identity
      WHERE revision_id = NEW.parent_revision_id
    );

  SELECT CASE WHEN NEW.parent_revision_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.parent_revision_id
      AND project_id <> NEW.project_id
  ) THEN RAISE(ABORT, 'project state parent identity belongs to another project') END;
END;
CREATE TRIGGER project_state_revision_lineage_immutable
BEFORE UPDATE OF id, project_id, parent_revision_id, state_checksum, created_at
ON project_state_revision
BEGIN
  SELECT RAISE(ABORT, 'project state revision lineage is immutable');
END;
CREATE TRIGGER project_state_head_reserve_base_identity_insert
BEFORE INSERT ON project_state_head
WHEN NEW.base_revision_id IS NOT NULL
BEGIN
  INSERT INTO project_state_revision_identity(revision_id, project_id)
  SELECT NEW.base_revision_id, NEW.project_id
  WHERE NOT EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.base_revision_id
  );

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.base_revision_id
      AND project_id <> NEW.project_id
  ) THEN RAISE(ABORT, 'project state base identity belongs to another project') END;
END;
CREATE TRIGGER project_state_head_reserve_base_identity_update
BEFORE UPDATE OF project_id, base_revision_id ON project_state_head
WHEN NEW.base_revision_id IS NOT NULL
BEGIN
  INSERT INTO project_state_revision_identity(revision_id, project_id)
  SELECT NEW.base_revision_id, NEW.project_id
  WHERE NOT EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.base_revision_id
  );

  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM project_state_revision_identity
    WHERE revision_id = NEW.base_revision_id
      AND project_id <> NEW.project_id
  ) THEN RAISE(ABORT, 'project state base identity belongs to another project') END;
END;
CREATE INDEX audit_event_aggregate_idx
ON audit_event(aggregate_id, occurred_at, id);
CREATE INDEX task_requirement_requirement_idx
ON task_requirement(requirement_id, task_id);
CREATE TRIGGER task_requirement_project_ownership_insert
BEFORE INSERT ON task_requirement
WHEN NOT EXISTS (
  SELECT 1
  FROM task t
  JOIN requirement r ON r.id = NEW.requirement_id
  WHERE t.id = NEW.task_id AND t.project_id = r.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'task and requirement must belong to the same project');
END;
CREATE TRIGGER task_requirement_project_ownership_update
BEFORE UPDATE OF task_id, requirement_id ON task_requirement
WHEN NOT EXISTS (
  SELECT 1
  FROM task t
  JOIN requirement r ON r.id = NEW.requirement_id
  WHERE t.id = NEW.task_id AND t.project_id = r.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'task and requirement must belong to the same project');
END;
CREATE TRIGGER agent_run_execution_immutable
BEFORE UPDATE OF execution_json ON agent_run
WHEN OLD.execution_json IS NOT NULL AND NEW.execution_json IS NOT OLD.execution_json
BEGIN SELECT RAISE(ABORT, 'agent run execution provenance is immutable'); END;
CREATE INDEX agent_run_memory_retrieval_project_idx
ON agent_run_memory_retrieval(project_id, created_at, run_id);
CREATE TRIGGER agent_run_memory_retrieval_project_ownership
BEFORE INSERT ON agent_run_memory_retrieval
WHEN NOT EXISTS (
  SELECT 1 FROM agent_run r
  WHERE r.id = NEW.run_id AND r.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'memory retrieval must belong to the run project');
END;
CREATE TRIGGER agent_run_memory_retrieval_no_update
BEFORE UPDATE ON agent_run_memory_retrieval
BEGIN SELECT RAISE(ABORT, 'agent_run_memory_retrieval is append-only'); END;
CREATE TRIGGER agent_run_memory_retrieval_no_delete
BEFORE DELETE ON agent_run_memory_retrieval
BEGIN SELECT RAISE(ABORT, 'agent_run_memory_retrieval is append-only'); END;
CREATE TRIGGER agent_run_memory_reference_no_update
BEFORE UPDATE ON agent_run_memory_reference
BEGIN SELECT RAISE(ABORT, 'agent_run_memory_reference is append-only'); END;
CREATE TRIGGER agent_run_memory_reference_no_delete
BEFORE DELETE ON agent_run_memory_reference
BEGIN SELECT RAISE(ABORT, 'agent_run_memory_reference is append-only'); END;
CREATE TRIGGER agent_run_memory_retrieval_query_digests
BEFORE INSERT ON agent_run_memory_retrieval
WHEN (NEW.outcome IN ('retrieved', 'empty') AND NEW.provider_query_sha256 IS NULL)
  OR (NEW.outcome = 'skipped' AND NEW.provider_query_sha256 IS NOT NULL)
  OR (NEW.provider_query_sha256 IS NOT NULL AND NEW.context_query_sha256 IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'memory retrieval query digests are inconsistent');
END;
CREATE TRIGGER agent_run_model_routing_immutable
BEFORE UPDATE OF model_routing_json ON agent_run
WHEN NEW.model_routing_json IS NOT OLD.model_routing_json
BEGIN SELECT RAISE(ABORT, 'agent run model routing is immutable'); END;
CREATE INDEX job_outbox_pending_idx
ON job_outbox(dispatched_at, available_at, created_at, id);
CREATE TRIGGER job_outbox_immutable_intent
BEFORE UPDATE OF id, project_id, job_type, aggregate_type, aggregate_id,
  dedupe_key, payload_json, created_at ON job_outbox
BEGIN SELECT RAISE(ABORT, 'job outbox intent is immutable'); END;
CREATE TRIGGER job_outbox_dispatched_once
BEFORE UPDATE OF dispatched_at ON job_outbox
WHEN OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS NOT OLD.dispatched_at
BEGIN SELECT RAISE(ABORT, 'job outbox dispatch is immutable'); END;
CREATE TRIGGER agent_run_role_guidance_immutable
BEFORE UPDATE OF role_guidance_json ON agent_run
WHEN NEW.role_guidance_json IS NOT OLD.role_guidance_json
BEGIN SELECT RAISE(ABORT, 'agent run role guidance is immutable'); END;
CREATE INDEX agent_run_pipeline_stage_idx
ON agent_run(project_id, pipeline_stage_run_id, status, created_at, id);
CREATE TRIGGER agent_run_pipeline_stage_binding_valid
BEFORE INSERT ON agent_run
WHEN NEW.pipeline_run_id IS NOT NULL AND (
  NEW.pipeline_stage_run_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pipeline_run pr
    JOIN pipeline_stage_run psr
      ON psr.project_id = pr.project_id
     AND psr.pipeline_run_id = pr.id
     AND psr.id = NEW.pipeline_stage_run_id
    WHERE pr.id = NEW.pipeline_run_id
      AND pr.project_id = NEW.project_id
      AND pr.task_id = NEW.task_id
      AND pr.status = 'active'
      AND psr.stage_index = pr.current_stage_index
      AND psr.status = 'active'
      AND psr.assigned_agent_id = NEW.agent_id
  )
)
BEGIN SELECT RAISE(ABORT, 'agent run pipeline stage binding is not currently assigned'); END;
CREATE TRIGGER agent_run_pipeline_stage_binding_immutable
BEFORE UPDATE OF pipeline_stage_run_id ON agent_run
WHEN NEW.pipeline_stage_run_id IS NOT OLD.pipeline_stage_run_id
BEGIN SELECT RAISE(ABORT, 'agent run pipeline stage binding is immutable'); END;
CREATE INDEX job_outbox_stage_idx
ON job_outbox(project_id, pipeline_stage_run_id, dispatched_at, created_at, id);
CREATE TRIGGER job_outbox_stage_binding_valid
BEFORE INSERT ON job_outbox
WHEN NEW.pipeline_stage_run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
  FROM pipeline_stage_run psr
  WHERE psr.project_id = NEW.project_id
    AND psr.id = NEW.pipeline_stage_run_id
    AND (
      (NEW.job_type = 'orchestrate_pipeline'
       AND NEW.aggregate_type = 'pipeline_run'
       AND psr.pipeline_run_id = NEW.aggregate_id)
      OR
      (NEW.job_type = 'execute_agent_run'
       AND NEW.aggregate_type = 'agent_run'
       AND EXISTS (
         SELECT 1
         FROM agent_run ar
         WHERE ar.project_id = NEW.project_id
           AND ar.id = NEW.aggregate_id
           AND ar.pipeline_stage_run_id = psr.id
       ))
    )
)
BEGIN SELECT RAISE(ABORT, 'job outbox pipeline stage binding is invalid'); END;
CREATE TRIGGER job_outbox_stage_binding_immutable
BEFORE UPDATE OF pipeline_stage_run_id ON job_outbox
WHEN NEW.pipeline_stage_run_id IS NOT OLD.pipeline_stage_run_id
BEGIN SELECT RAISE(ABORT, 'job outbox pipeline stage binding is immutable'); END;
CREATE TRIGGER pipeline_run_manifest_revision_tuple_insert
BEFORE INSERT ON pipeline_run
WHEN NOT EXISTS (
  SELECT 1
  FROM office_manifest_revision
  WHERE id = NEW.manifest_revision_id
    AND project_id = NEW.project_id
    AND revision = NEW.manifest_revision
)
BEGIN
  SELECT RAISE(ABORT, 'pipeline run manifest revision tuple is invalid');
END;
CREATE TRIGGER pipeline_run_manifest_revision_tuple_update
BEFORE UPDATE OF project_id, manifest_revision_id, manifest_revision ON pipeline_run
WHEN NOT EXISTS (
  SELECT 1
  FROM office_manifest_revision
  WHERE id = NEW.manifest_revision_id
    AND project_id = NEW.project_id
    AND revision = NEW.manifest_revision
)
BEGIN
  SELECT RAISE(ABORT, 'pipeline run manifest revision tuple is invalid');
END;
CREATE INDEX task_dependency_project_prerequisite_idx
ON task_dependency(project_id, depends_on_task_id);
CREATE TRIGGER task_dependency_ownership_insert
BEFORE INSERT ON task_dependency
WHEN NOT EXISTS (
  SELECT 1 FROM task task
  JOIN task prerequisite ON prerequisite.id = NEW.depends_on_task_id
  WHERE task.id = NEW.task_id
    AND task.project_id = NEW.project_id
    AND prerequisite.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'task dependency must remain in one project');
END;
CREATE TRIGGER task_dependency_ownership_update
BEFORE UPDATE OF project_id, task_id, depends_on_task_id ON task_dependency
WHEN NOT EXISTS (
  SELECT 1 FROM task task
  JOIN task prerequisite ON prerequisite.id = NEW.depends_on_task_id
  WHERE task.id = NEW.task_id
    AND task.project_id = NEW.project_id
    AND prerequisite.project_id = NEW.project_id
)
BEGIN
  SELECT RAISE(ABORT, 'task dependency must remain in one project');
END;
CREATE TRIGGER task_dependency_cycle_insert
BEFORE INSERT ON task_dependency
WHEN EXISTS (
  WITH RECURSIVE reachable(id) AS (
    SELECT task_id FROM task_dependency WHERE depends_on_task_id = NEW.task_id
    UNION
    SELECT edge.task_id FROM task_dependency edge
    JOIN reachable ON edge.depends_on_task_id = reachable.id
  )
  SELECT 1 FROM reachable WHERE id = NEW.depends_on_task_id
)
BEGIN
  SELECT RAISE(ABORT, 'task dependency cycle');
END;
CREATE INDEX governance_event_project_idx ON governance_event(project_id, occurred_at, id);
CREATE TRIGGER governance_event_prevent_update
BEFORE UPDATE ON governance_event
BEGIN SELECT RAISE(ABORT, 'governance_event is append-only'); END;
CREATE TRIGGER governance_event_prevent_delete
BEFORE DELETE ON governance_event
BEGIN SELECT RAISE(ABORT, 'governance_event is append-only'); END;
CREATE TRIGGER task_dependency_prevent_update
BEFORE UPDATE ON task_dependency
BEGIN
  SELECT RAISE(ABORT, 'task dependency edges are immutable');
END;
CREATE INDEX task_execution_history_project_idx
ON task_execution_history(project_id, task_id);
CREATE TRIGGER task_execution_history_ownership
BEFORE INSERT ON task_execution_history
WHEN NOT EXISTS (SELECT 1 FROM task WHERE id = NEW.task_id AND project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'task execution history must belong to task project'); END;
CREATE TRIGGER task_execution_history_no_regression
BEFORE UPDATE ON task_execution_history
WHEN NOT (
  NEW.task_id = OLD.task_id
  AND NEW.project_id = OLD.project_id
  AND (
    (OLD.state = 'unknown' AND NEW.state = 'executed')
    OR (
      OLD.state = 'executed'
      AND NEW.state = 'executed'
      AND (
        NEW.first_known_at IS OLD.first_known_at
        OR (
          NEW.first_known_at IS NOT NULL
          AND (
            OLD.first_known_at IS NULL
            OR NEW.first_known_at < OLD.first_known_at
          )
        )
      )
    )
  )
)
BEGIN SELECT RAISE(ABORT, 'task execution history is monotonic'); END;
CREATE TRIGGER task_execution_history_no_delete
BEFORE DELETE ON task_execution_history
WHEN EXISTS (SELECT 1 FROM task WHERE id = OLD.task_id)
  AND EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'task execution history is append-only'); END;
CREATE TRIGGER task_execution_history_task_start
AFTER UPDATE OF status ON task
WHEN NEW.status IN ('running', 'waiting_review') AND OLD.status <> NEW.status
BEGIN
  SELECT RAISE(ABORT, 'task has incomplete prerequisites')
  WHERE NEW.status = 'running' AND EXISTS (
    SELECT 1 FROM task_dependency edge
    JOIN task prerequisite ON prerequisite.id = edge.depends_on_task_id
    WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.id
      AND prerequisite.status <> 'completed'
  );
  INSERT INTO task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (NEW.id, NEW.project_id, 'executed',
    CASE WHEN NEW.status = 'running' THEN NEW.updated_at ELSE NULL END)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = CASE
      WHEN task_execution_history.first_known_at IS NULL THEN excluded.first_known_at
      WHEN excluded.first_known_at IS NULL THEN task_execution_history.first_known_at
      WHEN excluded.first_known_at < task_execution_history.first_known_at THEN excluded.first_known_at
      ELSE task_execution_history.first_known_at
    END
  WHERE task_execution_history.state = 'unknown'
    OR (
      task_execution_history.state = 'executed'
      AND excluded.first_known_at IS NOT NULL
      AND (
        task_execution_history.first_known_at IS NULL
        OR excluded.first_known_at < task_execution_history.first_known_at
      )
    );
END;
CREATE TRIGGER task_execution_history_agent_run
AFTER INSERT ON agent_run
BEGIN
  SELECT RAISE(ABORT, 'task has incomplete prerequisites')
  WHERE NEW.status IN ('queued', 'preparing', 'running', 'reviewing') AND EXISTS (
    SELECT 1 FROM task_dependency edge
    JOIN task prerequisite ON prerequisite.id = edge.depends_on_task_id
    WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.task_id
      AND prerequisite.status <> 'completed'
  );
  INSERT INTO task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (NEW.task_id, NEW.project_id, 'executed', NEW.created_at)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = CASE
      WHEN task_execution_history.first_known_at IS NULL THEN excluded.first_known_at
      WHEN excluded.first_known_at IS NULL THEN task_execution_history.first_known_at
      WHEN excluded.first_known_at < task_execution_history.first_known_at THEN excluded.first_known_at
      ELSE task_execution_history.first_known_at
    END
  WHERE task_execution_history.state = 'unknown'
    OR (
      task_execution_history.state = 'executed'
      AND excluded.first_known_at IS NOT NULL
      AND (
        task_execution_history.first_known_at IS NULL
        OR excluded.first_known_at < task_execution_history.first_known_at
      )
    );
END;
CREATE TRIGGER task_execution_history_pipeline_run
AFTER INSERT ON pipeline_run
BEGIN
  SELECT RAISE(ABORT, 'task has incomplete prerequisites')
  WHERE NEW.status = 'active' AND EXISTS (
    SELECT 1 FROM task_dependency edge
    JOIN task prerequisite ON prerequisite.id = edge.depends_on_task_id
    WHERE edge.project_id = NEW.project_id AND edge.task_id = NEW.task_id
      AND prerequisite.status <> 'completed'
  );
  INSERT INTO task_execution_history(task_id, project_id, state, first_known_at)
  VALUES (NEW.task_id, NEW.project_id, 'executed', NEW.created_at)
  ON CONFLICT(task_id) DO UPDATE SET state = 'executed',
    first_known_at = CASE
      WHEN task_execution_history.first_known_at IS NULL THEN excluded.first_known_at
      WHEN excluded.first_known_at IS NULL THEN task_execution_history.first_known_at
      WHEN excluded.first_known_at < task_execution_history.first_known_at THEN excluded.first_known_at
      ELSE task_execution_history.first_known_at
    END
  WHERE task_execution_history.state = 'unknown'
    OR (
      task_execution_history.state = 'executed'
      AND excluded.first_known_at IS NOT NULL
      AND (
        task_execution_history.first_known_at IS NULL
        OR excluded.first_known_at < task_execution_history.first_known_at
      )
    );
END;
CREATE TRIGGER task_dependency_history_insert
BEFORE INSERT ON task_dependency
WHEN EXISTS (SELECT 1 FROM task_execution_history
  WHERE task_id = NEW.task_id AND project_id = NEW.project_id)
BEGIN SELECT RAISE(ABORT, 'task dependency cannot change after execution history'); END;
CREATE TRIGGER task_dependency_history_delete
BEFORE DELETE ON task_dependency
WHEN EXISTS (SELECT 1 FROM task WHERE id = OLD.task_id)
  AND EXISTS (SELECT 1 FROM project WHERE id = OLD.project_id)
  AND EXISTS (SELECT 1 FROM task_execution_history
    WHERE task_id = OLD.task_id AND project_id = OLD.project_id)
BEGIN SELECT RAISE(ABORT, 'task dependency cannot change after execution history'); END;
COMMIT;
