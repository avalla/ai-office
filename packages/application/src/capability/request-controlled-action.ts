import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import { ConcurrentActionTransitionError } from "../capability-errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import {
  ActionRequest,
  type CanonicalActionPayload,
} from "@ai-office/domain/capability/action-request.ts";
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
  ) {}

  async execute(input: {
    projectId: string;
    agentId: string;
    resourceId: string;
    operation: string;
    arguments: Readonly<Record<string, unknown>>;
    pipelineRunId?: string;
  }): Promise<{ request: ActionRequest; outcome: ControlledActionOutcome }> {
    return this.transactions.run(async () => {
      const evaluated = await this.evaluatePolicy.execute(input);
      const connector = evaluated.connector;
      const payload: CanonicalActionPayload = {
        schemaVersion: 1,
        projectId: input.projectId,
        agentId: input.agentId,
        resourceId: evaluated.resource.id,
        connector: connector.id,
        connectorVersion: connector.version,
        operation: input.operation.trim(),
        normalizedArguments: evaluated.normalizedArguments,
        effectiveConstraints: evaluated.decision.effectiveConstraints,
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
        agentId: input.agentId,
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
        actorId: input.agentId,
        projectId: input.projectId,
        aggregateType: "action_request",
        aggregateId: request.snapshot().id,
        payload: {
          resourceId: evaluated.resource.id,
          operation: payload.operation,
          riskLevel: evaluated.decision.riskLevel,
          payloadHash,
          reasons: evaluated.decision.reasons,
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
        actorId: input.agentId,
        projectId: input.projectId,
        aggregateType: "action_request",
        aggregateId: request.snapshot().id,
        payload: {
          decision: evaluated.decision.decision,
          riskLevel: evaluated.decision.riskLevel,
          matchedGrantIds: evaluated.decision.matchedGrantIds,
          payloadHash,
          reasons: evaluated.decision.reasons,
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
          actorId: input.agentId,
          projectId: input.projectId,
          aggregateType: "pipeline_run",
          aggregateId: evaluated.pipeline.pipelineRunId,
          payload: {
            actionRequestId: request.snapshot().id,
            operation: payload.operation,
            reasons: evaluated.pipeline.reasons,
            ...(evaluated.pipeline.pipelineStageId === undefined
              ? {}
              : { stageId: evaluated.pipeline.pipelineStageId }),
          },
        });
      return { request, outcome: outcomes[evaluated.decision.decision] };
    });
  }
}
