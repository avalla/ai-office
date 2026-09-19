import type { ProjectId } from "@ai-office/domain/project/project.ts";
import {
  Task,
  type TaskId,
  type TaskStatus,
} from "@ai-office/domain/task/task.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import { PostgresClient } from "../database/postgres-client.ts";
import {
  PostgresTenantScopeError,
  requirePostgresTenantId,
} from "../database/postgres-tenant-context.ts";

interface TaskRow extends Record<string, unknown> {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  created_at: Date | string;
  updated_at: Date | string;
}

function restore(row: TaskRow): Task {
  return Task.restore({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    status: row.status,
    priority: row.priority,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  });
}

export class PostgresTaskRepository implements TaskRepository {
  private readonly tenantId: string;

  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async findById(id: TaskId): Promise<Task | null> {
    const [row] = await this.database.query<TaskRow>(
      `
        SELECT task.id, task.project_id, task.title, task.description, task.status, task.priority,
               task.created_at, task.updated_at
        FROM core.task AS task
        JOIN core.project AS project
          ON project.id = task.project_id AND project.tenant_id = $2
        WHERE task.id = $1
      `,
      [id, this.tenantId],
    );
    return row === undefined ? null : restore(row);
  }

  async listByProject(projectId: ProjectId): Promise<Task[]> {
    const rows = await this.database.query<TaskRow>(
      `
        SELECT task.id, task.project_id, task.title, task.description, task.status, task.priority,
               task.created_at, task.updated_at
        FROM core.task AS task
        JOIN core.project AS project
          ON project.id = task.project_id AND project.tenant_id = $2
        WHERE task.project_id = $1
        ORDER BY task.priority DESC, task.created_at ASC, task.id ASC
      `,
      [projectId, this.tenantId],
    );
    return rows.map(restore);
  }

  async save(task: Task): Promise<void> {
    const value = task.snapshot();
    const rows = await this.database.query<{ id: string }>(
      `
        INSERT INTO core.task(
          id, project_id, title, description, status, priority,
          created_at, updated_at
        )
        SELECT $1, $2, $3, $4, $5, $6, $7, $8
        WHERE EXISTS (
          SELECT 1 FROM core.project
          WHERE id = $2 AND tenant_id = $9
        )
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          priority = excluded.priority,
          updated_at = excluded.updated_at
        WHERE EXISTS (
          SELECT 1 FROM core.project
          WHERE id = core.task.project_id AND tenant_id = $9
        )
        RETURNING id
      `,
      [
        value.id,
        value.projectId,
        value.title,
        value.description ?? null,
        value.status,
        value.priority,
        value.createdAt,
        value.updatedAt,
        this.tenantId,
      ],
    );
    if (rows.length !== 1)
      throw new PostgresTenantScopeError("Task", value.id);
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}
