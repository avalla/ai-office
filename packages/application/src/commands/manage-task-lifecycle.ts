/**
 * Semantic task lifecycle operations.
 *
 * Every operation names an event that happened — the work started, it was
 * blocked, it failed — rather than assigning a status. There is deliberately no
 * `setStatus`: a generic terminal-state write is exactly the escape hatch that
 * lets a board fabricate project history, and the same danger was identified
 * while probing `requirement:set-status`.
 *
 * The domain owns *whether* a transition is legal; this service owns project
 * scoping, transactionality, and the audit record. Neither writes the status
 * column directly.
 *
 * Historical correction of work that happened outside this lifecycle is *not*
 * here. It is a different statement about the project, so it is a different
 * command: see `RecordTaskCompletion`.
 */

import {
  allowedTaskTransitions,
  isTerminalTaskStatus,
  normalizeTaskReason,
  terminalTaskStatuses,
  type Task,
  type TaskStatus,
} from "@ai-office/domain/task/task.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { ProjectNotFoundError } from "../errors.ts";
import { TaskNotFoundError } from "./schedule-agent-run.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { RecordAuditEvent } from "./record-audit-event.ts";

/**
 * The lifecycle operations an operator can invoke, and the CLI command that
 * invokes each one. Introspection publishes this mapping so a caller never has
 * to guess which command performs a transition it was told is allowed.
 */
export const taskLifecycleOperations = {
  start: { command: "task:start", to: "running" },
  "submit-review": { command: "task:submit-review", to: "waiting_review" },
  complete: { command: "task:complete", to: "completed" },
  block: { command: "task:block", to: "blocked" },
  unblock: { command: "task:unblock", to: "pending" },
  fail: { command: "task:fail", to: "failed" },
  cancel: { command: "task:cancel", to: "cancelled" },
} as const satisfies Readonly<
  Record<string, { command: string; to: TaskStatus }>
>;

export type TaskLifecycleOperation = keyof typeof taskLifecycleOperations;

/**
 * The domain call each operation makes. One entry per operation, so an
 * operation named by a batch caller resolves to the same aggregate method a
 * direct command would use rather than to a second hand-written branch.
 */
const lifecycleMutations = {
  start: (task, now) => task.start(now),
  "submit-review": (task, now) => task.submitForReview(now),
  complete: (task, now) => task.complete(now),
  block: (task, now) => task.block(now),
  unblock: (task, now) => task.unblock(now),
  fail: (task, now) => task.fail(now),
  cancel: (task, now) => task.cancel(now),
} as const satisfies Readonly<
  Record<TaskLifecycleOperation, (task: Task, now: Date) => void>
>;

/**
 * Operations whose rationale is mandatory, and those that merely accept one.
 *
 * Enforced here rather than only at the CLI: "mandatory" has to hold for the
 * daemon protocol and for reconciliation too, not just for an operator who
 * typed the option.
 */
const reasonRequiredOperations = new Set<TaskLifecycleOperation>([
  "block",
  "fail",
]);
const reasonAcceptedOperations = new Set<TaskLifecycleOperation>([
  "block",
  "fail",
  "cancel",
]);

/** One transition an operator may perform right now. */
export interface AvailableTaskTransition {
  to: TaskStatus;
  operation: TaskLifecycleOperation;
  command: string;
  terminal: boolean;
}

/** Non-mutating answer to "what can I do with this task?". */
export interface TaskTransitionReport {
  taskId: string;
  projectId: string;
  title: string;
  status: TaskStatus;
  terminal: boolean;
  allowed: readonly AvailableTaskTransition[];
  terminalStatuses: readonly TaskStatus[];
}

const operationsByTarget = new Map<TaskStatus, TaskLifecycleOperation>(
  Object.entries(taskLifecycleOperations).map(
    ([operation, value]) =>
      [value.to, operation as TaskLifecycleOperation] as const,
  ),
);

/** One lifecycle operation, named rather than passed as a callback. */
export interface TaskLifecycleRequest extends TaskCommandInput {
  operation: TaskLifecycleOperation;
  reason?: string;
}

export class ManageTaskLifecycle {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly tasks: TaskRepository,
    private readonly audit: RecordAuditEvent,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  /**
   * Read-only introspection. It performs no write of any kind, so an agent can
   * discover what is possible before deciding whether to act.
   */
  async transitions(input: {
    projectId: string;
    taskId: string;
  }): Promise<TaskTransitionReport> {
    const task = await this.requireTask(input.projectId, input.taskId);
    const snapshot = task.snapshot();
    return {
      taskId: snapshot.id,
      projectId: snapshot.projectId,
      title: snapshot.title,
      status: snapshot.status,
      terminal: isTerminalTaskStatus(snapshot.status),
      allowed: allowedTaskTransitions(snapshot.status).map((to) => {
        const operation = operationsByTarget.get(to)!;
        return {
          to,
          operation,
          command: taskLifecycleOperations[operation].command,
          terminal: isTerminalTaskStatus(to),
        };
      }),
      terminalStatuses: terminalTaskStatuses(),
    };
  }

