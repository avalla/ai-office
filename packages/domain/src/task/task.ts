import type { ProjectId } from "../project/project.ts";
import { DomainValidationError, InvalidTaskTransitionError } from "../errors.ts";

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
      ...(input.description === undefined ? {} : { description: input.description }),
      status: "pending",
      priority,
      createdAt: input.now,
      updatedAt: input.now
    });
  }

  static restore(props: TaskProps): Task {
    return new Task(props);
  }

  start(now: Date): void {
    if (this.props.status !== "pending" && this.props.status !== "assigned") {
      throw new InvalidTaskTransitionError(this.props.status, "running");
    }

    this.props = { ...this.props, status: "running", updatedAt: now };
  }

  complete(now: Date): void {
    if (this.props.status !== "running" && this.props.status !== "waiting_review") {
      throw new InvalidTaskTransitionError(this.props.status, "completed");
    }

    this.props = { ...this.props, status: "completed", updatedAt: now };
  }

  snapshot(): TaskProps {
    return {
      ...this.props,
      createdAt: new Date(this.props.createdAt),
      updatedAt: new Date(this.props.updatedAt)
    };
  }
}
