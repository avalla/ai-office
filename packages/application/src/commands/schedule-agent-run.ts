import {
  AgentRun,
  type AgentActionIntentInput,
} from "@ai-office/domain/agent/agent-run.ts";
import { ProjectNotFoundError } from "../errors.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";

export class AgentNotFoundError extends Error {
  constructor(id: string) {
    super(`Agent ${id} not found`);
    this.name = "AgentNotFoundError";
  }
}
export class TaskNotFoundError extends Error {
  constructor(id: string) {
    super(`Task ${id} not found`);
    this.name = "TaskNotFoundError";
  }
}
export class TaskLockActiveError extends Error {
  constructor(id: string) {
    super(`Task ${id} is already locked by another run`);
    this.name = "TaskLockActiveError";
  }
}
export class TaskLockExpiredError extends Error {
  constructor(runId: string) {
    super(`Task lock owned by run ${runId} has expired`);
    this.name = "TaskLockExpiredError";
  }
}

export class ScheduleAgentRun {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly runtime: AgentRuntimeRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}
  async execute(input: {
    projectId: string;
    taskId: string;
    agentId: string;
    actionIntent?: AgentActionIntentInput;
  }): Promise<string> {
    if ((await this.projects.findById(input.projectId)) === null)
      throw new ProjectNotFoundError(input.projectId);
    const task = await this.tasks.findById(input.taskId);
    if (task === null || task.snapshot().projectId !== input.projectId)
      throw new TaskNotFoundError(input.taskId);
    const agent = await this.runtime.findAgent(input.agentId);
    if (agent === null || agent.projectId !== input.projectId || !agent.enabled)
      throw new AgentNotFoundError(input.agentId);
    const now = this.clock.now();
    const run = AgentRun.create({ id: this.ids.generate(), ...input, now });
    await this.transactions.run(async () => {
      await this.runtime.saveRun(run);
      const locked = await this.runtime.acquireTaskLock(
        input.taskId,
        run.snapshot().id,
        now,
        new Date(now.getTime() + 30 * 60_000),
      );
      if (!locked) throw new TaskLockActiveError(input.taskId);
    });
    return run.snapshot().id;
  }
}
