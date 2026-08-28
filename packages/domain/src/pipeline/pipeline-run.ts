import { DomainValidationError } from "../errors.ts";
import type { OfficePipeline } from "../office/office-manifest.ts";

export type PipelineRunStatus = "active" | "completed" | "cancelled";
export type PipelineStageRunStatus =
  "pending" | "active" | "awaiting_approval" | "completed" | "cancelled";

export interface PipelineStageRunProps {
  id: string;
  stageId: string;
  stageIndex: number;
  roleId: string;
  status: PipelineStageRunStatus;
  assignedAgentId?: string;
  assignedAt?: Date;
  completedAt?: Date;
  approvedBy?: string;
  approvalDecision?: "approved" | "rejected";
  approvalRationale?: string;
  approvedAt?: Date;
}

export interface PipelineRunProps {
  id: string;
  projectId: string;
  taskId: string;
  manifestRevisionId: string;
  manifestRevision: number;
  definition: OfficePipeline;
  status: PipelineRunStatus;
  currentStageIndex: number;
  stages: readonly PipelineStageRunProps[];
  startedBy: string;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  cancelledAt?: Date;
}

export interface PipelineOverrideRecord {
  id: string;
  projectId: string;
  pipelineRunId: string;
  stageRunId: string;
  actorId: string;
  reason: string;
  previousRule: string;
  resultingAuthorization: string;
  createdAt: Date;
}

export class PipelineTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PipelineTransitionError";
  }
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (normalized === "")
    throw new DomainValidationError(`${name} cannot be empty`);
  return normalized;
}

function cloneStage(value: PipelineStageRunProps): PipelineStageRunProps {
  return {
    ...value,
    ...(value.assignedAt === undefined
      ? {}
      : { assignedAt: new Date(value.assignedAt) }),
    ...(value.completedAt === undefined
      ? {}
      : { completedAt: new Date(value.completedAt) }),
    ...(value.approvedAt === undefined
      ? {}
      : { approvedAt: new Date(value.approvedAt) }),
  };
}

export class PipelineRun {
  private constructor(private props: PipelineRunProps) {}

