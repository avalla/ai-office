import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import { ConcurrentActionTransitionError } from "../capability-errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import { AgentRunProvenanceError } from "../pipeline-errors.ts";
import {
  ActionRequest,
  type CanonicalActionPayload,
} from "@ai-office/domain/capability/action-request.ts";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import { hashCanonicalActionPayload } from "./canonical-action.ts";
import { EvaluateActionPolicy } from "./evaluate-action-policy.ts";

export type ControlledActionOutcome =
  "allowed" | "denied" | "simulation_required" | "approval_required";

const outcomes = {
  allow: "allowed",
  deny: "denied",
  allow_simulation_only: "simulation_required",
  allow_with_approval: "approval_required",
} as const;

export class RequestControlledAction {
  constructor(
    private readonly evaluatePolicy: EvaluateActionPolicy,
    private readonly repository: CapabilityPolicyRepository,
    private readonly audit: RecordAuditEvent,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly runtime?: AgentRuntimeRepository,
  ) {}

  async executeFromAgentRun(agentRunId: string): Promise<{
    request: ActionRequest;
    outcome: ControlledActionOutcome;
  }> {
    if (this.runtime === undefined)
      throw new AgentRunProvenanceError("Agent-run gateway is unavailable");
    const run = await this.runtime.findRun(agentRunId);
    if (run === null) throw new AgentRunProvenanceError();
    const value = run.snapshot();
    if (
      value.actionIntent === undefined ||
      !(
        value.status === "running" ||
        value.status === "reviewing" ||
        value.status === "completed"
      )
    )
      throw new AgentRunProvenanceError(
        "Agent run is not executing an action intent",
      );
    return this.execute({
      projectId: value.projectId,
      agentId: value.agentId,
      resourceId: value.actionIntent.resourceId,
      operation: value.actionIntent.operation,
      arguments: value.actionIntent.arguments,
      agentRunId: value.id,
    });
  }

