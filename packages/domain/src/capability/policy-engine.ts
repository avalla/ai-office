import type {
  CapabilityGrant,
  ConnectorConstraintHandler,
  PolicyDecision,
  PolicyInput,
  RiskLevel,
} from "./capability.ts";
import { fakeConnectorDescriptor } from "./capability.ts";
import { canonicalStringify } from "./canonical-json.ts";
import { FakeConnectorConstraintHandler } from "./fake-connector-policy.ts";

const riskOrder: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

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
  private readonly handlers: ReadonlyMap<string, ConnectorConstraintHandler>;

  constructor(
    handlers: readonly ConnectorConstraintHandler[] = [
      new FakeConnectorConstraintHandler(),
    ],
  ) {
    this.handlers = new Map(
      handlers.map((handler) => [handler.connector, handler]),
    );
  }

  evaluate(input: PolicyInput, evaluatedAt: Date): PolicyDecision {
    if (input.projectId !== input.resource.projectId)
      return denied("resource belongs to a different project");
    if (input.resource.status === "disabled")
      return denied("resource is disabled");
    if (input.resource.provider !== fakeConnectorDescriptor.id)
      return denied(`unsupported connector: ${input.resource.provider}`);
    const descriptor = fakeConnectorDescriptor.operations.find(
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

    const handler = this.handlers.get(input.resource.provider);
    if (handler === undefined)
      return denied("connector has no constraint handler", riskLevel);
    const constraintResult = handler.combineAndValidate(
      input.operation,
      input.arguments,
      matching.map((grant) => grant.constraints),
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

    const decision =
      riskOrder[riskLevel] >= riskOrder.critical
        ? "allow_with_approval"
        : riskOrder[riskLevel] >= riskOrder.high
          ? "allow_with_approval"
          : riskOrder[riskLevel] >= riskOrder.medium
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
