import type { Database } from "bun:sqlite";
import type {
  AgentRunEvent,
  AgentRuntimeRepository,
} from "@ai-office/application/ports/agent-runtime-repository.port.ts";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import {
  AgentRun,
  type AgentActionIntent,
  type AgentRunStatus,
} from "@ai-office/domain/agent/agent-run.ts";
import { Role, type RoleLimits } from "@ai-office/domain/agent/role.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";

interface AgentRow {
  id: string;
  project_id: string;
  role_id: string;
  name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}
interface RoleRow {
  id: string;
  project_id: string;
  role_key: string;
  name: string;
  version: number;
  capabilities_json: string;
  tools_json: string;
  model_policy: string;
  limits_json: string;
  source_path: string;
  created_at: string;
  updated_at: string;
}
interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  agent_id: string;
  action_intent_json: string | null;
  pipeline_run_id: string | null;
  status: AgentRunStatus;
  worktree_path: string | null;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}
interface RunEventRow {
  run_id: string;
  status: AgentRunStatus;
  payload_json: string;
  occurred_at: string;
}
const agent = (row: AgentRow): Agent => ({
  id: row.id,
  projectId: row.project_id,
  roleId: row.role_id,
  name: row.name,
  enabled: row.enabled === 1,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});
const run = (row: RunRow): AgentRun =>
  AgentRun.restore({
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    agentId: row.agent_id,
    ...(row.action_intent_json === null
      ? {}
      : {
          actionIntent: JSON.parse(row.action_intent_json) as AgentActionIntent,
        }),
    ...(row.pipeline_run_id === null
      ? {}
      : { pipelineRunId: row.pipeline_run_id }),
    status: row.status,
    ...(row.worktree_path === null ? {} : { worktreePath: row.worktree_path }),
    ...(row.result_json === null
      ? {}
      : { result: JSON.parse(row.result_json) as unknown }),
    ...(row.error_json === null
      ? {}
      : { error: JSON.parse(row.error_json) as unknown }),
    createdAt: new Date(row.created_at),
    ...(row.started_at === null ? {} : { startedAt: new Date(row.started_at) }),
    ...(row.completed_at === null
      ? {}
      : { completedAt: new Date(row.completed_at) }),
    updatedAt: new Date(row.updated_at),
  });
const runColumns =
  "id, project_id, task_id, agent_id, action_intent_json, pipeline_run_id, status, worktree_path, result_json, error_json, created_at, started_at, completed_at, updated_at";

function parseStoredStringArray(json: string, field: string): string[] {
  const value = JSON.parse(json) as unknown;
  if (!Array.isArray(value))
    throw new DomainValidationError(
      `Stored role ${field} must be a string array`,
    );
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string")
      throw new DomainValidationError(
        `Stored role ${field} must be a string array`,
      );
    result.push(item);
  }
  return result;
}

function parseStoredRoleLimits(json: string): RoleLimits {
  const value = JSON.parse(json) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new DomainValidationError("Stored role limits must be an object");
  const record = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(record.maxIterations) ||
    typeof record.maxIterations !== "number" ||
    !Number.isSafeInteger(record.timeoutSeconds) ||
    typeof record.timeoutSeconds !== "number" ||
    typeof record.maxCostMicros !== "string"
  )
    throw new DomainValidationError("Stored role limits are invalid");
  let maxCostMicros: bigint;
  try {
    maxCostMicros = BigInt(record.maxCostMicros);
  } catch {
    throw new DomainValidationError("Stored role max cost is invalid");
  }
  if (
    record.maxIterations < 1 ||
    record.timeoutSeconds < 1 ||
    maxCostMicros < 0n
  )
    throw new DomainValidationError("Stored role limits are invalid");
  return {
    maxIterations: record.maxIterations,
    maxCostMicros,
    timeoutSeconds: record.timeoutSeconds,
  };
}

