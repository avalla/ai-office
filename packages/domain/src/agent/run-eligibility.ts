import type { TaskStatus } from "../task/task.ts";
import { DomainValidationError } from "../errors.ts";

export function isTaskRunnable(status: TaskStatus): boolean {
  return (
    status === "pending" ||
    status === "assigned" ||
    status === "running" ||
    status === "waiting_review"
  );
}

export class TaskNotRunnableError extends DomainValidationError {
  constructor() {
    super("Task is blocked or terminal; no agent work may be admitted");
  }
}
