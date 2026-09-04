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
 */

import {
  allowedTaskTransitions,
  isTerminalTaskStatus,
  terminalTaskStatuses,
  type Task,
  type TaskStatus,
} from "@ai-office/domain/task/task.ts";
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
    return this.apply(input, "start", (task, now) => task.start(now));
  }

  async submitForReview(input: TaskCommandInput): Promise<TaskStatus> {
    return this.apply(input, "submit-review", (task, now) =>
      task.submitForReview(now),
    );
  }

  async complete(input: TaskCommandInput): Promise<TaskStatus> {
    return this.apply(input, "complete", (task, now) => task.complete(now));
  }

  /**
   * The reason is recorded on the audit event rather than on the aggregate:
   * `task` has no column for it, and adding one is a schema decision this
   * lifecycle fix does not need.
   */
  async block(
    input: TaskCommandInput & { reason: string },
  ): Promise<TaskStatus> {
    return this.apply(
      input,
      "block",
      (task, now) => task.block(now),
      { reason: input.reason },
    );
  }

  async unblock(input: TaskCommandInput): Promise<TaskStatus> {
    return this.apply(input, "unblock", (task, now) => task.unblock(now));
  }

  async fail(
    input: TaskCommandInput & { reason: string },
  ): Promise<TaskStatus> {
    return this.apply(
      input,
      "fail",
      (task, now) => task.fail(now),
      { reason: input.reason },
    );
  }

  async cancel(
    input: TaskCommandInput & { reason?: string },
  ): Promise<TaskStatus> {
    return this.apply(
      input,
      "cancel",
      (task, now) => task.cancel(now),
      input.reason === undefined ? {} : { reason: input.reason },
    );
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
  private async apply(
    input: TaskCommandInput,
    operation: TaskLifecycleOperation,
    mutate: (task: Task, now: Date) => void,
    payload: Readonly<Record<string, unknown>> = {},
  ): Promise<TaskStatus> {
    const task = await this.requireTask(input.projectId, input.taskId);
    const from = task.snapshot().status;
    const now = this.clock.now();
    mutate(task, now);
    const after = task.snapshot();
    await this.transactions.run(async () => {
      await this.tasks.save(task);
      await this.audit.execute({
        eventType: "task.status_changed",
        actorType: "cli",
        actorId: input.actorId,
        projectId: after.projectId,
        aggregateType: "task",
        aggregateId: after.id,
        payload: { operation, from, to: after.status, ...payload },
      });
    });
    return after.status;
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