export class SqliteAgentRuntimeRepository implements AgentRuntimeRepository {
  constructor(private readonly database: Database) {}
  async saveRole(role: Role): Promise<void> {
    const v = role.snapshot();
    this.database
      .prepare(
        `INSERT INTO role(id, project_id, role_key, name, version, capabilities_json, tools_json, model_policy, limits_json, source_path, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, role_key) DO UPDATE SET name=excluded.name, version=excluded.version, capabilities_json=excluded.capabilities_json, tools_json=excluded.tools_json, model_policy=excluded.model_policy, limits_json=excluded.limits_json, source_path=excluded.source_path, updated_at=excluded.updated_at`,
      )
      .run(
        v.id,
        v.projectId,
        v.key,
        v.name,
        v.version,
        JSON.stringify(v.capabilities),
        JSON.stringify(v.tools),
        v.modelPolicy,
        JSON.stringify({
          maxIterations: v.limits.maxIterations,
          maxCostMicros: v.limits.maxCostMicros.toString(),
          timeoutSeconds: v.limits.timeoutSeconds,
        }),
        v.sourcePath,
        v.createdAt.toISOString(),
        v.updatedAt.toISOString(),
      );
  }
  async findRole(id: string, projectId: string): Promise<Role | null> {
    const row = this.database
      .query<RoleRow, [string, string]>(
        "SELECT id, project_id, role_key, name, version, capabilities_json, tools_json, model_policy, limits_json, source_path, created_at, updated_at FROM role WHERE id=? AND project_id=?",
      )
      .get(id, projectId);
    if (row === null) return null;
    return Role.restore({
      id: row.id,
      projectId: row.project_id,
      key: row.role_key,
      name: row.name,
      version: row.version,
      capabilities: parseStoredStringArray(
        row.capabilities_json,
        "capabilities",
      ),
      tools: parseStoredStringArray(row.tools_json, "tools"),
      modelPolicy: row.model_policy,
      limits: parseStoredRoleLimits(row.limits_json),
      sourcePath: row.source_path,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }
  async saveAgent(value: Agent): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO agent(id, project_id, role_id, name, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, name) DO UPDATE SET role_id=excluded.role_id, enabled=excluded.enabled, updated_at=excluded.updated_at`,
      )
      .run(
        value.id,
        value.projectId,
        value.roleId,
        value.name,
        value.enabled ? 1 : 0,
        value.createdAt.toISOString(),
        value.updatedAt.toISOString(),
      );
  }
  async listAgents(projectId: string): Promise<Agent[]> {
    return this.database
      .query<AgentRow, [string]>(
        "SELECT id, project_id, role_id, name, enabled, created_at, updated_at FROM agent WHERE project_id=? ORDER BY name, id",
      )
      .all(projectId)
      .map(agent);
  }
  async findAgent(id: string): Promise<Agent | null> {
    const row = this.database
      .query<AgentRow, [string]>(
        "SELECT id, project_id, role_id, name, enabled, created_at, updated_at FROM agent WHERE id=?",
      )
      .get(id);
    return row === null ? null : agent(row);
  }
  async saveRun(value: AgentRun): Promise<void> {
    const v = value.snapshot();
    this.database.transaction(() => {
      const previous = this.database
        .query<{ status: AgentRunStatus }, [string]>(
          "SELECT status FROM agent_run WHERE id=?",
        )
        .get(v.id);
      this.database
        .prepare(
          `INSERT INTO agent_run(${runColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, worktree_path=excluded.worktree_path, result_json=excluded.result_json, error_json=excluded.error_json, started_at=excluded.started_at, completed_at=excluded.completed_at, updated_at=excluded.updated_at`,
        )
        .run(
          v.id,
          v.projectId,
          v.taskId,
          v.agentId,
          v.actionIntent === undefined ? null : JSON.stringify(v.actionIntent),
          v.pipelineRunId ?? null,
          v.status,
          v.worktreePath ?? null,
          v.result === undefined ? null : JSON.stringify(v.result),
          v.error === undefined ? null : JSON.stringify(v.error),
          v.createdAt.toISOString(),
          v.startedAt?.toISOString() ?? null,
          v.completedAt?.toISOString() ?? null,
          v.updatedAt.toISOString(),
        );
      if (previous?.status !== v.status)
        this.database
          .prepare(
            "INSERT INTO agent_run_event(id,run_id,status,payload_json,occurred_at) VALUES (?,?,?,?,?)",
          )
          .run(
            `${v.id}:${v.status}`,
            v.id,
            v.status,
            JSON.stringify({
              hasResult: v.result !== undefined,
              hasError: v.error !== undefined,
            }),
            v.updatedAt.toISOString(),
          );
    })();
  }
  async findRun(id: string): Promise<AgentRun | null> {
    const row = this.database
      .query<RunRow, [string]>(`SELECT ${runColumns} FROM agent_run WHERE id=?`)
      .get(id);
    return row === null ? null : run(row);
  }
  async listRuns(projectId: string): Promise<AgentRun[]> {
    return this.database
      .query<RunRow, [string]>(
        `SELECT ${runColumns} FROM agent_run WHERE project_id=? ORDER BY created_at, id`,
      )
      .all(projectId)
      .map(run);
  }
  async listQueuedRuns(projectId: string, limit: number): Promise<AgentRun[]> {
    return this.database
      .query<RunRow, [string, number]>(
        `SELECT ${runColumns} FROM agent_run WHERE project_id=? AND status='queued' ORDER BY created_at, id LIMIT ?`,
      )
      .all(projectId, limit)
      .map(run);
  }
  async listRecoverableRuns(projectId: string): Promise<AgentRun[]> {
    return this.database
      .query<RunRow, [string]>(
        `SELECT ${runColumns} FROM agent_run WHERE project_id=? AND status IN ('preparing','running','reviewing') ORDER BY updated_at,id`,
      )
      .all(projectId)
      .map(run);
  }
  async listRunEvents(runId: string): Promise<AgentRunEvent[]> {
    return this.database
      .query<RunEventRow, [string]>(
        "SELECT run_id,status,payload_json,occurred_at FROM agent_run_event WHERE run_id=? ORDER BY rowid",
      )
      .all(runId)
      .map((row) => ({
        runId: row.run_id,
        status: row.status,
        payload: JSON.parse(row.payload_json) as AgentRunEvent["payload"],
        occurredAt: new Date(row.occurred_at),
      }));
  }
  async acquireTaskLock(
    taskId: string,
    runId: string,
    acquiredAt: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    const row = this.database
      .query<
        { run_id: string },
        [string, string, string, string, string, string]
      >(
        `INSERT INTO task_lock(task_id,run_id,acquired_at,expires_at)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM agent_run
           WHERE id = ? AND task_id = ?
             AND status IN ('queued','preparing','running','reviewing')
         )
         ON CONFLICT(task_id) DO UPDATE SET
           run_id=excluded.run_id,
           acquired_at=excluded.acquired_at,
           expires_at=excluded.expires_at
         WHERE task_lock.expires_at <= excluded.acquired_at
         RETURNING run_id`,
      )
      .get(
        taskId,
        runId,
        acquiredAt.toISOString(),
        expiresAt.toISOString(),
        runId,
        taskId,
      );
    return row?.run_id === runId;
  }
  async renewTaskLock(
    runId: string,
    now: Date,
    newExpiresAt: Date,
  ): Promise<boolean> {
    if (newExpiresAt.getTime() <= now.getTime()) return false;
    return (
      this.database
        .prepare(
          `UPDATE task_lock SET expires_at=?
           WHERE run_id=? AND expires_at>?
             AND EXISTS (
               SELECT 1 FROM agent_run
               WHERE agent_run.id = task_lock.run_id
                 AND agent_run.status IN (
                   'queued','preparing','running','reviewing'
                 )
             )`,
        )
        .run(newExpiresAt.toISOString(), runId, now.toISOString()).changes === 1
    );
  }
  async releaseTaskLock(runId: string): Promise<boolean> {
    return (
      this.database.prepare("DELETE FROM task_lock WHERE run_id=?").run(runId)
        .changes === 1
    );
  }
}
