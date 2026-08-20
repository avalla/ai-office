export class AgentClientIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentClientIntegrationError";
  }
}

export class AgentClientPlanConflictError extends AgentClientIntegrationError {
  constructor() {
    super("Agent client integration plan contains unresolved conflicts");
    this.name = "AgentClientPlanConflictError";
  }
}

export class AgentClientPlanApprovalError extends AgentClientIntegrationError {
  constructor() {
    super("Agent client integration approval does not match the current plan");
    this.name = "AgentClientPlanApprovalError";
  }
}
