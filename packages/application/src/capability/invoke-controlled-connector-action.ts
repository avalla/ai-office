import type {
  ConnectorDefinition,
  ConnectorFilePrecondition,
  ConnectorInvocationResult,
  ConnectorOperationDescriptor,
} from "@ai-office/connector-sdk/connector.ts";
import { ConnectorExecutionUnavailableError } from "@ai-office/connector-sdk/errors.ts";
import type { ConnectorRegistry } from "@ai-office/connector-sdk/connector-registry.ts";
import {
  ActionApprovalConflictError,
  ActionSimulationConflictError,
  ConcurrentActionTransitionError,
  InvalidConnectorInvocationStateError,
  ActionRequestNotFoundError,
  CapabilityProjectMismatchError,
  StaleActionAuthorizationError,
} from "../capability-errors.ts";
import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { ControlledExecutionRepository } from "../ports/controlled-execution-repository.port.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type {
  ActionOperationMode,
  ActionRequestProps,
  ActionStatus,
} from "@ai-office/domain/capability/action-request.ts";
import { ActionRequest } from "@ai-office/domain/capability/action-request.ts";
import { ActionApproval } from "@ai-office/domain/capability/action-approval.ts";
import type { Resource } from "@ai-office/domain/capability/capability.ts";
import {
  ActionSimulation,
  type FilePrecondition,
} from "@ai-office/domain/capability/action-simulation.ts";
import {
  hashActionSimulationArtifact,
  sha256Text,
} from "./action-simulation-hash.ts";
import { hashCanonicalActionPayload } from "./canonical-action.ts";
import {
  RequestControlledAction,
  type ControlledActionOutcome,
} from "./request-controlled-action.ts";
import { EvaluateActionPolicy } from "./evaluate-action-policy.ts";

export interface InvokedControlledAction {
  requestId: string;
  outcome: ControlledActionOutcome;
  status: ActionStatus;
  result?: Readonly<Record<string, unknown>>;
  simulation?: ActionSimulation;
}

const outcomeByDecision = {
  allow: "allowed",
  deny: "denied",
  allow_simulation_only: "simulation_required",
  allow_with_approval: "approval_required",
} as const;

interface FreshAuthorization {
  definition: ConnectorDefinition;
  operation: ConnectorOperationDescriptor;
  resource: Resource;
  outcome: ControlledActionOutcome;
}

export interface AuthorizationLeaseHooks {
  afterEvaluationBeforeCas?(input: {
    actionRequestId: string;
    targetStatus: "executing" | "simulating";
  }): void | Promise<void>;
  afterCas?(input: {
    actionRequestId: string;
    status: "executing" | "simulating";
  }): void | Promise<void>;
}

interface AuthorizationLease extends FreshAuthorization {
  request: ActionRequest;
}

function filePreconditions(
  values: readonly ConnectorFilePrecondition[],
): readonly FilePrecondition[] {
  return Object.freeze(
    values.map((value) => {
      if (value.kind === "absent")
        return Object.freeze({ kind: "absent" as const, path: value.path });
      if (value.sha256 === undefined || value.size === undefined)
        throw new InvalidConnectorInvocationStateError(
          "Connector returned an incomplete file precondition",
        );
      return Object.freeze({
        kind: "file" as const,
        path: value.path,
        sha256: value.sha256,
        size: value.size,
      });
    }),
  );
}

export class InvokeControlledConnectorAction {
  constructor(
    private readonly requestAction: RequestControlledAction,
    private readonly repository: CapabilityPolicyRepository,
    private readonly audit: RecordAuditEvent,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly connectors: ConnectorRegistry,
    private readonly evaluatePolicy: EvaluateActionPolicy,
    private readonly controlledExecution: ControlledExecutionRepository,
    private readonly leaseHooks: AuthorizationLeaseHooks = {},
    private readonly runtime?: AgentRuntimeRepository,
  ) {}

