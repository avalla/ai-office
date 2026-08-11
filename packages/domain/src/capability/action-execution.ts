import { CapabilityValidationError } from "./errors.ts";

export type ActionExecutionStatus =
  | "executing"
  | "completed"
  | "failed"
  | "execution_unknown";

export interface ActionExecutionProps {
  id: string;
  projectId: string;
  actionRequestId: string;
  simulationId: string;
  approvalId: string;
  status: ActionExecutionStatus;
  startedAt: Date;
  completedAt?: Date;
  failureCode?: string;
  resultHash?: string;
}

function validHash(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function normalize(props: ActionExecutionProps): ActionExecutionProps {
  for (const value of [
    props.id,
    props.projectId,
    props.actionRequestId,
    props.simulationId,
    props.approvalId,
  ]) {
    if (value.trim().length === 0 || value.trim() !== value)
      throw new CapabilityValidationError(
        "Action execution identifiers must be canonical and non-empty",
      );
  }
  if (!Number.isFinite(props.startedAt.getTime()))
    throw new CapabilityValidationError("Action execution timestamp is invalid");
  if (props.status === "executing") {
    if (
      props.completedAt !== undefined ||
      props.failureCode !== undefined ||
      props.resultHash !== undefined
    )
      throw new CapabilityValidationError(
        "Executing action cannot have a terminal outcome",
      );
  } else {
    if (
      props.completedAt === undefined ||
      !Number.isFinite(props.completedAt.getTime()) ||
      props.completedAt.getTime() < props.startedAt.getTime()
    )
      throw new CapabilityValidationError(
        "Terminal action execution requires a monotonic timestamp",
      );
    if (
      props.status === "completed" &&
      props.failureCode !== undefined
    )
      throw new CapabilityValidationError(
        "Completed action execution cannot have a failure code",
      );
    if (
      props.status !== "completed" &&
      (props.failureCode === undefined || props.failureCode.trim().length === 0)
    )
      throw new CapabilityValidationError(
        "Failed or unknown execution requires a failure code",
      );
    if (props.resultHash !== undefined && !validHash(props.resultHash))
      throw new CapabilityValidationError("Action execution result hash is invalid");
  }
  return {
    ...props,
    startedAt: new Date(props.startedAt),
    ...(props.completedAt === undefined
      ? {}
      : { completedAt: new Date(props.completedAt) }),
  };
}

export class ActionExecution {
  private constructor(private props: ActionExecutionProps) {}

  static start(
    props: Omit<
      ActionExecutionProps,
      "status" | "startedAt" | "completedAt" | "failureCode" | "resultHash"
    > & { now: Date },
  ): ActionExecution {
    return new ActionExecution(
      normalize({ ...props, status: "executing", startedAt: props.now }),
    );
  }

  static restore(props: ActionExecutionProps): ActionExecution {
    return new ActionExecution(normalize(props));
  }

  complete(now: Date, resultHash?: string): void {
    this.finish("completed", now, undefined, resultHash);
  }

  fail(now: Date, failureCode: string): void {
    this.finish("failed", now, failureCode);
  }

  markUnknown(now: Date, failureCode: string): void {
    this.finish("execution_unknown", now, failureCode);
  }

  private finish(
    status: Exclude<ActionExecutionStatus, "executing">,
    now: Date,
    failureCode?: string,
    resultHash?: string,
  ): void {
    if (this.props.status !== "executing")
      throw new CapabilityValidationError("Action execution is already terminal");
    this.props = normalize({
      ...this.props,
      status,
      completedAt: now,
      ...(failureCode === undefined ? {} : { failureCode }),
      ...(resultHash === undefined ? {} : { resultHash }),
    });
  }

  snapshot(): ActionExecutionProps {
    return {
      ...this.props,
      startedAt: new Date(this.props.startedAt),
      ...(this.props.completedAt === undefined
        ? {}
        : { completedAt: new Date(this.props.completedAt) }),
    };
  }
}
