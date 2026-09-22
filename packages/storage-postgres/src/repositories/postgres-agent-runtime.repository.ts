import type {
  AgentRunEvent,
  AgentRuntimeRepository,
  RunAdmission,
  WorkerAuthorityFence,
} from "@ai-office/application/ports/agent-runtime-repository.port.ts";
import type { AgentExecutionResult } from "@ai-office/agent-runtime/executor.ts";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import {
  AgentRun,
  type AgentActionIntent,
  type AgentRunStatus,
} from "@ai-office/domain/agent/agent-run.ts";
import { parseAgentExecution } from "@ai-office/domain/agent/agent-execution.ts";
import { parseAgentRunModelRouting } from "@ai-office/domain/agent/agent-run-model.ts";
import { Role, type RoleLimits } from "@ai-office/domain/agent/role.ts";
import {
  PostgresTenantScopeError,
  requirePostgresTenantId,
} from "../database/postgres-tenant-context.ts";
import { PostgresClient } from "../database/postgres-client.ts";

type Timestamp = Date | string;
type JsonColumn = unknown;
interface AgentRow {
  id: string;
  project_id: string;
  role_id: string;
  name: string;
  enabled: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}
interface RoleRow {
  id: string;
  project_id: string;
  role_key: string;
  name: string;
  version: number;
  capabilities_json: JsonColumn;
  tools_json: JsonColumn;
  model_policy: string;
  limits_json: JsonColumn;
  source_path: string;
  guidance_text: string;
  guidance_version: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}
interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  agent_id: string;
  action_intent_json: JsonColumn | null;
  pipeline_run_id: string | null;
  pipeline_stage_run_id: string | null;
  status: AgentRunStatus;
  worktree_path: string | null;
  result_json: JsonColumn | null;
  error_json: JsonColumn | null;
  created_at: Timestamp;
  started_at: Timestamp | null;
  completed_at: Timestamp | null;
  updated_at: Timestamp;
  execution_json: JsonColumn | null;
  model_routing_json: JsonColumn | null;
  role_guidance_json: JsonColumn | null;
}
const runColumns = `
  run.id, run.project_id, run.task_id, run.agent_id,
  run.action_intent_json, run.pipeline_run_id, run.pipeline_stage_run_id,
  run.status, run.worktree_path, run.result_json, run.error_json,
  run.created_at, run.started_at, run.completed_at, run.updated_at,
  run.execution_json, run.model_routing_json, run.role_guidance_json
`;