  async execute(
    input:
      | {
          agentRunId: string;
          signal?: AbortSignal;
        }
      | {
          projectId: string;
          agentId: string;
          resourceId: string;
          operation: string;
          arguments: Readonly<Record<string, unknown>>;
          pipelineRunId?: string;
          signal?: AbortSignal;
        },
  ): Promise<InvokedControlledAction> {
    const requested =
      "agentRunId" in input
        ? await this.requestAction.executeFromAgentRun(input.agentRunId)
        : await this.requestAction.execute(input);
    const request = requested.request;
    const snapshot = request.snapshot();
    if (requested.outcome === "denied")
      return {
        requestId: snapshot.id,
        outcome: requested.outcome,
        status: snapshot.status,
      };
    return this.invokeRequest(
      request.snapshot().id,
      request.snapshot().projectId,
      input.signal,
    );
  }

  async invokeAuthorized(input: {
    projectId: string;
    actionRequestId: string;
    signal?: AbortSignal;
  }): Promise<InvokedControlledAction> {
    return this.invokeRequest(
      input.actionRequestId,
      input.projectId,
      input.signal,
    );
  }

  private async invokeRequest(
    actionRequestId: string,
    projectId: string,
    signal?: AbortSignal,
  ): Promise<InvokedControlledAction> {
    const lease = await this.acquireAuthorizationLease(
      actionRequestId,
      projectId,
    );
    const { request, definition, operation, resource, outcome } = lease;
    let snapshot = request.snapshot();
    if (definition.invoke === undefined)
      throw new ConnectorExecutionUnavailableError(snapshot.connector);

    if (operation.mode === "read") {
      try {
        const result = await definition.invoke({
          resource: {
            id: resource.id,
            type: resource.type,
            provider: resource.provider,
            ...(resource.externalRef === undefined
              ? {}
              : { externalRef: resource.externalRef }),
            configuration: resource.configuration,
          },
          operation: snapshot.operation,
          arguments: snapshot.normalizedArguments as Readonly<
            Record<string, unknown>
          >,
          effectiveConstraints: snapshot.effectiveConstraints as Readonly<
            Record<string, unknown>
          >,
          ...(signal === undefined ? {} : { signal }),
        });
        if (result.kind !== "read")
          throw new InvalidConnectorInvocationStateError(
            "Read connector returned a simulation result",
          );
        await this.transition(
          request,
          "completed",
          "read",
          "action.completed",
          this.readAudit(result),
        );
        snapshot = request.snapshot();
        return {
          requestId: snapshot.id,
          outcome,
          status: snapshot.status,
          result: result.output,
        };
      } catch (error) {
        if (request.snapshot().status === "executing")
          await this.transition(request, "failed", "read", "action.failed", {
            errorCode: error instanceof Error ? error.name : "UnknownError",
          });
        throw error;
      }
    }

    try {
      const result = await definition.invoke({
        resource: {
          id: resource.id,
          type: resource.type,
          provider: resource.provider,
          ...(resource.externalRef === undefined
            ? {}
            : { externalRef: resource.externalRef }),
          configuration: resource.configuration,
        },
        operation: snapshot.operation,
        arguments: snapshot.normalizedArguments as Readonly<
          Record<string, unknown>
        >,
        effectiveConstraints: snapshot.effectiveConstraints as Readonly<
          Record<string, unknown>
        >,
        ...(signal === undefined ? {} : { signal }),
      });
      if (result.kind !== "simulation")
        throw new InvalidConnectorInvocationStateError(
          "Mutation connector returned a read result",
        );
      const simulation = this.createSimulation(request.snapshot(), result);
      const beforeSimulation = request.snapshot();
      const simulatedAt = this.clock.now();
      const approvalPendingAt = this.clock.now();
      const approval = operation.requiresApproval
        ? ActionApproval.request({
            id: this.ids.generate(),
            projectId: beforeSimulation.projectId,
            actionRequestId: beforeSimulation.id,
            simulationId: simulation.snapshot().id,
            actionPayloadHash: beforeSimulation.payloadHash,
            simulationArtifactHash: simulation.snapshot().artifactSha256,
            connector: beforeSimulation.connector,
            connectorVersion: beforeSimulation.connectorVersion,
            operation: beforeSimulation.operation,
            now: approvalPendingAt,
          })
        : undefined;
      await this.transactions.run(async () => {
        if (!(await this.repository.insertActionSimulation(simulation)))
          throw new ActionSimulationConflictError(request.snapshot().id);
        if (
          !(await this.repository.transitionActionRequest({
            id: beforeSimulation.id,
            projectId: beforeSimulation.projectId,
            expectedStatus: "simulating",
            status: "simulated",
            updatedAt: simulatedAt,
          }))
        )
          throw new ConcurrentActionTransitionError(
            beforeSimulation.id,
            "simulating",
            "simulated",
          );
        await this.audit.execute({
          eventType: "action.simulated",
          actorType: "system",
          actorId: snapshot.agentId,
          projectId: snapshot.projectId,
          aggregateType: "action_request",
          aggregateId: request.snapshot().id,
          payload: {
            simulationId: simulation.snapshot().id,
            diffSha256: simulation.snapshot().diffSha256,
            artifactSha256: simulation.snapshot().artifactSha256,
          },
        });
        if (operation.requiresApproval) {
          if (
            approval === undefined ||
            !(await this.controlledExecution.insertApproval(approval))
          )
            throw new ActionApprovalConflictError(beforeSimulation.id);
          await this.audit.execute({
            eventType: "action_approval_requested",
            actorType: "system",
            actorId: snapshot.agentId,
            projectId: snapshot.projectId,
            aggregateType: "action_approval",
            aggregateId: approval.snapshot().id,
            payload: {
              actionRequestId: beforeSimulation.id,
              simulationId: simulation.snapshot().id,
              artifactSha256: simulation.snapshot().artifactSha256,
            },
          });
          if (
            !(await this.repository.transitionActionRequest({
              id: beforeSimulation.id,
              projectId: beforeSimulation.projectId,
              expectedStatus: "simulated",
              status: "approval_pending",
              updatedAt: approvalPendingAt,
            }))
          )
            throw new ConcurrentActionTransitionError(
              beforeSimulation.id,
              "simulated",
              "approval_pending",
            );
          await this.audit.execute({
            eventType: "action.approval_pending",
            actorType: "system",
            actorId: snapshot.agentId,
            projectId: snapshot.projectId,
            aggregateType: "action_request",
            aggregateId: request.snapshot().id,
            payload: { simulationId: simulation.snapshot().id },
          });
        }
      });
      request.transition("simulated", simulatedAt, "mutation");
      if (operation.requiresApproval)
        request.transition(
          "approval_pending",
          approvalPendingAt,
          "mutation",
          true,
        );
      return {
        requestId: request.snapshot().id,
        outcome,
        status: request.snapshot().status,
        simulation,
      };
    } catch (error) {
      const persisted = await this.repository.findActionRequest(
        request.snapshot().id,
      );
      if (persisted?.snapshot().status === "simulating")
        await this.transition(
          persisted,
          "failed",
          "mutation",
          "action.failed",
          {
            errorCode: error instanceof Error ? error.name : "UnknownError",
          },
        );
      throw error;
    }
  }

