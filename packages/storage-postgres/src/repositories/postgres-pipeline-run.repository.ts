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
import { PostgresClient } from "../database/postgres-client.ts";
import {
  PostgresTenantScopeError,
  requirePostgresTenantId,
} from "../database/postgres-tenant-context.ts";

interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  manifest_revision_id: string;
  manifest_revision: number | string;
  definition_json: unknown;
  status: PipelineRunStatus;
  current_stage_index: number | string;
  started_by: string;
  version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  completed_at: Date | string | null;
  cancelled_at: Date | string | null;
}

interface StageRow {
  id: string;
  stage_id: string;
  stage_index: number | string;
  role_id: string;
  status: PipelineStageRunStatus;
  assigned_agent_id: string | null;
  assigned_at: Date | string | null;
  completed_at: Date | string | null;
  approved_by: string | null;
  approval_decision: "approved" | "rejected" | null;
  approval_rationale: string | null;
  approved_at: Date | string | null;
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
  created_at: Date | string;
}

function date(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}

function jsonValue(value: unknown): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}

function stage(row: StageRow): PipelineStageRunProps {
  return {
    id: row.id,
    stageId: row.stage_id,
    stageIndex: Number(row.stage_index),
    roleId: row.role_id,
    status: row.status,
    ...(row.assigned_agent_id === null
      ? {}
      : { assignedAgentId: row.assigned_agent_id }),
    ...(row.assigned_at === null ? {} : { assignedAt: date(row.assigned_at) }),
    ...(row.completed_at === null
      ? {}
      : { completedAt: date(row.completed_at) }),
    ...(row.approved_by === null ? {} : { approvedBy: row.approved_by }),
    ...(row.approval_decision === null
      ? {}
      : { approvalDecision: row.approval_decision }),
    ...(row.approval_rationale === null
      ? {}
      : { approvalRationale: row.approval_rationale }),
    ...(row.approved_at === null ? {} : { approvedAt: date(row.approved_at) }),
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
    createdAt: date(row.created_at),
  };
}

export class PostgresPipelineRunRepository implements PipelineRunRepository {
  private readonly tenantId: string;

  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async insert(run: PipelineRun): Promise<void> {
    const value = run.snapshot();
    await this.database.runInTransaction(async () => {
      const inserted = await this.database.query<{ id: string }>(
        `
          INSERT INTO core.pipeline_run(
            id, project_id, task_id, manifest_revision_id, manifest_revision,
            definition_json, status, current_stage_index, started_by, version,
            created_at, updated_at, completed_at, cancelled_at
          )
          SELECT $1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10,
                 $11, $12, $13, $14
          FROM core.project AS project
          JOIN core.task AS task
            ON task.id = $3 AND task.project_id = $2
          JOIN core.office_manifest_revision AS manifest
            ON manifest.id = $4 AND manifest.project_id = $2
          WHERE project.id = $2 AND project.tenant_id = $15
          RETURNING id
        `,
        [
          value.id,
          value.projectId,
          value.taskId,
          value.manifestRevisionId,
          value.manifestRevision,
          JSON.parse(canonicalStringify(value.definition)) as Record<
            string,
            unknown
          >,
          value.status,
          value.currentStageIndex,
          value.startedBy,
          value.version,
          value.createdAt,
          value.updatedAt,
          value.completedAt ?? null,
          value.cancelledAt ?? null,
          this.tenantId,
        ],
      );
      if (inserted.length !== 1)
        throw new PostgresTenantScopeError("PipelineRun", value.id);

      for (const item of value.stages) {
        const stageRows = await this.database.query<{ id: string }>(
          `
            INSERT INTO core.pipeline_stage_run(
              id, pipeline_run_id, project_id, stage_id, stage_index, role_id,
              status, assigned_agent_id, assigned_at, completed_at, approved_by,
              approval_decision, approval_rationale, approved_at
            )
            SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
            FROM core.pipeline_run AS pipeline
            JOIN core.project AS project
              ON project.id = pipeline.project_id AND project.tenant_id = $15
            WHERE pipeline.id = $2 AND pipeline.project_id = $3
            RETURNING id
          `,
          [
            item.id,
            value.id,
            value.projectId,
            item.stageId,
            item.stageIndex,
            item.roleId,
            item.status,
            item.assignedAgentId ?? null,
            item.assignedAt ?? null,
            item.completedAt ?? null,
            item.approvedBy ?? null,
            item.approvalDecision ?? null,
            item.approvalRationale ?? null,
            item.approvedAt ?? null,
            this.tenantId,
          ],
        );
        if (stageRows.length !== 1)
          throw new PostgresTenantScopeError("PipelineStageRun", item.id);
      }
    });
  }

