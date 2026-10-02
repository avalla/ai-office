import type { Database } from "bun:sqlite";
import type {
  TaskDependency,
  TaskDependencyRepository,
} from "@ai-office/application/ports/task-dependency-repository.port.ts";

interface Row {
  project_id: string;
  task_id: string;
  depends_on_task_id: string;
  created_at: string;
}

export class SqliteTaskDependencyRepository implements TaskDependencyRepository {
  constructor(private readonly database: Database) {}

  async hasExecutionHistory(
    projectId: string,
    taskId: string,
  ): Promise<boolean> {
    return (
      this.database
        .query<{ present: number }, [string, string]>(
          `SELECT EXISTS (SELECT 1 FROM task_execution_history
            WHERE project_id = ?1 AND task_id = ?2) AS present`,
        )
        .get(projectId, taskId)?.present === 1
    );
  }

  async listByProject(projectId: string): Promise<TaskDependency[]> {
    return this.database
      .query<Row, [string]>(
        `SELECT project_id, task_id, depends_on_task_id, created_at
       FROM task_dependency WHERE project_id = ?
       ORDER BY task_id, depends_on_task_id`,
      )
      .all(projectId)
      .map((row) => ({
        projectId: row.project_id,
        taskId: row.task_id,
        dependsOnTaskId: row.depends_on_task_id,
        createdAt: new Date(row.created_at),
      }));
  }

  async link(value: TaskDependency): Promise<boolean> {
    return (
      this.database
        .prepare(
          `INSERT INTO task_dependency(project_id, task_id, depends_on_task_id, created_at)
       SELECT ?, ?, ?, ? WHERE EXISTS (
         SELECT 1 FROM task task JOIN task prerequisite ON prerequisite.id = ?
         WHERE task.id = ? AND task.project_id = ? AND prerequisite.project_id = ?
       ) ON CONFLICT(task_id, depends_on_task_id) DO NOTHING`,
        )
        .run(
          value.projectId,
          value.taskId,
          value.dependsOnTaskId,
          value.createdAt.toISOString(),
          value.dependsOnTaskId,
          value.taskId,
          value.projectId,
          value.projectId,
        ).changes === 1
    );
  }

  async unlink(
    projectId: string,
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<boolean> {
    return (
      this.database
        .prepare(
          `DELETE FROM task_dependency WHERE project_id = ? AND task_id = ? AND depends_on_task_id = ?`,
        )
        .run(projectId, taskId, dependsOnTaskId).changes === 1
    );
  }
}