  private async acquireAuthorizationLease(
    actionRequestId: string,
    projectId: string,
  ): Promise<AuthorizationLease> {
    const acquired = await this.transactions.run<
      AuthorizationLease | { stale: StaleActionAuthorizationError }
    >(async () => {
      let request = await this.repository.findActionRequest(actionRequestId);
      if (request === null)
        throw new ActionRequestNotFoundError(actionRequestId);
      if (request.snapshot().projectId !== projectId)
        throw new CapabilityProjectMismatchError();
      let leaseAt = this.clock.now();
      let fresh = await this.requireFreshAuthorization(request, leaseAt);
      if (fresh.definition.invoke === undefined)
        throw new ConnectorExecutionUnavailableError(
          request.snapshot().connector,
        );
      const targetStatus =
        fresh.operation.mode === "read" ? "executing" : "simulating";
      if (
        (fresh.operation.mode === "read" &&
          (!fresh.operation.supportsExecution ||
            fresh.outcome !== "allowed")) ||
        (fresh.operation.mode === "mutation" &&
          !fresh.operation.supportsSimulation)
      )
        throw new InvalidConnectorInvocationStateError(
          "Action is not invocable in its current policy state",
        );
      await this.leaseHooks.afterEvaluationBeforeCas?.({
        actionRequestId,
        targetStatus,
      });

      if (this.leaseHooks.afterEvaluationBeforeCas !== undefined) {
        request =
          (await this.repository.findActionRequest(actionRequestId)) ?? request;
        leaseAt = this.clock.now();
        try {
          fresh = await this.requireFreshAuthorization(request, leaseAt);
        } catch (error) {
          if (error instanceof StaleActionAuthorizationError)
            return { stale: error };
          throw error;
        }
      }
      const before = request.snapshot();
      const updatedAt = leaseAt;
      request.transition(
        targetStatus,
        updatedAt,
        fresh.operation.mode,
        fresh.operation.requiresApproval,
      );
      if (
        !(await this.repository.transitionActionRequest({
          id: before.id,
          projectId: before.projectId,
          expectedStatus: "authorized",
          status: targetStatus,
          updatedAt,
        }))
      )
        throw new ConcurrentActionTransitionError(
          before.id,
          "authorized",
          targetStatus,
        );
      await this.audit.execute({
        eventType:
          targetStatus === "executing"
            ? "action.executing"
            : "action.simulating",
        actorType: "system",
        actorId: before.agentId,
        projectId: before.projectId,
        aggregateType: "action_request",
        aggregateId: before.id,
        payload: {},
      });
      await this.leaseHooks.afterCas?.({
        actionRequestId,
        status: targetStatus,
      });
      return { request, ...fresh };
    });
    if ("stale" in acquired) throw acquired.stale;
    return acquired;
  }