function toDate(value: Timestamp): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}
function jsonValue(value: JsonColumn): unknown {
  return typeof value === "string" ? (JSON.parse(value) as unknown) : value;
}
function jsonObject(value: JsonColumn, label: string): Record<string, unknown> {
  const parsed = jsonValue(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`Stored ${label} must be an object`);
  return parsed as Record<string, unknown>;
}
function stringArray(value: JsonColumn, label: string): string[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string"))
    throw new Error(`Stored role ${label} must be a string array`);
  return [...parsed];
}
function roleLimits(value: JsonColumn): RoleLimits {
  const record = jsonObject(value, "role limits");
  if (
    typeof record.maxIterations !== "number" ||
    !Number.isSafeInteger(record.maxIterations) ||
    typeof record.timeoutSeconds !== "number" ||
    !Number.isSafeInteger(record.timeoutSeconds) ||
    typeof record.maxCostMicros !== "string"
  )
    throw new Error("Stored role limits are invalid");
  let maxCostMicros: bigint;
  try {
    maxCostMicros = BigInt(record.maxCostMicros);
  } catch {
    throw new Error("Stored role max cost is invalid");
  }
  if (
    record.maxIterations < 1 ||
    record.timeoutSeconds < 1 ||
    maxCostMicros < 0n
  )
    throw new Error("Stored role limits are invalid");
  return {
    maxIterations: record.maxIterations,
    maxCostMicros,
    timeoutSeconds: record.timeoutSeconds,
  };
}
function restoreAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    projectId: row.project_id,
    roleId: row.role_id,
    name: row.name,
    enabled: row.enabled,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  };
}
function restoreRole(row: RoleRow): Role {
  return Role.restore({
    id: row.id,
    projectId: row.project_id,
    key: row.role_key,
    name: row.name,
    version: row.version,
    capabilities: stringArray(row.capabilities_json, "capabilities"),
    tools: stringArray(row.tools_json, "tools"),
    modelPolicy: row.model_policy,
    limits: roleLimits(row.limits_json),
    sourcePath: row.source_path,
    ...(row.guidance_text === "" ? {} : { guidanceText: row.guidance_text }),
    guidanceVersion: row.guidance_version,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });
}
function restoreRun(row: RunRow): AgentRun {
  return AgentRun.restore({
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    ...(row.execution_json === null
      ? {}
      : { execution: parseAgentExecution(jsonValue(row.execution_json)) }),
    ...(row.model_routing_json === null
      ? {}
      : {
          modelRouting: parseAgentRunModelRouting(
            jsonValue(row.model_routing_json),
          ),
        }),
    ...(row.role_guidance_json === null
      ? {}
      : {
          roleGuidance: jsonObject(row.role_guidance_json, "run guidance") as {
            version: number;
            text: string;
          },
        }),
    ...(row.action_intent_json === null
      ? {}
      : {
          actionIntent: jsonObject(
            row.action_intent_json,
            "action intent",
          ) as unknown as AgentActionIntent,
        }),
    ...(row.pipeline_run_id === null
      ? {}
      : { pipelineRunId: row.pipeline_run_id }),
    ...(row.pipeline_stage_run_id === null
      ? {}
      : { pipelineStageRunId: row.pipeline_stage_run_id }),
    status: row.status,
    ...(row.worktree_path === null ? {} : { worktreePath: row.worktree_path }),
    ...(row.result_json === null ? {} : { result: jsonValue(row.result_json) }),
    ...(row.error_json === null ? {} : { error: jsonValue(row.error_json) }),
    createdAt: toDate(row.created_at),
    ...(row.started_at === null ? {} : { startedAt: toDate(row.started_at) }),
    ...(row.completed_at === null
      ? {}
      : { completedAt: toDate(row.completed_at) }),
    updatedAt: toDate(row.updated_at),
  });
}

export class PostgresAgentRuntimeRepository implements AgentRuntimeRepository {
  private readonly tenantId: string;
  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async saveRole(role: Role): Promise<void> {
    const value = role.snapshot();
    const rows = await this.database.query<{ id: string }>(
      `
      INSERT INTO core.role(
        id, project_id, role_key, name, version, capabilities_json, tools_json,
        model_policy, limits_json, source_path, guidance_text, guidance_version,
        created_at, updated_at
      )
      SELECT $1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9::jsonb,
             $10, $11, $12, $13, $14
      FROM core.project AS project
      WHERE project.id = $2 AND project.tenant_id = $15
      ON CONFLICT (project_id, role_key) DO UPDATE SET
        name = excluded.name, version = excluded.version,
        capabilities_json = excluded.capabilities_json, tools_json = excluded.tools_json,
        model_policy = excluded.model_policy, limits_json = excluded.limits_json,
        source_path = excluded.source_path, guidance_text = excluded.guidance_text,
        guidance_version = excluded.guidance_version, updated_at = excluded.updated_at
      RETURNING id`,
      [
        value.id,
        value.projectId,
        value.key,
        value.name,
        value.version,
        value.capabilities,
        value.tools,
        value.modelPolicy,
        {
          maxIterations: value.limits.maxIterations,
          maxCostMicros: value.limits.maxCostMicros.toString(),
          timeoutSeconds: value.limits.timeoutSeconds,
        },
        value.sourcePath,
        value.guidanceText ?? "",
        value.guidanceVersion ?? 1,
        value.createdAt,
        value.updatedAt,
        this.tenantId,
      ],
    );
    if (rows.length !== 1) throw new PostgresTenantScopeError("Role", value.id);
  }