  async findById(id: string, projectId: string): Promise<PipelineRun | null> {
    const row = await this.findRunRow(
      "pipeline.id = $1 AND pipeline.project_id = $2",
      [id, projectId],
    );
    return row === null ? null : this.restore(row);
  }

  async findActiveByTask(
    taskId: string,
    projectId: string,
  ): Promise<PipelineRun | null> {
    const row = await this.findRunRow(
      "pipeline.task_id = $1 AND pipeline.project_id = $2 AND pipeline.status = 'active'",
      [taskId, projectId],
      "pipeline.created_at DESC, pipeline.id DESC",
    );
    return row === null ? null : this.restore(row);
  }

  async listByProject(projectId: string): Promise<PipelineRun[]> {
    const rows = await this.listRunRows(
      "pipeline.project_id = $1",
      [projectId],
      "pipeline.created_at, pipeline.id",
    );
    return Promise.all(rows.map((row) => this.restore(row)));
  }

  async listActiveByProject(projectId: string): Promise<PipelineRun[]> {
    const rows = await this.listRunRows(
      "pipeline.project_id = $1 AND pipeline.status = 'active'",
      [projectId],
      "pipeline.created_at, pipeline.id",
    );
    return Promise.all(rows.map((row) => this.restore(row)));
  }

  async save(run: PipelineRun, expectedVersion: number): Promise<boolean> {
    const value = run.snapshot();
    return this.database.runInTransaction(async () => {
      const updated = await this.database.query<{ id: string }>(
        `
          UPDATE core.pipeline_run AS pipeline
          SET status = $1, current_stage_index = $2, version = $3,
              updated_at = $4, completed_at = $5, cancelled_at = $6
          FROM core.project AS project
          WHERE pipeline.id = $7 AND pipeline.project_id = $8
            AND project.id = pipeline.project_id AND project.tenant_id = $9
            AND pipeline.version = $10
          RETURNING pipeline.id
        `,
        [
          value.status,
          value.currentStageIndex,
          value.version,
          value.updatedAt,
          value.completedAt ?? null,
          value.cancelledAt ?? null,
          value.id,
          value.projectId,
          this.tenantId,
          expectedVersion,
        ],
      );
      if (updated.length !== 1) return false;

      const stageCount = await this.database.query<{ count: number | string }>(
        `
          SELECT count(*)::integer AS count
          FROM core.pipeline_stage_run AS stage
          JOIN core.project AS project
            ON project.id = stage.project_id AND project.tenant_id = $3
          WHERE stage.pipeline_run_id = $1 AND stage.project_id = $2
        `,
        [value.id, value.projectId, this.tenantId],
      );
      if (Number(stageCount[0]?.count ?? -1) !== value.stages.length)
        throw new Error(
          `PipelineRun ${value.id} has an inconsistent stage set`,
        );

      for (const item of value.stages) {
        const stageRows = await this.database.query<{ id: string }>(
          `
            UPDATE core.pipeline_stage_run AS stage
            SET status = $1, assigned_agent_id = $2, assigned_at = $3,
                completed_at = $4, approved_by = $5, approval_decision = $6,
                approval_rationale = $7, approved_at = $8
            FROM core.pipeline_run AS pipeline
            JOIN core.project AS project
              ON project.id = pipeline.project_id AND project.tenant_id = $9
            WHERE stage.id = $10 AND stage.pipeline_run_id = $11
              AND stage.project_id = $12
              AND pipeline.id = $11 AND pipeline.project_id = $12
            RETURNING stage.id
          `,
          [
            item.status,
            item.assignedAgentId ?? null,
            item.assignedAt ?? null,
            item.completedAt ?? null,
            item.approvedBy ?? null,
            item.approvalDecision ?? null,
            item.approvalRationale ?? null,
            item.approvedAt ?? null,
            this.tenantId,
            item.id,
            value.id,
            value.projectId,
          ],
        );
        if (stageRows.length !== 1)
          throw new Error(`Pipeline stage ${item.id} was not updated`);
      }
      return true;
    });
  }

