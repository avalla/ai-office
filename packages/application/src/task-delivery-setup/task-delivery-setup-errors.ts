export type TaskDeliverySetupErrorCode =
  | "TASK_DELIVERY_SETUP_UNKNOWN_KEY"
  | "TASK_DELIVERY_SETUP_INVALID_VALUE"
  | "TASK_DELIVERY_SETUP_SCOPE_REF_REQUIRED"
  | "TASK_DELIVERY_SETUP_SCOPE_REF_FORBIDDEN";

/**
 * Typed failure at the task-delivery setup boundary. The code is the entire
 * machine contract; the message is operator-facing and never carries the
 * rejected payload.
 */
export class TaskDeliverySetupError extends Error {
  constructor(
    readonly code: TaskDeliverySetupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskDeliverySetupError";
  }
}
