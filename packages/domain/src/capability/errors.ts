export class CapabilityValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapabilityValidationError";
  }
}

export class InvalidCapabilityConstraintsError extends CapabilityValidationError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCapabilityConstraintsError";
  }
}

export class UnsupportedConnectorProviderError extends CapabilityValidationError {
  constructor(readonly provider: string) {
    super(`Unsupported connector provider: ${provider}`);
    this.name = "UnsupportedConnectorProviderError";
  }
}

export class UnsupportedConnectorResourceTypeError extends CapabilityValidationError {
  constructor(
    readonly provider: string,
    readonly resourceType: string,
  ) {
    super(
      `Resource type ${resourceType} is not supported by connector ${provider}`,
    );
    this.name = "UnsupportedConnectorResourceTypeError";
  }
}

export class CanonicalSerializationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`Cannot canonicalize ${path}: ${message}`);
    this.name = "CanonicalSerializationError";
  }
}

export class InvalidActionTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Cannot transition action request from ${from} to ${to}`);
    this.name = "InvalidActionTransitionError";
  }
}

export class InvalidActionTimestampError extends Error {
  constructor() {
    super("Action request transition time must be valid and monotonic");
    this.name = "InvalidActionTimestampError";
  }
}
