import type { Database } from "bun:sqlite";
import type { ControlledExecutionRepository } from "@ai-office/application/ports/controlled-execution-repository.port.ts";
import {
  ActionApproval,
  type ActionApprovalStatus,
} from "@ai-office/domain/capability/action-approval.ts";
import {
  ActionExecution,
  type ActionExecutionStatus,
} from "@ai-office/domain/capability/action-execution.ts";

interface ApprovalRow {
  id: string;
  project_id: string;
  action_request_id: string;
  simulation_id: string;
  action_payload_hash: string;
  simulation_artifact_hash: string;
  connector: string;
  connector_version: string;
  operation: string;
  status: ActionApprovalStatus;
  requested_at: string;
  decided_at: string | null;
  actor: string | null;
}

interface ExecutionRow {
  id: string;
  project_id: string;
  action_request_id: string;
  simulation_id: string;
  approval_id: string;
  status: ActionExecutionStatus;
  started_at: string;
  completed_at: string | null;
  failure_code: string | null;
  result_hash: string | null;
}

const approvalColumns =
  "id, project_id, action_request_id, simulation_id, action_payload_hash, simulation_artifact_hash, connector, connector_version, operation, status, requested_at, decided_at, actor";
const executionColumns =
  "id, project_id, action_request_id, simulation_id, approval_id, status, started_at, completed_at, failure_code, result_hash";

function approval(row: ApprovalRow): ActionApproval {
  return ActionApproval.restore({
    id: row.id,
    projectId: row.project_id,
    actionRequestId: row.action_request_id,
    simulationId: row.simulation_id,
    actionPayloadHash: row.action_payload_hash,
    simulationArtifactHash: row.simulation_artifact_hash,
    connector: row.connector,
    connectorVersion: row.connector_version,
    operation: row.operation,
    status: row.status,
    requestedAt: new Date(row.requested_at),
    ...(row.decided_at === null ? {} : { decidedAt: new Date(row.decided_at) }),
    ...(row.actor === null ? {} : { actor: row.actor }),
  });
}

function execution(row: ExecutionRow): ActionExecution {
  return ActionExecution.restore({
    id: row.id,
    projectId: row.project_id,
    actionRequestId: row.action_request_id,
    simulationId: row.simulation_id,
    approvalId: row.approval_id,
    status: row.status,
    startedAt: new Date(row.started_at),
    ...(row.completed_at === null
      ? {}
      : { completedAt: new Date(row.completed_at) }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    ...(row.result_hash === null ? {} : { resultHash: row.result_hash }),
  });
}

export class SqliteControlledExecutionRepository implements ControlledExecutionRepository {
  constructor(private readonly database: Database) {}

  async insertApproval(value: ActionApproval): Promise<boolean> {
    const item = value.snapshot();
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO action_approvals(
            id, project_id, action_request_id, simulation_id,
            action_payload_hash, simulation_artifact_hash, connector,
            connector_version, operation, status, requested_at, decided_at, actor
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          item.projectId,
          item.actionRequestId,
          item.simulationId,
          item.actionPayloadHash,
          item.simulationArtifactHash,
          item.connector,
          item.connectorVersion,
          item.operation,
          item.status,
          item.requestedAt.toISOString(),
          item.decidedAt?.toISOString() ?? null,
          item.actor ?? null,
        ).changes === 1
    );
  }

  async findApprovalByAction(
    actionRequestId: string,
    projectId: string,
  ): Promise<ActionApproval | null> {
    const row = this.database
      .query<ApprovalRow, [string, string]>(
        `SELECT ${approvalColumns} FROM action_approvals
         WHERE action_request_id=? AND project_id=?`,
      )
      .get(actionRequestId, projectId);
    return row === null ? null : approval(row);
  }

  async transitionApproval(input: {
    id: string;
    projectId: string;
    expectedStatus: ActionApprovalStatus;
    status: Exclude<ActionApprovalStatus, "pending">;
    decidedAt: Date;
    actor: string;
  }): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE action_approvals
           SET status=?, decided_at=?, actor=?
           WHERE id=? AND project_id=? AND status=?`,
        )
        .run(
          input.status,
          input.decidedAt.toISOString(),
          input.actor,
          input.id,
          input.projectId,
          input.expectedStatus,
        ).changes === 1
    );
  }

  async insertExecution(value: ActionExecution): Promise<boolean> {
    const item = value.snapshot();
    return (
      this.database
        .prepare(
          `INSERT OR IGNORE INTO action_executions(
            id, project_id, action_request_id, simulation_id, approval_id,
            status, started_at, completed_at, failure_code, result_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.id,
          item.projectId,
          item.actionRequestId,
          item.simulationId,
          item.approvalId,
          item.status,
          item.startedAt.toISOString(),
          item.completedAt?.toISOString() ?? null,
          item.failureCode ?? null,
          item.resultHash ?? null,
        ).changes === 1
    );
  }

  async findExecutionByAction(
    actionRequestId: string,
    projectId: string,
  ): Promise<ActionExecution | null> {
    const row = this.database
      .query<ExecutionRow, [string, string]>(
        `SELECT ${executionColumns} FROM action_executions
         WHERE action_request_id=? AND project_id=?`,
      )
      .get(actionRequestId, projectId);
    return row === null ? null : execution(row);
  }

  async transitionExecution(input: {
    id: string;
    projectId: string;
    expectedStatus: ActionExecutionStatus;
    status: Exclude<ActionExecutionStatus, "executing">;
    completedAt: Date;
    failureCode?: string;
    resultHash?: string;
  }): Promise<boolean> {
    return (
      this.database
        .prepare(
          `UPDATE action_executions
           SET status=?, completed_at=?, failure_code=?, result_hash=?
           WHERE id=? AND project_id=? AND status=?`,
        )
        .run(
          input.status,
          input.completedAt.toISOString(),
          input.failureCode ?? null,
          input.resultHash ?? null,
          input.id,
          input.projectId,
          input.expectedStatus,
        ).changes === 1
    );
  }
}