  async findRole(roleId: string, projectId: string): Promise<Role | null> {
    const [row] = await this.database.query<RoleRow>(
      `
      SELECT role.id, role.project_id, role.role_key, role.name, role.version,
             role.capabilities_json, role.tools_json, role.model_policy, role.limits_json,
             role.source_path, role.guidance_text, role.guidance_version,
             role.created_at, role.updated_at
      FROM core.role AS role
      JOIN core.project AS project
        ON project.id = role.project_id AND project.tenant_id = $3
      WHERE role.id = $1 AND role.project_id = $2`,
      [roleId, projectId, this.tenantId],
    );
    return row === undefined ? null : restoreRole(row);
  }

  async saveAgent(value: Agent): Promise<void> {
    const rows = await this.database.query<{ id: string }>(
      `
      INSERT INTO core.agent(id, project_id, role_id, name, enabled, created_at, updated_at)
      SELECT $1, $2, $3, $4, $5, $6, $7
      FROM core.project AS project
      WHERE project.id = $2 AND project.tenant_id = $8
        AND EXISTS (SELECT 1 FROM core.role WHERE id = $3 AND project_id = $2)
      ON CONFLICT (project_id, name) DO UPDATE SET
        role_id = excluded.role_id, enabled = excluded.enabled,
        updated_at = excluded.updated_at
      RETURNING id`,
      [
        value.id,
        value.projectId,
        value.roleId,
        value.name,
        value.enabled,
        value.createdAt,
        value.updatedAt,
        this.tenantId,
      ],
    );
    if (rows.length !== 1)
      throw new PostgresTenantScopeError("Agent", value.id);
  }

  async listAgents(projectId: string): Promise<Agent[]> {
    const rows = await this.database.query<AgentRow>(
      `
      SELECT agent.id, agent.project_id, agent.role_id, agent.name,
             agent.enabled, agent.created_at, agent.updated_at
      FROM core.agent AS agent
      JOIN core.project AS project
        ON project.id = agent.project_id AND project.tenant_id = $2
      WHERE agent.project_id = $1 ORDER BY agent.name, agent.id`,
      [projectId, this.tenantId],
    );
    return rows.map(restoreAgent);
  }

  async findAgent(agentId: string): Promise<Agent | null> {
    const [row] = await this.database.query<AgentRow>(
      `
      SELECT agent.id, agent.project_id, agent.role_id, agent.name,
             agent.enabled, agent.created_at, agent.updated_at
      FROM core.agent AS agent
      JOIN core.project AS project
        ON project.id = agent.project_id AND project.tenant_id = $2
      WHERE agent.id = $1`,
      [agentId, this.tenantId],
    );
    return row === undefined ? null : restoreAgent(row);
  }

