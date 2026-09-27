import type {
  LinkedRequirement,
  TaskRequirementLink,
  TaskRequirementRepository,
} from "@ai-office/application/ports/task-requirement-repository.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { RecordId, type Surreal } from "surrealdb";
import { querySurreal } from "./transaction-context.ts";
import { asDate, recordKey } from "./surreal-project-repository.ts";

type Row = Record<string, unknown>;

export class SurrealTaskRequirementRepository
  implements TaskRequirementRepository
{
  constructor(
    private readonly db: Surreal,
    private readonly tenantId: string,
    private readonly transactions: TransactionRunner,
  ) {}

  async link(input: {
    projectId: string;
    taskId: string;
    requirementId: string;
    now: Date;
  }): Promise<boolean> {
    return this.transactions.run(async () => {
      const [tasks] = await querySurreal<[Row[]]>(this.db,
        `SELECT id FROM type::record('office_task', $task_key)
         WHERE tenant_id = $tenant AND project_id = $project LIMIT 1`,
        {
          task_key: recordKey(input.taskId),
          tenant: this.tenantId,
          project: input.projectId,
        },
      );
      const [requirements] = await querySurreal<[Row[]]>(this.db,
        `SELECT id FROM type::record('office_requirement', $requirement_key)
         WHERE tenant_id = $tenant AND project_id = $project LIMIT 1`,
        {
          requirement_key: recordKey(input.requirementId),
          tenant: this.tenantId,
          project: input.projectId,
        },
      );
      const taskRecord = tasks?.[0]?.id;
      const requirementRecord = requirements?.[0]?.id;
      if (taskRecord === undefined || requirementRecord === undefined)
        return false;

      const [existing] = await querySurreal<[Row[]]>(this.db,
        `SELECT id FROM office_task_requirement
         WHERE in = type::record('office_task', $task_key)
           AND out = type::record('office_requirement', $requirement_key)
           AND tenant_id = $tenant AND project_id = $project LIMIT 1`,
        {
          task_key: recordKey(input.taskId),
          requirement_key: recordKey(input.requirementId),
          tenant: this.tenantId,
          project: input.projectId,
        },
      );
      if (existing?.length) return false;

      await querySurreal(this.db,
        `RELATE ONLY $task_record->office_task_requirement->$requirement_record
         SET tenant_id = $tenant, project_id = $project, created_at = $created_at`,
        {
          task_record: taskRecord,
          requirement_record: requirementRecord,
          tenant: this.tenantId,
          project: input.projectId,
          created_at: input.now,
        },
      );
      return true;
    });
  }

  async unlink(input: {
    projectId: string;
    taskId: string;
    requirementId: string;
  }): Promise<boolean> {
    const [removed] = await querySurreal<[Row[]]>(this.db,
      `DELETE FROM office_task_requirement
       WHERE in = type::record('office_task', $task_key)
         AND out = type::record('office_requirement', $requirement_key)
         AND tenant_id = $tenant AND project_id = $project
       RETURN BEFORE`,
      {
        task_key: recordKey(input.taskId),
        requirement_key: recordKey(input.requirementId),
        tenant: this.tenantId,
        project: input.projectId,
      },
    );
    return (removed?.length ?? 0) > 0;
  }

  async listForTask(
    projectId: string,
    taskId: string,
  ): Promise<LinkedRequirement[]> {
    const [rows] = await querySurreal<[Row[]]>(this.db,
      `SELECT out.external_id AS requirement_id,
              out.requirement_key AS key, out.title AS title, out.status AS status
       FROM office_task_requirement
       WHERE in = type::record('office_task', $task_key)
         AND tenant_id = $tenant AND project_id = $project
       ORDER BY out.requirement_key, out.external_id`,
      {
        task_key: recordKey(taskId),
        tenant: this.tenantId,
        project: projectId,
      },
    );
    return (rows ?? []).map(toLinkedRequirement);
  }

  async listForTasks(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<Map<string, LinkedRequirement[]>> {
    const grouped = new Map<string, LinkedRequirement[]>();
    if (taskIds.length === 0) return grouped;
    const keys = taskIds.map(recordKey);
    const [rows] = await querySurreal<[Row[]]>(this.db,
      `SELECT in.external_id AS task_id, out.external_id AS requirement_id,
              out.requirement_key AS key, out.title AS title, out.status AS status
       FROM office_task_requirement
       WHERE in IN $task_keys AND tenant_id = $tenant AND project_id = $project
       ORDER BY in.external_id, out.requirement_key, out.external_id`,
      { task_keys: keys.map((key) => new RecordId("office_task", key)), tenant: this.tenantId, project: projectId },
    );
    for (const row of [...(rows ?? [])].sort(compareRelationRows)) {
      const taskId = String(row.task_id);
      const list = grouped.get(taskId) ?? [];
      list.push(toLinkedRequirement(row));
      grouped.set(taskId, list);
    }
    return grouped;
  }

  async listByProject(projectId: string): Promise<TaskRequirementLink[]> {
    const [rows] = await querySurreal<[Row[]]>(this.db,
      `SELECT in.external_id AS task_id, out.external_id AS requirement_id, created_at
       FROM office_task_requirement
       WHERE tenant_id = $tenant AND project_id = $project
       ORDER BY in.external_id, out.external_id`,
      { tenant: this.tenantId, project: projectId },
    );
    return [...(rows ?? [])].sort(compareRelationRows).map((row) => ({
      taskId: String(row.task_id),
      requirementId: String(row.requirement_id),
      createdAt: asDate(row.created_at),
    }));
  }
}

function compareRelationRows(left: Row, right: Row): number {
  for (const field of ["task_id", "key", "requirement_id"] as const) {
    const a = String(left[field]);
    const b = String(right[field]);
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function toLinkedRequirement(row: Row): LinkedRequirement {
  return {
    requirementId: String(row.requirement_id),
    key: String(row.key),
    title: String(row.title),
    status: String(row.status) as LinkedRequirement["status"],
  };
}
