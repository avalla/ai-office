import {
  AgentRunPersistenceConflictError,
  canPersistAgentRunTransition,
} from "@ai-office/application/ports/agent-runtime-repository.port.ts";
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
type NumericColumn = number | string;
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
  version: NumericColumn;
  capabilities_json: JsonColumn;
  tools_json: JsonColumn;
  model_policy: string;
  limits_json: JsonColumn;
  source_path: string;
  guidance_text: string;
  guidance_version: NumericColumn;
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
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
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
function safeNumber(value: NumericColumn, label: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result))
    throw new Error(`Stored ${label} is invalid`);
  return result;
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
    version: safeNumber(row.version, "role version"),
    capabilities: stringArray(row.capabilities_json, "capabilities"),
    tools: stringArray(row.tools_json, "tools"),
    modelPolicy: row.model_policy,
    limits: roleLimits(row.limits_json),
    sourcePath: row.source_path,
    ...(row.guidance_text === "" ? {} : { guidanceText: row.guidance_text }),
    guidanceVersion: safeNumber(row.guidance_version, "role guidance version"),
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

  private async appendRunEvent(
    run: ReturnType<AgentRun["snapshot"]>,
    previousStatus: AgentRunStatus | undefined,
  ): Promise<void> {
    await this.database.query(
      `
      INSERT INTO core.agent_run_event(
        id, run_id, project_id, status, payload_json, occurred_at
      )
      VALUES ($1, $2, $3, $4, $5::jsonb, $6)
      ON CONFLICT (id) DO NOTHING`,
      [
        `${run.id}:${run.status}`,
        run.id,
        run.projectId,
        run.status,
        {
          hasResult: run.result !== undefined,
          hasError: run.error !== undefined,
          ...(run.execution === undefined ? {} : { execution: run.execution }),
          ...(previousStatus === undefined && run.modelRouting !== undefined
            ? { modelRouting: run.modelRouting }
            : {}),
        },
        run.updatedAt,
      ],
    );
  }
  async saveRun(value: AgentRun): Promise<void> {
    const run = value.snapshot();
    await this.database.runInTransaction(async () => {
      const inserted = await this.database.query<{ id: string }>(
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
        ON CONFLICT (id) DO NOTHING
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
      if (inserted.length === 1) {
        await this.appendRunEvent(run, undefined);
        return;
      }
      const [current] = await this.database.query<RunRow>(
        `SELECT ${runColumns} FROM core.agent_run AS run
         JOIN core.project AS project
           ON project.id = run.project_id AND project.tenant_id = $2
         WHERE run.id = $1 FOR UPDATE OF run`,
        [run.id, this.tenantId],
      );
      if (current === undefined || current.status === null)
        throw new PostgresTenantScopeError("AgentRun", run.id);
      if (
        current.project_id !== run.projectId ||
        current.task_id !== run.taskId ||
        current.agent_id !== run.agentId ||
        current.pipeline_run_id !== (run.pipelineRunId ?? null) ||
        current.pipeline_stage_run_id !== (run.pipelineStageRunId ?? null) ||
        stableJson(jsonValue(current.action_intent_json)) !==
          stableJson(run.actionIntent ?? null) ||
        stableJson(jsonValue(current.model_routing_json)) !==
          stableJson(run.modelRouting ?? null) ||
        stableJson(jsonValue(current.role_guidance_json)) !==
          stableJson(run.roleGuidance ?? null) ||
        toDate(current.created_at).getTime() !== run.createdAt.getTime()
      )
        throw new AgentRunPersistenceConflictError(run.id);
      if (current.status === run.status) {
        const sameMutableState =
          current.worktree_path === (run.worktreePath ?? null) &&
          stableJson(jsonValue(current.result_json)) ===
            stableJson(run.result ?? null) &&
          stableJson(jsonValue(current.error_json)) ===
            stableJson(run.error ?? null) &&
          (current.started_at === null
            ? undefined
            : toDate(current.started_at).getTime()) ===
            (run.startedAt?.getTime() ?? undefined) &&
          (current.completed_at === null
            ? undefined
            : toDate(current.completed_at).getTime()) ===
            (run.completedAt?.getTime() ?? undefined) &&
          stableJson(jsonValue(current.execution_json)) ===
            stableJson(run.execution ?? null) &&
          toDate(current.updated_at).getTime() === run.updatedAt.getTime();
        if (sameMutableState) return;
        throw new AgentRunPersistenceConflictError(run.id);
      }
      if (
        !canPersistAgentRunTransition(current.status, run.status) ||
        toDate(current.updated_at).getTime() > run.updatedAt.getTime()
      )
        throw new AgentRunPersistenceConflictError(run.id);
      const [updated] = await this.database.query<{ id: string }>(
        `UPDATE core.agent_run AS current
         SET status = $2, worktree_path = $3, result_json = $4::jsonb,
             error_json = $5::jsonb, started_at = $6, completed_at = $7,
             updated_at = $8, execution_json = $9::jsonb
         WHERE current.id = $1 AND current.status = $10 AND current.updated_at = $11
         RETURNING current.id`,
        [
          run.id,
          run.status,
          run.worktreePath ?? null,
          run.result === undefined ? null : run.result,
          run.error === undefined ? null : run.error,
          run.startedAt ?? null,
          run.completedAt ?? null,
          run.updatedAt,
          run.execution === undefined ? null : run.execution,
          current.status,
          current.updated_at,
        ],
      );
      if (updated === undefined)
        throw new AgentRunPersistenceConflictError(run.id);
      await this.appendRunEvent(run, current.status);
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

  /**
   * Authority lock order: task → agent → role → task_lock → pipeline_run →
   * pipeline_stage_run → agent_run. The task lock also closes the negative
   * pipeline case: pipeline/task_lock inserts must take a FK key-share lock on
   * this task and therefore cannot create a phantom authority while this
   * transaction is deciding admission/result acceptance. Future PostgreSQL
   * pipeline writers must use this same task-scoped boundary.
   */
  private async lockAuthorityRows(
    projectId: string,
    taskId: string,
    agentId: string,
  ): Promise<void> {
    await this.database.query(
      `SELECT task.id FROM core.task AS task
       JOIN core.project AS project
         ON project.id = task.project_id AND project.tenant_id = $3
       WHERE task.id = $1 AND task.project_id = $2
       FOR UPDATE OF task`,
      [taskId, projectId, this.tenantId],
    );
    const [agent] = await this.database.query<{ role_id: string }>(
      `SELECT agent.role_id FROM core.agent AS agent
       JOIN core.project AS project
         ON project.id = agent.project_id AND project.tenant_id = $3
       WHERE agent.id = $1 AND agent.project_id = $2
       FOR UPDATE OF agent`,
      [agentId, projectId, this.tenantId],
    );
    if (agent !== undefined)
      await this.database.query(
        `SELECT role.id FROM core.role AS role
         JOIN core.project AS project
           ON project.id = role.project_id AND project.tenant_id = $3
         WHERE role.id = $1 AND role.project_id = $2
         FOR UPDATE OF role`,
        [agent.role_id, projectId, this.tenantId],
      );
    await this.database.query(
      `SELECT lock.task_id FROM core.task_lock AS lock
       JOIN core.project AS project
         ON project.id = lock.project_id AND project.tenant_id = $3
       WHERE lock.task_id = $1 AND lock.project_id = $2
       FOR UPDATE OF lock`,
      [taskId, projectId, this.tenantId],
    );
    await this.database.query(
      `SELECT pipeline.id FROM core.pipeline_run AS pipeline
       JOIN core.project AS project
         ON project.id = pipeline.project_id AND project.tenant_id = $2
       WHERE pipeline.project_id = $1 AND pipeline.task_id = $3
       ORDER BY pipeline.id
       FOR UPDATE OF pipeline`,
      [projectId, this.tenantId, taskId],
    );
    await this.database.query(
      `SELECT stage.id FROM core.pipeline_stage_run AS stage
       JOIN core.pipeline_run AS pipeline
         ON pipeline.id = stage.pipeline_run_id
        AND pipeline.project_id = stage.project_id
       JOIN core.project AS project
         ON project.id = stage.project_id AND project.tenant_id = $2
       WHERE stage.project_id = $1 AND pipeline.task_id = $3
       ORDER BY pipeline.id, stage.stage_index, stage.id
       FOR UPDATE OF stage`,
      [projectId, this.tenantId, taskId],
    );
  }
  async admitQueuedRun(input: RunAdmission): Promise<AgentRun | null> {
    return this.database.runInTransaction(async () => {
      const [candidate] = await this.database.query<{
        project_id: string;
        task_id: string;
        agent_id: string;
      }>(
        `SELECT run.project_id, run.task_id, run.agent_id
         FROM core.agent_run AS run
         JOIN core.project AS project
           ON project.id = run.project_id AND project.tenant_id = $2
         WHERE run.id = $1 AND run.status = 'queued'`,
        [input.runId, this.tenantId],
      );
      if (candidate === undefined) return null;
      await this.lockAuthorityRows(
        candidate.project_id,
        candidate.task_id,
        candidate.agent_id,
      );
      const [current] = await this.database.query<RunRow>(
        `SELECT ${runColumns} FROM core.agent_run AS run
         JOIN core.project AS project
           ON project.id = run.project_id AND project.tenant_id = $2
         WHERE run.id = $1 AND run.status = 'queued'
         FOR UPDATE OF run`,
        [input.runId, this.tenantId],
      );
      if (current === undefined) return null;
      const authority = input.authority;
      let accepted = false;
      if (authority !== null) {
        const [valid] = await this.database.query<{ id: string }>(
          `
          SELECT run.id FROM core.agent_run AS run
          JOIN core.project AS project ON project.id = run.project_id AND project.tenant_id = $12
          JOIN core.task AS task ON task.id = run.task_id AND task.project_id = run.project_id
          JOIN core.agent AS agent ON agent.id = run.agent_id AND agent.project_id = run.project_id
          JOIN core.role AS role ON role.id = agent.role_id AND role.project_id = agent.project_id
          JOIN core.task_lock AS lock ON lock.run_id = run.id AND lock.project_id = run.project_id
          WHERE run.id = $1 AND run.status = 'queued'
            AND task.status = $2 AND task.updated_at = $3
            AND agent.enabled AND agent.role_id = $4 AND agent.updated_at = $5
            AND role.id = $6 AND role.role_key = $7 AND role.version = $8
            AND role.limits_json = $9::jsonb AND role.updated_at = $10
            AND lock.expires_at > $11 AND (
              ($13::text IS NULL AND run.pipeline_run_id IS NULL AND run.pipeline_stage_run_id IS NULL
                AND NOT EXISTS (SELECT 1 FROM core.pipeline_run AS p
                  WHERE p.project_id = run.project_id AND p.task_id = run.task_id AND p.status = 'active'))
              OR EXISTS (
                SELECT 1 FROM core.pipeline_run AS p
                JOIN core.pipeline_stage_run AS s
                  ON s.pipeline_run_id = p.id AND s.project_id = p.project_id
                 AND s.id = run.pipeline_stage_run_id AND s.stage_index = p.current_stage_index
                WHERE p.id = $13 AND p.project_id = run.project_id AND p.task_id = run.task_id
                  AND p.status = 'active' AND p.version = $14 AND s.id = $15
                  AND s.status = 'active' AND s.assigned_agent_id = run.agent_id
                  AND s.role_id = role.role_key AND run.pipeline_run_id = p.id))
          `,
          [
            input.runId,
            authority.taskStatus,
            authority.taskUpdatedAt,
            authority.agentRoleId,
            authority.agentUpdatedAt,
            authority.roleId,
            authority.roleKey,
            authority.roleVersion,
            {
              maxIterations: authority.roleLimits.maxIterations,
              maxCostMicros: authority.roleLimits.maxCostMicros.toString(),
              timeoutSeconds: authority.roleLimits.timeoutSeconds,
            },
            authority.roleUpdatedAt,
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
      // Lock the entire fence before evaluating it; UPDATE rechecks only after
      // every authority writer in the documented order has been serialized.
      await this.lockAuthorityRows(
        fence.projectId,
        fence.taskId,
        fence.agentId,
      );
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
