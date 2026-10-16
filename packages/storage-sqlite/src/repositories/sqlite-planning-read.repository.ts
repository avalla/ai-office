import type { Database } from "bun:sqlite";
import type {
  MilestoneStatus,
  RequirementStatus,
} from "@ai-office/domain/governance/governance.ts";
import type { TaskStatus } from "@ai-office/domain/task/task.ts";
import type {
  PlanningReadRepository,
  PlanningStateRecord,
} from "@ai-office/application/ports/planning-read.port.ts";

/**
 * Read-only SQLite adapter for the planning read model.
 *
 * Every statement names its columns and none selects a description, so long
 * text never leaves the database through this adapter.
 */
export class SqlitePlanningReadRepository implements PlanningReadRepository {
  constructor(private readonly database: Database) {}

  async readPlanningState(
    projectId: string,
  ): Promise<PlanningStateRecord | null> {
    // One read transaction: every collection sees the same committed state.
    return this.database.transaction((): PlanningStateRecord | null => {
      const project = this.database
        .query<{ id: string }, [string]>("SELECT id FROM project WHERE id = ?")
        .get(projectId);
      if (project === null) return null;
      return {
        projectId,
        milestones: this.database
          .query<
            { id: string; title: string; status: MilestoneStatus },
            [string]
          >(
            `SELECT id, title,
                    CASE WHEN archived_at IS NOT NULL THEN 'archived' ELSE status END AS status
             FROM milestone
             WHERE project_id = ?
             ORDER BY created_at, id`,
          )
          .all(projectId)
          .map((row) => ({ id: row.id, title: row.title, status: row.status })),
        tasks: this.database
          .query<
            { id: string; title: string; status: TaskStatus; priority: number },
            [string]
          >(
            `SELECT id, title, status, priority
             FROM task
             WHERE project_id = ?
             ORDER BY id`,
          )
          .all(projectId)
          .map((row) => ({
            id: row.id,
            title: row.title,
            status: row.status,
            priority: row.priority,
          })),
        dependencies: this.database
          .query<{ task_id: string; depends_on_task_id: string }, [string]>(
            `SELECT task_id, depends_on_task_id
             FROM task_dependency
             WHERE project_id = ?
             ORDER BY task_id, depends_on_task_id`,
          )
          .all(projectId)
          .map((row) => ({
            taskId: row.task_id,
            dependsOnTaskId: row.depends_on_task_id,
          })),
        requirements: this.database
          .query<
            {
              id: string;
              requirement_key: string;
              title: string;
              status: RequirementStatus;
              milestone_id: string | null;
            },
            [string]
          >(
            `SELECT id, requirement_key, title, status, milestone_id
             FROM requirement
             WHERE project_id = ?
             ORDER BY requirement_key, id`,
          )
          .all(projectId)
          .map((row) => ({
            id: row.id,
            key: row.requirement_key,
            title: row.title,
            status: row.status,
            milestoneId: row.milestone_id,
          })),
        taskRequirementLinks: this.database
          .query<{ task_id: string; requirement_id: string }, [string, string]>(
            `SELECT l.task_id, l.requirement_id
             FROM task_requirement l
             JOIN task t ON t.id = l.task_id
             JOIN requirement r ON r.id = l.requirement_id
             WHERE t.project_id = ? AND r.project_id = ?
             ORDER BY l.task_id, l.requirement_id`,
          )
          .all(projectId, projectId)
          .map((row) => ({
            taskId: row.task_id,
            requirementId: row.requirement_id,
          })),
      };
    })();
  }
}
