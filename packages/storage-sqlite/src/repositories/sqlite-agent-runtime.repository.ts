import type { Database } from "bun:sqlite";
import type { AgentRuntimeRepository } from "@ai-office/application/ports/agent-runtime-repository.port.ts";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import {
  AgentRun,
  type AgentRunProps,
  type AgentRunStatus,
} from "@ai-office/domain/agent/agent-run.ts";
import type { Role } from "@ai-office/domain/agent/role.ts";

interface AgentRow {
  id: string;
  project_id: string;
  role_id: string;
  name: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}
interface RunRow {
  id: string;
  project_id: string;
  task_id: string;
  agent_id: string;
  status: AgentRunStatus;
  worktree_path: string | null;
  result_json: string | null;
  error_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
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
  "id, project_id, task_id, agent_id, status, worktree_path, result_json, error_json, created_at, started_at, completed_at, updated_at";

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
    this.database
      .prepare(
        `INSERT INTO agent_run(${runColumns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, worktree_path=excluded.worktree_path, result_json=excluded.result_json, error_json=excluded.error_json, started_at=excluded.started_at, completed_at=excluded.completed_at, updated_at=excluded.updated_at`,
      )
      .run(
        v.id,
        v.projectId,
        v.taskId,
        v.agentId,
        v.status,
        v.worktreePath ?? null,
        v.result === undefined ? null : JSON.stringify(v.result),
        v.error === undefined ? null : JSON.stringify(v.error),
        v.createdAt.toISOString(),
        v.startedAt?.toISOString() ?? null,
        v.completedAt?.toISOString() ?? null,
        v.updatedAt.toISOString(),
      );
    this.database
      .prepare(
        "INSERT OR IGNORE INTO agent_run_event(id,run_id,status,payload_json,occurred_at) VALUES (?,?,?,?,?)",
      )
      .run(
        `${v.id}:${v.status}:${v.updatedAt.toISOString()}`,
        v.id,
        v.status,
        JSON.stringify({
          hasResult: v.result !== undefined,
          hasError: v.error !== undefined,
        }),
        v.updatedAt.toISOString(),
      );
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
  async acquireTaskLock(
    taskId: string,
    runId: string,
    acquiredAt: Date,
    expiresAt: Date,
  ): Promise<boolean> {
    this.database
      .prepare("DELETE FROM task_lock WHERE task_id=? AND expires_at <= ?")
      .run(taskId, acquiredAt.toISOString());
    const result = this.database
      .prepare(
        "INSERT OR IGNORE INTO task_lock(task_id, run_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(taskId, runId, acquiredAt.toISOString(), expiresAt.toISOString());
    return result.changes === 1;
  }
  async releaseTaskLock(runId: string): Promise<void> {
    this.database.prepare("DELETE FROM task_lock WHERE run_id=?").run(runId);
  }
}
