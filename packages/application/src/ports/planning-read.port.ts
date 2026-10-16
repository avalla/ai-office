/**
 * Read-side port for the planning read model (CB-02).
 *
 * Planning state only: tasks, prerequisite edges, milestones, requirements and
 * task→requirement links. No description, reason or other long text, and no
 * operational fact (runs, leases, agents, attention, activity) is part of it,
 * so a caller cannot expose what the port never returns.
 *
 * Records here are application-level values, not database rows.
 */

import type {
  MilestoneStatus,
  RequirementStatus,
} from "@ai-office/domain/governance/governance.ts";
import type { TaskStatus } from "@ai-office/domain/task/task.ts";

export interface PlanningTaskRecord {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
}

export interface PlanningMilestoneRecord {
  id: string;
  title: string;
  /** `archived` when the milestone carries an archive mark, as elsewhere. */
  status: MilestoneStatus;
}

export interface PlanningRequirementRecord {
  id: string;
  key: string;
  title: string;
  status: RequirementStatus;
  milestoneId: string | null;
}

export interface PlanningStateRecord {
  projectId: string;
  /** In recorded order: creation time, then id. */
  milestones: PlanningMilestoneRecord[];
  tasks: PlanningTaskRecord[];
  dependencies: { taskId: string; dependsOnTaskId: string }[];
  requirements: PlanningRequirementRecord[];
  /** Links whose task and requirement both belong to the project. */
  taskRequirementLinks: { taskId: string; requirementId: string }[];
}

export interface PlanningReadRepository {
  /**
   * The project's complete planning state, read in one consistent snapshot so
   * every edge and link references a task, milestone or requirement the same
   * result contains. `null` when the project does not exist.
   */
  readPlanningState(projectId: string): Promise<PlanningStateRecord | null>;
}
