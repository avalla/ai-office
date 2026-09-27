import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import type { ProjectId } from "@ai-office/domain/project/project.ts";
import { Task, type TaskId, type TaskStatus } from "@ai-office/domain/task/task.ts";
import { RecordId, type Surreal } from "surrealdb";
import { querySurreal, withSurrealTransaction } from "./transaction-context.ts";
import { asDate, recordKey } from "./surreal-project-repository.ts";

type Row = Record<string, unknown>;

export class SurrealTaskRepository implements TaskRepository {
  constructor(
    private readonly db: Surreal,
    private readonly tenantId: string,
  ) {}

  async findById(id: TaskId): Promise<Task | null> {
    const [rows] = await querySurreal<[Row[]]>(this.db,
      "SELECT * FROM type::record('office_task', $key) WHERE tenant_id = $tenant LIMIT 1",
      { key: recordKey(id), tenant: this.tenantId },
    );
    return rows?.[0] === undefined ? null : restore(rows[0]);
  }

  async listByProject(projectId: ProjectId): Promise<Task[]> {
    const [rows] = await querySurreal<[Row[]]>(this.db,
      `SELECT * FROM office_task
       WHERE tenant_id = $tenant AND project_id = $project
       ORDER BY priority DESC, created_at ASC, external_id ASC`,
      { tenant: this.tenantId, project: projectId },
    );
    return (rows ?? []).map(restore);
  }

  async save(task: Task): Promise<void> {
    const value = task.snapshot();
    await withSurrealTransaction(this.db, async () => querySurreal(this.db,
      `LET $owner = (SELECT id FROM type::record('office_project', $project_key)
         WHERE tenant_id = $tenant LIMIT 1);
       IF array::len($owner) = 0 {
         THROW 'Task project is not visible in the trusted tenant context';
       };
       LET $updated = (UPDATE type::record('office_task', $key)
         MERGE { title: $title, description: $description, status: $status,
                 priority: $priority, updated_at: $updated_at }
         WHERE tenant_id = $tenant RETURN AFTER);
       IF array::len($updated) = 0 {
         CREATE ONLY type::record('office_task', $key) CONTENT {
           tenant_id: $tenant, project_id: $project,
           external_id: $external_id, title: $title, description: $description,
           status: $status, priority: $priority,
           created_at: $created_at, updated_at: $updated_at
         };
         RELATE ONLY $project_record->office_project_task->$task_record
           SET tenant_id = $tenant, project_id = $project;
       };`,
      {
        key: recordKey(value.id),
        tenant: this.tenantId,
        project: value.projectId,
        project_key: recordKey(value.projectId),
        project_record: new RecordId("office_project", recordKey(value.projectId)),
        task_record: new RecordId("office_task", recordKey(value.id)),
        external_id: value.id,
        title: value.title,
        description: value.description,
        status: value.status,
        priority: value.priority,
        created_at: value.createdAt,
        updated_at: value.updatedAt,
      },
    ));
  }
}

function restore(row: Row): Task {
  return Task.restore({
    id: String(row.external_id),
    projectId: String(row.project_id),
    title: String(row.title),
    ...(typeof row.description === "string" ? { description: row.description } : {}),
    status: String(row.status) as TaskStatus,
    priority: Number(row.priority),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  });
}