  async saveRun(value: AgentRun): Promise<void> {
    const run = value.snapshot();
    await this.database.runInTransaction(async () => {
      const [previous] = await this.database.query<{
        status: AgentRunStatus | null;
      }>(
        `
        SELECT run.status FROM core.agent_run AS run
        JOIN core.project AS project
          ON project.id = run.project_id AND project.tenant_id = $2
        WHERE run.id = $1`,
        [run.id, this.tenantId],
      );
      const rows = await this.database.query<{ id: string }>(
        `
        INSERT INTO core.agent_run(
          id, project_id, task_id, agent_id, action_intent_json, pipeline_run_id,
          pipeline_stage_run_id, status, worktree_path, result_json, error_json,
          created_at, started_at, completed_at, updated_at, execution_json,
          model_routing_json, role_guidance_json
        )
        SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11::jsonb,
               $12, $13, $14, $15, $16::jsonb, $17::jsonb, $18::jsonb
        FROM core.project AS project
        WHERE project.id = $2 AND project.tenant_id = $19
          AND EXISTS (SELECT 1 FROM core.task WHERE id = $3 AND project_id = $2)
          AND EXISTS (SELECT 1 FROM core.agent WHERE id = $4 AND project_id = $2)
        ON CONFLICT (id) DO UPDATE SET
          status = excluded.status, worktree_path = excluded.worktree_path,
          result_json = excluded.result_json, error_json = excluded.error_json,
          started_at = excluded.started_at, completed_at = excluded.completed_at,
          updated_at = excluded.updated_at, execution_json = excluded.execution_json
        WHERE core.agent_run.project_id = excluded.project_id
          AND core.agent_run.status IS NOT NULL
          AND EXISTS (SELECT 1 FROM core.project WHERE id = core.agent_run.project_id AND tenant_id = $19)
        RETURNING id`,
        [
          run.id,
          run.projectId,
          run.taskId,
          run.agentId,
          run.actionIntent === undefined ? null : run.actionIntent,
          run.pipelineRunId ?? null,
          run.pipelineStageRunId ?? null,
          run.status,
          run.worktreePath ?? null,
          run.result === undefined ? null : run.result,
          run.error === undefined ? null : run.error,
          run.createdAt,
          run.startedAt ?? null,
          run.completedAt ?? null,
          run.updatedAt,
          run.execution === undefined ? null : run.execution,
          run.modelRouting === undefined ? null : run.modelRouting,
          run.roleGuidance === undefined ? null : run.roleGuidance,
          this.tenantId,
        ],
      );
      if (rows.length !== 1)
        throw new PostgresTenantScopeError("AgentRun", run.id);
      if (previous?.status !== run.status)
        await this.database.query(
          `
          INSERT INTO core.agent_run_event(id, run_id, project_id, status, payload_json, occurred_at)
          VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [
            `${run.id}:${run.status}`,
            run.id,
            run.projectId,
            run.status,
            {
              hasResult: run.result !== undefined,
              hasError: run.error !== undefined,
              ...(run.execution === undefined
                ? {}
                : { execution: run.execution }),
              ...(previous === undefined && run.modelRouting !== undefined
                ? { modelRouting: run.modelRouting }
                : {}),
            },
            run.updatedAt,
          ],
        );
    });
  }

  async findRun(runId: string): Promise<AgentRun | null> {
    const [row] = await this.database.query<RunRow>(
      `
      SELECT ${runColumns} FROM core.agent_run AS run
      JOIN core.project AS project ON project.id = run.project_id AND project.tenant_id = $2
      WHERE run.id = $1 AND run.status IS NOT NULL`,
      [runId, this.tenantId],
    );
    return row === undefined ? null : restoreRun(row);
  }

  async listRuns(projectId: string): Promise<AgentRun[]> {
    const rows = await this.database.query<RunRow>(
      `
      SELECT ${runColumns} FROM core.agent_run AS run
      JOIN core.project AS project ON project.id = run.project_id AND project.tenant_id = $2
      WHERE run.project_id = $1 AND run.status IS NOT NULL ORDER BY run.created_at, run.id`,
      [projectId, this.tenantId],
    );
    return rows.map(restoreRun);
  }

  async listQueuedRuns(projectId: string, limit: number): Promise<AgentRun[]> {
    const rows = await this.database.query<RunRow>(
      `
      SELECT ${runColumns} FROM core.agent_run AS run
      JOIN core.project AS project ON project.id = run.project_id AND project.tenant_id = $3
      WHERE run.project_id = $1 AND run.status = 'queued'
      ORDER BY run.created_at, run.id LIMIT $2`,
      [projectId, limit, this.tenantId],
    );
    return rows.map(restoreRun);
  }

  async listRecoverableRuns(projectId: string): Promise<AgentRun[]> {
    const rows = await this.database.query<RunRow>(
      `
      SELECT ${runColumns} FROM core.agent_run AS run
      JOIN core.project AS project ON project.id = run.project_id AND project.tenant_id = $2
      WHERE run.project_id = $1 AND run.status IN ('preparing', 'running', 'reviewing')
      ORDER BY run.updated_at, run.id`,
      [projectId, this.tenantId],
    );
    return rows.map(restoreRun);
  }

  async listRunEvents(runId: string): Promise<AgentRunEvent[]> {
    const rows = await this.database.query<{
      run_id: string;
      status: AgentRunStatus;
      payload_json: JsonColumn;
      occurred_at: Timestamp;
    }>(
      `
      SELECT event.run_id, event.status, event.payload_json, event.occurred_at
      FROM core.agent_run_event AS event
      JOIN core.agent_run AS run ON run.id = event.run_id AND run.project_id = event.project_id
      JOIN core.project AS project ON project.id = event.project_id AND project.tenant_id = $2
      WHERE event.run_id = $1 ORDER BY event.sequence`,
      [runId, this.tenantId],
    );
    return rows.map((row) => ({
      runId: row.run_id,
      status: row.status,
      payload: jsonObject(
        row.payload_json,
        "run event payload",
      ) as AgentRunEvent["payload"],
      occurredAt: toDate(row.occurred_at),
    }));
  }

  async executionOwner(runId: string): Promise<string | null> {
    const [row] = await this.database.query<{ owner: string | null }>(
      `
      SELECT event.payload_json ->> 'ownerId' AS owner
      FROM core.agent_run_event AS event
      JOIN core.project AS project ON project.id = event.project_id AND project.tenant_id = $2
      WHERE event.run_id = $1 AND event.status = 'preparing'
      ORDER BY event.sequence LIMIT 1`,
      [runId, this.tenantId],
    );
    return row?.owner ?? null;
  }

  async admitQueuedRun(input: RunAdmission): Promise<AgentRun | null> {
    return this.database.runInTransaction(async () => {
      const [current] = await this.database.query<RunRow>(
        `
        SELECT ${runColumns} FROM core.agent_run AS run
        JOIN core.project AS project ON project.id = run.project_id AND project.tenant_id = $2
        WHERE run.id = $1 AND run.status = 'queued' FOR UPDATE`,
        [input.runId, this.tenantId],
      );
      if (current === undefined) return null;
      const authority = input.authority;
      let accepted = false;
      if (authority !== null) {
        const [valid] = await this.database.query<{ id: string }>(
          `
          SELECT run.id FROM core.agent_run AS run
          JOIN core.project AS project ON project.id = run.project_id AND project.tenant_id = $7
          JOIN core.task AS task ON task.id = run.task_id AND task.project_id = run.project_id
          JOIN core.agent AS agent ON agent.id = run.agent_id AND agent.project_id = run.project_id
          JOIN core.role AS role ON role.id = agent.role_id AND role.project_id = agent.project_id
          JOIN core.task_lock AS lock ON lock.run_id = run.id AND lock.project_id = run.project_id
          WHERE run.id = $1 AND run.status = 'queued'
            AND task.status = $2 AND task.updated_at = $3
            AND agent.enabled AND agent.role_id = $4 AND agent.updated_at = $5
            AND lock.expires_at > $6 AND (
              ($8::text IS NULL AND run.pipeline_run_id IS NULL AND run.pipeline_stage_run_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM core.pipeline_run AS p
                  WHERE p.project_id = run.project_id AND p.task_id = run.task_id AND p.status = 'active'))
              OR EXISTS (
                SELECT 1 FROM core.pipeline_run AS p
                JOIN core.pipeline_stage_run AS s
                  ON s.pipeline_run_id = p.id AND s.project_id = p.project_id
                 AND s.id = run.pipeline_stage_run_id AND s.stage_index = p.current_stage_index
                WHERE p.id = $8 AND p.project_id = run.project_id AND p.task_id = run.task_id
                  AND p.status = 'active' AND p.version = $9 AND s.id = $10
                  AND s.status = 'active' AND s.assigned_agent_id = run.agent_id
                  AND s.role_id = role.role_key AND run.pipeline_run_id = p.id))
          FOR UPDATE OF run`,
          [
            input.runId,
            authority.taskStatus,
            authority.taskUpdatedAt,
            authority.agentRoleId,
            authority.agentUpdatedAt,
            input.now,
            this.tenantId,
            authority.pipelineId,
            authority.pipelineVersion,
            authority.pipelineStageRunId,
          ],
        );
        accepted = valid !== undefined;
      }
      const status = accepted ? "preparing" : "cancelled";
      const error = accepted
        ? null
        : {
            code: "RUN_NOT_ELIGIBLE",
            message: "Run authority is no longer eligible",
          };
      const [updated] = await this.database.query<{ id: string }>(
        `
        UPDATE core.agent_run AS run
        SET status = $2, updated_at = $3, completed_at = $4, error_json = $5::jsonb
        FROM core.project AS project
        WHERE run.id = $1 AND run.project_id = project.id
          AND project.tenant_id = $6 AND run.status = 'queued'
        RETURNING run.id`,
        [
          input.runId,
          status,
          input.now,
          accepted ? null : input.now,
          error,
          this.tenantId,
        ],
      );
      if (updated === undefined) return null;
      await this.database.query(
        `
        INSERT INTO core.agent_run_event(id, run_id, project_id, status, payload_json, occurred_at)
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [
          `${input.runId}:${status}`,
          input.runId,
          current.project_id,
          status,
          {
            hasResult: false,
            hasError: !accepted,
            ...(input.ownerId === undefined ? {} : { ownerId: input.ownerId }),
          },
          input.now,
        ],
      );
      if (!accepted)
        await this.database.query(
          "DELETE FROM core.task_lock WHERE run_id = $1 AND project_id = $2",
          [input.runId, current.project_id],
        );
      const [result] = await this.database.query<RunRow>(
        `SELECT ${runColumns} FROM core.agent_run AS run WHERE run.id = $1`,
        [input.runId],
      );
      return result === undefined ? null : restoreRun(result);
    });
  }

  async acceptWorkerResult(input: {
    fence: WorkerAuthorityFence;
    run: AgentRun;
    result: AgentExecutionResult;
    acceptedAt: Date;
  }): Promise<boolean> {
    const fence = input.fence;
    const run = input.run.snapshot();
    const expectedExecution = fence.execution;
    const expectedLimits = {
      maxIterations: fence.roleLimits.maxIterations,
      maxCostMicros: fence.roleLimits.maxCostMicros.toString(),
      timeoutSeconds: fence.roleLimits.timeoutSeconds,
    };
    return this.database.runInTransaction(async () => {
      const [updated] = await this.database.query<{ id: string }>(
        `
        UPDATE core.agent_run AS run
        SET status = 'reviewing', result_json = $24::jsonb, updated_at = $16
        FROM core.project AS project, core.task AS task, core.agent AS agent,
             core.role AS role, core.task_lock AS lock
        WHERE run.id = $1 AND run.project_id = $2
          AND project.id = run.project_id AND project.tenant_id = $25
          AND task.id = run.task_id AND task.project_id = run.project_id
          AND agent.id = run.agent_id AND agent.project_id = run.project_id
          AND role.id = agent.role_id AND role.project_id = agent.project_id
          AND lock.task_id = run.task_id AND lock.run_id = run.id
          AND lock.project_id = run.project_id
          AND run.task_id = $3 AND run.agent_id = $4 AND run.status = 'running'
          AND run.updated_at = $5 AND run.execution_json = $6::jsonb
          AND task.status = $7 AND task.updated_at = $8
          AND agent.enabled AND agent.role_id = $9 AND agent.updated_at = $10
          AND role.id = $11 AND role.role_key = $12 AND role.version = $13
          AND role.limits_json = $14::jsonb AND role.updated_at = $15
          AND lock.expires_at > $16 AND (
            ($17::text IS NULL AND run.pipeline_run_id IS NULL AND run.pipeline_stage_run_id IS NULL
              AND NOT EXISTS (SELECT 1 FROM core.pipeline_run AS p
                WHERE p.project_id = run.project_id AND p.task_id = run.task_id AND p.status = 'active'))
            OR EXISTS (
              SELECT 1 FROM core.pipeline_run AS p
              JOIN core.pipeline_stage_run AS s
                ON s.pipeline_run_id = p.id AND s.project_id = p.project_id
               AND s.stage_index = p.current_stage_index
              WHERE p.id = $17 AND p.project_id = run.project_id AND p.task_id = run.task_id
                AND p.status = 'active' AND p.version = $18 AND p.current_stage_index = $19
                AND s.stage_id = $20 AND s.id = $21 AND run.pipeline_stage_run_id = s.id
                AND s.role_id = $22 AND s.status = 'active'
                AND s.assigned_agent_id = $23 AND run.agent_id = s.assigned_agent_id))
        RETURNING run.id`,
        [
          fence.runId,
          fence.projectId,
          fence.taskId,
          fence.agentId,
          run.updatedAt,
          expectedExecution,
          fence.taskStatus,
          fence.taskUpdatedAt,
          fence.agentRoleId,
          fence.agentUpdatedAt,
          fence.roleId,
          fence.roleKey,
          fence.roleVersion,
          expectedLimits,
          fence.roleUpdatedAt,
          input.acceptedAt,
          fence.pipeline?.id ?? null,
          fence.pipeline?.version ?? null,
          fence.pipeline?.currentStageIndex ?? null,
          fence.pipeline?.stageId ?? null,
          fence.pipeline?.stageRunId ?? null,
          fence.pipeline?.stageRoleId ?? null,
          fence.pipeline?.assignedAgentId ?? null,
          input.result,
          this.tenantId,
        ],
      );
      if (updated === undefined) return false;
      await this.database.query(
        `
        INSERT INTO core.agent_run_event(id, run_id, project_id, status, payload_json, occurred_at)
        VALUES ($1, $2, $3, 'reviewing', $4::jsonb, $5)`,
        [
          `${fence.runId}:reviewing`,
          fence.runId,
          fence.projectId,
          { hasResult: true, hasError: false },
          input.acceptedAt,
        ],
      );
      return true;
    });
  }

  async findTaskLock(
    taskId: string,
  ): Promise<{ runId: string; expiresAt: Date } | null> {
    const [row] = await this.database.query<{
      run_id: string;
      expires_at: Timestamp;
    }>(
      `
      SELECT lock.run_id, lock.expires_at FROM core.task_lock AS lock
      JOIN core.project AS project ON project.id = lock.project_id AND project.tenant_id = $2
      WHERE lock.task_id = $1`,
      [taskId, this.tenantId],
    );
    return row === undefined
      ? null
      : { runId: row.run_id, expiresAt: toDate(row.expires_at) };
  }

  async acquireTaskLock(
    taskId: string,
    runId: string,
    acquiredAt: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    const [row] = await this.database.query<{ run_id: string }>(
      `
      INSERT INTO core.task_lock(task_id, project_id, run_id, acquired_at, expires_at)
      SELECT run.task_id, run.project_id, $2, $3, $4
      FROM core.agent_run AS run
      JOIN core.project AS project ON project.id = run.project_id AND project.tenant_id = $5
      WHERE run.id = $2 AND run.task_id = $1
        AND run.status IN ('queued', 'preparing', 'running', 'reviewing')
      ON CONFLICT (task_id) DO UPDATE SET
        project_id = excluded.project_id, run_id = excluded.run_id,
        acquired_at = excluded.acquired_at, expires_at = excluded.expires_at
      WHERE core.task_lock.expires_at <= excluded.acquired_at
      RETURNING run_id`,
      [taskId, runId, acquiredAt, expiresAt, this.tenantId],
    );
    return row?.run_id === runId;
  }

  async renewTaskLock(
    runId: string,
    now: Date,
    newExpiresAt: Date,
  ): Promise<boolean> {
    const [row] = await this.database.query<{ run_id: string }>(
      `
      UPDATE core.task_lock AS lock SET expires_at = $3
      FROM core.agent_run AS run
      JOIN core.project AS project ON project.id = run.project_id AND project.tenant_id = $4
      WHERE lock.run_id = $1 AND lock.project_id = run.project_id AND run.id = $1
        AND run.status IN ('queued', 'preparing', 'running', 'reviewing')
        AND lock.expires_at > $2 AND $3::timestamptz > $2
      RETURNING lock.run_id`,
      [runId, now, newExpiresAt, this.tenantId],
    );
    return row?.run_id === runId;
  }

  async releaseTaskLock(runId: string): Promise<boolean> {
    const [row] = await this.database.query<{ run_id: string }>(
      `
      DELETE FROM core.task_lock AS lock USING core.agent_run AS run
      JOIN core.project AS project ON project.id = run.project_id AND project.tenant_id = $2
      WHERE lock.run_id = $1 AND lock.project_id = run.project_id AND run.id = $1
      RETURNING lock.run_id`,
      [runId, this.tenantId],
    );
    return row?.run_id === runId;
  }
}
