export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

/**
 * A task transition the lifecycle does not allow.
 *
 * Carries the transitions that *are* allowed from the current status, so a
 * caller can tell an operator what to do next without re-deriving the table.
 * An empty `allowed` means the status is terminal.
 */
export class InvalidTaskTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly allowed: readonly string[] = [],
  ) {
    super(
      allowed.length === 0
        ? `Cannot transition task from ${from} to ${to}: ${from} is terminal`
        : `Cannot transition task from ${from} to ${to}. Allowed from ${from}: ${allowed.join(", ")}`,
    );
    this.name = "InvalidTaskTransitionError";
  }
}

/**
 * A historical correction the task's current state cannot carry.
 *
 * Correction is not lifecycle progression, so it does not reuse
 * `InvalidTaskTransitionError`: the allowed-transitions list that error carries
 * would point an operator at the ordinary commands, which are exactly what the
 * correction exists to avoid.
 */
export class InvalidTaskCorrectionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly detail: string,
  ) {
    super(`Cannot record ${to} for a task that is ${from}: ${detail}`);
    this.name = "InvalidTaskCorrectionError";
  }
}
