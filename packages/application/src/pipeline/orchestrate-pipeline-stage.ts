import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import { localOperatorPrincipal } from "../ports/execution-principal.port.ts";
import type { PipelineRunRepository } from "../ports/pipeline-run-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import { ManagePipelineRuns } from "./manage-pipeline-runs.ts";
import { ScheduleAgentRun } from "../commands/schedule-agent-run.ts";

export class PipelineStageOrchestrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineStageOrchestrationError";
  }
}

/** Resolves one active SQLite stage into one authoritative AgentRun. */
export class OrchestratePipelineStage {
  constructor(
    private readonly pipelines: PipelineRunRepository,
    private readonly agents: AgentRuntimeRepository,
    private readonly tasks: TaskRepository,
    private readonly pipelineManagement: ManagePipelineRuns,
    private readonly schedule: ScheduleAgentRun,
  ) {}

  async execute(input: {
    projectId: string;
    pipelineRunId: string;
    pipelineStageRunId: string;
  }): Promise<string | null> {
    const pipeline = await this.pipelines.findById(
      input.pipelineRunId,
      input.projectId,
    );
    if (pipeline === null)
      throw new PipelineStageOrchestrationError("Pipeline run not found");
    const snapshot = pipeline.snapshot();
    const stage = pipeline.currentStage();
    if (
      snapshot.status !== "active" ||
      stage === null ||
      stage.status !== "active" ||
      stage.id !== input.pipelineStageRunId
    )
      return null;

    const boundRuns = (await this.agents.listRuns(input.projectId)).filter(
      (run) => {
        const value = run.snapshot();
        return (
          value.pipelineRunId === snapshot.id &&
          value.pipelineStageRunId === stage.id
        );
      },
    );
    const existing = boundRuns.find((run) =>
      ["queued", "preparing", "running", "reviewing"].includes(
        run.snapshot().status,
      ),
    );
    if (existing !== undefined) return existing.snapshot().id;

    // A completed run can be left just before the SQLite stage bridge by a
    // process crash. Replaying the stage intent repairs that exact binding.
    const completed = boundRuns.find(
      (run) => run.snapshot().status === "completed",
    );
    if (completed !== undefined) {
      if (stage.assignedAgentId !== completed.snapshot().agentId)
        throw new PipelineStageOrchestrationError(
          "Completed AgentRun cannot reconcile the assigned pipeline stage",
        );
      await this.pipelineManagement.completeStageFromAgentRun({
        projectId: input.projectId,
        agentRunId: completed.snapshot().id,
        expectedPipelineRunId: snapshot.id,
      });
      return null;
    }

    // Failed and cancelled runs are authoritative terminal outcomes. The
    // active stage remains visible for explicit operator reconciliation.
    if (
      boundRuns.some((run) =>
        ["failed", "cancelled"].includes(run.snapshot().status),
      )
    )
      return null;

    let assignedAgentId = stage.assignedAgentId;
    if (assignedAgentId === undefined) {
      const candidates = [];
      for (const agent of await this.agents.listAgents(input.projectId)) {
        if (!agent.enabled) continue;
        const role = await this.agents.findRole(agent.roleId, input.projectId);
        if (role?.snapshot().key !== stage.roleId) continue;
        const separated = (
          snapshot.definition.stages[stage.stageIndex]
            ?.requiresDifferentAgentFrom ?? []
        ).some(
          (predecessorId) =>
            snapshot.stages.find(
              (candidate) => candidate.stageId === predecessorId,
            )?.assignedAgentId === agent.id,
        );
        if (!separated) candidates.push(agent);
      }
      candidates.sort((left, right) => left.id.localeCompare(right.id));
      if (candidates.length === 0)
        throw new PipelineStageOrchestrationError(
          `No enabled agent is eligible for role ${stage.roleId}`,
        );
      assignedAgentId = candidates[0]!.id;
      await this.pipelineManagement.assign({
        projectId: input.projectId,
        pipelineRunId: snapshot.id,
        agentId: assignedAgentId,
        principal: localOperatorPrincipal,
        actorLabel: "queue-orchestrator",
      });
    }

    const task = await this.tasks.findById(snapshot.taskId);
    if (task === null || task.snapshot().projectId !== input.projectId)
      throw new PipelineStageOrchestrationError("Pipeline task is unavailable");
    return this.schedule.execute({
      projectId: input.projectId,
      taskId: snapshot.taskId,
      agentId: assignedAgentId,
    });
  }
}
