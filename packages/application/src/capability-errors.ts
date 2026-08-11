export class ResourceNotFoundError extends Error {
  constructor(id: string) {
    super(`Resource not found: ${id}`);
    this.name = "ResourceNotFoundError";
  }
}

export class ResourceDisabledError extends Error {
  constructor(id: string) {
    super(`Resource is already disabled: ${id}`);
    this.name = "ResourceDisabledError";
  }
}

export class CapabilityGrantNotFoundError extends Error {
  constructor(id: string) {
    super(`Capability grant not found: ${id}`);
    this.name = "CapabilityGrantNotFoundError";
  }
}

export class CapabilityGrantRevokedError extends Error {
  constructor(id: string) {
    super(`Capability grant is already revoked: ${id}`);
    this.name = "CapabilityGrantRevokedError";
  }
}

export class CapabilityPrincipalNotFoundError extends Error {
  constructor(type: string, id: string) {
    super(`Capability principal not found in project: ${type}:${id}`);
    this.name = "CapabilityPrincipalNotFoundError";
  }
}

export class ActionRequestNotFoundError extends Error {
  constructor(id: string) {
    super(`Action request not found: ${id}`);
    this.name = "ActionRequestNotFoundError";
  }
}

export class CapabilityProjectMismatchError extends Error {
  constructor() {
    super("Capability reference belongs to a different project");
    this.name = "CapabilityProjectMismatchError";
  }
}

export class ConcurrentActionTransitionError extends Error {
  constructor(id: string, from: string, to: string) {
    super(
      `Action request ${id} no longer has expected status ${from}; cannot transition to ${to}`,
    );
    this.name = "ConcurrentActionTransitionError";
  }
}

export class ActionSimulationConflictError extends Error {
  constructor(id: string) {
    super(`Action request already has a simulation: ${id}`);
    this.name = "ActionSimulationConflictError";
  }
}

export class InvalidConnectorInvocationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidConnectorInvocationStateError";
  }
}

export class StaleActionAuthorizationError extends Error {
  constructor() {
    super("Action authorization is no longer current");
    this.name = "StaleActionAuthorizationError";
  }
}
