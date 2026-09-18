import {
  AgentRun,
  type AgentActionIntentInput,
} from "@ai-office/domain/agent/agent-run.ts";
import { ProjectNotFoundError } from "../errors.ts";
import {
  isTaskRunnable,
  TaskNotRunnableError,
} from "@ai-office/domain/agent/run-eligibility.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { JobOutboxRepository } from "../ports/job-outbox-repository.port.ts";
import type { PipelineRunRepository } from "../ports/pipeline-run-repository.port.ts";
import { taskRunLeaseDurationMs } from "../runtime/run-policy.ts";
import {
  resolveAgentRunModel,
  unconfiguredModelRouting,
  type ModelRoutingState,
} from "../model-routing/model-routing.ts";

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
    private readonly pipelines?: PipelineRunRepository,
    /** Immutable host routing; unconfigured records runs as `unrouted`. */
    private readonly modelRouting: ModelRoutingState = unconfiguredModelRouting,
    /** Durable delivery intent; omitted by legacy/manual compositions. */
    private readonly outbox?: JobOutboxRepository,
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
    if (!isTaskRunnable(task.snapshot().status))
      throw new TaskNotRunnableError();
    if (
      (await this.runtime.listRuns(input.projectId)).some(
        (value) =>
          value.snapshot().taskId === input.taskId &&
          !["completed", "failed", "cancelled"].includes(
            value.snapshot().status,
          ),
      )
    )
      throw new TaskLockActiveError(input.taskId);
    const agent = await this.runtime.findAgent(input.agentId);
    if (agent === null || agent.projectId !== input.projectId || !agent.enabled)
      throw new AgentNotFoundError(input.agentId);
    const now = this.clock.now();
    const id = this.ids.generate();
    await this.transactions.run(async () => {
      // Resolve from the agent and role read inside the write transaction, so
      // the persisted model matches the authority the run was admitted with.
      const current = await this.runtime.findAgent(input.agentId);
      if (
        current === null ||
        current.projectId !== input.projectId ||
        !current.enabled
      )
        throw new AgentNotFoundError(input.agentId);
      const role = await this.runtime.findRole(current.roleId, input.projectId);
      if (role === null) throw new AgentNotFoundError(input.agentId);
      const roleState = role.snapshot();
      const pipeline = await this.pipelines?.findActiveByTask(
        input.taskId,
        input.projectId,
      );
      const pipelineSnapshot = pipeline?.snapshot();
      const stage = pipeline?.currentStage();
      if (
        pipelineSnapshot !== undefined &&
        (stage?.status !== "active" || stage.assignedAgentId !== input.agentId)
      )
        throw new AgentNotFoundError(
          `${input.agentId} is not assigned to the active pipeline stage`,
        );
      const run = AgentRun.create({
        id,
        ...input,
        ...(pipelineSnapshot === undefined ||
        stage === null ||
        stage === undefined
          ? {}
          : {
              pipelineRunId: pipelineSnapshot.id,
              pipelineStageRunId: stage.id,
            }),
        ...(roleState.guidanceText === undefined ||
        roleState.guidanceText.trim() === ""
          ? {}
          : {
              roleGuidance: {
                text: roleState.guidanceText,
                version: roleState.guidanceVersion ?? roleState.version,
              },
            }),
        modelRouting: resolveAgentRunModel(this.modelRouting, {
          projectId: input.projectId,
          agentName: current.name,
          modelPolicy: role.snapshot().modelPolicy,
        }),
        now,
      });
      await this.runtime.saveRun(run);
      const locked = await this.runtime.acquireTaskLock(
        input.taskId,
        run.snapshot().id,
        now,
        new Date(now.getTime() + taskRunLeaseDurationMs),
      );
      if (!locked) throw new TaskLockActiveError(input.taskId);
      if (this.outbox !== undefined)
        await this.outbox.append({
          id: `outbox:agent-run:${run.snapshot().id}`,
          projectId: input.projectId,
          jobType: "execute_agent_run",
          aggregateType: "agent_run",
          aggregateId: run.snapshot().id,
          ...(run.snapshot().pipelineStageRunId === undefined
            ? {}
            : { pipelineStageRunId: run.snapshot().pipelineStageRunId }),
          dedupeKey: `agent-run:${run.snapshot().id}`,
          payload: {
            projectId: input.projectId,
            runId: run.snapshot().id,
            ...(run.snapshot().pipelineStageRunId === undefined
              ? {}
              : { pipelineStageRunId: run.snapshot().pipelineStageRunId }),
          },
          availableAt: now,
          createdAt: now,
        });
    });
    return id;
  }
}
