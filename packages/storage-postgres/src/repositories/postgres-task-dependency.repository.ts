import type {
  TaskDependency,
  TaskDependencyRepository,
} from "@ai-office/application/ports/task-dependency-repository.port.ts";
import { PostgresClient } from "../database/postgres-client.ts";
import { requirePostgresTenantId } from "../database/postgres-tenant-context.ts";

interface Row extends Record<string, unknown> {
  project_id: string;
  task_id: string;
  depends_on_task_id: string;
  created_at: Date | string;
}

export class PostgresTaskDependencyRepository implements TaskDependencyRepository {
  private readonly tenantId: string;

  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async hasExecutionHistory(
    projectId: string,
    taskId: string,
  ): Promise<boolean> {
    const rows = await this.database.query<{ present: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM core.task_execution_history h
        JOIN core.project p ON p.id = h.project_id
        WHERE h.project_id = $1 AND h.task_id = $2 AND p.tenant_id = $3
      ) AS present`,
      [projectId, taskId, this.tenantId],
    );
    return rows[0]?.present === true;
  }

  async listByProject(projectId: string): Promise<TaskDependency[]> {
    const rows = await this.database.query<Row>(
      `SELECT d.project_id, d.task_id, d.depends_on_task_id, d.created_at
       FROM core.task_dependency d JOIN core.project p ON p.id = d.project_id
       WHERE d.project_id = $1 AND p.tenant_id = $2
       ORDER BY d.task_id, d.depends_on_task_id`,
      [projectId, this.tenantId],
    );
    return rows.map((row) => ({
      projectId: row.project_id,
      taskId: row.task_id,
      dependsOnTaskId: row.depends_on_task_id,
      createdAt: new Date(row.created_at),
    }));
  }

  async link(value: TaskDependency): Promise<boolean> {
    const rows = await this.database.query<{ task_id: string }>(
      `INSERT INTO core.task_dependency(project_id, task_id, depends_on_task_id, created_at)
       SELECT $1, $2, $3, $4 WHERE EXISTS (
         SELECT 1 FROM core.project p
         JOIN core.task task ON task.project_id = p.id AND task.id = $2
         JOIN core.task prerequisite ON prerequisite.project_id = p.id AND prerequisite.id = $3
         WHERE p.id = $1 AND p.tenant_id = $5
       ) ON CONFLICT(task_id, depends_on_task_id) DO NOTHING RETURNING task_id`,
      [
        value.projectId,
        value.taskId,
        value.dependsOnTaskId,
        value.createdAt,
        this.tenantId,
      ],
    );
    return rows.length === 1;
  }

  async unlink(
    projectId: string,
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<boolean> {
    const rows = await this.database.query<{ task_id: string }>(
      `DELETE FROM core.task_dependency d WHERE d.project_id = $1 AND d.task_id = $2
       AND d.depends_on_task_id = $3 AND EXISTS (
         SELECT 1 FROM core.project p WHERE p.id = d.project_id AND p.tenant_id = $4
       ) RETURNING d.task_id`,
      [projectId, taskId, dependsOnTaskId, this.tenantId],
    );
    return rows.length === 1;
  }
}
