export type ResourceType =
  | "filesystem_scope"
  | "github_repository"
  | "sqlite_database"
  | "shell_environment";

export type ResourceStatus = "active" | "disabled";

export interface Resource {
  id: string;
  projectId: string;
  type: ResourceType;
  provider: string;
  externalRef?: string;
  displayName: string;
  configuration: Readonly<Record<string, unknown>>;
  credentialRef?: string;
  status: ResourceStatus;
  createdAt: Date;
  updatedAt: Date;
}

export type CapabilityPrincipalType =
  "user" | "agent" | "role" | "workflow" | "application";

export interface CapabilityGrant {
  id: string;
  projectId: string;
  principalType: CapabilityPrincipalType;
  principalId: string;
  resourceId: string;
  actions: readonly string[];
  constraints: Readonly<Record<string, unknown>>;
  validFrom: Date;
  expiresAt?: Date;
  revokedAt?: Date;
  grantedBy: string;
  reason: string;
  createdAt: Date;
}

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type PolicyDecisionKind =
  "allow" | "deny" | "allow_with_approval" | "allow_simulation_only";

export interface PolicyInput {
  projectId: string;
  agentId: string;
  roleIds: readonly string[];
  resource: Resource;
  operation: string;
  arguments: Readonly<Record<string, unknown>>;
  grants: readonly CapabilityGrant[];
}

export interface PolicyDecision {
  decision: PolicyDecisionKind;
  riskLevel: RiskLevel;
  matchedGrantIds: readonly string[];
  effectiveConstraints: Readonly<Record<string, unknown>>;
  reasons: readonly string[];
}

export interface FakeConnectorConstraints {
  allowedTargets?: readonly string[];
  deniedTargets?: readonly string[];
  maxPayloadBytes?: number;
  allowMutation?: boolean;
}

export interface ConnectorConstraintResult {
  ok: boolean;
  effectiveConstraints: Readonly<Record<string, unknown>>;
  reasons: readonly string[];
}

export type ConnectorConstraintEvaluator = (
  this: void,
  operation: string,
  arguments_: Readonly<Record<string, unknown>>,
  constraints: readonly Readonly<Record<string, unknown>>[],
  resourceConfiguration: Readonly<Record<string, unknown>>,
) => ConnectorConstraintResult;

export interface ConnectorConstraintHandler {
  readonly connector: string;
  readonly combineAndValidate: ConnectorConstraintEvaluator;
}

export interface PolicyOperationDescriptor {
  operation: string;
  mode: "read" | "mutation";
  riskLevel: RiskLevel;
  supportsSimulation: boolean;
  supportsExecution: boolean;
  requiresApproval: boolean;
}

export interface PolicyConnectorDescriptor {
  id: string;
  version: string;
  supportedResourceTypes: readonly ResourceType[];
  operations: readonly PolicyOperationDescriptor[];
}

export interface ConnectorPolicyDefinition {
  descriptor: PolicyConnectorDescriptor;
  constraintHandler: ConnectorConstraintHandler;
}

export interface ConnectorPolicyRegistry {
  getPolicyDefinition(provider: string): ConnectorPolicyDefinition | null;
}
