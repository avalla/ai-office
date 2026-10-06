import { createHash } from "node:crypto";
import {
  contributionKinds,
  type Contribution,
  type ContributionKind,
  type DomainPackManifest,
  type PolicyContribution,
  type WorkflowContribution,
} from "../../../domain-pack-contracts/src/index.ts";
import { canonicalizeJcsJson } from "../../../domain-pack-contracts/src/jcs.ts";
import {
  DomainPackCatalogError,
  type InstalledDomainPackCatalog,
  type PackIdentity,
} from "../ports/installed-domain-pack-catalog.port.ts";
import {
  noOperationProviders,
  type OperationProviderCatalog,
} from "../ports/operation-provider-catalog.port.ts";
import type { ProjectPackBinding } from "../ports/project-pack-binding-repository.port.ts";
import {
  bindCapabilityContracts,
  type ResolvedCapability,
} from "./capability-contracts.ts";
import {
  compareExactSources,
  compareOwnedDefinitions,
  parseDefinitionMutation,
  ProjectDefinitionConflictError,
  projectOwnedKinds,
  type AgentDefinition,
  type DescriptiveDefinition,
  type ExactPackDefinitionSource,
  type OverrideOperation,
  type OverridePayload,
  type ProjectDefinitionOverride,
  type ProjectDefinitionPayload,
  type ProjectDefinitionState,
  type ProjectOwnedDefinition,
} from "./project-definition.ts";
import {
  policyClauses,
  policyTargetMissing,
  policyTargetViolations,
  type PolicyClauses,
} from "./pack-policy-clauses.ts";
import {
  CapturedPackManifestError,
  resolveInstalledPackManifests,
  type ResolvedPackManifest,
} from "./resolve-installed-pack-manifests.ts";

export const configurationFormatVersion = 1 as const;

export type ConfigurationIssueCode =
  | "pack_unavailable"
  | "pack_dependency_failure"
  | "binding_source_mismatch"
  | "unresolved_override"
  | "duplicate_effective_definition"
  | "missing_workflow_reference"
  | "missing_agent_reference"
  | "ambiguous_reference"
  | "disabled_required_definition"
  | "agent_capability_exceeds_role"
  | "unsupported_security_composition"
  | typeof policyTargetMissing
  | "missing_required_capability_provider"
  | "capability_provider_mismatch"
  | "configuration_invariant"
  | "stale_resolution";

export class ProjectConfigurationResolutionError extends Error {
  constructor(
    readonly code: ConfigurationIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectConfigurationResolutionError";
  }
}

/** A pack role keeps the capability references its manifest declares. */
export interface ResolvedPackRolePayload extends DescriptiveDefinition {
  readonly capabilities?: readonly string[];
}

export interface ResolvedDefinition {
  readonly effectiveId: string;
  readonly kind: ContributionKind;
  readonly localId: string;
  readonly enabled: boolean;
  readonly payload: ProjectDefinitionPayload | ResolvedPackRolePayload;
}

/**
 * The declarative contract of one enabled role. `roleId` is the stable slot
 * identity: it carries no pack version, digest or presentation, so it survives
 * rename, replacement and pack upgrade. Capabilities are stable capability
 * IDs owned by the selected pack version; they grant nothing.
 */
export interface ResolvedRole {
  readonly roleId: string;
  readonly effectiveId: string;
  readonly origin: "pack_owned" | "project_owned";
  readonly title?: string;
  readonly description?: string;
  readonly capabilities: readonly string[];
  readonly customization: "none" | "replace" | "extend";
}

/**
 * The declarative contract of one enabled agent. `agentId` is the stable slot
 * identity, like `roleId`. Every reference is the stable ID of a definition in
 * the agent's own namespace; `capabilities` are requested capabilities inside
 * the role's declared set. Nothing here creates a Runtime agent or grants
 * anything.
 */
export interface ResolvedAgent {
  readonly agentId: string;
  readonly effectiveId: string;
  readonly origin: "pack_owned" | "project_owned";
  readonly title?: string;
  readonly description?: string;
  readonly roleId?: string;
  readonly prompts: readonly string[];
  readonly knowledge: readonly string[];
  readonly capabilities: readonly string[];
  readonly customization: "none" | "replace" | "extend";
}

