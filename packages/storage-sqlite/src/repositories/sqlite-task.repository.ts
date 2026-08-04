import type { Database } from "bun:sqlite";
import { Task } from "@ai-office/domain/task/task.ts";
import type { TaskId, TaskStatus } from "@ai-office/domain/task/task.ts";
import type { ProjectId } from "@ai-office/domain/project/project.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  created_at: string;
  updated_at: string;
}

function restore(row: TaskRow): Task {
  return Task.restore({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    status: row.status,
    priority: row.priority,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at)
  });
}

export class SqliteTaskRepository implements TaskRepository {
  constructor(private readonly database: Database) {}

  async findById(id: TaskId): Promise<Task | null> {
    const row = this.database
      .query<TaskRow, [string]>(`
        SELECT id, project_id, title, description, status, priority, created_at, updated_at
        FROM task
        WHERE id = ?
      `)
      .get(id);

    return row === null ? null : restore(row);
  }

  async listByProject(projectId: ProjectId): Promise<Task[]> {
    return this.database
      .query<TaskRow, [string]>(
        `SELECT id, project_id, title, description, status, priority, created_at, updated_at
         FROM task
         WHERE project_id = ?
         ORDER BY priority DESC, created_at ASC, id ASC`
      )
      .all(projectId)
      .map(restore);
  }

  async save(task: Task): Promise<void> {
    const value = task.snapshot();

    this.database
      .prepare(`
        INSERT INTO task(
          id, project_id, title, description, status, priority, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          priority = excluded.priority,
          updated_at = excluded.updated_at
      `)
      .run(
        value.id,
        value.projectId,
        value.title,
        value.description ?? null,
        value.status,
        value.priority,
        value.createdAt.toISOString(),
        value.updatedAt.toISOString()
      );
  }
}
