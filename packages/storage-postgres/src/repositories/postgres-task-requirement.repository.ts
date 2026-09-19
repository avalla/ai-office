import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";
import type {
  LinkedRequirement,
  TaskRequirementLink,
  TaskRequirementRepository,
} from "@ai-office/application/ports/task-requirement-repository.port.ts";
import { PostgresClient } from "../database/postgres-client.ts";
import {
  PostgresTenantScopeError,
  requirePostgresTenantId,
} from "../database/postgres-tenant-context.ts";

interface LinkedRequirementRow extends Record<string, unknown> {
  task_id: string;
  requirement_id: string;
  requirement_key: string;
  title: string;
  status: RequirementStatus;
}

interface LinkRow extends Record<string, unknown> {
  task_id: string;
  requirement_id: string;
  created_at: Date | string;
}

function placeholders(count: number, startAt: number): string {
  return Array.from(
    { length: count },
    (_, index) => `$${startAt + index}`,
  ).join(", ");
}

export class PostgresTaskRequirementRepository implements TaskRequirementRepository {
  private readonly tenantId: string;

  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async link(input: {
    projectId: string;
    taskId: string;
    requirementId: string;
    now: Date;
  }): Promise<boolean> {
    const [project] = await this.database.query<{ id: string }>(
      `
        SELECT id
        FROM core.project
        WHERE id = $1 AND tenant_id = $2
      `,
      [input.projectId, this.tenantId],
    );
    if (project === undefined)
      throw new PostgresTenantScopeError("Project", input.projectId);

    const rows = await this.database.query<{ task_id: string }>(
      `
        INSERT INTO core.task_requirement(
          project_id, task_id, requirement_id, created_at
        )
        SELECT $1, $2, $3, $4
        WHERE EXISTS (
          SELECT 1
          FROM core.task t
          JOIN core.requirement r ON r.id = $3
          JOIN core.project p ON p.id = $1 AND p.tenant_id = $5
          WHERE t.id = $2 AND t.project_id = $1 AND r.project_id = $1
        )
        ON CONFLICT(task_id, requirement_id) DO NOTHING
        RETURNING task_id
      `,
      [input.projectId, input.taskId, input.requirementId, input.now, this.tenantId],
    );
    return rows.length === 1;
  }

  async unlink(input: {
    projectId: string;
    taskId: string;
    requirementId: string;
  }): Promise<boolean> {
    const rows = await this.database.query<{ task_id: string }>(
      `
        DELETE FROM core.task_requirement link
        WHERE link.task_id = $1
          AND link.requirement_id = $2
          AND link.project_id = $3
          AND EXISTS (
            SELECT 1 FROM core.project p
            WHERE p.id = link.project_id AND p.tenant_id = $4
          )
        RETURNING link.task_id
      `,
      [input.taskId, input.requirementId, input.projectId, this.tenantId],
    );
    return rows.length === 1;
  }

  async listForTask(
    projectId: string,
    taskId: string,
  ): Promise<LinkedRequirement[]> {
    const rows = await this.database.query<LinkedRequirementRow>(
      `
        SELECT r.id AS requirement_id, r.requirement_key,
               r.title, r.status, link.task_id
        FROM core.task_requirement link
        JOIN core.requirement r ON r.id = link.requirement_id
        JOIN core.task t ON t.id = link.task_id
        JOIN core.project p ON p.id = link.project_id AND p.tenant_id = $3
        WHERE link.task_id = $1
          AND link.project_id = $2
          AND t.project_id = r.project_id
        ORDER BY r.requirement_key, r.id
      `,
      [taskId, projectId, this.tenantId],
    );
    return rows.map(toLinkedRequirement);
  }

  async listForTasks(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<Map<string, LinkedRequirement[]>> {
    const grouped = new Map<string, LinkedRequirement[]>();
    if (taskIds.length === 0) return grouped;
    const rows = await this.database.query<LinkedRequirementRow>(
      `
        SELECT link.task_id, r.id AS requirement_id, r.requirement_key,
               r.title, r.status
        FROM core.task_requirement link
        JOIN core.requirement r ON r.id = link.requirement_id
        JOIN core.task t ON t.id = link.task_id
        JOIN core.project p ON p.id = link.project_id AND p.tenant_id = $2
        WHERE link.project_id = $1
          AND r.project_id = t.project_id
          AND link.task_id IN (${placeholders(taskIds.length, 3)})
        ORDER BY link.task_id, r.requirement_key, r.id
      `,
      [projectId, this.tenantId, ...taskIds],
    );
    for (const value of rows) {
      const list = grouped.get(value.task_id) ?? [];
      list.push(toLinkedRequirement(value));
      grouped.set(value.task_id, list);
    }
    return grouped;
  }

  async listByProject(projectId: string): Promise<TaskRequirementLink[]> {
    const rows = await this.database.query<LinkRow>(
      `
        SELECT link.task_id, link.requirement_id, link.created_at
        FROM core.task_requirement link
        JOIN core.project p ON p.id = link.project_id AND p.tenant_id = $2
        WHERE link.project_id = $1
        ORDER BY link.task_id, link.requirement_id
      `,
      [projectId, this.tenantId],
    );
    return rows.map((value) => ({
      taskId: value.task_id,
      requirementId: value.requirement_id,
      createdAt: toDate(value.created_at),
    }));
  }
}

function toLinkedRequirement(value: LinkedRequirementRow): LinkedRequirement {
  return {
    requirementId: value.requirement_id,
    key: value.requirement_key,
    title: value.title,
    status: value.status,
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? new Date(value) : new Date(value);
}
