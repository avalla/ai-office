import type { ActionApproval } from "@ai-office/domain/capability/action-approval.ts";
import {
  ActionApprovalNotFoundError,
  ActionRequestNotFoundError,
  CapabilityProjectMismatchError,
  ConcurrentActionTransitionError,
  InvalidActionApprovalStateError,
} from "../capability-errors.ts";
import { RecordAuditEvent } from "../commands/record-audit-event.ts";
import type { CapabilityPolicyRepository } from "../ports/capability-policy-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { ControlledExecutionRepository } from "../ports/controlled-execution-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import { requiredText } from "./validation.ts";
import { assertApprovalBinding } from "./action-approval-binding.ts";

export interface DecidedControlledAction {
  approval: ActionApproval;
  actionStatus: "approval_pending" | "rejected";
}

export class DecideControlledAction {
  constructor(
    private readonly repository: CapabilityPolicyRepository,
    private readonly controlled: ControlledExecutionRepository,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async approve(input: {
    projectId: string;
    actionRequestId: string;
    actor: string;
  }): Promise<DecidedControlledAction> {
    return this.decide(input, "approved");
  }

  async reject(input: {
    projectId: string;
    actionRequestId: string;
    actor: string;
  }): Promise<DecidedControlledAction> {
    return this.decide(input, "rejected");
  }

  private async decide(
    input: { projectId: string; actionRequestId: string; actor: string },
    decision: "approved" | "rejected",
  ): Promise<DecidedControlledAction> {
    const actor = requiredText(input.actor, "approval actor");
    return this.transactions.run(async () => {
      const request = await this.repository.findActionRequest(
        input.actionRequestId,
      );
      if (request === null)
        throw new ActionRequestNotFoundError(input.actionRequestId);
      if (request.snapshot().projectId !== input.projectId)
        throw new CapabilityProjectMismatchError();
      if (request.snapshot().status !== "approval_pending")
        throw new InvalidActionApprovalStateError();
      const simulation = await this.repository.findActionSimulationByAction(
        input.actionRequestId,
        input.projectId,
      );
      const approval = await this.controlled.findApprovalByAction(
        input.actionRequestId,
        input.projectId,
      );
      if (approval === null) throw new ActionApprovalNotFoundError(input.actionRequestId);
      if (simulation === null) throw new InvalidActionApprovalStateError();
      assertApprovalBinding(request, simulation, approval);
      if (approval.snapshot().status !== "pending")
        throw new InvalidActionApprovalStateError("Action approval is already decided");
      const decidedAt = this.clock.now();
      if (decision === "approved") approval.approve(actor, decidedAt);
      else approval.reject(actor, decidedAt);
      if (
        !(await this.controlled.transitionApproval({
          id: approval.snapshot().id,
          projectId: input.projectId,
          expectedStatus: "pending",
          status: decision,
          decidedAt,
          actor,
        }))
      )
        throw new InvalidActionApprovalStateError("Action approval changed concurrently");
      let actionStatus: "approval_pending" | "rejected" = "approval_pending";
      if (decision === "rejected") {
        request.transition("rejected", decidedAt, "mutation", true);
        if (
          !(await this.repository.transitionActionRequest({
            id: input.actionRequestId,
            projectId: input.projectId,
            expectedStatus: "approval_pending",
            status: "rejected",
            updatedAt: decidedAt,
          }))
        )
          throw new ConcurrentActionTransitionError(
            input.actionRequestId,
            "approval_pending",
            "rejected",
          );
        actionStatus = "rejected";
      }
      await this.audit.execute({
        eventType: decision === "approved" ? "action_approved" : "action_rejected",
        actorType: "cli",
        actorId: actor,
        projectId: input.projectId,
        aggregateType: "action_approval",
        aggregateId: approval.snapshot().id,
        payload: {
          actionRequestId: input.actionRequestId,
          simulationId: simulation.snapshot().id,
          artifactSha256: simulation.snapshot().artifactSha256,
        },
      });
      return { approval, actionStatus };
    });
  }
}