  async appendOverride(record: PipelineOverrideRecord): Promise<void> {
    const rows = await this.database.query<{ id: string }>(
      `
        INSERT INTO core.pipeline_override(
          id, project_id, pipeline_run_id, stage_run_id, actor_id, reason,
          previous_rule, resulting_authorization, created_at
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
        FROM core.pipeline_run AS pipeline
        JOIN core.pipeline_stage_run AS stage
          ON stage.pipeline_run_id = pipeline.id
         AND stage.id = $4
         AND stage.project_id = pipeline.project_id
        JOIN core.project AS project
          ON project.id = pipeline.project_id AND project.tenant_id = $10
        WHERE pipeline.id = $3 AND pipeline.project_id = $2
        RETURNING id
      `,
      [
        record.id,
        record.projectId,
        record.pipelineRunId,
        record.stageRunId,
        record.actorId,
        record.reason,
        record.previousRule,
        record.resultingAuthorization,
        record.createdAt,
        this.tenantId,
      ],
    );
    if (rows.length !== 1)
      throw new PostgresTenantScopeError("PipelineOverride", record.id);
  }

  async listOverrides(
    pipelineRunId: string,
    projectId: string,
  ): Promise<PipelineOverrideRecord[]> {
    const rows = await this.database.query<OverrideRow>(
      `
        SELECT override.id, override.project_id, override.pipeline_run_id,
               override.stage_run_id, override.actor_id, override.reason,
               override.previous_rule, override.resulting_authorization,
               override.created_at
        FROM core.pipeline_override AS override
        JOIN core.project AS project
          ON project.id = override.project_id AND project.tenant_id = $3
        WHERE override.pipeline_run_id = $1 AND override.project_id = $2
        ORDER BY override.created_at, override.id
      `,
      [pipelineRunId, projectId, this.tenantId],
    );
    return rows.map(override);
  }

  private async findRunRow(
    predicate: string,
    values: readonly unknown[],
    orderBy = "pipeline.created_at, pipeline.id",
  ): Promise<RunRow | null> {
    const rows = await this.listRunRows(predicate, values, orderBy, 1);
    return rows[0] ?? null;
  }

  private async listRunRows(
    predicate: string,
    values: readonly unknown[],
    orderBy: string,
    limit?: number,
  ): Promise<RunRow[]> {
    const limitSql = limit === undefined ? "" : ` LIMIT ${limit}`;
    return this.database.query<RunRow>(
      `
        SELECT pipeline.id, pipeline.project_id, pipeline.task_id,
               pipeline.manifest_revision_id, pipeline.manifest_revision,
               pipeline.definition_json, pipeline.status,
               pipeline.current_stage_index, pipeline.started_by,
               pipeline.version, pipeline.created_at, pipeline.updated_at,
               pipeline.completed_at, pipeline.cancelled_at
        FROM core.pipeline_run AS pipeline
        JOIN core.project AS project
          ON project.id = pipeline.project_id AND project.tenant_id = $${values.length + 1}
        WHERE ${predicate}
          AND pipeline.manifest_revision_id IS NOT NULL
        ORDER BY ${orderBy}${limitSql}
      `,
      [...values, this.tenantId],
    );
  }

  private async restore(row: RunRow): Promise<PipelineRun> {
    const stages = await this.database.query<StageRow>(
      `
        SELECT stage.id, stage.stage_id, stage.stage_index, stage.role_id,
               stage.status, stage.assigned_agent_id, stage.assigned_at,
               stage.completed_at, stage.approved_by, stage.approval_decision,
               stage.approval_rationale, stage.approved_at
        FROM core.pipeline_stage_run AS stage
        JOIN core.project AS project
          ON project.id = stage.project_id AND project.tenant_id = $3
        WHERE stage.pipeline_run_id = $1 AND stage.project_id = $2
        ORDER BY stage.stage_index, stage.id
      `,
      [row.id, row.project_id, this.tenantId],
    );
    const props: PipelineRunProps = {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      manifestRevisionId: row.manifest_revision_id,
      manifestRevision: Number(row.manifest_revision),
      definition: jsonValue(row.definition_json) as OfficePipeline,
      status: row.status,
      currentStageIndex: Number(row.current_stage_index),
      stages: stages.map(stage),
      startedBy: row.started_by,
      version: Number(row.version),
      createdAt: date(row.created_at),
      updatedAt: date(row.updated_at),
      ...(row.completed_at === null
        ? {}
        : { completedAt: date(row.completed_at) }),
      ...(row.cancelled_at === null
        ? {}
        : { cancelledAt: date(row.cancelled_at) }),
    };
    return PipelineRun.restore(props);
  }
}
