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
