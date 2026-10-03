import { createHash } from "node:crypto";
import {
  contributionKinds,
  DomainPackManifestError,
  verifyDomainPackManifest,
  type Contribution,
  type ContributionKind,
  type DomainPackManifest,
  type WorkflowContribution,
} from "../../../domain-pack-contracts/src/index.ts";
import { canonicalizeJcsJson } from "../../../domain-pack-contracts/src/jcs.ts";
import {
  DomainPackCatalogError,
  type InstalledDomainPackCatalog,
  type PackIdentity,
} from "../ports/installed-domain-pack-catalog.port.ts";
import type { ProjectPackBinding } from "../ports/project-pack-binding-repository.port.ts";
import type {
  ProjectDefinitionState,
  ProjectDefinitionPayload,
} from "./project-definition.ts";
import { resolveInstalledPacks } from "./resolve-installed-packs.ts";

export const configurationFormatVersion = 1 as const;

export type ConfigurationIssueCode =
  | "pack_unavailable"
  | "pack_dependency_failure"
  | "binding_source_mismatch"
  | "unresolved_override"
  | "duplicate_effective_definition"
  | "missing_workflow_reference"
  | "ambiguous_reference"
  | "disabled_required_definition"
  | "unsupported_security_composition"
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

export interface ResolvedDefinition {
  readonly effectiveId: string;
  readonly kind: ContributionKind;
  readonly localId: string;
  readonly enabled: boolean;
  readonly payload: ProjectDefinitionPayload;
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
  return [...packs].sort((a, b) => compare(tupleKey(a), tupleKey(b)));
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

function validateRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    failure("configuration_invariant", "Invalid source revision");
}

function validOverridePayload(
  value: unknown,
  id: string,
  partial: boolean,
): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some(
      (key) => !["id", "title", "description"].includes(key),
    )
  )
    return false;
  if (partial ? item.id !== undefined : item.id !== id) return false;
  if (partial && item.title === undefined && item.description === undefined)
    return false;
  return ["title", "description"].every(
    (key) =>
      item[key] === undefined ||
      (typeof item[key] === "string" && item[key].length <= 16_000),
  );
}

