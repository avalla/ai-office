/**
 * The operational task board.
 *
 * `status` is the task's own persisted state and nothing else. Requirement
 * progress travels beside it, computed only from explicitly linked
 * requirements, and the contradiction between the two is decided here rather
 * than in a renderer — a presentation layer that derived either one could hide
 * the defect this board exists to show.
 */

import type { TaskProps, TaskStatus } from "@ai-office/domain/task/task.ts";
import {
  requirementProgress,
  type RequirementProgress,
} from "../commands/reconcile-tasks.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type {
  LinkedRequirement,
  TaskRequirementRepository,
} from "../ports/task-requirement-repository.port.ts";
import { ProjectNotFoundError } from "../errors.ts";

export interface TaskBoardRow {
  taskId: string;
  title: string;
  /** Exactly what `task.status` holds. Never derived from requirements. */
  status: TaskStatus;
  priority: number;
  requirements: readonly LinkedRequirement[];
  progress: RequirementProgress;
  /**
   * The task has not started while every linked requirement is already
   * terminal. Not proof that the task is finished — only that the two
   * authoritative records disagree and a human should look.
   */
  contradictsRequirements: boolean;
  updatedAt: Date;
}

export class ListTaskBoard {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly links: TaskRequirementRepository,
  ) {}

  async execute(projectId: string): Promise<TaskBoardRow[]> {
    if ((await this.projects.findById(projectId)) === null)
      throw new ProjectNotFoundError(projectId);
    const tasks = (await this.tasks.listByProject(projectId)).map((task) =>
      task.snapshot(),
    );
    if (tasks.length === 0) return [];
    // One query for the whole board rather than one per row.
    const linked = await this.links.listForTasks(
      projectId,
      tasks.map((task) => task.id),
    );
    return tasks.map((task) => row(task, linked.get(task.id) ?? []));
  }
}

function row(
  task: TaskProps,
  requirements: readonly LinkedRequirement[],
): TaskBoardRow {
  const progress = requirementProgress(requirements);
  return {
    taskId: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
    requirements,
    progress,
    contradictsRequirements:
      (task.status === "pending" || task.status === "assigned") &&
      progress.total > 0 &&
      progress.open === 0,
    updatedAt: task.updatedAt,
  };
}