  static create(input: {
    id: string;
    projectId: string;
    taskId: string;
    manifestRevisionId: string;
    manifestRevision: number;
    definition: OfficePipeline;
    startedBy: string;
    stageRunIds: readonly string[];
    now: Date;
  }): PipelineRun {
    if (input.definition.enforcement !== "enforced")
      throw new DomainValidationError(
        "Only an enforced pipeline can be started",
      );
    if (input.definition.stages.length === 0)
      throw new DomainValidationError(
        "An enforced pipeline must contain a stage",
      );
    if (input.stageRunIds.length !== input.definition.stages.length)
      throw new DomainValidationError(
        "Every pipeline stage requires a stage-run ID",
      );
    const stages = input.definition.stages.map((stage, index) => ({
      id: required(input.stageRunIds[index]!, "Stage-run ID"),
      stageId: stage.id,
      stageIndex: index,
      roleId: stage.roleId,
      status: index === 0 ? ("active" as const) : ("pending" as const),
    }));
    return new PipelineRun({
      id: required(input.id, "Pipeline-run ID"),
      projectId: required(input.projectId, "Project ID"),
      taskId: required(input.taskId, "Task ID"),
      manifestRevisionId: required(
        input.manifestRevisionId,
        "Manifest revision ID",
      ),
      manifestRevision: input.manifestRevision,
      definition: input.definition,
      status: "active",
      currentStageIndex: 0,
      stages,
      startedBy: required(input.startedBy, "Pipeline actor"),
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: PipelineRunProps): PipelineRun {
    return new PipelineRun({
      ...props,
      stages: props.stages.map(cloneStage),
      createdAt: new Date(props.createdAt),
      updatedAt: new Date(props.updatedAt),
      ...(props.completedAt === undefined
        ? {}
        : { completedAt: new Date(props.completedAt) }),
      ...(props.cancelledAt === undefined
        ? {}
        : { cancelledAt: new Date(props.cancelledAt) }),
    });
  }

  currentStage(): PipelineStageRunProps | null {
    if (this.props.status !== "active") return null;
    return cloneStage(this.props.stages[this.props.currentStageIndex]!);
  }

  assign(agentId: string, agentRoleId: string, now: Date): void {
    const stage = this.requireCurrent("active");
    if (stage.assignedAgentId !== undefined)
      throw new PipelineTransitionError("The active stage is already assigned");
    if (agentRoleId !== stage.roleId)
      throw new PipelineTransitionError(
        `Stage ${stage.stageId} requires role ${stage.roleId}`,
      );
    const definition = this.props.definition.stages[stage.stageIndex]!;
    for (const predecessorId of definition.requiresDifferentAgentFrom ?? []) {
      const predecessor = this.props.stages.find(
        (value) => value.stageId === predecessorId,
      );
      if (predecessor?.assignedAgentId === agentId)
        throw new PipelineTransitionError(
          `Agent separation is required between ${predecessorId} and ${stage.stageId}`,
        );
    }
    this.replaceStage(stage.stageIndex, {
      ...stage,
      assignedAgentId: required(agentId, "Agent ID"),
      assignedAt: now,
    });
    this.changed(now);
  }

  completeStage(agentId: string, now: Date): void {
    const stage = this.requireCurrent("active");
    if (stage.assignedAgentId === undefined)
      throw new PipelineTransitionError(
        "The active stage has no assigned agent",
      );
    if (stage.assignedAgentId !== agentId)
      throw new PipelineTransitionError(
        "Only the assigned agent can complete the stage",
      );
    const definition = this.props.definition.stages[stage.stageIndex]!;
    if (definition.requiresApproval) {
      this.replaceStage(stage.stageIndex, {
        ...stage,
        status: "awaiting_approval",
      });
      this.changed(now);
      return;
    }
    this.finishCurrent(now);
  }

  approveStage(
    actorId: string,
    rationale: string | undefined,
    now: Date,
  ): void {
    const stage = this.requireCurrent("awaiting_approval");
    const actor = required(actorId, "Approval actor");
    const definition = this.props.definition.stages[stage.stageIndex]!;
    if (
      definition.requiresIndependentApproval === true &&
      stage.assignedAgentId === actor
    )
      throw new PipelineTransitionError(
        "An assigned agent cannot approve its own stage",
      );
    this.replaceStage(stage.stageIndex, {
      ...stage,
      approvedBy: actor,
      approvalDecision: "approved",
      ...(rationale === undefined
        ? {}
        : { approvalRationale: required(rationale, "Approval rationale") }),
      approvedAt: now,
    });
    this.finishCurrent(now);
  }

  rejectStage(actorId: string, rationale: string, now: Date): void {
    const stage = this.requireCurrent("awaiting_approval");
    const actor = required(actorId, "Approval actor");
    const definition = this.props.definition.stages[stage.stageIndex]!;
    if (
      definition.requiresIndependentApproval === true &&
      stage.assignedAgentId === actor
    )
      throw new PipelineTransitionError(
        "An assigned agent cannot reject its own stage",
      );
    this.replaceStage(stage.stageIndex, {
      ...stage,
      status: "cancelled",
      approvedBy: actor,
      approvalDecision: "rejected",
      approvalRationale: required(rationale, "Rejection rationale"),
      approvedAt: now,
    });
    this.props = {
      ...this.props,
      status: "cancelled",
      stages: this.props.stages.map((value) =>
        value.status === "pending"
          ? { ...value, status: "cancelled" as const }
          : value,
      ),
      version: this.props.version + 1,
      updatedAt: now,
      cancelledAt: now,
    };
  }

  overrideCurrent(input: {
    id: string;
    actorId: string;
    reason: string;
    now: Date;
  }): PipelineOverrideRecord {
    const stage = this.currentStage();
    if (stage === null)
      throw new PipelineTransitionError("Pipeline is not active");
    const previousRule =
      stage.status === "awaiting_approval"
        ? "pipeline_approval_required"
        : stage.assignedAgentId === undefined
          ? "pipeline_agent_not_assigned"
          : "pipeline_stage_incomplete";
    const record: PipelineOverrideRecord = {
      id: required(input.id, "Override ID"),
      projectId: this.props.projectId,
      pipelineRunId: this.props.id,
      stageRunId: stage.id,
      actorId: required(input.actorId, "Override actor"),
      reason: required(input.reason, "Override reason"),
      previousRule,
      resultingAuthorization: "stage_completed",
      createdAt: input.now,
    };
    this.finishCurrent(input.now);
    return record;
  }

  cancel(actorId: string, now: Date): void {
    required(actorId, "Cancellation actor");
    if (this.props.status !== "active")
      throw new PipelineTransitionError(
        "Only an active pipeline can be cancelled",
      );
    this.props = {
      ...this.props,
      status: "cancelled",
      stages: this.props.stages.map((stage) =>
        stage.status === "pending" ||
        stage.status === "active" ||
        stage.status === "awaiting_approval"
          ? { ...stage, status: "cancelled" as const }
          : stage,
      ),
      version: this.props.version + 1,
      updatedAt: now,
      cancelledAt: now,
    };
  }

  snapshot(): PipelineRunProps {
    return {
      ...this.props,
      definition: structuredClone(this.props.definition),
      stages: this.props.stages.map(cloneStage),
      createdAt: new Date(this.props.createdAt),
      updatedAt: new Date(this.props.updatedAt),
      ...(this.props.completedAt === undefined
        ? {}
        : { completedAt: new Date(this.props.completedAt) }),
      ...(this.props.cancelledAt === undefined
        ? {}
        : { cancelledAt: new Date(this.props.cancelledAt) }),
    };
  }

  private requireCurrent(
    status: PipelineStageRunStatus,
  ): PipelineStageRunProps {
    const stage = this.currentStage();
    if (stage === null || stage.status !== status)
      throw new PipelineTransitionError(`Current stage must be ${status}`);
    return stage;
  }

  private finishCurrent(now: Date): void {
    const stage = this.currentStage();
    if (stage === null)
      throw new PipelineTransitionError("Pipeline is not active");
    this.replaceStage(stage.stageIndex, {
      ...stage,
      status: "completed",
      completedAt: now,
    });
    const nextIndex = stage.stageIndex + 1;
    if (nextIndex >= this.props.stages.length) {
      this.props = {
        ...this.props,
        status: "completed",
        version: this.props.version + 1,
        updatedAt: now,
        completedAt: now,
      };
      return;
    }
    const next = this.props.stages[nextIndex]!;
    this.replaceStage(nextIndex, { ...next, status: "active" });
    this.props = {
      ...this.props,
      currentStageIndex: nextIndex,
      version: this.props.version + 1,
      updatedAt: now,
    };
  }

  private replaceStage(index: number, value: PipelineStageRunProps): void {
    this.props = {
      ...this.props,
      stages: this.props.stages.map((stage, candidate) =>
        candidate === index ? value : stage,
      ),
    };
  }

  private changed(now: Date): void {
    this.props = {
      ...this.props,
      version: this.props.version + 1,
      updatedAt: now,
    };
  }
}
