import type { ProjectId } from "@ai-office/domain/project/project.ts";
import {
  Task,
  type TaskId,
  type TaskStatus,
} from "@ai-office/domain/task/task.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import { PostgresClient } from "../database/postgres-client.ts";

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
  constructor(private readonly database: PostgresClient) {}

  async findById(id: TaskId): Promise<Task | null> {
    const [row] = await this.database.query<TaskRow>(
      `
        SELECT id, project_id, title, description, status, priority,
               created_at, updated_at
        FROM core.task
        WHERE id = $1
      `,
      [id],
    );
    return row === undefined ? null : restore(row);
  }

  async listByProject(projectId: ProjectId): Promise<Task[]> {
    const rows = await this.database.query<TaskRow>(
      `
        SELECT id, project_id, title, description, status, priority,
               created_at, updated_at
        FROM core.task
        WHERE project_id = $1
        ORDER BY priority DESC, created_at ASC, id ASC
      `,
      [projectId],
    );
    return rows.map(restore);
  }

  async save(task: Task): Promise<void> {
    const value = task.snapshot();
    await this.database.query(
      `
        INSERT INTO core.task(
          id, project_id, title, description, status, priority,
          created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          priority = excluded.priority,
          updated_at = excluded.updated_at
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
      ],
    );
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}