/** Pure derived resolution over an explicit, coherent authoritative input set. */
export function resolveProjectConfiguration(input: {
  readonly projectId: string;
  readonly binding: ProjectPackBinding;
  readonly definitions: ProjectDefinitionState;
  readonly catalog: InstalledDomainPackCatalog;
  readonly coreContractVersion: number;
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

  // Capture exactly the artifacts examined by the public GP-04 resolver. A
  // second catalog read could observe another registration after validation.
  const captured = new Map<string, Uint8Array>();
  const verifiedCatalog: InstalledDomainPackCatalog = {
    coreContractVersion,
    list: () => catalog.list(),
    trusts: (provenance) => catalog.trusts(provenance),
    read: (id, version) => {
      const artifact = catalog.read(id, version);
      if (artifact)
        captured.set(`${id}\u0000${version}`, new Uint8Array(artifact.bytes));
      return artifact;
    },
  };
  let closure;
  try {
    closure = resolveInstalledPacks(verifiedCatalog, binding.packs);
  } catch (error) {
    if (error instanceof DomainPackCatalogError) packFailure(error);
    throw error;
  }
  const selectedPacks = sortedPacks(binding.packs);
  const resolvedPacks = sortedPacks(closure.map((entry) => entry.identity));
  const manifests = new Map<string, DomainPackManifest>();
  for (const pack of resolvedPacks) {
    const bytes = captured.get(`${pack.id}\u0000${pack.version}`);
    if (!bytes)
      failure(
        "configuration_invariant",
        "Verified pack artifact was not captured",
      );
    let manifest: DomainPackManifest;
    try {
      manifest = verifyDomainPackManifest(bytes);
    } catch (error) {
      if (error instanceof DomainPackManifestError)
        failure(
          "pack_unavailable",
          `Captured pack manifest failed verification: ${error.code}`,
        );
      throw error;
    }
    if (manifest.manifestDigest !== pack.manifestDigest)
      failure(
        "binding_source_mismatch",
        "Verified manifest differs from resolved pack tuple",
      );
    manifests.set(tupleKey(pack), manifest);
  }

  const byKind = Object.fromEntries(
    contributionKinds.map((kind) => [kind, []]),
  ) as unknown as Record<ContributionKind, ResolvedDefinition[]>;
  const origins: Record<string, DefinitionProvenance> = {};
  const source = new Map<string, ResolvedDefinition>();
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
    byKind[definition.kind].push(definition);
    origins[definition.effectiveId] = provenance;
  };

  for (const pack of resolvedPacks) {
    const manifest = manifests.get(tupleKey(pack))!;
    if (manifest.contributions.policies.length)
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
  for (const entry of [...definitions.owned].sort((a, b) =>
    compare(`${a.kind}\u0000${a.id}`, `${b.kind}\u0000${b.id}`),
  )) {
    if (
      ![
        "roles",
        "taskTypes",
        "workflows",
        "agents",
        "artifactTypes",
        "evidenceTypes",
        "knowledge",
        "prompts",
      ].includes(entry.kind)
    )
      failure(
        "unsupported_security_composition",
        `Project definition kind ${entry.kind} has no schema-1 ownership contract`,
      );
    if (byKind[entry.kind].some((item) => item.localId === entry.id))
      failure(
        "duplicate_effective_definition",
        `Project definition ${entry.kind}/${entry.id} collides with a selected pack source`,
      );
    const effectiveId = projectId(entry.kind, entry.id);
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
  for (const entry of [...definitions.overrides].sort((a, b) =>
    compare(
      packId(a.source, a.source.kind, a.source.localId),
      packId(b.source, b.source.kind, b.source.localId),
    ),
  )) {
    const pack = resolvedPacks.find((item) => item.id === entry.source.id);
    if (
      !pack ||
      pack.version !== entry.source.version ||
      pack.manifestDigest !== entry.source.manifestDigest
    )
      failure(
        "unresolved_override",
        `Override source pack ${entry.source.id}@${entry.source.version} is not in the exact resolved closure`,
      );
    const effectiveId = packId(
      entry.source,
      entry.source.kind,
      entry.source.localId,
    );
    const current = source.get(effectiveId);
    if (!current)
      failure(
        "unresolved_override",
        `Override source ${entry.source.kind}/${entry.source.localId} is missing`,
      );
    if (appliedOverrides.some((item) => item.effectiveId === effectiveId))
      failure(
        "duplicate_effective_definition",
        `Duplicate override for ${effectiveId}`,
      );
    const payload = entry.payload;
    let next: ResolvedDefinition;
    if (
      entry.operation === "disable" &&
      entry.source.kind === "prompts" &&
      payload === undefined
    )
      next = { ...current, enabled: false };
    else if (
      entry.operation === "replace" &&
      payload &&
      validOverridePayload(payload, entry.source.localId, false) &&
      entry.source.kind !== "workflows" &&
      entry.source.kind !== "policies" &&
      entry.source.kind !== "capabilities" &&
      entry.source.kind !== "validators"
    )
      next = { ...current, payload };
    else if (
      entry.operation === "extend" &&
      payload &&
      validOverridePayload(payload, entry.source.localId, true) &&
      entry.source.kind !== "workflows" &&
      entry.source.kind !== "policies" &&
      entry.source.kind !== "capabilities" &&
      entry.source.kind !== "validators" &&
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
    byKind[entry.source.kind] = byKind[entry.source.kind].map((item) =>
      item.effectiveId === effectiveId ? next : item,
    );
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

  const resolveReference = (
    workflow: ResolvedDefinition,
    kind: "taskTypes" | "roles",
    localId: string,
  ): string => {
    const provenance = origins[workflow.effectiveId];
    if (!provenance)
      failure("configuration_invariant", "Workflow provenance is missing");
    const candidates = byKind[kind].filter((item) => {
      if (item.localId !== localId) return false;
      const origin = origins[item.effectiveId];
      if (!origin)
        failure("configuration_invariant", "Definition provenance is missing");
      return provenance.origin === "project_owned"
        ? origin.origin === "project_owned"
        : origin.origin === "pack_owned" &&
            origin.pack.id === provenance.pack.id;
    });
    if (candidates.length > 1)
      failure(
        "ambiguous_reference",
        `Ambiguous ${kind}/${localId} in workflow ${workflow.effectiveId}`,
      );
    if (!candidates.length) {
      const externalMatches = byKind[kind].filter(
        (item) => item.localId === localId,
      );
      if (externalMatches.length > 1)
        failure(
          "ambiguous_reference",
          `Bare ${kind}/${localId} crosses pack namespaces in workflow ${workflow.effectiveId}`,
        );
      failure(
        "missing_workflow_reference",
        `Missing ${kind}/${localId} in workflow ${workflow.effectiveId}`,
      );
    }
    if (!candidates[0]!.enabled)
      failure(
        "disabled_required_definition",
        `Disabled ${kind}/${localId} in workflow ${workflow.effectiveId}`,
      );
    return candidates[0]!.effectiveId;
  };
  const resolvedWorkflowReferences: ResolvedWorkflowReferences[] = [];
  for (const workflow of byKind.workflows) {
    if (!workflow.enabled) continue;
    const payload = workflow.payload as WorkflowContribution;
    resolvedWorkflowReferences.push({
      workflowId: workflow.effectiveId,
      taskTypeId: resolveReference(workflow, "taskTypes", payload.taskType),
      stages: payload.stages.map((stage) => ({
        id: stage.id,
        roleId: resolveReference(workflow, "roles", stage.role),
      })),
    });
  }
  resolvedWorkflowReferences.sort((a, b) =>
    compare(a.workflowId, b.workflowId),
  );

  for (const kind of contributionKinds)
    byKind[kind].sort((a, b) => compare(a.effectiveId, b.effectiveId));
  const sortedOrigins = Object.fromEntries(
    Object.entries(origins).sort(([a], [b]) => compare(a, b)),
  );
  const disabledDefinitions = [...source.values()]
    .filter((item) => !item.enabled)
    .map((item) => item.effectiveId)
    .sort(compare);
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
