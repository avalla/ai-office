import { ProjectNotFoundError } from "../errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import { TaskNotFoundError } from "./schedule-agent-run.ts";
import type { RecordAuditEvent } from "./record-audit-event.ts";

export interface UpdateTaskInput {
  projectId: string;
  taskId: string;
  description: string;
  actorId: string;
}

/** Updates the task description without changing lifecycle state. */
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
    updatedAt: Date;
  }> {
    return this.transactions.run(async () => {
      if ((await this.projects.findById(input.projectId)) === null)
        throw new ProjectNotFoundError(input.projectId);
      const task = await this.tasks.findById(input.taskId);
      if (task === null || task.snapshot().projectId !== input.projectId)
        throw new TaskNotFoundError(input.taskId);

      task.updateDescription(input.description, this.clock.now());
      const snapshot = task.snapshot();
      await this.tasks.save(task);
      await this.audit.execute({
        eventType: "task.description_updated",
        actorType: "cli",
        actorId: input.actorId,
        projectId: snapshot.projectId,
        aggregateType: "task",
        aggregateId: snapshot.id,
        payload: { descriptionUpdated: true },
      });
      return {
        taskId: snapshot.id,
        description: snapshot.description ?? "",
        updatedAt: snapshot.updatedAt,
      };
    });
  }
}
