export class DomainValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainValidationError";
  }
}

export class InvalidTaskTransitionError extends Error {
  constructor(from: string, to: string) {
    super(`Cannot transition task from ${from} to ${to}`);
    this.name = "InvalidTaskTransitionError";
  }
}
