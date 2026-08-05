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
import { fakeConnectorDescriptor } from "@ai-office/domain/capability/capability.ts";
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
  }): Promise<{ request: ActionRequest; outcome: ControlledActionOutcome }> {
    return this.transactions.run(async () => {
      const evaluated = await this.evaluatePolicy.execute(input);
      const payload: CanonicalActionPayload = {
        schemaVersion: 1,
        projectId: input.projectId,
        agentId: input.agentId,
        resourceId: evaluated.resource.id,
        connector: evaluated.resource.provider,
        connectorVersion: fakeConnectorDescriptor.version,
        operation: input.operation.trim(),
        normalizedArguments: evaluated.normalizedArguments,
        effectiveConstraints: evaluated.decision.effectiveConstraints,
      };
      const payloadHash = hashCanonicalActionPayload(payload).hash;
      const requestedAt = this.clock.now();
      const request = ActionRequest.create({
        id: this.ids.generate(),
        projectId: input.projectId,
        agentId: input.agentId,
        resourceId: evaluated.resource.id,
        connector: evaluated.resource.provider,
        connectorVersion: fakeConnectorDescriptor.version,
        operation: payload.operation,
        normalizedArguments: evaluated.normalizedArguments,
        effectiveConstraints: evaluated.decision.effectiveConstraints,
        payloadHash,
        decision: evaluated.decision.decision,
        riskLevel: evaluated.decision.riskLevel,
        matchedGrantIds: evaluated.decision.matchedGrantIds,
        reasons: evaluated.decision.reasons,
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
        },
      });
      return { request, outcome: outcomes[evaluated.decision.decision] };
    });
  }
}
