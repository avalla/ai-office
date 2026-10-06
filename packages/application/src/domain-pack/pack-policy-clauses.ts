import type { PolicyContribution } from "../../../domain-pack-contracts/src/index.ts";

/**
 * The one code for a workflow that no longer carries what its pack policy
 * governs (GP-25): reported before a definition mutation or a restore is
 * accepted, and by GP-06 resolution for state that arrived otherwise.
 */
export const policyTargetMissing = "policy_target_missing" as const;

/**
 * The clauses of one governed stage with every fact stated: a flag the policy
 * does not declare is `false` and a list it does not declare is empty. An
 * empty `operations` list means that no operation is admitted on the stage.
 */
export interface PolicyStageClauses {
  readonly stage: string;
  readonly requiresApproval: boolean;
  readonly requiresIndependentApproval: boolean;
  readonly requiresDifferentAgentFrom: readonly string[];
  readonly operations: readonly string[];
}

export interface PolicyClauses {
  readonly enforcement: "enforced" | "guidance";
  readonly stages: readonly PolicyStageClauses[];
}

/** The declared clauses of a typed policy, in the manifest's stage order. */
export function policyClauses(policy: PolicyContribution): PolicyClauses {
  return {
    enforcement: policy.enforcement ?? "guidance",
    stages: (policy.stages ?? []).map((clause) => ({
      stage: clause.stage,
      requiresApproval: clause.requiresApproval === true,
      requiresIndependentApproval: clause.requiresIndependentApproval === true,
      requiresDifferentAgentFrom: [
        ...(clause.requiresDifferentAgentFrom ?? []),
      ],
      operations: [...(clause.operations ?? [])],
    })),
  };
}

/** What a workflow's stage list lacks that its policy governs. */
export type PolicyTargetViolation =
  | { readonly kind: "stage_missing"; readonly stage: string }
  | {
      readonly kind: "separation_order";
      readonly stage: string;
      readonly predecessor: string;
    };

/**
 * A pack policy is mandatory: the workflow it targets must keep every stage
 * the policy names, as a governed stage or as a separation predecessor, and
 * every predecessor must stay earlier than the stage that names it. Returns
 * each violation of `stageIds`, the workflow's stage IDs in its own order,
 * once and in the policy's stage order. The one computation behind GP-06
 * resolution, the definition pre-store check and the restore preflight.
 */
export function policyTargetViolations(
  policy: PolicyContribution,
  stageIds: readonly string[],
): PolicyTargetViolation[] {
  const violations: PolicyTargetViolation[] = [];
  const missing = new Set<string>();
  const lacks = (stage: string): boolean => {
    if (stageIds.includes(stage)) return false;
    if (!missing.has(stage)) {
      missing.add(stage);
      violations.push({ kind: "stage_missing", stage });
    }
    return true;
  };
  for (const clause of policy.stages ?? []) {
    const absent = lacks(clause.stage);
    for (const predecessor of clause.requiresDifferentAgentFrom ?? []) {
      if (lacks(predecessor) || absent) continue;
      if (stageIds.indexOf(predecessor) >= stageIds.indexOf(clause.stage))
        violations.push({
          kind: "separation_order",
          stage: clause.stage,
          predecessor,
        });
    }
  }
  return violations;
}
