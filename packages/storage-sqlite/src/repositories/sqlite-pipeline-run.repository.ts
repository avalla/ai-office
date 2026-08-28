import type { Database } from "bun:sqlite";
import type { PipelineRunRepository } from "@ai-office/application/ports/pipeline-run-repository.port.ts";
import {
  PipelineRun,
  type PipelineOverrideRecord,
  type PipelineRunProps,
  type PipelineRunStatus,
  type PipelineStageRunProps,
  type PipelineStageRunStatus,
} from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { OfficePipeline } from "@ai-office/domain/office/office-manifest.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";

interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  manifest_revision_id: string;
  manifest_revision: number;
  definition_json: string;
  status: PipelineRunStatus;
  current_stage_index: number;
  started_by: string;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

interface StageRow {
  id: string;
  stage_id: string;
  stage_index: number;
  role_id: string;
  status: PipelineStageRunStatus;
  assigned_agent_id: string | null;
  assigned_at: string | null;
  completed_at: string | null;
  approved_by: string | null;
  approval_decision: "approved" | "rejected" | null;
  approval_rationale: string | null;
  approved_at: string | null;
}

interface OverrideRow {
  id: string;
  project_id: string;
  pipeline_run_id: string;
  stage_run_id: string;
  actor_id: string;
  reason: string;
  previous_rule: string;
  resulting_authorization: string;
  created_at: string;
}

function stage(row: StageRow): PipelineStageRunProps {
  return {
    id: row.id,
    stageId: row.stage_id,
    stageIndex: row.stage_index,
    roleId: row.role_id,
    status: row.status,
    ...(row.assigned_agent_id === null
      ? {}
      : { assignedAgentId: row.assigned_agent_id }),
    ...(row.assigned_at === null
      ? {}
      : { assignedAt: new Date(row.assigned_at) }),
    ...(row.completed_at === null
      ? {}
      : { completedAt: new Date(row.completed_at) }),
    ...(row.approved_by === null ? {} : { approvedBy: row.approved_by }),
    ...(row.approval_decision === null
      ? {}
      : { approvalDecision: row.approval_decision }),
    ...(row.approval_rationale === null
      ? {}
      : { approvalRationale: row.approval_rationale }),
    ...(row.approved_at === null
      ? {}
      : { approvedAt: new Date(row.approved_at) }),
  };
}

function override(row: OverrideRow): PipelineOverrideRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    pipelineRunId: row.pipeline_run_id,
    stageRunId: row.stage_run_id,
    actorId: row.actor_id,
    reason: row.reason,
    previousRule: row.previous_rule,
    resultingAuthorization: row.resulting_authorization,
    createdAt: new Date(row.created_at),
  };
}

export class SqlitePipelineRunRepository implements PipelineRunRepository {
  constructor(private readonly database: Database) {}