  async execute(input: {
    projectId: string;
    agentId: string;
    resourceId: string;
    operation: string;
    arguments: Readonly<Record<string, unknown>>;
    agentRunId?: string;
    pipelineRunId?: string;
  }): Promise<{ request: ActionRequest; outcome: ControlledActionOutcome }> {
    const resolved = await this.resolveProvenance(input);
    return this.transactions.run(async () => {
      const evaluated = await this.evaluatePolicy.execute(resolved);
      const connector = evaluated.connector;
      const payload: CanonicalActionPayload = {
        schemaVersion: 1,
        projectId: input.projectId,
        agentId: resolved.agentId,
        resourceId: evaluated.resource.id,
        connector: connector.id,
        connectorVersion: connector.version,
        operation: input.operation.trim(),
        normalizedArguments: evaluated.normalizedArguments,
        effectiveConstraints: evaluated.decision.effectiveConstraints,
        ...(resolved.agentRunId === undefined
          ? {}
          : { agentRunId: resolved.agentRunId }),
        ...(evaluated.pipeline.pipelineRunId === undefined
          ? {}
          : { pipelineRunId: evaluated.pipeline.pipelineRunId }),
        ...(evaluated.pipeline.pipelineStageRunId === undefined
          ? {}
          : { pipelineStageRunId: evaluated.pipeline.pipelineStageRunId }),
      };
      const payloadHash = hashCanonicalActionPayload(payload).hash;
      const requestedAt = this.clock.now();
      const request = ActionRequest.create({
        id: this.ids.generate(),
        projectId: input.projectId,
        agentId: resolved.agentId,
        resourceId: evaluated.resource.id,
        connector: connector.id,
        connectorVersion: connector.version,
        operation: payload.operation,
        normalizedArguments: evaluated.normalizedArguments,
        effectiveConstraints: evaluated.decision.effectiveConstraints,
        payloadHash,
        decision: evaluated.decision.decision,
        riskLevel: evaluated.decision.riskLevel,
        matchedGrantIds: evaluated.decision.matchedGrantIds,
        reasons: evaluated.decision.reasons,
        ...(resolved.agentRunId === undefined
          ? {}
          : { agentRunId: resolved.agentRunId }),
        ...(evaluated.pipeline.pipelineRunId === undefined
          ? {}
          : { pipelineRunId: evaluated.pipeline.pipelineRunId }),
        ...(evaluated.pipeline.pipelineStageRunId === undefined
          ? {}
          : { pipelineStageRunId: evaluated.pipeline.pipelineStageRunId }),
        now: requestedAt,
      });
      await this.repository.insertActionRequest(request);
      await this.audit.execute({
        eventType: "action.requested",
        actorType: "system",
        actorId: resolved.agentId,
        projectId: resolved.projectId,
        aggregateType: "action_request",
        aggregateId: request.snapshot().id,
        payload: {
          resourceId: evaluated.resource.id,
          operation: payload.operation,
          riskLevel: evaluated.decision.riskLevel,
          payloadHash,
          reasons: evaluated.decision.reasons,
          ...(resolved.agentRunId === undefined
            ? {}
            : { agentRunId: resolved.agentRunId }),
          ...(evaluated.pipeline.pipelineRunId === undefined
            ? {}
            : { pipelineRunId: evaluated.pipeline.pipelineRunId }),
          ...(evaluated.pipeline.pipelineStageId === undefined
            ? {}
            : { pipelineStageId: evaluated.pipeline.pipelineStageId }),
        },
      });
      const nextStatus =
        evaluated.decision.decision === "deny" ? "denied" : "authorized";
      const transitionedAt = this.clock.now();
      const transitioned = await this.repository.transitionActionRequest({
        id: request.snapshot().id,
        projectId: input.projectId,
        expectedStatus: "requested",
        status: nextStatus,
        updatedAt: transitionedAt,
      });
      if (!transitioned)
        throw new ConcurrentActionTransitionError(
          request.snapshot().id,
          "requested",
          nextStatus,
        );
      request.transition(nextStatus, transitionedAt);
      await this.audit.execute({
        eventType:
          nextStatus === "denied" ? "action.denied" : "action.authorized",
        actorType: "system",
        actorId: resolved.agentId,
        projectId: input.projectId,
        aggregateType: "action_request",
        aggregateId: request.snapshot().id,
        payload: {
          decision: evaluated.decision.decision,
          riskLevel: evaluated.decision.riskLevel,
          matchedGrantIds: evaluated.decision.matchedGrantIds,
          payloadHash,
          reasons: evaluated.decision.reasons,
          ...(resolved.agentRunId === undefined
            ? {}
            : { agentRunId: resolved.agentRunId }),
          ...(evaluated.pipeline.pipelineRunId === undefined
            ? {}
            : { pipelineRunId: evaluated.pipeline.pipelineRunId }),
          ...(evaluated.pipeline.pipelineStageId === undefined
            ? {}
            : { pipelineStageId: evaluated.pipeline.pipelineStageId }),
        },
      });
      if (
        nextStatus === "denied" &&
        evaluated.pipeline.decision === "deny" &&
        evaluated.pipeline.pipelineRunId !== undefined
      )
        await this.audit.execute({
          eventType: "pipeline.action_denied",
          actorType: "system",
          actorId: resolved.agentId,
          projectId: input.projectId,
          aggregateType: "pipeline_run",
          aggregateId: evaluated.pipeline.pipelineRunId,
          payload: {
            actionRequestId: request.snapshot().id,
            operation: payload.operation,
            reasons: evaluated.pipeline.reasons,
            ...(resolved.agentRunId === undefined
              ? {}
              : { agentRunId: resolved.agentRunId }),
            ...(evaluated.pipeline.pipelineStageId === undefined
              ? {}
              : { stageId: evaluated.pipeline.pipelineStageId }),
          },
        });
      return { request, outcome: outcomes[evaluated.decision.decision] };
    });
  }

  private async resolveProvenance(input: {
    projectId: string;
    agentId: string;
    resourceId: string;
    operation: string;
    arguments: Readonly<Record<string, unknown>>;
    agentRunId?: string;
    pipelineRunId?: string;
  }): Promise<typeof input> {
    if (input.agentRunId === undefined) {
      if (input.pipelineRunId !== undefined)
        throw new AgentRunProvenanceError(
          "Pipeline context must come from an AgentRun",
        );
      return input;
    }
    if (this.runtime === undefined)
      throw new AgentRunProvenanceError("Agent-run gateway is unavailable");
    const run = await this.runtime.findRun(input.agentRunId);
    if (run === null) throw new AgentRunProvenanceError();
    const value = run.snapshot();
    const intent = value.actionIntent;
    if (
      value.projectId !== input.projectId ||
      value.agentId !== input.agentId ||
      intent === undefined ||
      intent.resourceId !== input.resourceId.trim() ||
      intent.operation !== input.operation.trim() ||
      canonicalStringify(intent.arguments) !==
        canonicalStringify(input.arguments)
    )
      throw new AgentRunProvenanceError(
        "Action input does not match the persisted AgentRun intent",
      );
    if (
      input.pipelineRunId !== undefined &&
      input.pipelineRunId !== value.pipelineRunId
    )
      throw new AgentRunProvenanceError(
        "Pipeline context does not match the persisted AgentRun",
      );
    return {
      ...input,
      ...(value.pipelineRunId === undefined
        ? {}
        : { pipelineRunId: value.pipelineRunId }),
    };
  }
}
