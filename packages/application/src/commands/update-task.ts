import { ProjectNotFoundError } from "../errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import { TaskNotFoundError } from "./schedule-agent-run.ts";
import type { RecordAuditEvent } from "./record-audit-event.ts";

/** At least one field must change; both may change in one command. */
export type UpdateTaskInput = {
  projectId: string;
  taskId: string;
  actorId: string;
} & (
  | { description: string; priority?: number }
  | { description?: string; priority: number }
);

/**
 * Updates the task description and/or priority without changing lifecycle
 * state. Each supplied field is saved and audited in one transaction, so a
 * combined update either lands completely or not at all.
 */
export class UpdateTask {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(input: UpdateTaskInput): Promise<{
    taskId: string;
    description: string;
    priority: number;
    updatedAt: Date;
  }> {
    return this.transactions.run(async () => {
      if ((await this.projects.findById(input.projectId)) === null)
        throw new ProjectNotFoundError(input.projectId);
      const task = await this.tasks.findById(input.taskId);
      if (task === null || task.snapshot().projectId !== input.projectId)
        throw new TaskNotFoundError(input.taskId);

      const now = this.clock.now();
      const previousPriority = task.snapshot().priority;
      // Priority first: it is the only field that can be refused, so a refused
      // combined update leaves the aggregate untouched.
      if (input.priority !== undefined) task.updatePriority(input.priority, now);
      if (input.description !== undefined)
        task.updateDescription(input.description, now);
      const snapshot = task.snapshot();
      await this.tasks.save(task);
      if (input.description !== undefined)
        await this.audit.execute({
          eventType: "task.description_updated",
          actorType: "cli",
          actorId: input.actorId,
          projectId: snapshot.projectId,
          aggregateType: "task",
          aggregateId: snapshot.id,
          payload: { descriptionUpdated: true },
        });
      if (input.priority !== undefined)
        await this.audit.execute({
          eventType: "task.priority_updated",
          actorType: "cli",
          actorId: input.actorId,
          projectId: snapshot.projectId,
          aggregateType: "task",
          aggregateId: snapshot.id,
          payload: { from: previousPriority, to: snapshot.priority },
        });
      return {
        taskId: snapshot.id,
        description: snapshot.description ?? "",
        priority: snapshot.priority,
        updatedAt: snapshot.updatedAt,
      };
    });
  }
}
