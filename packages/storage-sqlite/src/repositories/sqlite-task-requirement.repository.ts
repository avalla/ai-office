import type { Database } from "bun:sqlite";
import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";
import type {
  LinkedRequirement,
  TaskRequirementLink,
  TaskRequirementRepository,
} from "@ai-office/application/ports/task-requirement-repository.port.ts";

interface LinkedRequirementRow {
  requirement_id: string;
  requirement_key: string;
  title: string;
  status: RequirementStatus;
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

/**
 * SQLite adapter for the explicit Task <-> Requirement relation.
 *
 * Every statement joins through `task` on `project_id`, so a link can never be
 * created, read, or removed across a project boundary even if a caller supplies
 * a mismatched pair. The `task_requirement_project_ownership_*` triggers are the
 * backstop; these joins are the rule.
 */
export class SqliteTaskRequirementRepository
  implements TaskRequirementRepository
{
  constructor(private readonly database: Database) {}

  async link(input: {
    projectId: string;
    taskId: string;
    requirementId: string;
    now: Date;
  }): Promise<boolean> {
    // The SELECT ... WHERE EXISTS makes project ownership part of the write
    // itself: a mismatched pair inserts nothing rather than relying on the
    // caller having checked first.
    const changes = this.database
      .prepare(
        `INSERT INTO task_requirement(task_id, requirement_id, created_at)
         SELECT ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM task t
            JOIN requirement r ON r.id = ?
            WHERE t.id = ? AND t.project_id = ? AND r.project_id = ?
          )
         ON CONFLICT(task_id, requirement_id) DO NOTHING`,
      )
      .run(
        input.taskId,
        input.requirementId,
        input.now.toISOString(),
        input.requirementId,
        input.taskId,
        input.projectId,
        input.projectId,
      ).changes;
    return changes === 1;
  }

  async unlink(input: {
    projectId: string;
    taskId: string;
    requirementId: string;
  }): Promise<boolean> {
    return (
      this.database
        .prepare(
          `DELETE FROM task_requirement
            WHERE task_id = ?
              AND requirement_id = ?
              AND EXISTS (
                SELECT 1 FROM task t
                WHERE t.id = task_requirement.task_id AND t.project_id = ?
              )`,
        )
        .run(input.taskId, input.requirementId, input.projectId).changes === 1
    );
  }

  async listForTask(
    projectId: string,
    taskId: string,
  ): Promise<LinkedRequirement[]> {
    return this.database
      .query<LinkedRequirementRow, [string, string]>(
        `SELECT r.id AS requirement_id, r.requirement_key, r.title, r.status
           FROM task_requirement link
           JOIN requirement r ON r.id = link.requirement_id
           JOIN task t ON t.id = link.task_id
          WHERE link.task_id = ? AND t.project_id = ? AND r.project_id = t.project_id
          ORDER BY r.requirement_key, r.id`,
      )
      .all(taskId, projectId)
      .map(row);
  }

  async listForTasks(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<Map<string, LinkedRequirement[]>> {
    const grouped = new Map<string, LinkedRequirement[]>();
    if (taskIds.length === 0) return grouped;
    // One statement for the whole page: the board must not issue a query per
    // row, and neither must reconciliation.
    const rows = this.database
      .query<LinkedRequirementRow & { task_id: string }, string[]>(
        `SELECT link.task_id, r.id AS requirement_id, r.requirement_key,
                r.title, r.status
           FROM task_requirement link
           JOIN requirement r ON r.id = link.requirement_id
           JOIN task t ON t.id = link.task_id
          WHERE t.project_id = ?
            AND r.project_id = t.project_id
            AND link.task_id IN (${placeholders(taskIds.length)})
          ORDER BY link.task_id, r.requirement_key, r.id`,
      )
      .all(projectId, ...taskIds);
    for (const value of rows) {
      const list = grouped.get(value.task_id) ?? [];
      list.push(row(value));
      grouped.set(value.task_id, list);
    }
    return grouped;
  }

  async listByProject(projectId: string): Promise<TaskRequirementLink[]> {
    return this.database
      .query<
        { task_id: string; requirement_id: string; created_at: string },
        [string]
      >(
        `SELECT link.task_id, link.requirement_id, link.created_at
           FROM task_requirement link
           JOIN task t ON t.id = link.task_id
          WHERE t.project_id = ?
          ORDER BY link.task_id, link.requirement_id`,
      )
      .all(projectId)
      .map((value) => ({
        taskId: value.task_id,
        requirementId: value.requirement_id,
        createdAt: new Date(value.created_at),
      }));
  }
}

function row(value: LinkedRequirementRow): LinkedRequirement {
  return {
    requirementId: value.requirement_id,
    key: value.requirement_key,
    title: value.title,
    status: value.status,
  };
}
