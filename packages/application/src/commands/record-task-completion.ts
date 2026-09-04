/**
 * Historical completion correction — an operator attestation, not a transition.
 *
 * The motivating defect was a task left at `pending` while every requirement it
 * delivers is verified. Reconciliation can see the contradiction but must never
 * resolve it: requirement acceptance is governance state and does not prove that
 * operational work happened. Only a person knows that, and only a person can say
 * so.
 *
 * This command is that statement, and it is deliberately not any of the three
 * things it could have been:
 *
 * - not `pending -> completed` in the lifecycle table, which would let ordinary
 *   `task:complete` skip the whole lifecycle for every future task;
 * - not `task:set-status`, which would let any state be written to any other;
 * - not `task:start` followed by `task:complete`, which would enter a moment at
 *   which work began that nobody observed, in the name of recording work that
 *   happened outside the record.
 *
 * It is narrower than the lifecycle in every direction: it reaches exactly one
 * status, only from states the lifecycle cannot reach it from, never from a
 * terminal state, always with a mandatory rationale, and only against a plan the
 * operator saw and approved.
 */

import { createHash } from "node:crypto";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import {
  historicalCompletionRefusal,
  isTaskTransitionAllowed,
  normalizeTaskReason,
  type Task,
  type TaskStatus,
} from "@ai-office/domain/task/task.ts";
import { ProjectNotFoundError } from "../errors.ts";
import { TaskNotFoundError } from "./schedule-agent-run.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { TaskRequirementRepository } from "../ports/task-requirement-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { RecordAuditEvent } from "./record-audit-event.ts";
import {
  requirementProgress,
  type RequirementProgress,
} from "./task-requirement-progress.ts";

/** The CLI command that performs this correction. Published so nothing guesses it. */
export const taskCompletionRecordCommand = "task:record-completion" as const;

/** The audit event this correction writes. Never `task.status_changed`. */
export const taskCompletionRecordEventType = "task.completion_recorded" as const;

/**
 * What the proposed change is, if anything.
 *
 * `lifecycle_transition` means the ordinary lifecycle already reaches
 * `completed` from here, so this correction is refused and `task:complete` is
 * named instead. A correction that could stand in for a transition would be a
 * way of avoiding the ordinary record.
 */
export type TaskCompletionRecordKind =
  | "historical_correction"
  | "lifecycle_transition"
  | "none";

/** Read-only description of the correction, its evidence, and its consequence. */
export interface TaskCompletionRecordPlan {
  projectId: string;
  taskId: string;
  title: string;
  /** The task's own persisted status. Never derived from requirements. */
  status: TaskStatus;
  /** Where the task would be left. Always `completed` when available. */
  resultingStatus: TaskStatus;
  kind: TaskCompletionRecordKind;
  /** True when this command may be executed against the state described here. */
  available: boolean;
  /** Why it may not be. Null when `available` is true. */
  refusalReason: string | null;
  /** The command that would apply instead, when one does. */
  suggestedCommand: string | null;
  /**
   * The linked-requirement evidence available to the operator. Reported so an
   * attestation is made in front of the facts — never so the system can infer
   * one from them.
   */
  evidence: RequirementProgress;
  /** The normalized rationale that would be recorded. */
  reason: string;
  /** Always true. Stated in the report so a machine reader need not assume it. */
  rationaleRequired: true;
  /**
   * Covers the task, the exact status it is being corrected from, the rationale,
   * and the evidence shown. Any of them changing invalidates the approval, so an
   * operator can never approve one attestation and execute another.
   */
  planHash: string | null;
}

export interface TaskCompletionRecordResult {
  taskId: string;
  from: TaskStatus;
  to: TaskStatus;
  planHash: string;
  correction: true;
}

export class TaskCompletionApprovalError extends Error {
  constructor() {
    super(
      `Completion record approval does not match the current plan; re-run ${taskCompletionRecordCommand} without --approve and approve the new plan hash`,
    );
    this.name = "TaskCompletionApprovalError";
  }
}

export interface TaskCompletionRecordInput {
  projectId: string;
  taskId: string;
  actorId: string;
  /** Mandatory. Trimmed, non-empty, and length-bounded by the domain. */
  reason: string;
}

