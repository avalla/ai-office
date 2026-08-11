import type {
  CapabilityGrant,
  ConnectorPolicyRegistry,
  PolicyDecision,
  PolicyInput,
  RiskLevel,
} from "./capability.ts";
import { canonicalStringify } from "./canonical-json.ts";

function denied(
  reason: string,
  riskLevel: RiskLevel = "critical",
): PolicyDecision {
  return {
    decision: "deny",
    riskLevel,
    matchedGrantIds: [],
    effectiveConstraints: {},
    reasons: [reason],
  };
}

function isPrincipalMatch(grant: CapabilityGrant, input: PolicyInput): boolean {
  return grant.principalType === "agent"
    ? grant.principalId === input.agentId
    : grant.principalType === "role" &&
        input.roleIds.includes(grant.principalId);
}

function actionMatches(
  action: string,
  operation: string,
  risk: RiskLevel,
): boolean {
  if (action === operation) return true;
  if (risk === "critical") return false;
  if (!action.endsWith(".*") || action.indexOf("*") !== action.length - 1)
    return false;
  return (
    operation.startsWith(action.slice(0, -1)) &&
    operation.length > action.length - 1
  );
}

export class PolicyEngine {
  constructor(private readonly registry: ConnectorPolicyRegistry) {}

  evaluate(input: PolicyInput, evaluatedAt: Date): PolicyDecision {
    if (input.projectId !== input.resource.projectId)
      return denied("resource belongs to a different project");
    if (input.resource.status === "disabled")
      return denied("resource is disabled");
    const definition = this.registry.getPolicyDefinition(
      input.resource.provider,
    );
    if (definition === null)
      return denied(`unsupported connector: ${input.resource.provider}`);
    const connector = definition.descriptor;
    if (!connector.supportedResourceTypes.includes(input.resource.type))
      return denied(
        `resource type ${input.resource.type} is not supported by connector ${connector.id}`,
      );
    const descriptor = connector.operations.find(
      (candidate) => candidate.operation === input.operation,
    );
    if (descriptor === undefined)
      return denied(`unsupported operation: ${input.operation}`);
    const riskLevel = descriptor.riskLevel;
    if (!Number.isFinite(evaluatedAt.getTime()))
      return denied("policy evaluation time is invalid", riskLevel);
    try {
      canonicalStringify(input.arguments);
    } catch {
      return denied(
        "action arguments are not canonically serializable",
        riskLevel,
      );
    }

    const matching = input.grants.filter((grant) => {
      if (
        grant.projectId !== input.projectId ||
        grant.resourceId !== input.resource.id
      )
        return false;
      if (!isPrincipalMatch(grant, input)) return false;
      if (
        !Number.isFinite(grant.validFrom.getTime()) ||
        (grant.expiresAt !== undefined &&
          !Number.isFinite(grant.expiresAt.getTime()))
      )
        return false;
      if (
        grant.revokedAt !== undefined ||
        grant.validFrom.getTime() > evaluatedAt.getTime()
      )
        return false;
      if (
        grant.expiresAt !== undefined &&
        grant.expiresAt.getTime() <= evaluatedAt.getTime()
      )
        return false;
      return grant.actions.some((action) =>
        actionMatches(action, input.operation, riskLevel),
      );
    });
    if (matching.length === 0)
      return denied("no valid grant permits the operation", riskLevel);

    const constraintResult = definition.constraintHandler.combineAndValidate(
      input.operation,
      input.arguments,
      matching.map((grant) => grant.constraints),
      input.resource.configuration,
    );
    const matchedGrantIds = matching.map((grant) => grant.id).sort();
    if (!constraintResult.ok) {
      return {
        decision: "deny",
        riskLevel,
        matchedGrantIds,
        effectiveConstraints: constraintResult.effectiveConstraints,
        reasons: constraintResult.reasons,
      };
    }

    const decision = descriptor.requiresApproval
      ? "allow_with_approval"
      : descriptor.supportsSimulation && descriptor.mode === "mutation"
        ? "allow_simulation_only"
        : "allow";
    return {
      decision,
      riskLevel,
      matchedGrantIds,
      effectiveConstraints: constraintResult.effectiveConstraints,
      reasons: [
        `operation risk is ${riskLevel}`,
        ...(decision === "allow_simulation_only"
          ? ["simulation is required"]
          : []),
        ...(decision === "allow_with_approval" ? ["approval is required"] : []),
      ],
    };
  }
}
