import type {
  ActionApproval,
  ActionApprovalStatus,
} from "@ai-office/domain/capability/action-approval.ts";
import type {
  ActionExecution,
  ActionExecutionStatus,
} from "@ai-office/domain/capability/action-execution.ts";

export interface ControlledExecutionRepository {
  insertApproval(approval: ActionApproval): Promise<boolean>;
  findApprovalByAction(
    actionRequestId: string,
    projectId: string,
  ): Promise<ActionApproval | null>;
  transitionApproval(input: {
    id: string;
    projectId: string;
    expectedStatus: ActionApprovalStatus;
    status: Exclude<ActionApprovalStatus, "pending">;
    decidedAt: Date;
    actor: string;
  }): Promise<boolean>;
  insertExecution(execution: ActionExecution): Promise<boolean>;
  findExecutionByAction(
    actionRequestId: string,
    projectId: string,
  ): Promise<ActionExecution | null>;
  transitionExecution(input: {
    id: string;
    projectId: string;
    expectedStatus: ActionExecutionStatus;
    status: Exclude<ActionExecutionStatus, "executing">;
    completedAt: Date;
    failureCode?: string;
    resultHash?: string;
  }): Promise<boolean>;
}