export class RecordTaskCompletion {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly links: TaskRequirementRepository,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  /** Preflight. Performs no write of any kind. */
  async plan(input: TaskCompletionRecordInput): Promise<TaskCompletionRecordPlan> {
    return this.buildPlan(input);
  }

  /**
   * Applies the attestation, in one transaction, against the exact plan the
   * operator approved.
   *
   * The plan is rebuilt inside the transaction rather than trusted from the
   * preflight: the hash must be checked against the state actually being
   * mutated, not against a reading taken before the transaction opened.
   */
  async record(
    input: TaskCompletionRecordInput & { approvedPlanHash: string },
  ): Promise<TaskCompletionRecordResult> {
    return this.transactions.run(async () => {
      const { plan, task } = await this.buildPlan(input, { withTask: true });
      if (plan.planHash === null || plan.planHash !== input.approvedPlanHash)
        throw new TaskCompletionApprovalError();
      const from = plan.status;
      const now = this.clock.now();
      // The domain refuses again here. `plan.available` is a report; the
      // aggregate is the authority, and it is the only thing that writes the
      // status.
      task.recordHistoricalCompletion(now);
      await this.tasks.save(task);
      await this.audit.execute({
        eventType: taskCompletionRecordEventType,
        actorType: "cli",
        actorId: input.actorId,
        projectId: plan.projectId,
        aggregateType: "task",
        aggregateId: plan.taskId,
        payload: {
          operation: "record-completion",
          from,
          to: "completed",
          reason: plan.reason,
          // Distinguishes this record from execution for every later reader:
          // no work started here, a fact was entered about work that already
          // happened elsewhere.
          correction: true,
          evidence: { ...plan.evidence },
          planHash: plan.planHash,
        },
      });
      return {
        taskId: plan.taskId,
        from,
        to: "completed" as TaskStatus,
        planHash: plan.planHash,
        correction: true as const,
      };
    });
  }

  private async buildPlan(
    input: TaskCompletionRecordInput,
  ): Promise<TaskCompletionRecordPlan>;
  private async buildPlan(
    input: TaskCompletionRecordInput,
    options: { withTask: true },
  ): Promise<{ plan: TaskCompletionRecordPlan; task: Task }>;
  private async buildPlan(
    input: TaskCompletionRecordInput,
    options?: { withTask: true },
  ): Promise<TaskCompletionRecordPlan | { plan: TaskCompletionRecordPlan; task: Task }> {
    // Validated before anything is read, so a blank attestation costs nothing
    // and can never be half-recorded.
    const reason = normalizeTaskReason(input.reason, "completion record reason");
    if ((await this.projects.findById(input.projectId)) === null)
      throw new ProjectNotFoundError(input.projectId);
    const task = await this.tasks.findById(input.taskId);
    if (task === null || task.snapshot().projectId !== input.projectId)
      throw new TaskNotFoundError(input.taskId);
    const snapshot = task.snapshot();
    const evidence = requirementProgress(
      await this.links.listForTask(input.projectId, input.taskId),
    );
    const refusalReason = historicalCompletionRefusal(snapshot.status);
    const available = refusalReason === null;
    const kind: TaskCompletionRecordKind = available
      ? "historical_correction"
      : isTaskTransitionAllowed(snapshot.status, "completed")
        ? "lifecycle_transition"
        : "none";
    const plan: TaskCompletionRecordPlan = {
      projectId: input.projectId,
      taskId: snapshot.id,
      title: snapshot.title,
      status: snapshot.status,
      resultingStatus: available ? "completed" : snapshot.status,
      kind,
      available,
      refusalReason,
      suggestedCommand: kind === "lifecycle_transition" ? "task:complete" : null,
      evidence,
      reason,
      rationaleRequired: true,
      planHash: available
        ? completionPlanHash({
            projectId: input.projectId,
            taskId: snapshot.id,
            from: snapshot.status,
            reason,
            evidence,
          })
        : null,
    };
    return options === undefined ? plan : { plan, task };
  }
}

function completionPlanHash(value: {
  projectId: string;
  taskId: string;
  from: TaskStatus;
  reason: string;
  evidence: RequirementProgress;
}): string {
  return createHash("sha256")
    .update(
      canonicalStringify({
        kind: "task_completion_record",
        to: "completed",
        ...value,
        evidence: { ...value.evidence },
      }),
      "utf8",
    )
    .digest("hex");
}