  async start(input: TaskCommandInput): Promise<TaskStatus> {
    return this.apply({ ...input, operation: "start" });
  }

  async submitForReview(input: TaskCommandInput): Promise<TaskStatus> {
    return this.apply({ ...input, operation: "submit-review" });
  }

  async complete(input: TaskCommandInput): Promise<TaskStatus> {
    return this.apply({ ...input, operation: "complete" });
  }

  /**
   * The reason is recorded on the audit event rather than on the aggregate:
   * `task` has no column for it, and adding one is a schema decision this
   * lifecycle fix does not need.
   */
  async block(
    input: TaskCommandInput & { reason: string },
  ): Promise<TaskStatus> {
    return this.apply({ ...input, operation: "block" });
  }

  async unblock(input: TaskCommandInput): Promise<TaskStatus> {
    return this.apply({ ...input, operation: "unblock" });
  }

  async fail(
    input: TaskCommandInput & { reason: string },
  ): Promise<TaskStatus> {
    return this.apply({ ...input, operation: "fail" });
  }

  async cancel(
    input: TaskCommandInput & { reason?: string },
  ): Promise<TaskStatus> {
    return this.apply({
      ...input,
      operation: "cancel",
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
  }

  /**
   * The same validated mutation, persistence, and audit record as the public
   * commands, without owning a transaction.
   *
   * Transaction ownership is the only thing separated out. A batch caller — one
   * approved reconciliation plan — opens a single transaction and drives several
   * of these, so the whole plan commits or none of it does. It may not open a
   * nested one: `SqliteTransactionRunner` rejects that by design, and a plan
   * that committed one repair at a time would make an approved plan hash
   * describe something the operator never approved.
   *
   * Callers that do not already hold a transaction must use the named commands
   * above instead.
   */
  async applyWithinCurrentTransaction(
    request: TaskLifecycleRequest,
  ): Promise<TaskStatus> {
    return this.perform(request);
  }

  /**
   * One transition, one transaction.
   *
   * The status write and its audit event establish the same state change, so
   * they commit together: an audit trail that can disagree with the state it
   * describes is worse than none. The domain guard runs first and throws
   * `InvalidTaskTransitionError`, which already names the allowed transitions,
   * so nothing is coerced and no invalid write is attempted.
   *
   * Deliberately not idempotent: re-running `task:complete` on a completed task
   * is refused rather than silently accepted. A repeated lifecycle event is
   * either an operator mistake or a stale plan, and both deserve an error.
   */
  private async apply(request: TaskLifecycleRequest): Promise<TaskStatus> {
    return this.transactions.run(() => this.perform(request));
  }

  private async perform(request: TaskLifecycleRequest): Promise<TaskStatus> {
    const { operation } = request;
    const reason = this.resolveReason(operation, request.reason);
    const task = await this.requireTask(request.projectId, request.taskId);
    const from = task.snapshot().status;
    const now = this.clock.now();
    lifecycleMutations[operation](task, now);
    const after = task.snapshot();
    await this.tasks.save(task);
    await this.audit.execute({
      eventType: "task.status_changed",
      actorType: "cli",
      actorId: request.actorId,
      projectId: after.projectId,
      aggregateType: "task",
      aggregateId: after.id,
      payload: {
        operation,
        from,
        to: after.status,
        ...(reason === undefined ? {} : { reason }),
      },
    });
    return after.status;
  }

  /**
   * Validates the rationale before anything is mutated. A mandatory reason that
   * is blank or absurdly long is refused here, so the refusal costs nothing and
   * no partial record survives it.
   */
  private resolveReason(
    operation: TaskLifecycleOperation,
    value: string | undefined,
  ): string | undefined {
    if (value === undefined) {
      if (reasonRequiredOperations.has(operation))
        throw new DomainValidationError(
          `Task ${operation} requires a reason`,
        );
      return undefined;
    }
    if (!reasonAcceptedOperations.has(operation))
      throw new DomainValidationError(
        `Task ${operation} does not accept a reason`,
      );
    return normalizeTaskReason(value, `${operation} reason`);
  }

  private async requireTask(projectId: string, taskId: string): Promise<Task> {
    if ((await this.projects.findById(projectId)) === null)
      throw new ProjectNotFoundError(projectId);
    const task = await this.tasks.findById(taskId);
    // A task of another project must read as absent, never as forbidden: the
    // caller learns nothing about projects it did not name.
    if (task === null || task.snapshot().projectId !== projectId)
      throw new TaskNotFoundError(taskId);
    return task;
  }
}

export interface TaskCommandInput {
  projectId: string;
  taskId: string;
  /** Audit identity of the operator performing the transition. */
  actorId: string;
}
