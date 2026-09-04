import type { ProjectId } from "../project/project.ts";
import {
  DomainValidationError,
  InvalidTaskTransitionError,
} from "../errors.ts";

export type TaskId = string;
export type TaskStatus =
  | "pending"
  | "assigned"
  | "running"
  | "blocked"
  | "waiting_review"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * The task lifecycle, declared once.
 *
 * This mirrors `governanceTransitions`: the table is the single definition of
 * what may happen, the guards below read it, and introspection publishes it. A
 * second hand-written `if` chain would be a second definition that could drift.
 *
 * `assigned` deliberately has no transition into it. The `Task` aggregate holds
 * no assignee, so "assigned" could not name who it is assigned to; it survives
 * as a status a restored archive may carry, and `start` still accepts it.
 */
const taskTransitions = {
  pending: ["running", "blocked", "cancelled"],
  assigned: ["running", "blocked", "cancelled"],
  running: [
    "waiting_review",
    "completed",
    "blocked",
    "failed",
    "cancelled",
  ],
  blocked: ["pending", "failed", "cancelled"],
  waiting_review: ["completed", "blocked", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
} as const satisfies Readonly<Record<TaskStatus, readonly TaskStatus[]>>;

/**
 * States no transition leaves. A board that could reverse one could fabricate
 * project history, so this is an invariant rather than a policy.
 */
const terminalStatuses = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return terminalStatuses.has(status);
}

export function terminalTaskStatuses(): readonly TaskStatus[] {
  return ["completed", "failed", "cancelled"];
}

export function allowedTaskTransitions(
  from: TaskStatus,
): readonly TaskStatus[] {
  return taskTransitions[from];
}

export function isTaskTransitionAllowed(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return (taskTransitions[from] as readonly TaskStatus[]).includes(to);
}

export interface TaskProps {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Task {
  private constructor(private props: TaskProps) {}

  static create(input: {
    id: TaskId;
    projectId: ProjectId;
    title: string;
    description?: string;
    priority?: number;
    now: Date;
  }): Task {
    const title = input.title.trim();

    if (title.length === 0) {
      throw new DomainValidationError("Task title cannot be empty");
    }

    const priority = input.priority ?? 0;

    if (!Number.isSafeInteger(priority)) {
      throw new DomainValidationError("Task priority must be a safe integer");
    }

    return new Task({
      id: input.id,
      projectId: input.projectId,
      title,
      ...(input.description === undefined
        ? {}
        : { description: input.description }),
      status: "pending",
      priority,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: TaskProps): Task {
    return new Task(props);
  }

  /** Work has begun. Driven by `pipeline:start` and by `task:start`. */
  start(now: Date): void {
    this.transition("running", now);
  }

  /** Work is finished and needs a decision before it can be completed. */
  submitForReview(now: Date): void {
    this.transition("waiting_review", now);
  }

  /** Work is done. Driven by a terminal pipeline and by `task:complete`. */
  complete(now: Date): void {
    this.transition("completed", now);
  }

  /**
   * Work is stopped by something outside the task. The reason is not stored on
   * the aggregate — there is no column for it — it is recorded on the audit
   * event that accompanies the transition.
   */
  block(now: Date): void {
    this.transition("blocked", now);
  }

  /**
   * The obstacle is gone. Returns to `pending` rather than to whatever preceded
   * the block: the aggregate keeps no previous status, and guessing one would
   * invent history. `start` moves it on from there.
   */
  unblock(now: Date): void {
    this.transition("pending", now);
  }

  /**
   * The work was attempted and did not succeed. Reachable only once work has
   * begun; a task that never started is cancelled, not failed.
   */
  fail(now: Date): void {
    this.transition("failed", now);
  }

  /** The work will not be done. Allowed from any non-terminal status. */
  cancel(now: Date): void {
    this.transition("cancelled", now);
  }

  private transition(to: TaskStatus, now: Date): void {
    if (!isTaskTransitionAllowed(this.props.status, to))
      throw new InvalidTaskTransitionError(
        this.props.status,
        to,
        allowedTaskTransitions(this.props.status),
      );
    this.props = { ...this.props, status: to, updatedAt: now };
  }

  snapshot(): TaskProps {
    return {
      ...this.props,
      createdAt: new Date(this.props.createdAt),
      updatedAt: new Date(this.props.updatedAt),
    };
  }
}
