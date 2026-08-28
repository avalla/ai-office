import type {
  ConnectorDefinition,
  ConnectorMutationExecutionResult,
  ConnectorOperationDescriptor,
} from "@ai-office/connector-sdk/connector.ts";
import type { ConnectorRegistry } from "@ai-office/connector-sdk/connector-registry.ts";
import {
  ConnectorExecutionUnavailableError,
  ConnectorMutationExecutionError,
} from "@ai-office/connector-sdk/errors.ts";
import { ActionExecution } from "@ai-office/domain/capability/action-execution.ts";
import { ActionRequest } from "@ai-office/domain/capability/action-request.ts";
import type { ActionSimulation } from "@ai-office/domain/capability/action-simulation.ts";
import type { Resource } from "@ai-office/domain/capability/capability.ts";
import {
  ActionApprovalNotFoundError,
  ActionExecutionConflictError,
  ActionRequestNotFoundError,
  CapabilityProjectMismatchError,
  ConcurrentActionTransitionError,
  InvalidActionApprovalStateError,
  InvalidActionExecutionStateError,
  StaleActionAuthorizationError,
} from "../capability-errors.ts";
import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { ControlledExecutionRepository } from "../ports/controlled-execution-repository.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import { assertApprovalBinding } from "./action-approval-binding.ts";
import { hashCanonicalActionPayload } from "./canonical-action.ts";
import { EvaluateActionPolicy } from "./evaluate-action-policy.ts";

interface ExecutionLease {
  request: ActionRequest;
  simulation: ActionSimulation;
  execution: ActionExecution;
  definition: ConnectorDefinition;
  operation: ConnectorOperationDescriptor;
  resource: Resource;
}

const outcomePersistenceFailureCode = "OutcomePersistenceFailed";

export interface ExecutedControlledAction {
  actionRequestId: string;
  executionId: string;
  status: "completed" | "failed" | "execution_unknown";
  resultHash?: string;
  failureCode?: string;
}

export interface ControlledExecutionHooks {
  afterFreshAuthorizationBeforeLease?(
    actionRequestId: string,
  ): void | Promise<void>;
}

export class ExecuteControlledAction {
  constructor(
    private readonly repository: CapabilityPolicyRepository,
    private readonly controlled: ControlledExecutionRepository,
    private readonly audit: RecordAuditEvent,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
    private readonly connectors: ConnectorRegistry,
    private readonly evaluatePolicy: EvaluateActionPolicy,
    private readonly hooks: ControlledExecutionHooks = {},
  ) {}