  private async requireFreshAuthorization(
    request: ActionRequest,
    evaluatedAt: Date,
  ): Promise<FreshAuthorization> {
    const snapshot = request.snapshot();
    await this.validateAgentRunBinding(snapshot);
    if (snapshot.status !== "authorized")
      throw new InvalidConnectorInvocationStateError(
        `Action request must be authorized before invocation: ${snapshot.status}`,
      );
    const definition = this.connectors.requireDefinition(snapshot.connector);
    const operation = this.connectors.requireOperation(
      snapshot.connector,
      snapshot.operation,
    );
    if (definition.descriptor.version !== snapshot.connectorVersion)
      throw new StaleActionAuthorizationError();

    const current = await this.evaluatePolicy.execute({
      projectId: snapshot.projectId,
      agentId: snapshot.agentId,
      resourceId: snapshot.resourceId,
      operation: snapshot.operation,
      evaluatedAt,
      arguments: snapshot.normalizedArguments as Readonly<
        Record<string, unknown>
      >,
      ...(snapshot.pipelineRunId === undefined
        ? {}
        : { pipelineRunId: snapshot.pipelineRunId }),
    });
    const currentPayloadHash = hashCanonicalActionPayload({
      schemaVersion: 1,
      projectId: snapshot.projectId,
      agentId: snapshot.agentId,
      resourceId: current.resource.id,
      connector: current.connector.id,
      connectorVersion: current.connector.version,
      operation: snapshot.operation,
      normalizedArguments: current.normalizedArguments,
      effectiveConstraints: current.decision.effectiveConstraints,
      ...(snapshot.agentRunId === undefined
        ? {}
        : { agentRunId: snapshot.agentRunId }),
      ...(current.pipeline.pipelineRunId === undefined
        ? {}
        : { pipelineRunId: current.pipeline.pipelineRunId }),
      ...(current.pipeline.pipelineStageRunId === undefined
        ? {}
        : { pipelineStageRunId: current.pipeline.pipelineStageRunId }),
    }).hash;
    const sameGrantIds =
      current.decision.matchedGrantIds.length ===
        snapshot.matchedGrantIds.length &&
      current.decision.matchedGrantIds.every(
        (id, index) => id === snapshot.matchedGrantIds[index],
      );
    if (
      current.resource.status !== "active" ||
      current.resource.projectId !== snapshot.projectId ||
      current.resource.provider !== definition.descriptor.id ||
      !definition.descriptor.supportedResourceTypes.includes(
        current.resource.type,
      ) ||
      current.connector.id !== snapshot.connector ||
      current.connector.version !== snapshot.connectorVersion ||
      current.decision.decision !== snapshot.decision ||
      current.decision.decision === "deny" ||
      current.decision.riskLevel !== snapshot.riskLevel ||
      current.pipeline.pipelineRunId !== snapshot.pipelineRunId ||
      current.pipeline.pipelineStageRunId !== snapshot.pipelineStageRunId ||
      !sameGrantIds ||
      currentPayloadHash !== snapshot.payloadHash ||
      hashCanonicalActionPayload(request.canonicalPayload()).hash !==
        snapshot.payloadHash
    )
      throw new StaleActionAuthorizationError();
    return {
      definition,
      operation,
      resource: current.resource,
      outcome: outcomeByDecision[current.decision.decision],
    };
  }