/**
 * The declarative contract of one enabled workflow. `workflowId` is the
 * stable slot identity, like `roleId`; a stage is identified by its `id`
 * inside the workflow. The task type and every stage role are stable IDs of
 * definitions in the workflow's own namespace, and the stages are in the
 * workflow's own order. Nothing here creates a Runtime pipeline.
 */
export interface ResolvedWorkflow {
  readonly workflowId: string;
  readonly effectiveId: string;
  readonly origin: "pack_owned" | "project_owned";
  readonly title?: string;
  readonly description?: string;
  readonly taskTypeId: string;
  readonly stages: readonly { readonly id: string; readonly roleId: string }[];
  readonly customization: "none" | "replace" | "extend";
}

/**
 * The declared policy of one pack workflow (GP-25). `policyId` and
 * `workflowId` are stable slot identities. `state` is `inert` when the
 * project disabled the target workflow: nothing is left to govern. The
 * clauses are the pack's under every customization; a project cannot change
 * them. Nothing here is enforced, approved or granted.
 */
export interface ResolvedPolicy extends PolicyClauses {
  readonly policyId: string;
  readonly effectiveId: string;
  readonly origin: "pack_owned";
  readonly title?: string;
  readonly description?: string;
  readonly workflowId: string;
  readonly state: "active" | "inert";
}

export interface ResolvedWorkflowReferences {
  readonly workflowId: string;
  readonly taskTypeId: string;
  readonly stages: readonly { readonly id: string; readonly roleId: string }[];
}

export type DefinitionProvenance =
  | {
      readonly origin: "pack_owned";
      readonly pack: PackIdentity;
      readonly kind: ContributionKind;
      readonly localId: string;
      readonly override?: {
        readonly operation: string;
        readonly revision: number;
      };
    }
  | {
      readonly origin: "project_owned";
      readonly kind: ContributionKind;
      readonly localId: string;
      readonly revision: number;
    };