  async insert(run: PipelineRun): Promise<void> {
    const value = run.snapshot();
    this.database
      .prepare(
        `INSERT INTO pipeline_run(
         id, project_id, task_id, manifest_revision_id, manifest_revision,
         definition_json, status, current_stage_index, started_by, version,
         created_at, updated_at, completed_at, cancelled_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        value.projectId,
        value.taskId,
        value.manifestRevisionId,
        value.manifestRevision,
        canonicalStringify(value.definition),
        value.status,
        value.currentStageIndex,
        value.startedBy,
        value.version,
        value.createdAt.toISOString(),
        value.updatedAt.toISOString(),
        value.completedAt?.toISOString() ?? null,
        value.cancelledAt?.toISOString() ?? null,
      );
    for (const valueStage of value.stages)
      this.insertStage(value.id, value.projectId, valueStage);
  }

  async findById(id: string, projectId: string): Promise<PipelineRun | null> {
    const row = this.database
      .query<RunRow, [string, string]>(
        `SELECT * FROM pipeline_run WHERE id = ? AND project_id = ?`,
      )
      .get(id, projectId);
    return row === null ? null : this.restore(row);
  }

  async findActiveByTask(
    taskId: string,
    projectId: string,
  ): Promise<PipelineRun | null> {
    const row = this.database
      .query<RunRow, [string, string]>(
        `SELECT * FROM pipeline_run
       WHERE task_id = ? AND project_id = ? AND status = 'active'
       ORDER BY created_at DESC LIMIT 1`,
      )
      .get(taskId, projectId);
    return row === null ? null : this.restore(row);
  }

  async listByProject(projectId: string): Promise<PipelineRun[]> {
    const rows = this.database
      .query<RunRow, [string]>(
        `SELECT * FROM pipeline_run WHERE project_id = ? ORDER BY created_at, id`,
      )
      .all(projectId);
    return rows.map((row) => this.restore(row));
  }

  async listActiveByProject(projectId: string): Promise<PipelineRun[]> {
    const rows = this.database
      .query<RunRow, [string]>(
        `SELECT * FROM pipeline_run
       WHERE project_id = ? AND status = 'active' ORDER BY created_at, id`,
      )
      .all(projectId);
    return rows.map((row) => this.restore(row));
  }

  async save(run: PipelineRun, expectedVersion: number): Promise<boolean> {
    const value = run.snapshot();
    const changed = this.database
      .prepare(
        `UPDATE pipeline_run SET
         status = ?, current_stage_index = ?, version = ?, updated_at = ?,
         completed_at = ?, cancelled_at = ?
       WHERE id = ? AND project_id = ? AND version = ?`,
      )
      .run(
        value.status,
        value.currentStageIndex,
        value.version,
        value.updatedAt.toISOString(),
        value.completedAt?.toISOString() ?? null,
        value.cancelledAt?.toISOString() ?? null,
        value.id,
        value.projectId,
        expectedVersion,
      );
    if (changed.changes !== 1) return false;
    const update = this.database.prepare(
      `UPDATE pipeline_stage_run SET
         status = ?, assigned_agent_id = ?, assigned_at = ?, completed_at = ?,
         approved_by = ?, approval_decision = ?, approval_rationale = ?, approved_at = ?
       WHERE id = ? AND pipeline_run_id = ? AND project_id = ?`,
    );
    for (const item of value.stages)
      update.run(
        item.status,
        item.assignedAgentId ?? null,
        item.assignedAt?.toISOString() ?? null,
        item.completedAt?.toISOString() ?? null,
        item.approvedBy ?? null,
        item.approvalDecision ?? null,
        item.approvalRationale ?? null,
        item.approvedAt?.toISOString() ?? null,
        item.id,
        value.id,
        value.projectId,
      );
    return true;
  }

  async appendOverride(record: PipelineOverrideRecord): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO pipeline_override(
         id, project_id, pipeline_run_id, stage_run_id, actor_id, reason,
         previous_rule, resulting_authorization, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.pipelineRunId,
        record.stageRunId,
        record.actorId,
        record.reason,
        record.previousRule,
        record.resultingAuthorization,
        record.createdAt.toISOString(),
      );
  }

  async listOverrides(
    pipelineRunId: string,
    projectId: string,
  ): Promise<PipelineOverrideRecord[]> {
    return this.database
      .query<OverrideRow, [string, string]>(
        `SELECT * FROM pipeline_override
       WHERE pipeline_run_id = ? AND project_id = ? ORDER BY created_at, id`,
      )
      .all(pipelineRunId, projectId)
      .map(override);
  }

  private restore(row: RunRow): PipelineRun {
    const stages = this.database
      .query<StageRow, [string, string]>(
        `SELECT id, stage_id, stage_index, role_id, status, assigned_agent_id,
              assigned_at, completed_at, approved_by, approval_decision,
              approval_rationale, approved_at
       FROM pipeline_stage_run WHERE pipeline_run_id = ? AND project_id = ?
       ORDER BY stage_index`,
      )
      .all(row.id, row.project_id)
      .map(stage);
    const props: PipelineRunProps = {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      manifestRevisionId: row.manifest_revision_id,
      manifestRevision: row.manifest_revision,
      definition: JSON.parse(row.definition_json) as OfficePipeline,
      status: row.status,
      currentStageIndex: row.current_stage_index,
      stages,
      startedBy: row.started_by,
      version: row.version,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
      ...(row.completed_at === null
        ? {}
        : { completedAt: new Date(row.completed_at) }),
      ...(row.cancelled_at === null
        ? {}
        : { cancelledAt: new Date(row.cancelled_at) }),
    };
    return PipelineRun.restore(props);
  }

  private insertStage(
    pipelineRunId: string,
    projectId: string,
    value: PipelineStageRunProps,
  ): void {
    this.database
      .prepare(
        `INSERT INTO pipeline_stage_run(
         id, pipeline_run_id, project_id, stage_id, stage_index, role_id, status,
         assigned_agent_id, assigned_at, completed_at, approved_by,
         approval_decision, approval_rationale, approved_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        value.id,
        pipelineRunId,
        projectId,
        value.stageId,
        value.stageIndex,
        value.roleId,
        value.status,
        value.assignedAgentId ?? null,
        value.assignedAt?.toISOString() ?? null,
        value.completedAt?.toISOString() ?? null,
        value.approvedBy ?? null,
        value.approvalDecision ?? null,
        value.approvalRationale ?? null,
        value.approvedAt?.toISOString() ?? null,
      );
  }
}
