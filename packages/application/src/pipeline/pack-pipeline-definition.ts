import type {
  OfficePipeline,
  OfficePipelineStage,
} from "@ai-office/domain/office/office-manifest.ts";
import { PackPipelineUnsupportedError } from "../pipeline-errors.ts";
import type {
  ResolvedPolicy,
  ResolvedProjectConfiguration,
  ResolvedWorkflow,
} from "../domain-pack/resolve-project-configuration.ts";

/**
 * M16.5 Runtime activation: the pack-owned or project-owned definition of a
 * resolved workflow, expressed as the enforced pipeline a run freezes.
 *
 * The mapping is pure and adds no authority. Approval, independent approval,
 * separation of agents and stage operations come only from the workflow's
 * active pack policy (GP-25); a stage the policy does not name is ungoverned.
 * A workflow without an active enforced policy maps to a guidance pipeline,
 * which `pipeline:start` refuses exactly as it refuses a guidance manifest
 * pipeline.
 */

/** The ID after the last `/` of a stable definition ID (`pack:id/kind/local`). */
export function localDefinitionId(stableId: string): string {
  return stableId.slice(stableId.lastIndexOf("/") + 1);
}

/**
 * Whether a workflow may start a run. A project-owned workflow always may. A
 * pack-owned workflow may only when its pack is one the project selected: a
 * pack that is merely resolved as a dependency of a selected pack contributes
 * definitions but is never startable, with or without `--source pack`.
 */
function isStartable(
  configuration: ResolvedProjectConfiguration,
  workflow: ResolvedWorkflow,
): boolean {
  if (workflow.origin !== "pack_owned") return true;
  const owner = /^pack:([^/]+)\//.exec(workflow.workflowId)?.[1];
  // A pack-owned workflow whose owner cannot be read fails closed.
  if (owner === undefined) return false;
  return configuration.selectedPacks.some((pack) => pack.id === owner);
}

function workflowsWithLocalId(
  configuration: ResolvedProjectConfiguration,
  localId: string,
): ResolvedWorkflow[] {
  return configuration.workflows.filter(
    (workflow) => localDefinitionId(workflow.workflowId) === localId,
  );
}

/**
 * The startable resolved workflow whose local ID is `localId`, or
 * `undefined`. Two startable workflows sharing a local ID cannot be told
 * apart by a pipeline ID, so the lookup refuses rather than choosing one.
 */
export function findPackWorkflow(
  configuration: ResolvedProjectConfiguration,
  localId: string,
): ResolvedWorkflow | undefined {
  const matches = workflowsWithLocalId(configuration, localId).filter(
    (workflow) => isStartable(configuration, workflow),
  );
  if (matches.length > 1)
    throw new PackPipelineUnsupportedError(
      localId,
      "more than one resolved workflow has this local ID (a manifest pipeline can still be started with --source manifest)",
    );
  return matches[0];
}

/** True when only a dependency pack's workflow carries this local ID. */
export function isDependencyOnlyWorkflow(
  configuration: ResolvedProjectConfiguration,
  localId: string,
): boolean {
  const matches = workflowsWithLocalId(configuration, localId);
  return (
    matches.length > 0 &&
    matches.every((workflow) => !isStartable(configuration, workflow))
  );
}

function activePolicy(
  configuration: ResolvedProjectConfiguration,
  workflow: ResolvedWorkflow,
): ResolvedPolicy | undefined {
  const policies = configuration.policies.filter(
    (policy) =>
      policy.workflowId === workflow.workflowId && policy.state === "active",
  );
  if (policies.length > 1)
    throw new PackPipelineUnsupportedError(
      localDefinitionId(workflow.workflowId),
      "more than one active policy governs it",
    );
  return policies[0];
}

export function packWorkflowPipeline(
  configuration: ResolvedProjectConfiguration,
  workflow: ResolvedWorkflow,
): OfficePipeline {
  const id = localDefinitionId(workflow.workflowId);
  const policy = activePolicy(configuration, workflow);
  const clauses = new Map(
    (policy?.stages ?? []).map((clause) => [clause.stage, clause]),
  );
  const stages: OfficePipelineStage[] = workflow.stages.map((stage) => {
    const clause = clauses.get(stage.id);
    return {
      id: stage.id,
      name: stage.title ?? stage.id,
      roleId: localDefinitionId(stage.roleId),
      objective: stage.objective ?? "",
      checks: [...(stage.checks ?? [])],
      requiresApproval: clause?.requiresApproval ?? false,
      requiresIndependentApproval: clause?.requiresIndependentApproval ?? false,
      capabilities: [...(clause?.operations ?? [])],
      requiresDifferentAgentFrom: [
        ...(clause?.requiresDifferentAgentFrom ?? []),
      ],
    };
  });
  return {
    id,
    name: workflow.title ?? id,
    description: workflow.description ?? "",
    defaultFor: [
      workflow.taskTypeId,
      ...(workflow.additionalTaskTypeIds ?? []),
    ].map(localDefinitionId),
    enforcement: policy?.enforcement === "enforced" ? "enforced" : "guidance",
    stages,
  };
}