export interface ResolvedProjectConfiguration {
  readonly formatVersion: typeof configurationFormatVersion;
  readonly configurationDigest: string;
  readonly coreContractVersion: number;
  readonly bindingRevision: number;
  readonly definitionRevision: number;
  readonly selectedPacks: readonly PackIdentity[];
  readonly resolvedPacks: readonly PackIdentity[];
  readonly projectOwnedDefinitions: readonly ResolvedDefinition[];
  readonly appliedOverrides: readonly {
    readonly effectiveId: string;
    readonly operation: string;
    readonly revision: number;
  }[];
  readonly effectiveDefinitions: {
    readonly [K in ContributionKind]: readonly ResolvedDefinition[];
  };
  readonly origins: Readonly<Record<string, DefinitionProvenance>>;
  readonly disabledDefinitions: readonly string[];
  readonly resolvedWorkflowReferences: readonly ResolvedWorkflowReferences[];
  /**
   * Derived role contract view over `effectiveDefinitions.roles`. It is not
   * digest material: the effective definitions already determine it.
   */
  readonly roles: readonly ResolvedRole[];
  /** Stable IDs of disabled roles, which are absent from `roles`. */
  readonly omittedRoles: readonly string[];
  /**
   * Derived agent contract view over `effectiveDefinitions.agents`. Like the
   * role view, it is not digest material.
   */
  readonly agents: readonly ResolvedAgent[];
  /** Stable IDs of disabled agents, which are absent from `agents`. */
  readonly disabledAgents: readonly string[];
  /**
   * Derived workflow contract view over `effectiveDefinitions.workflows`.
   * Like the role and agent views, it is not digest material.
   */
  readonly workflows: readonly ResolvedWorkflow[];
  /** Stable IDs of disabled workflows, which are absent from `workflows`. */
  readonly disabledWorkflows: readonly string[];
  /**
   * Derived capability contract view over the resolved pack closure (GP-16):
   * each declared operation with the provider this host bound it to. It is
   * not digest or pin material, and a binding grants nothing.
   */
  readonly capabilities: readonly ResolvedCapability[];
  /**
   * Derived policy contract view over `effectiveDefinitions.policies`. Like
   * the other views, it is not digest material.
   */
  readonly policies: readonly ResolvedPolicy[];
  /** The minimum evidence future run records must pin. */
  readonly pin: {
    readonly configurationDigest: string;
    readonly coreContractVersion: number;
    readonly bindingRevision: number;
    readonly definitionRevision: number;
    readonly selectedPacks: readonly PackIdentity[];
    readonly resolvedPacks: readonly PackIdentity[];
  };
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function tupleKey(pack: PackIdentity): string {
  return `${pack.id}\u0000${pack.version}\u0000${pack.manifestDigest}`;
}

function sortedPacks(packs: readonly PackIdentity[]): PackIdentity[] {
  return packs
    .map(({ id, version, manifestDigest }) => ({
      id,
      version,
      manifestDigest,
    }))
    .sort((a, b) => compare(tupleKey(a), tupleKey(b)));
}

function packId(
  pack: PackIdentity,
  kind: ContributionKind,
  id: string,
): string {
  return `pack:${pack.id}@${pack.version}#${pack.manifestDigest}/${kind}/${id}`;
}

function projectId(kind: ContributionKind, id: string): string {
  return `project:${kind}/${id}`;
}

/** Stable identity of a pack definition: no version, digest or presentation. */
export function stablePackDefinitionId(
  pack: string,
  kind: ContributionKind,
  id: string,
): string {
  return `pack:${pack}/${kind}/${id}`;
}

function failure(code: ConfigurationIssueCode, message: string): never {
  throw new ProjectConfigurationResolutionError(code, message);
}

function packFailure(error: DomainPackCatalogError): never {
  const dependency = [
    "missing_dependency",
    "dependency_digest_mismatch",
    "dependency_cycle",
    "duplicate_conflict",
    "version_conflict",
    "malformed_dependency_graph",
  ].includes(error.code);
  failure(
    dependency ? "pack_dependency_failure" : "pack_unavailable",
    `Exact pack resolution failed: ${error.code}`,
  );
}

function validateRevision(value: number, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    failure("configuration_invariant", "Invalid source revision");
}

/**
 * One canonical order for every derived list: pack sources in GP-07's exact
 * source tuple order, then project-owned entries in GP-07's kind/ID order.
 */
function compareProvenance(
  left: DefinitionProvenance,
  right: DefinitionProvenance,
): number {
  if (left.origin === "pack_owned" && right.origin === "pack_owned")
    return compareExactSources(
      { ...left.pack, kind: left.kind, localId: left.localId },
      { ...right.pack, kind: right.kind, localId: right.localId },
    );
  if (left.origin === "project_owned" && right.origin === "project_owned")
    return compareOwnedDefinitions(
      { kind: left.kind, id: left.localId },
      { kind: right.kind, id: right.localId },
    );
  return left.origin === "pack_owned" ? -1 : 1;
}

/** Stored entries are re-checked against GP-07's own mutation contract. */
function storedOwnedDefinition(entry: ProjectOwnedDefinition): {
  readonly kind: ContributionKind;
  readonly id: string;
  readonly enabled: boolean;
  readonly payload: ProjectDefinitionPayload;
} {
  if (!contributionKinds.some((kind) => kind === entry?.kind))
    failure(
      "configuration_invariant",
      "Stored project definition has an unknown kind",
    );
  if (!projectOwnedKinds.includes(entry.kind))
    failure(
      "unsupported_security_composition",
      `Project definition kind ${entry.kind} has no schema-1 ownership contract`,
    );
  validateRevision(entry.revision, 1);
  try {
    const parsed = parseDefinitionMutation({
      action: "put_owned",
      kind: entry.kind,
      id: entry.id,
      payload: entry.payload,
      enabled: entry.enabled,
    });
    if (parsed.action !== "put_owned") throw new TypeError("unreachable");
    return parsed;
  } catch (error) {
    if (error instanceof ProjectDefinitionConflictError)
      failure(
        "configuration_invariant",
        `Stored project definition violates the definition contract: ${error.code}`,
      );
    throw error;
  }
}

function storedOverride(entry: ProjectDefinitionOverride): {
  readonly source: ExactPackDefinitionSource;
  readonly operation: OverrideOperation;
  readonly payload?: OverridePayload;
} {
  try {
    const parsed = parseDefinitionMutation({
      action: "put_override",
      source: entry?.source,
      operation: entry?.operation,
      ...(entry?.payload === undefined ? {} : { payload: entry.payload }),
    });
    if (parsed.action !== "put_override") throw new TypeError("unreachable");
    validateRevision(entry.revision, 1);
    return parsed;
  } catch (error) {
    if (error instanceof ProjectDefinitionConflictError)
      failure(
        "unresolved_override",
        `Stored override violates the override contract: ${error.code}`,
      );
    throw error;
  }
}

/** Pure derived resolution over an explicit, coherent authoritative input set. */
export function resolveProjectConfiguration(input: {
  readonly projectId: string;
  readonly binding: ProjectPackBinding;
  readonly definitions: ProjectDefinitionState;
  readonly catalog: InstalledDomainPackCatalog;
  readonly coreContractVersion: number;
  /**
   * The host's registered operation providers. Absent means none, so a
   * required operation is never bound by omission.
   */
  readonly providers?: OperationProviderCatalog;
}): ResolvedProjectConfiguration {
  const {
    projectId: owner,
    binding,
    definitions,
    catalog,
    coreContractVersion,
  } = input;
  if (
    binding.projectId !== owner ||
    definitions.projectId !== owner ||
    coreContractVersion !== catalog.coreContractVersion
  )
    failure(
      "configuration_invariant",
      "Configuration input ownership or core contract mismatch",
    );
  validateRevision(binding.configurationRevision);
  validateRevision(definitions.revision);

  // The shared helper runs the public GP-04 resolver and returns the manifests
  // of exactly the artifacts that resolver examined.
  let closure: readonly ResolvedPackManifest[];
  try {
    closure = resolveInstalledPackManifests(catalog, binding.packs);
  } catch (error) {
    if (error instanceof DomainPackCatalogError) packFailure(error);
    if (!(error instanceof CapturedPackManifestError)) throw error;
    if (error.code === "artifact_not_captured")
      failure(
        "configuration_invariant",
        "Verified pack artifact was not captured",
      );
    if (error.code === "manifest_unverified")
      failure(
        "pack_unavailable",
        `Captured pack manifest failed verification: ${error.manifestErrorCode}`,
      );
    failure(
      "binding_source_mismatch",
      "Verified manifest differs from resolved pack tuple",
    );
  }
  const selectedPacks = sortedPacks(binding.packs);
  const resolvedPacks = sortedPacks(closure.map((entry) => entry.identity));
  const manifests = new Map<string, DomainPackManifest>(
    closure.map((entry) => [tupleKey(entry.identity), entry.manifest]),
  );

  if (new Set(binding.packs.map(tupleKey)).size !== binding.packs.length)
    failure("configuration_invariant", "Duplicate selected pack tuple");
  const selectedById = new Map(selectedPacks.map((pack) => [pack.id, pack]));

  const origins: Record<string, DefinitionProvenance> = {};
  const source = new Map<string, ResolvedDefinition>();
  // Bare kind/local-ID occurrences across all namespaces, for collision and
  // ambiguity diagnostics only. Lookups always use a qualified effective ID.
  const bareCount = new Map<string, number>();
  const bareKey = (kind: ContributionKind, localId: string): string =>
    `${kind}\u0000${localId}`;
  const add = (
    definition: ResolvedDefinition,
    provenance: DefinitionProvenance,
  ): void => {
    if (source.has(definition.effectiveId))
      failure(
        "duplicate_effective_definition",
        `Duplicate effective definition ${definition.effectiveId}`,
      );
    source.set(definition.effectiveId, definition);
    origins[definition.effectiveId] = provenance;
    const bare = bareKey(definition.kind, definition.localId);
    bareCount.set(bare, (bareCount.get(bare) ?? 0) + 1);
  };

  for (const pack of resolvedPacks) {
    const manifest = manifests.get(tupleKey(pack))!;
    // A policy without a target workflow has no typed clause (GP-25).
    if (
      manifest.contributions.policies.some(
        (policy) => policy.workflow === undefined,
      )
    )
      failure(
        "unsupported_security_composition",
        `Pack ${pack.id}@${pack.version} has schema-1 policy declarations without typed clauses`,
      );
    for (const kind of contributionKinds)
      for (const item of manifest.contributions[kind]) {
        const effectiveId = packId(pack, kind, item.id);
        add(
          { effectiveId, kind, localId: item.id, enabled: true, payload: item },
          { origin: "pack_owned", pack, kind, localId: item.id },
        );
      }
  }

  const ownedDefinitions: ResolvedDefinition[] = [];
  const checkedOwned = definitions.owned.map((entry) => ({
    ...storedOwnedDefinition(entry),
    revision: entry.revision,
  }));
  for (const entry of checkedOwned.sort(compareOwnedDefinitions)) {
    const effectiveId = projectId(entry.kind, entry.id);
    if (source.has(effectiveId))
      failure(
        "duplicate_effective_definition",
        `Duplicate project definition ${entry.kind}/${entry.id}`,
      );
    if (bareCount.has(bareKey(entry.kind, entry.id)))
      failure(
        "duplicate_effective_definition",
        `Project definition ${entry.kind}/${entry.id} collides with the resolved pack closure`,
      );
    const definition = {
      effectiveId,
      kind: entry.kind,
      localId: entry.id,
      enabled: entry.enabled,
      payload: entry.payload,
    };
    add(definition, {
      origin: "project_owned",
      kind: entry.kind,
      localId: entry.id,
      revision: entry.revision,
    });
    ownedDefinitions.push(definition);
  }

  const appliedOverrides: {
    effectiveId: string;
    operation: string;
    revision: number;
  }[] = [];
  const overridden = new Set<string>();
  const checkedOverrides = definitions.overrides.map((entry) => ({
    ...storedOverride(entry),
    revision: entry.revision,
  }));
  for (const entry of checkedOverrides.sort((a, b) =>
    compareExactSources(a.source, b.source),
  )) {
    // GP-07 pins overrides to an explicitly selected pack. A pack that is only
    // a transitive dependency of the closure is not an override source.
    const pack = selectedById.get(entry.source.id);
    if (
      !pack ||
      pack.version !== entry.source.version ||
      pack.manifestDigest !== entry.source.manifestDigest
    )
      failure(
        "unresolved_override",
        `Override source pack ${entry.source.id}@${entry.source.version} is not an exact selected pack`,
      );
    const effectiveId = packId(pack, entry.source.kind, entry.source.localId);
    const current = source.get(effectiveId);
    if (!current)
      failure(
        "unresolved_override",
        `Override source ${entry.source.kind}/${entry.source.localId} is missing`,
      );
    if (overridden.has(effectiveId))
      failure(
        "duplicate_effective_definition",
        `Duplicate override for ${effectiveId}`,
      );
    overridden.add(effectiveId);
    const payload = entry.payload;
    let next: ResolvedDefinition;
    if (entry.operation === "disable") next = { ...current, enabled: false };
    else if (entry.operation === "replace" && payload) {
      // A replacement substitutes the descriptive envelope only. A role's
      // capability set stays the pack's: a project payload cannot carry one.
      // An agent's references are project-controlled: its replacement is the
      // complete agent envelope and is never merged with the pack's. The
      // same holds for a workflow's task type and ordered stages.
      const capabilities =
        current.kind === "roles"
          ? (current.payload as ResolvedPackRolePayload).capabilities
          : undefined;
      next = {
        ...current,
        payload:
          capabilities === undefined ? payload : { ...payload, capabilities },
      };
    } else if (
      entry.operation === "extend" &&
      payload &&
      (payload.title === undefined ||
        (current.payload as Contribution).title === undefined) &&
      (payload.description === undefined ||
        (current.payload as Contribution).description === undefined)
    )
      next = { ...current, payload: { ...current.payload, ...payload } };
    else
      failure(
        "unresolved_override",
        `Unsupported override operation for ${effectiveId}`,
      );
    source.set(effectiveId, next);
    origins[effectiveId] = {
      origin: "pack_owned",
      pack,
      kind: entry.source.kind,
      localId: entry.source.localId,
      override: { operation: entry.operation, revision: entry.revision },
    };
    appliedOverrides.push({
      effectiveId,
      operation: entry.operation,
      revision: entry.revision,
    });
  }

  const provenanceOf = (effectiveId: string): DefinitionProvenance => {
    const provenance = origins[effectiveId];
    if (!provenance)
      failure("configuration_invariant", "Definition provenance is missing");
    return provenance;
  };
  const compareIds = (left: string, right: string): number =>
    compareProvenance(provenanceOf(left), provenanceOf(right));
  const byKind = Object.fromEntries(
    contributionKinds.map((kind) => [kind, []]),
  ) as unknown as Record<ContributionKind, ResolvedDefinition[]>;
  for (const effectiveId of [...source.keys()].sort(compareIds)) {
    const definition = source.get(effectiveId)!;
    byKind[definition.kind].push(definition);
  }

  // A workflow's or an agent's bare references stay inside its own namespace:
  // the exact originating pack tuple, or the project-owned definitions.
  const resolveReference = (
    referrer: ResolvedDefinition,
    kind: ContributionKind,
    localId: string,
    noun: "workflow" | "agent" = "workflow",
  ): ResolvedDefinition => {
    const provenance = provenanceOf(referrer.effectiveId);
    const target = source.get(
      provenance.origin === "project_owned"
        ? projectId(kind, localId)
        : packId(provenance.pack, kind, localId),
    );
    if (!target) {
      if ((bareCount.get(bareKey(kind, localId)) ?? 0) > 1)
        failure(
          "ambiguous_reference",
          `Bare ${kind}/${localId} crosses pack namespaces in ${noun} ${referrer.effectiveId}`,
        );
      failure(
        noun === "agent"
          ? "missing_agent_reference"
          : "missing_workflow_reference",
        `Missing ${kind}/${localId} in ${noun} ${referrer.effectiveId}`,
      );
    }
    if (!target.enabled)
      failure(
        "disabled_required_definition",
        `Disabled ${kind}/${localId} in ${noun} ${referrer.effectiveId}`,
      );
    return target;
  };
  // Stable identity of any resolved definition: pack-owned ones lose their
  // version and digest, project-owned ones already have neither.
  const stableId = (definition: ResolvedDefinition): string => {
    const provenance = provenanceOf(definition.effectiveId);
    return provenance.origin === "pack_owned"
      ? stablePackDefinitionId(
          provenance.pack.id,
          definition.kind,
          definition.localId,
        )
      : definition.effectiveId;
  };
  const resolvedWorkflowReferences: ResolvedWorkflowReferences[] = [];
  const workflows: ResolvedWorkflow[] = [];
  const disabledWorkflows: string[] = [];
  const workflowIds = new Set<string>();
  for (const workflow of byKind.workflows) {
    const provenance = provenanceOf(workflow.effectiveId);
    const workflowId = stableId(workflow);
    if (workflowIds.has(workflowId))
      failure(
        "configuration_invariant",
        `Duplicate workflow identity ${workflowId}`,
      );
    workflowIds.add(workflowId);
    // A disabled workflow is not part of the configuration, so its task type
    // and stage roles are not required.
    if (!workflow.enabled) {
      disabledWorkflows.push(workflowId);
      continue;
    }
    // A customized workflow resolves like the pack's own: inside the exact
    // originating pack tuple. Stage order is the payload's, never sorted.
    const payload = workflow.payload as WorkflowContribution;
    const taskType = resolveReference(workflow, "taskTypes", payload.taskType);
    const stages = payload.stages.map((stage) => ({
      id: stage.id,
      role: resolveReference(workflow, "roles", stage.role),
    }));
    resolvedWorkflowReferences.push({
      workflowId: workflow.effectiveId,
      taskTypeId: taskType.effectiveId,
      stages: stages.map((stage) => ({
        id: stage.id,
        roleId: stage.role.effectiveId,
      })),
    });
    const { title, description } = workflow.payload;
    const operation =
      provenance.origin === "pack_owned"
        ? provenance.override?.operation
        : undefined;
    workflows.push({
      workflowId,
      effectiveId: workflow.effectiveId,
      origin: provenance.origin,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      taskTypeId: stableId(taskType),
      stages: stages.map((stage) => ({
        id: stage.id,
        roleId: stableId(stage.role),
      })),
      customization:
        operation === "replace" || operation === "extend" ? operation : "none",
    });
  }

  // A pack policy is mandatory and pack-owned: its clauses are the pack's,
  // and the effective workflow, the pack's or the project's replacement,
  // must still carry every stage the policy names, in the required order.
  const policies: ResolvedPolicy[] = [];
  for (const definition of byKind.policies) {
    const provenance = provenanceOf(definition.effectiveId);
    const policy = definition.payload as PolicyContribution;
    if (provenance.origin !== "pack_owned" || policy.workflow === undefined)
      failure(
        "unsupported_security_composition",
        `Policy ${definition.effectiveId} has no typed pack clauses`,
      );
    const target = source.get(
      packId(provenance.pack, "workflows", policy.workflow),
    );
    if (!target)
      failure(
        policyTargetMissing,
        `Policy ${definition.effectiveId} targets workflows/${policy.workflow}, which its pack does not declare`,
      );
    // A disabled workflow leaves the configuration: nothing to govern.
    if (target.enabled) {
      const violation = policyTargetViolations(
        policy,
        (target.payload as WorkflowContribution).stages.map(
          (stage) => stage.id,
        ),
      )[0];
      if (violation)
        failure(
          policyTargetMissing,
          violation.kind === "stage_missing"
            ? `Policy ${definition.effectiveId} governs stage ${violation.stage}, which workflow ${target.effectiveId} does not declare`
            : `Policy ${definition.effectiveId} requires stage ${violation.predecessor} before stage ${violation.stage} in workflow ${target.effectiveId}`,
        );
    }
    const { title, description } = definition.payload;
    policies.push({
      policyId: stableId(definition),
      effectiveId: definition.effectiveId,
      origin: "pack_owned",
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      workflowId: stableId(target),
      state: target.enabled ? "active" : "inert",
      ...policyClauses(policy),
    });
  }

  const roles: ResolvedRole[] = [];
  const omittedRoles: string[] = [];
  const roleIds = new Set<string>();
  for (const definition of byKind.roles) {
    const provenance = provenanceOf(definition.effectiveId);
    const roleId =
      provenance.origin === "pack_owned"
        ? stablePackDefinitionId(
            provenance.pack.id,
            "roles",
            definition.localId,
          )
        : definition.effectiveId;
    if (roleIds.has(roleId))
      failure("configuration_invariant", `Duplicate role identity ${roleId}`);
    roleIds.add(roleId);
    if (!definition.enabled) {
      omittedRoles.push(roleId);
      continue;
    }
    const { title, description } = definition.payload;
    const operation =
      provenance.origin === "pack_owned"
        ? provenance.override?.operation
        : undefined;
    roles.push({
      roleId,
      effectiveId: definition.effectiveId,
      origin: provenance.origin,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      // Only a pack source declares capabilities; they are reported by the
      // stable ID of the capability the same pack declares.
      capabilities:
        provenance.origin === "pack_owned"
          ? (
              (definition.payload as ResolvedPackRolePayload).capabilities ?? []
            ).map((capability) =>
              stablePackDefinitionId(
                provenance.pack.id,
                "capabilities",
                capability,
              ),
            )
          : [],
      customization:
        operation === "replace" || operation === "extend" ? operation : "none",
    });
  }

  const agents: ResolvedAgent[] = [];
  const disabledAgents: string[] = [];
  const agentIds = new Set<string>();
  for (const definition of byKind.agents) {
    const provenance = provenanceOf(definition.effectiveId);
    const agentId = stableId(definition);
    if (agentIds.has(agentId))
      failure("configuration_invariant", `Duplicate agent identity ${agentId}`);
    agentIds.add(agentId);
    // A disabled agent is not part of the configuration, so its references
    // are not resolved.
    if (!definition.enabled) {
      disabledAgents.push(agentId);
      continue;
    }
    const payload = definition.payload as AgentDefinition;
    const role =
      payload.role === undefined
        ? undefined
        : resolveReference(definition, "roles", payload.role, "agent");
    const references = (kind: "prompts" | "knowledge"): string[] =>
      (payload[kind] ?? []).map((localId) =>
        stableId(resolveReference(definition, kind, localId, "agent")),
      );
    const prompts = references("prompts");
    const knowledge = references("knowledge");
    // The limit: a request stays inside the effective role's declared set,
    // which is the pack's under every role override (GP-11).
    const declared =
      role === undefined
        ? []
        : ((role.payload as ResolvedPackRolePayload).capabilities ?? []);
    const capabilities = (payload.capabilities ?? []).map((capability) => {
      const target = resolveReference(
        definition,
        "capabilities",
        capability,
        "agent",
      );
      if (!declared.includes(capability))
        failure(
          "agent_capability_exceeds_role",
          `Agent ${definition.effectiveId} requests capabilities/${capability} outside the declared set of its role ${role === undefined ? "(none)" : `roles/${role.localId}`}`,
        );
      return stableId(target);
    });
    const { title, description } = definition.payload;
    const operation =
      provenance.origin === "pack_owned"
        ? provenance.override?.operation
        : undefined;
    agents.push({
      agentId,
      effectiveId: definition.effectiveId,
      origin: provenance.origin,
      ...(title === undefined ? {} : { title }),
      ...(description === undefined ? {} : { description }),
      ...(role === undefined ? {} : { roleId: stableId(role) }),
      prompts,
      knowledge,
      capabilities,
      customization:
        operation === "replace" || operation === "extend" ? operation : "none",
    });
  }

  // GP-16: every capability of the closure, whether or not a role or an agent
  // names it. A capability has no override, so nothing above can hide one.
  const bound = bindCapabilityContracts(
    closure,
    input.providers ?? noOperationProviders,
  );
  if ("issues" in bound)
    failure(bound.issues[0]!.code, bound.issues[0]!.message);

  const sortedOrigins = Object.fromEntries(
    Object.keys(origins)
      .sort(compareIds)
      .map((effectiveId) => [effectiveId, origins[effectiveId]!]),
  );
  const disabledDefinitions = [...source.values()]
    .filter((item) => !item.enabled)
    .map((item) => item.effectiveId)
    .sort(compareIds);
  const material = {
    formatVersion: configurationFormatVersion,
    coreContractVersion,
    bindingRevision: binding.configurationRevision,
    definitionRevision: definitions.revision,
    selectedPacks,
    resolvedPacks,
    projectOwnedDefinitions: ownedDefinitions,
    appliedOverrides,
    effectiveDefinitions: byKind,
    origins: sortedOrigins,
    disabledDefinitions,
    resolvedWorkflowReferences,
  };
  let configurationDigest: string;
  try {
    const normalized: unknown = JSON.parse(JSON.stringify(material));
    const canonical = canonicalizeJcsJson(
      normalized as Parameters<typeof canonicalizeJcsJson>[0],
    );
    configurationDigest = `sha256:${createHash("sha256").update(`ai-office-project-configuration-v1\n${canonical}`).digest("hex")}`;
  } catch {
    failure(
      "configuration_invariant",
      "Configuration digest could not be computed",
    );
  }
  return {
    ...material,
    configurationDigest,
    roles,
    omittedRoles,
    agents,
    disabledAgents,
    workflows,
    disabledWorkflows,
    capabilities: bound.capabilities,
    policies,
    pin: {
      configurationDigest,
      coreContractVersion,
      bindingRevision: binding.configurationRevision,
      definitionRevision: definitions.revision,
      selectedPacks,
      resolvedPacks,
    },
  };
}
