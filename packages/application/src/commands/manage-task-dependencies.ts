import {
  assertAcyclicDependency,
  blockingPrerequisites,
  TaskDependencyError,
} from "@ai-office/domain/task/task-dependency.ts";
import { isTaskRunnable } from "@ai-office/domain/agent/run-eligibility.ts";
import type { TaskStatus } from "@ai-office/domain/task/task.ts";
import { ProjectNotFoundError } from "../errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskDependencyRepository } from "../ports/task-dependency-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { RecordAuditEvent } from "./record-audit-event.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";

export class TaskPrerequisiteIncompleteError extends TaskDependencyError {
  constructor(
    readonly taskId: string,
    readonly blockedBy: readonly { taskId: string; status: TaskStatus }[],
  ) {
    super(
      `Task ${taskId} has incomplete prerequisites: ${blockedBy.map((item) => item.taskId).join(", ")}`,
    );
    this.name = "TaskPrerequisiteIncompleteError";
  }
}

export async function assertTaskPrerequisitesComplete(
  projectId: string,
  taskId: string,
  tasks: TaskRepository,
  dependencies: TaskDependencyRepository,
): Promise<void> {
  const [allTasks, edges] = await Promise.all([
    tasks.listByProject(projectId),
    dependencies.listByProject(projectId),
  ]);
  const statuses = new Map(
    allTasks.map(
      (item) => [item.snapshot().id, item.snapshot().status] as const,
    ),
  );
  const blockedBy = blockingPrerequisites(
    taskId,
    edges
      .filter((edge) => edge.taskId === taskId)
      .map((edge) => edge.dependsOnTaskId),
    statuses,
  );
  if (blockedBy.length > 0)
    throw new TaskPrerequisiteIncompleteError(taskId, blockedBy);
}

export interface TaskDependencyReadiness {
  taskId: string;
  status: TaskStatus;
  runnable: boolean;
  blockedBy: readonly { taskId: string; status: TaskStatus }[];
}

export class ManageTaskDependencies {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly dependencies: TaskDependencyRepository,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly runtime?: AgentRuntimeRepository,
  ) {}

  async link(input: {
    projectId: string;
    taskId: string;
    dependsOnTaskId: string;
    actorId: string;
  }): Promise<{ created: boolean }> {
    return this.transactions.run(async () => {
      const task = await this.requireTask(input.projectId, input.taskId);
      if (
        task.snapshot().status !== "pending" &&
        task.snapshot().status !== "blocked"
      )
        throw new TaskDependencyError(
          "Prerequisites can be added only before work starts or while it is blocked",
        );
      if (
        (await this.runtime?.listRuns(input.projectId))?.some(
          (run) =>
            run.snapshot().taskId === input.taskId &&
            !["completed", "failed", "cancelled"].includes(
              run.snapshot().status,
            ),
        )
      )
        throw new TaskDependencyError(
          "Prerequisites cannot be added while an agent run is active",
        );
      await this.requireTask(input.projectId, input.dependsOnTaskId);
      const edges = await this.dependencies.listByProject(input.projectId);
      if (
        edges.some(
          (edge) =>
            edge.taskId === input.taskId &&
            edge.dependsOnTaskId === input.dependsOnTaskId,
        )
      )
        return { created: false };
      assertAcyclicDependency(input.taskId, input.dependsOnTaskId, edges);
      const created = await this.dependencies.link({
        ...input,
        createdAt: this.clock.now(),
      });
      if (!created)
        throw new TaskDependencyError("Task dependency changed during linkage");
      await this.audit.execute({
        eventType: "task.dependency_linked",
        actorType: "cli",
        actorId: input.actorId,
        projectId: input.projectId,
        aggregateType: "task",
        aggregateId: input.taskId,
        payload: { dependsOnTaskId: input.dependsOnTaskId },
      });
      return { created };
    });
  }

  async unlink(input: {
    projectId: string;
    taskId: string;
    dependsOnTaskId: string;
    actorId: string;
  }): Promise<{ removed: boolean }> {
    return this.transactions.run(async () => {
      await this.requireTask(input.projectId, input.taskId);
      await this.requireTask(input.projectId, input.dependsOnTaskId);
      const removed = await this.dependencies.unlink(
        input.projectId,
        input.taskId,
        input.dependsOnTaskId,
      );
      if (removed)
        await this.audit.execute({
          eventType: "task.dependency_unlinked",
          actorType: "cli",
          actorId: input.actorId,
          projectId: input.projectId,
          aggregateType: "task",
          aggregateId: input.taskId,
          payload: { dependsOnTaskId: input.dependsOnTaskId },
        });
      return { removed };
    });
  }

  async readiness(
    projectId: string,
    taskId: string,
  ): Promise<TaskDependencyReadiness> {
    const task = await this.requireTask(projectId, taskId);
    const [tasks, edges] = await Promise.all([
      this.tasks.listByProject(projectId),
      this.dependencies.listByProject(projectId),
    ]);
    const statuses = new Map(
      tasks.map(
        (item) => [item.snapshot().id, item.snapshot().status] as const,
      ),
    );
    const blockedBy = blockingPrerequisites(
      taskId,
      edges
        .filter((edge) => edge.taskId === taskId)
        .map((edge) => edge.dependsOnTaskId),
      statuses,
    );
    const status = task.snapshot().status;
    return {
      taskId,
      status,
      runnable: isTaskRunnable(status) && blockedBy.length === 0,
      blockedBy,
    };
  }

  private async requireTask(projectId: string, taskId: string) {
    if ((await this.projects.findById(projectId)) === null)
      throw new ProjectNotFoundError(projectId);
    const task = await this.tasks.findById(taskId);
    if (task === null || task.snapshot().projectId !== projectId)
      throw new TaskDependencyError(
        `Task ${taskId} does not exist in project ${projectId}`,
      );
    return task;
  }
}
