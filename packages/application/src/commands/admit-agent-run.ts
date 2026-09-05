import { isTaskRunnable } from "@ai-office/domain/agent/run-eligibility.ts";
import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { PipelineRunRepository } from "../ports/pipeline-run-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";

export class AdmitAgentRun {
  constructor(
    private readonly runs: AgentRuntimeRepository,
    private readonly tasks: TaskRepository,
    private readonly pipelines: PipelineRunRepository,
    private readonly clock: Clock,
    private readonly ownerId?: string,
  ) {}

  async execute(run: AgentRun): Promise<AgentRun | null> {
    const r = run.snapshot();
    const task = (await this.tasks.findById(r.taskId))?.snapshot();
    const agent = await this.runs.findAgent(r.agentId);
    const pipeline = await this.pipelines.findActiveByTask(
      r.taskId,
      r.projectId,
    );
    const stage = pipeline?.currentStage();
    const role =
      agent === null
        ? null
        : await this.runs.findRole(agent.roleId, r.projectId);
    const valid =
      task !== undefined &&
      task.projectId === r.projectId &&
      isTaskRunnable(task.status) &&
      agent !== null &&
      agent.projectId === r.projectId &&
      agent.enabled &&
      (pipeline?.snapshot().id ?? undefined) === r.pipelineRunId &&
      (pipeline === null ||
        (stage?.status === "active" &&
          stage.assignedAgentId === r.agentId &&
          role?.snapshot().key === stage.roleId));
    if (!valid || task === undefined || agent === null)
      return this.runs.admitQueuedRun({
        runId: r.id,
        now: this.clock.now(),
        authority: null,
      });
    return this.runs.admitQueuedRun({
      runId: r.id,
      ...(this.ownerId === undefined ? {} : { ownerId: this.ownerId }),
      now: this.clock.now(),
      authority: {
        taskStatus: task.status,
        taskUpdatedAt: task.updatedAt,
        agentRoleId: agent.roleId,
        agentUpdatedAt: agent.updatedAt,
        pipelineId: pipeline?.snapshot().id ?? null,
        pipelineVersion: pipeline?.snapshot().version ?? null,
      },
    });
  }
}