  async execute(input: {
    projectId: string;
    actionRequestId: string;
    signal?: AbortSignal;
  }): Promise<ExecutedControlledAction> {
    const lease = await this.acquireLease(input);
    let result: ConnectorMutationExecutionResult;
    try {
      result = await lease.definition.executeMutation!({
        resource: {
          id: lease.resource.id,
          type: lease.resource.type,
          provider: lease.resource.provider,
          ...(lease.resource.externalRef === undefined
            ? {}
            : { externalRef: lease.resource.externalRef }),
          configuration: lease.resource.configuration,
        },
        operation: lease.request.snapshot().operation,
        arguments: lease.request.snapshot().normalizedArguments as Readonly<
          Record<string, unknown>
        >,
        effectiveConstraints: lease.request.snapshot()
          .effectiveConstraints as Readonly<Record<string, unknown>>,
        preconditions: lease.simulation.snapshot().preconditions,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
    } catch (error) {
      const certainty =
        error instanceof ConnectorMutationExecutionError
          ? error.certainty
          : "mutation_may_have_occurred";
      const status =
        certainty === "definite_no_mutation" ? "failed" : "execution_unknown";
      const failureCode =
        error instanceof ConnectorMutationExecutionError
          ? error.code
          : "UnexpectedConnectorError";
      const persisted = await this.finishWithFallback(
        lease,
        status,
        failureCode,
      );
      return {
        actionRequestId: input.actionRequestId,
        executionId: lease.execution.snapshot().id,
        status: persisted.status,
        ...(persisted.failureCode === undefined
          ? {}
          : { failureCode: persisted.failureCode }),
      };
    }
    const persisted = await this.finishWithFallback(
      lease,
      "completed",
      undefined,
      result,
    );
    return {
      actionRequestId: input.actionRequestId,
      executionId: lease.execution.snapshot().id,
      status: persisted.status,
      ...(persisted.failureCode === undefined
        ? {}
        : { failureCode: persisted.failureCode }),
      ...(persisted.status !== "completed" || result.resultHash === undefined
        ? {}
        : { resultHash: result.resultHash }),
    };
  }

  private async acquireLease(input: {
    projectId: string;
    actionRequestId: string;
  }): Promise<ExecutionLease> {
    return this.transactions.run(async () => {
      const request = await this.repository.findActionRequest(
        input.actionRequestId,
      );
      if (request === null)
        throw new ActionRequestNotFoundError(input.actionRequestId);
      const action = request.snapshot();
      if (action.projectId !== input.projectId)
        throw new CapabilityProjectMismatchError();
      if (action.status !== "approval_pending")
        throw new InvalidActionExecutionStateError();
      const definition = this.connectors.requireDefinition(action.connector);
      const operation = this.connectors.requireOperation(
        action.connector,
        action.operation,
      );
      if (
        definition.descriptor.version !== action.connectorVersion ||
        action.connector !== "filesystem" ||
        action.connectorVersion !== "2" ||
        operation.mode !== "mutation" ||
        !operation.supportsExecution ||
        !operation.requiresApproval ||
        definition.executeMutation === undefined
      )
        throw new ConnectorExecutionUnavailableError(action.connector);
      const simulation = await this.repository.findActionSimulationByAction(
        action.id,
        action.projectId,
      );
      const approval = await this.controlled.findApprovalByAction(
        action.id,
        action.projectId,
      );
      if (simulation === null)
        throw new InvalidActionExecutionStateError(
          "Action simulation is unavailable",
        );
      if (approval === null) throw new ActionApprovalNotFoundError(action.id);
      assertApprovalBinding(request, simulation, approval);
      if (approval.snapshot().status !== "approved")
        throw new InvalidActionApprovalStateError("Action is not approved");
      await this.requireFreshAuthorization(request, definition, operation);
      await this.hooks.afterFreshAuthorizationBeforeLease?.(action.id);
      if (this.hooks.afterFreshAuthorizationBeforeLease !== undefined)
        await this.requireFreshAuthorization(request, definition, operation);
      if (
        (await this.controlled.findExecutionByAction(
          action.id,
          action.projectId,
        )) !== null
      )
        throw new ActionExecutionConflictError(action.id);
      const startedAt = this.clock.now();
      const execution = ActionExecution.start({
        id: this.ids.generate(),
        projectId: action.projectId,
        actionRequestId: action.id,
        simulationId: simulation.snapshot().id,
        approvalId: approval.snapshot().id,
        now: startedAt,
      });
      if (!(await this.controlled.insertExecution(execution)))
        throw new ActionExecutionConflictError(action.id);
      request.transition("executing", startedAt, "mutation", true);
      if (
        !(await this.repository.transitionActionRequest({
          id: action.id,
          projectId: action.projectId,
          expectedStatus: "approval_pending",
          status: "executing",
          updatedAt: startedAt,
        }))
      )
        throw new ConcurrentActionTransitionError(
          action.id,
          "approval_pending",
          "executing",
        );
      await this.audit.execute({
        eventType: "action_execution_started",
        actorType: "system",
        ...(approval.snapshot().actor === undefined
          ? {}
          : { actorId: approval.snapshot().actor }),
        projectId: action.projectId,
        aggregateType: "action_execution",
        aggregateId: execution.snapshot().id,
        payload: {
          actionRequestId: action.id,
          simulationId: simulation.snapshot().id,
          approvalId: approval.snapshot().id,
        },
      });
      return {
        request,
        simulation,
        execution,
        definition,
        operation,
        resource: await this.requireCurrentResource(action.resourceId),
      };
    });
  }

  private async requireFreshAuthorization(
    request: ActionRequest,
    definition: ConnectorDefinition,
    operation: ConnectorOperationDescriptor,
  ): Promise<void> {
    const action = request.snapshot();
    const current = await this.evaluatePolicy.execute({
      projectId: action.projectId,
      agentId: action.agentId,
      resourceId: action.resourceId,
      operation: action.operation,
      arguments: action.normalizedArguments as Readonly<
        Record<string, unknown>
      >,
      evaluatedAt: this.clock.now(),
      ...(action.pipelineRunId === undefined
        ? {}
        : { pipelineRunId: action.pipelineRunId }),
    });
    const payloadHash = hashCanonicalActionPayload({
      schemaVersion: 1,
      projectId: action.projectId,
      agentId: action.agentId,
      resourceId: current.resource.id,
      connector: current.connector.id,
      connectorVersion: current.connector.version,
      operation: action.operation,
      normalizedArguments: current.normalizedArguments,
      effectiveConstraints: current.decision.effectiveConstraints,
      ...(current.pipeline.pipelineRunId === undefined
        ? {}
        : { pipelineRunId: current.pipeline.pipelineRunId }),
      ...(current.pipeline.pipelineStageRunId === undefined
        ? {}
        : { pipelineStageRunId: current.pipeline.pipelineStageRunId }),
    }).hash;
    const sameGrantIds =
      current.decision.matchedGrantIds.length ===
        action.matchedGrantIds.length &&
      current.decision.matchedGrantIds.every(
        (id, index) => id === action.matchedGrantIds[index],
      );
    if (
      current.resource.status !== "active" ||
      current.resource.projectId !== action.projectId ||
      current.resource.provider !== definition.descriptor.id ||
      !definition.descriptor.supportedResourceTypes.includes(
        current.resource.type,
      ) ||
      current.connector.id !== action.connector ||
      current.connector.version !== action.connectorVersion ||
      operation.operation !== action.operation ||
      current.decision.decision !== action.decision ||
      current.decision.decision !== "allow_with_approval" ||
      current.decision.riskLevel !== action.riskLevel ||
      current.pipeline.pipelineRunId !== action.pipelineRunId ||
      current.pipeline.pipelineStageRunId !== action.pipelineStageRunId ||
      !sameGrantIds ||
      payloadHash !== action.payloadHash ||
      hashCanonicalActionPayload(request.canonicalPayload()).hash !==
        action.payloadHash
    )
      throw new StaleActionAuthorizationError();
  }

  private async requireCurrentResource(resourceId: string): Promise<Resource> {
    const resource = await this.repository.findResource(resourceId);
    if (resource === null) throw new InvalidActionExecutionStateError();
    return resource;
  }

  private async finish(
    lease: ExecutionLease,
    status: "completed" | "failed" | "execution_unknown",
    failureCode?: string,
    result?: ConnectorMutationExecutionResult,
  ): Promise<void> {
    const action = lease.request.snapshot();
    const finishedAt = this.clock.now();
    const execution = ActionExecution.restore(lease.execution.snapshot());
    const request = ActionRequest.restore(lease.request.snapshot());
    if (status === "completed")
      execution.complete(finishedAt, result?.resultHash);
    else if (status === "failed") execution.fail(finishedAt, failureCode!);
    else execution.markUnknown(finishedAt, failureCode!);
    request.transition(status, finishedAt, "mutation", true);
    await this.transactions.run(async () => {
      if (
        !(await this.controlled.transitionExecution({
          id: execution.snapshot().id,
          projectId: action.projectId,
          expectedStatus: "executing",
          status,
          completedAt: finishedAt,
          ...(failureCode === undefined ? {} : { failureCode }),
          ...(result?.resultHash === undefined
            ? {}
            : { resultHash: result.resultHash }),
        }))
      )
        throw new InvalidActionExecutionStateError(
          "Execution outcome changed concurrently",
        );
      if (
        !(await this.repository.transitionActionRequest({
          id: action.id,
          projectId: action.projectId,
          expectedStatus: "executing",
          status,
          updatedAt: finishedAt,
        }))
      )
        throw new ConcurrentActionTransitionError(
          action.id,
          "executing",
          status,
        );
      await this.audit.execute({
        eventType:
          status === "completed"
            ? "action_execution_completed"
            : status === "failed"
              ? "action_execution_failed"
              : "action_execution_unknown",
        actorType: "system",
        projectId: action.projectId,
        aggregateType: "action_execution",
        aggregateId: execution.snapshot().id,
        payload: {
          actionRequestId: action.id,
          ...(failureCode === undefined ? {} : { failureCode }),
          ...(result?.resultHash === undefined
            ? {}
            : { resultHash: result.resultHash }),
          ...(result?.audit.relativePath === undefined
            ? {}
            : { path: result.audit.relativePath }),
          ...(result?.audit.destinationPath === undefined
            ? {}
            : { destinationPath: result.audit.destinationPath }),
          ...(result?.audit.byteLength === undefined
            ? {}
            : { byteLength: result.audit.byteLength }),
        },
      });
    });
  }

  private async finishWithFallback(
    lease: ExecutionLease,
    status: "completed" | "failed" | "execution_unknown",
    failureCode?: string,
    result?: ConnectorMutationExecutionResult,
  ): Promise<{
    status: "completed" | "failed" | "execution_unknown";
    failureCode?: string;
  }> {
    try {
      await this.finish(lease, status, failureCode, result);
      return {
        status,
        ...(failureCode === undefined ? {} : { failureCode }),
      };
    } catch (error) {
      if (status === "failed") throw error;
      try {
        await this.persistOutcomeFailureAsUnknown(lease);
        return {
          status: "execution_unknown",
          failureCode: outcomePersistenceFailureCode,
        };
      } catch {
        throw error;
      }
    }
  }

  private async persistOutcomeFailureAsUnknown(
    lease: ExecutionLease,
  ): Promise<void> {
    const leasedAction = lease.request.snapshot();
    await this.transactions.run(async () => {
      const request = await this.repository.findActionRequest(leasedAction.id);
      const execution = await this.controlled.findExecutionByAction(
        leasedAction.id,
        leasedAction.projectId,
      );
      if (request === null || execution === null)
        throw new InvalidActionExecutionStateError(
          "Execution outcome cannot be recovered",
        );
      const action = request.snapshot();
      const currentExecution = execution.snapshot();
      if (
        action.projectId !== leasedAction.projectId ||
        action.status !== "executing" ||
        currentExecution.status !== "executing"
      )
        throw new InvalidActionExecutionStateError(
          "Execution outcome cannot be recovered",
        );
      const finishedAt = this.clock.now();
      execution.markUnknown(finishedAt, outcomePersistenceFailureCode);
      request.transition("execution_unknown", finishedAt, "mutation", true);
      if (
        !(await this.controlled.transitionExecution({
          id: currentExecution.id,
          projectId: action.projectId,
          expectedStatus: "executing",
          status: "execution_unknown",
          completedAt: finishedAt,
          failureCode: outcomePersistenceFailureCode,
        }))
      )
        throw new InvalidActionExecutionStateError(
          "Execution outcome changed concurrently",
        );
      if (
        !(await this.repository.transitionActionRequest({
          id: action.id,
          projectId: action.projectId,
          expectedStatus: "executing",
          status: "execution_unknown",
          updatedAt: finishedAt,
        }))
      )
        throw new ConcurrentActionTransitionError(
          action.id,
          "executing",
          "execution_unknown",
        );
      await this.audit.execute({
        eventType: "action_execution_unknown",
        actorType: "system",
        projectId: action.projectId,
        aggregateType: "action_execution",
        aggregateId: currentExecution.id,
        payload: {
          actionRequestId: action.id,
          failureCode: outcomePersistenceFailureCode,
        },
      });
    });
  }
}
