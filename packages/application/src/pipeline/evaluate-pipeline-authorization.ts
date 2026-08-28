import type { PipelineRunRepository } from "../ports/pipeline-run-repository.port.ts";

export type PipelineAuthorizationReason =
  | "pipeline_run_required"
  | "pipeline_stage_not_active"
  | "pipeline_capability_denied"
  | "pipeline_prerequisite_incomplete"
  | "pipeline_agent_not_assigned"
  | "pipeline_approval_required";

export interface PipelineAuthorizationDecision {
  decision: "allow" | "deny";
  reasons: readonly PipelineAuthorizationReason[];
  pipelineRunId?: string;
  pipelineStageRunId?: string;
  pipelineStageId?: string;
}

export class EvaluatePipelineAuthorization {
  constructor(private readonly pipelines: PipelineRunRepository) {}

  async execute(input: {
    projectId: string;
    agentId: string;
    operation: string;
    pipelineRunId?: string;
  }): Promise<PipelineAuthorizationDecision> {
    if (input.pipelineRunId === undefined) {
      const active = await this.pipelines.listActiveByProject(input.projectId);
      return active.length === 0
        ? { decision: "allow", reasons: [] }
        : { decision: "deny", reasons: ["pipeline_run_required"] };
    }
    const run = await this.pipelines.findById(
      input.pipelineRunId,
      input.projectId,
    );
    if (run === null)
      return {
        decision: "deny",
        reasons: ["pipeline_stage_not_active"],
      };
    if (run.snapshot().status !== "active")
      return {
        decision: "deny",
        reasons: ["pipeline_stage_not_active"],
        pipelineRunId: input.pipelineRunId,
      };
    const runSnapshot = run.snapshot();
    const stage = run.currentStage();
    if (stage === null)
      return {
        decision: "deny",
        reasons: ["pipeline_stage_not_active"],
        pipelineRunId: runSnapshot.id,
      };
    const context = {
      pipelineRunId: runSnapshot.id,
      pipelineStageRunId: stage.id,
      pipelineStageId: stage.stageId,
    };
    if (stage.status === "awaiting_approval")
      return {
        decision: "deny",
        reasons: ["pipeline_approval_required"],
        ...context,
      };
    if (stage.status !== "active")
      return {
        decision: "deny",
        reasons: ["pipeline_stage_not_active"],
        ...context,
      };
    if (
      stage.assignedAgentId === undefined ||
      stage.assignedAgentId !== input.agentId
    )
      return {
        decision: "deny",
        reasons: ["pipeline_agent_not_assigned"],
        ...context,
      };
    const definition = runSnapshot.definition.stages[stage.stageIndex]!;
    if (!(definition.capabilities ?? []).includes(input.operation)) {
      const futureStage = runSnapshot.definition.stages
        .slice(stage.stageIndex + 1)
        .some((candidate) =>
          (candidate.capabilities ?? []).includes(input.operation),
        );
      return {
        decision: "deny",
        reasons: [
          futureStage
            ? "pipeline_prerequisite_incomplete"
            : "pipeline_capability_denied",
        ],
        ...context,
      };
    }
    return { decision: "allow", reasons: [], ...context };
  }
}