  private async validateAgentRunBinding(
    action: ActionRequestProps,
  ): Promise<void> {
    if (action.agentRunId === undefined) return;
    if (this.runtime === undefined) throw new StaleActionAuthorizationError();
    const run = await this.runtime.findRun(action.agentRunId);
    const value = run?.snapshot();
    if (
      value === undefined ||
      value.projectId !== action.projectId ||
      value.agentId !== action.agentId ||
      value.pipelineRunId !== action.pipelineRunId
    )
      throw new StaleActionAuthorizationError();
  }

  private readAudit(
    result: Extract<ConnectorInvocationResult, { kind: "read" }>,
  ) {
    return {
      ...(result.audit.relativePath === undefined
        ? {}
        : { path: result.audit.relativePath }),
      ...(result.audit.byteLength === undefined
        ? {}
        : { byteLength: result.audit.byteLength }),
      ...(result.audit.resultCount === undefined
        ? {}
        : { resultCount: result.audit.resultCount }),
      ...(result.audit.contentSha256 === undefined
        ? {}
        : { contentSha256: result.audit.contentSha256 }),
      ...(result.audit.truncated === undefined
        ? {}
        : { truncated: result.audit.truncated }),
    };
  }

  private createSimulation(
    request: ActionRequestProps,
    result: Extract<ConnectorInvocationResult, { kind: "simulation" }>,
  ): ActionSimulation {
    const preconditions = filePreconditions(result.preconditions);
    const diffSha256 = sha256Text(result.diff);
    const artifactSha256 = hashActionSimulationArtifact({
      schemaVersion: 1,
      actionRequestId: request.id,
      authorizationPayloadHash: request.payloadHash,
      connector: request.connector,
      connectorVersion: request.connectorVersion,
      operation: request.operation,
      preconditions,
      diffSha256,
    });
    return ActionSimulation.create({
      id: this.ids.generate(),
      projectId: request.projectId,
      actionRequestId: request.id,
      authorizationPayloadHash: request.payloadHash,
      connector: request.connector,
      connectorVersion: request.connectorVersion,
      operation: request.operation,
      preconditions,
      diff: result.diff,
      diffSha256,
      artifactSha256,
      createdAt: this.clock.now(),
    });
  }

  private async transition(
    request: ActionRequest,
    status: ActionStatus,
    mode: ActionOperationMode,
    eventType: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const before = request.snapshot();
    const updatedAt = this.clock.now();
    await this.transactions.run(async () => {
      const transitioned = await this.repository.transitionActionRequest({
        id: before.id,
        projectId: before.projectId,
        expectedStatus: before.status,
        status,
        updatedAt,
      });
      if (!transitioned)
        throw new ConcurrentActionTransitionError(
          before.id,
          before.status,
          status,
        );
      await this.audit.execute({
        eventType,
        actorType: "system",
        actorId: before.agentId,
        projectId: before.projectId,
        aggregateType: "action_request",
        aggregateId: before.id,
        payload,
      });
    });
    request.transition(status, updatedAt, mode);
  }
}
