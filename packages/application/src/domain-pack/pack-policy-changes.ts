import { canonicalizeJcsJson } from "../../../domain-pack-contracts/src/jcs.ts";
import { policyClauses, type PolicyClauses } from "./pack-policy-clauses.ts";
import type { ResolvedPackManifest } from "./resolve-installed-pack-manifests.ts";
import { stablePackDefinitionId } from "./resolve-project-configuration.ts";

/**
 * The policy a resolved closure declares for one workflow (GP-25): stable
 * identities and clause values, never a title or a description.
 */
export interface WorkflowPolicy extends PolicyClauses {
  readonly policyId: string;
  readonly workflowId: string;
}

/**
 * A workflow whose policy differs between two resolved closures. `before` is
 * absent when the first closure declares no policy for the workflow, `after`
 * when the second declares none.
 */
export interface WorkflowPolicyDifference {
  readonly workflowId: string;
  readonly change: "added" | "removed" | "changed";
  readonly before?: WorkflowPolicy;
  readonly after?: WorkflowPolicy;
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

/** Stable IDs of every workflow a closure provides, governed or not. */
export function closureWorkflowIds(
  closure: readonly ResolvedPackManifest[],
): Set<string> {
  return new Set(
    closure.flatMap(({ identity, manifest }) =>
      manifest.contributions.workflows.map((workflow) =>
        stablePackDefinitionId(identity.id, "workflows", workflow.id),
      ),
    ),
  );
}

/**
 * Every typed policy of one closure, by stable workflow ID. A policy without
 * a target workflow has no clause to report; GP-06 rejects its pack.
 */
export function closureWorkflowPolicies(
  closure: readonly ResolvedPackManifest[],
): WorkflowPolicy[] {
  return closure
    .flatMap(({ identity, manifest }) =>
      manifest.contributions.policies.flatMap((policy) =>
        policy.workflow === undefined
          ? []
          : [
              {
                policyId: stablePackDefinitionId(
                  identity.id,
                  "policies",
                  policy.id,
                ),
                workflowId: stablePackDefinitionId(
                  identity.id,
                  "workflows",
                  policy.workflow,
                ),
                ...policyClauses(policy),
              },
            ],
      ),
    )
    .sort((left, right) => compare(left.workflowId, right.workflowId));
}

/**
 * Every workflow whose policy differs between `before` and `after`: its
 * identity, its enforcement or any stage clause. Presentation is not compared.
 * The one computation behind the upgrade plan and the pack binding guard.
 */
export function workflowPolicyDifferences(
  before: readonly ResolvedPackManifest[],
  after: readonly ResolvedPackManifest[],
): WorkflowPolicyDifference[] {
  const byWorkflow = (closure: readonly ResolvedPackManifest[]) =>
    new Map(
      closureWorkflowPolicies(closure).map((policy) => [
        policy.workflowId,
        policy,
      ]),
    );
  const old = byWorkflow(before);
  const next = byWorkflow(after);
  const differences: WorkflowPolicyDifference[] = [];
  for (const workflowId of new Set([...old.keys(), ...next.keys()])) {
    const previous = old.get(workflowId);
    const current = next.get(workflowId);
    if (previous === undefined && current !== undefined)
      differences.push({ workflowId, change: "added", after: current });
    else if (previous !== undefined && current === undefined)
      differences.push({ workflowId, change: "removed", before: previous });
    else if (
      previous !== undefined &&
      current !== undefined &&
      canonicalizeJcsJson(previous as never) !==
        canonicalizeJcsJson(current as never)
    )
      differences.push({
        workflowId,
        change: "changed",
        before: previous,
        after: current,
      });
  }
  return differences.sort((left, right) =>
    compare(left.workflowId, right.workflowId),
  );
}
