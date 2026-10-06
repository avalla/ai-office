import { createHash } from "node:crypto";
import { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import {
  contributionKinds,
  type AgentContribution,
  type Contribution,
  type ContributionKind,
  type DomainPackManifest,
  type WorkflowContribution,
} from "../../../domain-pack-contracts/src/index.ts";
import { canonicalizeJcsJson } from "../../../domain-pack-contracts/src/jcs.ts";
import { ProjectNotFoundError } from "../errors.ts";
import {
  DomainPackCatalogError,
  type InstalledDomainPackCatalog,
  type PackIdentity,
} from "../ports/installed-domain-pack-catalog.port.ts";
import type { OperationProviderCatalog } from "../ports/operation-provider-catalog.port.ts";
import {
  StaleProjectPackBindingError,
  type ProjectPackBinding,
  type ProjectPackBindingRepository,
} from "../ports/project-pack-binding-repository.port.ts";
import type { ProjectDefinitionRepository } from "../ports/project-definition-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { AuditEventRepository } from "../ports/audit-event-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import { normalizePackSelection } from "./manage-project-pack-binding.ts";
import {
  ProjectDefinitionConflictError,
  StaleProjectDefinitionError,
  compareExactSources,
  compareOwnedDefinitions,
  hasAgentReferences,
  parseExactSource,
  sourceKey,
  type ExactPackDefinitionSource,
  type OverrideOperation,
  type OverridePayload,
  type ProjectDefinitionOverride,
  type ProjectDefinitionState,
  type ProjectOwnedDefinition,
} from "./project-definition.ts";
import {
  capabilityContractDifferences,
  type CapabilityContractDifference,
} from "./capability-contracts.ts";
import {
  CapturedPackManifestError,
  resolveInstalledPackManifests,
  type ResolvedPackManifest,
} from "./resolve-installed-pack-manifests.ts";
import {
  roleCapabilityDifferences,
  roleCapabilitySets,
  type RoleCapabilityDifference,
  type RoleCapabilitySet,
} from "./role-capability-changes.ts";
import {
  ProjectConfigurationResolutionError,
  resolveProjectConfiguration,
  stablePackDefinitionId,
} from "./resolve-project-configuration.ts";

/**
 * An operator's reviewed answer to one override that cannot follow its pack.
 * Nothing is retained, converted, moved or removed without one.
 * `convert_to_replace` answers an `extend_conflict` only.
 */
export type OverrideResolutionAction =
  "retain_as_project_owned" | "remove_override" | "convert_to_replace";

const resolutionActions: readonly OverrideResolutionAction[] = [
  "retain_as_project_owned",
  "remove_override",
  "convert_to_replace",
];

export interface OverrideResolution {
  readonly source: ExactPackDefinitionSource;
  readonly action: OverrideResolutionAction;
}

export type OverrideConflictCode =
  | "source_pack_removed"
  | "source_definition_removed"
  | "extend_conflict"
  | "target_override_exists";

export type OverrideOutcome =
  | "unchanged"
  | "retargeted"
  | "retained_as_project_owned"
  | "converted_to_replace"
  | "removed"
  | "conflict";

/** What happened to the pack template under a project override. */
export type UpstreamChange = "unchanged" | "changed" | "removed" | "unknown";

export interface OverrideReconciliation {
  readonly source: ExactPackDefinitionSource;
  readonly operation: OverrideOperation;
  readonly outcome: OverrideOutcome;
  readonly upstream: UpstreamChange;
  readonly target?: ExactPackDefinitionSource;
  readonly retainedAs?: {
    readonly kind: ContributionKind;
    readonly id: string;
  };
  readonly conflict?: OverrideConflictCode;
}

export interface TemplateChange {
  readonly packId: string;
  readonly kind: ContributionKind;
  readonly localId: string;
  readonly change: "added" | "removed" | "changed";
  /** A project override names this definition; its value is never rewritten. */
  readonly customized: boolean;
}

/** A role capability difference, marked when a project override names it. */
export interface RoleCapabilityChange extends RoleCapabilityDifference {
  /** A project override names this role; it cannot alter the set. */
  readonly customized: boolean;
}

export type PackUpgradeIssueCode =
  | "target_closure_unresolved"
  | "unresolved_override_conflict"
  | "invalid_resolution"
  | "prospective_configuration_invalid";

export interface PackUpgradeIssue {
  readonly code: PackUpgradeIssueCode;
  /** The underlying typed code: a conflict, catalog or configuration code. */
  readonly detail: string;
  readonly message: string;
}

export interface PackUpgradePlan {
  readonly projectId: string;
  readonly bindingRevision: number;
  readonly definitionRevision: number;
  readonly currentPacks: readonly PackIdentity[];
  readonly proposedPacks: readonly PackIdentity[];
  readonly added: readonly PackIdentity[];
  readonly removed: readonly PackIdentity[];
  readonly changed: readonly {
    readonly before: PackIdentity;
    readonly after: PackIdentity;
  }[];
  /** Pack template differences over the resolved closures, by definition. */
  readonly templates:
    | {
        readonly availability: "available";
        readonly changes: readonly TemplateChange[];
      }
    | {
        readonly availability: "unavailable";
        readonly reason: "previous_closure_unresolved";
        readonly detail: string;
      };
  /**
   * Role capability differences over the resolved closures. A capability
   * change is never incidental: it is reviewed and approved with the plan.
   */
  readonly roleCapabilityChanges:
    | {
        readonly availability: "available";
        readonly changes: readonly RoleCapabilityChange[];
      }
    | {
        readonly availability: "unavailable";
        readonly reason: "previous_closure_unresolved";
        readonly detail: string;
      };
  /**
   * Every role of the target closure that declares capabilities. Approval
   * binds these sets even when the previous closure cannot be read.
   */
  readonly targetRoleCapabilities: readonly RoleCapabilitySet[];
  /**
   * Operation contract differences of pack capabilities over the resolved
   * closures (GP-16): added and removed operations and requirement changes.
   * Like a role capability change, it is reviewed and approved with the plan.
   */
  readonly capabilityContractChanges:
    | {
        readonly availability: "available";
        readonly changes: readonly CapabilityContractDifference[];
      }
    | {
        readonly availability: "unavailable";
        readonly reason: "previous_closure_unresolved";
        readonly detail: string;
      };
  readonly overrides: readonly OverrideReconciliation[];
  /** Supplied resolutions that matched no conflict; they change nothing. */
  readonly ignoredResolutions: readonly OverrideResolution[];
  /**
   * Runs do not pin pack configuration yet, so no run can depend on a pack
   * tuple. Existing manifest and pipeline pins are outside this operation.
   */
  readonly activePins: {
    readonly availability: "unavailable";
    readonly reason: "pack_configuration_run_pins_not_modelled";
  };
  /** Present when the plan has no issue: the digest GP-06 yields after apply. */
  readonly prospectiveConfigurationDigest?: string;
  readonly issues: readonly PackUpgradeIssue[];
  /** Nothing would be written: the selection and every override already agree. */
  readonly noop: boolean;
  /** Approval token: covers every field above. */
  readonly planDigest: string;
}

export type ProjectPackUpgradeErrorCode =
  | "malformed_request"
  | "stale_snapshot"
  | "upgrade_blocked"
  | "plan_not_approved";

export class ProjectPackUpgradeError extends Error {
  constructor(
    readonly code: ProjectPackUpgradeErrorCode,
    message: string,
    readonly issues: readonly PackUpgradeIssue[] = [],
  ) {
    super(message);
    this.name = "ProjectPackUpgradeError";
  }
}

export interface PackUpgradeResult {
  readonly result: "applied" | "unchanged";
  readonly planDigest: string;
  readonly bindingRevision: number;
  readonly definitionRevision: number;
  readonly packs: readonly PackIdentity[];
}

const compare = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const tupleKey = (pack: PackIdentity): string =>
  `${pack.id}\u0000${pack.version}\u0000${pack.manifestDigest}`;

const identity = ({ id, version, manifestDigest }: PackIdentity) => ({
  id,
  version,
  manifestDigest,
});

function parseResolutions(value: unknown): OverrideResolution[] {
  if (!Array.isArray(value))
    throw new ProjectPackUpgradeError(
      "malformed_request",
      "Expected an array of override resolutions",
    );
  const seen = new Set<string>();
  return value
    .map((item: unknown): OverrideResolution => {
      if (
        item === null ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).sort().join(",") !== "action,source"
      )
        throw new ProjectPackUpgradeError(
          "malformed_request",
          "Each resolution needs only source and action",
        );
      const { source: rawSource, action } = item as Record<string, unknown>;
      const known = resolutionActions.find((candidate) => candidate === action);
      if (known === undefined)
        throw new ProjectPackUpgradeError(
          "malformed_request",
          "Unknown override resolution action",
        );
      let source: ExactPackDefinitionSource;
      try {
        source = parseExactSource(rawSource);
      } catch (error) {
        if (error instanceof ProjectDefinitionConflictError)
          throw new ProjectPackUpgradeError("malformed_request", error.message);
        throw error;
      }
      if (seen.has(sourceKey(source)))
        throw new ProjectPackUpgradeError(
          "malformed_request",
          "An override has more than one resolution",
        );
      seen.add(sourceKey(source));
      return { source, action: known };
    })
    .sort((left, right) => compareExactSources(left.source, right.source));
}

function closureFailure(error: unknown): string | null {
  if (error instanceof DomainPackCatalogError) return error.code;
  if (error instanceof CapturedPackManifestError) return error.code;
  return null;
}

function templateChanges(
  before: readonly ResolvedPackManifest[],
  after: readonly ResolvedPackManifest[],
  overrides: readonly ProjectDefinitionOverride[],
): TemplateChange[] {
  const customized = new Set(
    overrides.map(
      ({ source }) => `${source.id}\u0000${source.kind}\u0000${source.localId}`,
    ),
  );
  const beforeById = new Map(before.map((entry) => [entry.identity.id, entry]));
  const afterById = new Map(after.map((entry) => [entry.identity.id, entry]));
  const changes: TemplateChange[] = [];
  for (const packId of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const old = beforeById.get(packId);
    const next = afterById.get(packId);
    if (old && next && tupleKey(old.identity) === tupleKey(next.identity))
      continue;
    for (const kind of contributionKinds) {
      const oldEntries = new Map<string, Contribution>(
        (old?.manifest.contributions[kind] ?? []).map((entry) => [
          entry.id,
          entry,
        ]),
      );
      const nextEntries = new Map<string, Contribution>(
        (next?.manifest.contributions[kind] ?? []).map((entry) => [
          entry.id,
          entry,
        ]),
      );
      for (const localId of new Set([
        ...oldEntries.keys(),
        ...nextEntries.keys(),
      ])) {
        const oldEntry = oldEntries.get(localId);
        const nextEntry = nextEntries.get(localId);
        const change =
          oldEntry === undefined
            ? "added"
            : nextEntry === undefined
              ? "removed"
              : sameContribution(oldEntry, nextEntry)
                ? null
                : "changed";
        if (change)
          changes.push({
            packId,
            kind,
            localId,
            change,
            customized: customized.has(
              `${packId}\u0000${kind}\u0000${localId}`,
            ),
          });
      }
    }
  }
  return changes.sort(
    (left, right) =>
      compare(left.packId, right.packId) ||
      compare(left.kind, right.kind) ||
      compare(left.localId, right.localId),
  );
}

function sameContribution(left: Contribution, right: Contribution): boolean {
  return (
    canonicalizeJcsJson(left as never) === canonicalizeJcsJson(right as never)
  );
}

function roleCapabilityChanges(
  before: readonly ResolvedPackManifest[],
  after: readonly ResolvedPackManifest[],
  overrides: readonly ProjectDefinitionOverride[],
): RoleCapabilityChange[] {
  const customized = new Set(
    overrides
      .filter(({ source }) => source.kind === "roles")
      .map(({ source }) =>
        stablePackDefinitionId(source.id, "roles", source.localId),
      ),
  );
  return roleCapabilityDifferences(before, after).map((item) => ({
    ...item,
    customized: customized.has(item.roleId),
  }));
}

/**
 * The definition state after the plan's override outcomes. A surviving override
 * is carried over whole: only the pack tuple of a retargeted source changes.
 * A converted extension is a changed entry and records who changed it.
 */
function reconciledDefinitions(
  current: ProjectDefinitionState,
  overrides: readonly OverrideReconciliation[],
  conversions: ReadonlyMap<string, OverridePayload>,
  actorId: string,
  changedAt: string,
): ProjectDefinitionState {
  const outcomes = new Map(
    overrides.map((item) => [sourceKey(item.source), item]),
  );
  const owned: ProjectOwnedDefinition[] = [...current.owned];
  const kept: ProjectDefinitionOverride[] = [];
  for (const override of current.overrides) {
    const outcome = outcomes.get(sourceKey(override.source));
    if (!outcome || outcome.outcome === "unchanged") kept.push(override);
    else if (outcome.outcome === "retargeted" && outcome.target)
      kept.push({
        ...override,
        source: outcome.target,
      });
    else if (outcome.outcome === "converted_to_replace" && outcome.target) {
      const payload = conversions.get(sourceKey(override.source));
      if (!payload)
        throw new TypeError("Converted override has no replacement payload");
      kept.push({
        origin: "project_override",
        source: outcome.target,
        operation: "replace",
        revision: override.revision + 1,
        payload,
        actorId,
        changedAt,
      });
    } else if (
      outcome.outcome === "retained_as_project_owned" &&
      override.payload
    )
      owned.push({
        origin: "project_owned",
        kind: override.source.kind,
        id: override.source.localId,
        revision: 1,
        enabled: true,
        payload: { ...override.payload, id: override.source.localId },
        actorId,
        changedAt,
      });
    else if (outcome.outcome === "conflict") kept.push(override);
  }
  return {
    projectId: current.projectId,
    revision: current.revision,
    owned: owned.sort(compareOwnedDefinitions),
    overrides: kept.sort((left, right) =>
      compareExactSources(left.source, right.source),
    ),
  };
}

function digestOf(plan: Omit<PackUpgradePlan, "planDigest">): string {
  return `sha256:${createHash("sha256")
    .update("ai-office-pack-upgrade-plan-v1\n", "utf8")
    .update(canonicalizeJcsJson(plan as never), "utf8")
    .digest("hex")}`;
}

interface UpgradeReconciliation {
  readonly plan: PackUpgradePlan;
  /**
   * Replacement payloads of converted extensions, by old source. They are
   * definition bodies, so they stay out of the report; the prospective
   * configuration digest in the plan covers them.
   */
  readonly conversions: ReadonlyMap<string, OverridePayload>;
}

/**
 * Pure reconciliation of one coherent authoritative snapshot against a desired
 * exact selection. It reads the installed catalog and writes nothing.
 */
export function planProjectPackUpgrade(input: {
  readonly binding: ProjectPackBinding;
  readonly definitions: ProjectDefinitionState;
  readonly desired: readonly PackIdentity[];
  readonly resolutions: readonly OverrideResolution[];
  readonly catalog: InstalledDomainPackCatalog;
  readonly providers?: OperationProviderCatalog;
}): PackUpgradePlan {
  return reconcileProjectPackUpgrade(input).plan;
}

function reconcileProjectPackUpgrade(input: {
  readonly binding: ProjectPackBinding;
  readonly definitions: ProjectDefinitionState;
  readonly desired: readonly PackIdentity[];
  readonly resolutions: readonly OverrideResolution[];
  readonly catalog: InstalledDomainPackCatalog;
  readonly providers?: OperationProviderCatalog;
}): UpgradeReconciliation {
  const { binding, definitions, catalog, resolutions } = input;
  const currentPacks = binding.packs.map(identity);
  const proposedPacks = input.desired.map(identity);
  const currentById = new Map(currentPacks.map((pack) => [pack.id, pack]));
  const proposedById = new Map(proposedPacks.map((pack) => [pack.id, pack]));
  const proposedKeys = new Set(proposedPacks.map(tupleKey));
  const selectionChanged =
    currentPacks.length !== proposedPacks.length ||
    currentPacks.some((pack) => !proposedKeys.has(tupleKey(pack)));
  const base = {
    projectId: binding.projectId,
    bindingRevision: binding.configurationRevision,
    definitionRevision: definitions.revision,
    currentPacks,
    proposedPacks,
    added: proposedPacks.filter((pack) => !currentById.has(pack.id)),
    removed: currentPacks.filter((pack) => !proposedById.has(pack.id)),
    changed: proposedPacks.flatMap((after) => {
      const before = currentById.get(after.id);
      return before && tupleKey(before) !== tupleKey(after)
        ? [{ before, after }]
        : [];
    }),
    activePins: {
      availability: "unavailable",
      reason: "pack_configuration_run_pins_not_modelled",
    },
  } as const;
  const conversions = new Map<string, OverridePayload>();
  const finish = (
    rest: Pick<
      PackUpgradePlan,
      | "templates"
      | "roleCapabilityChanges"
      | "targetRoleCapabilities"
      | "capabilityContractChanges"
      | "overrides"
      | "ignoredResolutions"
      | "issues"
      | "noop"
      | "prospectiveConfigurationDigest"
    >,
  ): UpgradeReconciliation => {
    const plan = { ...base, ...rest };
    return { plan: { ...plan, planDigest: digestOf(plan) }, conversions };
  };

  // Same selection and every override already on a selected tuple: nothing to
  // reconcile. Like GP-05, this holds even when an artifact is now unavailable.
  if (
    !selectionChanged &&
    definitions.overrides.every(({ source }) =>
      proposedKeys.has(tupleKey(source)),
    )
  )
    return finish({
      templates: { availability: "available", changes: [] },
      // A no-op reads no artifact, so it has no capability set to report.
      roleCapabilityChanges: { availability: "available", changes: [] },
      targetRoleCapabilities: [],
      capabilityContractChanges: { availability: "available", changes: [] },
      overrides: definitions.overrides.map(({ source, operation }) => ({
        source,
        operation,
        outcome: "unchanged",
        upstream: "unchanged",
      })),
      ignoredResolutions: resolutions,
      issues: [],
      noop: true,
    });

  const issues: PackUpgradeIssue[] = [];
  let target: readonly ResolvedPackManifest[] | null = null;
  try {
    target = resolveInstalledPackManifests(catalog, proposedPacks);
  } catch (error) {
    const detail = closureFailure(error);
    if (detail === null) throw error;
    issues.push({
      code: "target_closure_unresolved",
      detail,
      message: "The proposed pack selection cannot be resolved on this host",
    });
  }
  let templates: PackUpgradePlan["templates"] = {
    availability: "available",
    changes: [],
  };
  let capabilityChanges: PackUpgradePlan["roleCapabilityChanges"] = {
    availability: "available",
    changes: [],
  };
  let contractChanges: PackUpgradePlan["capabilityContractChanges"] = {
    availability: "available",
    changes: [],
  };
  if (target && selectionChanged)
    try {
      const previous = resolveInstalledPackManifests(catalog, currentPacks);
      templates = {
        availability: "available",
        changes: templateChanges(previous, target, definitions.overrides),
      };
      capabilityChanges = {
        availability: "available",
        changes: roleCapabilityChanges(previous, target, definitions.overrides),
      };
      contractChanges = {
        availability: "available",
        changes: capabilityContractDifferences(previous, target),
      };
    } catch (error) {
      const detail = closureFailure(error);
      if (detail === null) throw error;
      templates = {
        availability: "unavailable",
        reason: "previous_closure_unresolved",
        detail,
      };
      capabilityChanges = templates;
      contractChanges = templates;
    }
  const targetRoleCapabilities = roleCapabilitySets(target ?? []);

  const targetManifests = new Map<string, DomainPackManifest>(
    (target ?? []).map((entry) => [tupleKey(entry.identity), entry.manifest]),
  );
  const previousManifests = new Map<string, DomainPackManifest | null>();
  const previousManifest = (pack: PackIdentity): DomainPackManifest | null => {
    const key = tupleKey(pack);
    if (!previousManifests.has(key)) {
      let manifest: DomainPackManifest | null = null;
      try {
        manifest =
          resolveInstalledPackManifests(catalog, [identity(pack)]).find(
            (entry) => tupleKey(entry.identity) === key,
          )?.manifest ?? null;
      } catch (error) {
        if (closureFailure(error) === null) throw error;
      }
      previousManifests.set(key, manifest);
    }
    return previousManifests.get(key) ?? null;
  };

  const resolutionBySource = new Map(
    resolutions.map((item) => [sourceKey(item.source), item]),
  );
  const usedResolutions = new Set<string>();
  const existingOverrides = new Set(
    definitions.overrides.map(({ source }) => sourceKey(source)),
  );
  const ownedKeys = new Set(
    definitions.owned.map(({ kind, id }) => `${kind}\u0000${id}`),
  );
  // Overrides that would land on one target definition. No order picks a
  // winner: all of them conflict until explicit removals leave exactly one.
  const claimants = new Map<string, number>();
  const standing = new Map<string, number>();
  for (const { source } of definitions.overrides) {
    if (proposedKeys.has(tupleKey(source))) continue;
    const next = proposedById.get(source.id);
    if (
      !next ||
      !targetManifests
        .get(tupleKey(next))
        ?.contributions[source.kind].some(
          (entry) => entry.id === source.localId,
        )
    )
      continue;
    const key = sourceKey({
      ...identity(next),
      kind: source.kind,
      localId: source.localId,
    });
    claimants.set(key, (claimants.get(key) ?? 0) + 1);
    if (resolutionBySource.get(sourceKey(source))?.action !== "remove_override")
      standing.set(key, (standing.get(key) ?? 0) + 1);
  }
  const overrides: OverrideReconciliation[] = [];
  for (const override of [...definitions.overrides].sort((left, right) =>
    compareExactSources(left.source, right.source),
  )) {
    const { source, operation } = override;
    if (proposedKeys.has(tupleKey(source))) {
      overrides.push({
        source,
        operation,
        outcome: "unchanged",
        upstream: "unchanged",
      });
      continue;
    }
    const next = proposedById.get(source.id);
    const nextManifest = next ? targetManifests.get(tupleKey(next)) : undefined;
    // An unresolved target closure is already a blocking issue; the override
    // cannot be classified against a template nobody could read.
    if (next && !nextManifest) {
      overrides.push({
        source,
        operation,
        outcome: "unchanged",
        upstream: "unknown",
      });
      continue;
    }
    const nextEntry = nextManifest?.contributions[source.kind].find(
      (entry) => entry.id === source.localId,
    );
    const previousEntry = previousManifest(source)?.contributions[
      source.kind
    ].find((entry) => entry.id === source.localId);
    const upstream: UpstreamChange =
      nextEntry === undefined
        ? "removed"
        : previousEntry === undefined
          ? "unknown"
          : sameContribution(previousEntry, nextEntry)
            ? "unchanged"
            : "changed";
    const retarget: ExactPackDefinitionSource | null =
      next && nextEntry
        ? { ...identity(next), kind: source.kind, localId: source.localId }
        : null;
    let conflict: OverrideConflictCode | null = null;
    if (!next) conflict = "source_pack_removed";
    else if (!retarget) conflict = "source_definition_removed";
    else if (
      existingOverrides.has(sourceKey(retarget)) ||
      ((claimants.get(sourceKey(retarget)) ?? 0) > 1 &&
        (standing.get(sourceKey(retarget)) !== 1 ||
          resolutionBySource.get(sourceKey(source))?.action ===
            "remove_override"))
    )
      conflict = "target_override_exists";
    else if (
      operation === "extend" &&
      override.payload &&
      (["title", "description"] as const).some(
        (key) =>
          override.payload?.[key] !== undefined &&
          nextEntry?.[key] !== undefined,
      )
    )
      conflict = "extend_conflict";

    if (conflict === null && retarget) {
      overrides.push({
        source,
        operation,
        outcome: "retargeted",
        upstream,
        target: retarget,
      });
      continue;
    }
    const code = conflict ?? "source_definition_removed";
    const resolution = resolutionBySource.get(sourceKey(source));
    if (!resolution) {
      overrides.push({
        source,
        operation,
        outcome: "conflict",
        upstream,
        conflict: code,
      });
      issues.push({
        code: "unresolved_override_conflict",
        detail: code,
        message: `Override of ${source.id}@${source.version} ${source.kind}/${source.localId} needs an explicit resolution`,
      });
      continue;
    }
    usedResolutions.add(sourceKey(source));
    if (resolution.action === "remove_override") {
      overrides.push({
        source,
        operation,
        outcome: "removed",
        upstream,
        conflict: code,
      });
      continue;
    }
    if (resolution.action === "convert_to_replace") {
      // Only an extension the new template now overlaps can become a complete
      // replacement: the project's fields win, the template supplies the rest,
      // and neither side's information is dropped.
      if (
        code !== "extend_conflict" ||
        !retarget ||
        !nextEntry ||
        !override.payload
      ) {
        overrides.push({
          source,
          operation,
          outcome: "conflict",
          upstream,
          conflict: code,
        });
        issues.push({
          code: "invalid_resolution",
          detail: code,
          message: `Override of ${source.id}@${source.version} ${source.kind}/${source.localId} cannot be converted to a replacement: only an extension conflict can`,
        });
        continue;
      }
      const title = override.payload.title ?? nextEntry.title;
      const description = override.payload.description ?? nextEntry.description;
      // An extension sets no reference, so an agent's references are among
      // the fields taken from the new template.
      const { role, prompts, knowledge, capabilities }: AgentContribution =
        source.kind === "agents" ? nextEntry : { id: nextEntry.id };
      // Nor does it set a task type or a stage: a workflow's replacement
      // takes both from the new template, the stages in the template's order.
      const workflow =
        source.kind === "workflows"
          ? (nextEntry as WorkflowContribution)
          : undefined;
      conversions.set(sourceKey(source), {
        id: source.localId,
        ...(title === undefined ? {} : { title }),
        ...(description === undefined ? {} : { description }),
        ...(role === undefined ? {} : { role }),
        ...(prompts === undefined ? {} : { prompts }),
        ...(knowledge === undefined ? {} : { knowledge }),
        ...(capabilities === undefined ? {} : { capabilities }),
        ...(workflow === undefined
          ? {}
          : {
              taskType: workflow.taskType,
              stages: workflow.stages.map(({ id, role: stageRole }) => ({
                id,
                role: stageRole,
              })),
            }),
      });
      overrides.push({
        source,
        operation,
        outcome: "converted_to_replace",
        upstream,
        target: retarget,
        conflict: code,
      });
      continue;
    }
    const ownedKey = `${source.kind}\u0000${source.localId}`;
    // Only a complete replacement whose template is gone can stand alone as a
    // project definition; anything else would duplicate or truncate material.
    const reason =
      operation !== "replace" || !override.payload
        ? "only a replace override carries a complete definition"
        : nextEntry !== undefined
          ? "the pack still provides this definition"
          : ownedKeys.has(ownedKey)
            ? "a project-owned definition already uses this identity"
            : // Every reference of an override names a definition of its
              // pack; a project-owned agent resolves project definitions only.
              source.kind === "agents" && hasAgentReferences(override.payload)
              ? "the agent references pack definitions, which a project-owned agent cannot name"
              : // A workflow always names a task type and stage roles of its
                // pack; retained, the same bare IDs would re-resolve in the
                // project namespace.
                source.kind === "workflows"
                ? "the workflow references pack definitions, which would silently re-resolve in the project namespace"
                : null;
    if (reason !== null) {
      overrides.push({
        source,
        operation,
        outcome: "conflict",
        upstream,
        conflict: code,
      });
      issues.push({
        code: "invalid_resolution",
        detail: code,
        message: `Override of ${source.id}@${source.version} ${source.kind}/${source.localId} cannot be retained as project-owned: ${reason}`,
      });
      continue;
    }
    ownedKeys.add(ownedKey);
    overrides.push({
      source,
      operation,
      outcome: "retained_as_project_owned",
      upstream,
      retainedAs: { kind: source.kind, id: source.localId },
      conflict: code,
    });
  }

  let prospectiveConfigurationDigest: string | undefined;
  if (issues.length === 0)
    try {
      const prospective = reconciledDefinitions(
        definitions,
        overrides,
        conversions,
        "preview",
        "1970-01-01T00:00:00.000Z",
      );
      prospectiveConfigurationDigest = resolveProjectConfiguration({
        projectId: binding.projectId,
        binding: {
          projectId: binding.projectId,
          configurationRevision:
            binding.configurationRevision + (selectionChanged ? 1 : 0),
          packs: proposedPacks,
        },
        definitions: {
          ...prospective,
          // Apply always writes the definition stream; see apply().
          revision: definitions.revision + 1,
        },
        catalog,
        coreContractVersion: catalog.coreContractVersion,
        // GP-16: a target whose required provider is missing does not
        // resolve, so the upgrade is blocked like any invalid target.
        ...(input.providers === undefined
          ? {}
          : { providers: input.providers }),
      }).configurationDigest;
    } catch (error) {
      if (!(error instanceof ProjectConfigurationResolutionError)) throw error;
      issues.push({
        code: "prospective_configuration_invalid",
        detail: error.code,
        // The GP-06 diagnostic names the definition and the reference or
        // capability that failed; it carries identities only.
        message: `The reconciled project configuration would not resolve: ${error.message}`,
      });
    }

  return finish({
    templates,
    roleCapabilityChanges: capabilityChanges,
    targetRoleCapabilities,
    capabilityContractChanges: contractChanges,
    overrides,
    ignoredResolutions: resolutions.filter(
      (item) => !usedResolutions.has(sourceKey(item.source)),
    ),
    issues,
    noop: false,
    ...(prospectiveConfigurationDigest === undefined
      ? {}
      : { prospectiveConfigurationDigest }),
  });
}

/**
 * Previews and applies a pack upgrade, detach or override reconciliation as
 * one audited change. Preview is the reconciliation report; apply requires the
 * digest of that exact report.
 */
export class ReconcileProjectPackUpgrade {
  constructor(
    private readonly dependencies: {
      projects: ProjectRepository;
      bindings: ProjectPackBindingRepository;
      definitions: ProjectDefinitionRepository;
      catalog: InstalledDomainPackCatalog;
      /** Absent means no registered provider; see the resolver. */
      providers?: OperationProviderCatalog;
      auditEvents: AuditEventRepository;
      transactions: TransactionRunner;
      clock: Clock;
      ids: IdGenerator;
    },
  ) {}

  async preview(input: {
    projectId: string;
    desired: readonly PackIdentity[];
    resolutions?: unknown;
  }): Promise<PackUpgradePlan> {
    return (await this.reconcile(input)).plan;
  }

  private async reconcile(input: {
    projectId: string;
    desired: readonly PackIdentity[];
    resolutions?: unknown;
  }): Promise<UpgradeReconciliation> {
    const desired = normalizePackSelection(input.desired);
    const resolutions = parseResolutions(input.resolutions ?? []);
    const { bindings, definitions, projects } = this.dependencies;
    const snapshot = await this.dependencies.transactions.run(async () => {
      if (!(await projects.findById(input.projectId)))
        throw new ProjectNotFoundError(input.projectId);
      const binding = await bindings.get(input.projectId);
      const state = await definitions.get(input.projectId);
      // Overlapping reads, as in GP-06: both revisions must hold together.
      if (
        (await bindings.get(input.projectId)).configurationRevision !==
          binding.configurationRevision ||
        (await definitions.get(input.projectId)).revision !== state.revision
      )
        throw new ProjectPackUpgradeError(
          "stale_snapshot",
          "Project pack selection or definitions changed during the read",
        );
      return { binding, state };
    });
    return reconcileProjectPackUpgrade({
      binding: snapshot.binding,
      definitions: snapshot.state,
      desired,
      resolutions,
      catalog: this.dependencies.catalog,
      ...(this.dependencies.providers === undefined
        ? {}
        : { providers: this.dependencies.providers }),
    });
  }

  async apply(input: {
    projectId: string;
    desired: readonly PackIdentity[];
    resolutions?: unknown;
    approvedPlanDigest: string;
    actorId: string;
  }): Promise<PackUpgradeResult> {
    const { plan, conversions } = await this.reconcile(input);
    if (plan.noop)
      return {
        result: "unchanged",
        planDigest: plan.planDigest,
        bindingRevision: plan.bindingRevision,
        definitionRevision: plan.definitionRevision,
        packs: plan.currentPacks,
      };
    if (plan.issues[0])
      throw new ProjectPackUpgradeError(
        "upgrade_blocked",
        `Pack upgrade is blocked: ${plan.issues[0].message}`,
        plan.issues,
      );
    if (plan.planDigest !== input.approvedPlanDigest)
      throw new ProjectPackUpgradeError(
        "plan_not_approved",
        "The approved digest does not match the current upgrade plan; preview it again",
      );
    return this.dependencies.transactions.run(async () => {
      const binding = await this.dependencies.bindings.get(input.projectId);
      if (binding.configurationRevision !== plan.bindingRevision)
        throw new StaleProjectPackBindingError(
          input.projectId,
          binding.configurationRevision,
        );
      const current = await this.dependencies.definitions.get(input.projectId);
      if (current.revision !== plan.definitionRevision)
        throw new StaleProjectDefinitionError(
          input.projectId,
          current.revision,
        );
      const now = this.dependencies.clock.now();
      const replaced = await this.dependencies.bindings.replace(
        input.projectId,
        plan.bindingRevision,
        plan.proposedPacks,
        now,
      );
      // Written even when no override changes: the repository's revision
      // fence is what makes a concurrent definition change fail stale on a
      // read-committed backend, where the read above takes no lock.
      const definitions = await this.dependencies.definitions.replace(
        reconciledDefinitions(
          current,
          plan.overrides,
          conversions,
          input.actorId,
          now.toISOString(),
        ),
        plan.definitionRevision,
        now,
      );
      await this.dependencies.auditEvents.append(
        AuditEvent.create({
          id: this.dependencies.ids.generate(),
          eventType: "project.pack_upgrade_applied",
          actorType: "cli",
          actorId: input.actorId,
          aggregateType: "project",
          aggregateId: input.projectId,
          projectId: input.projectId,
          payload: {
            intent: "upgrade",
            planDigest: plan.planDigest,
            previousBindingRevision: plan.bindingRevision,
            newBindingRevision: replaced.binding.configurationRevision,
            previousDefinitionRevision: plan.definitionRevision,
            newDefinitionRevision: definitions.revision,
            previousPacks: plan.currentPacks,
            packs: plan.proposedPacks,
            // Identities and outcomes only; never a definition body.
            overrides: plan.overrides.filter(
              (item) => item.outcome !== "unchanged",
            ),
            templates:
              plan.templates.availability === "available"
                ? {
                    availability: "available",
                    added: plan.templates.changes.filter(
                      (item) => item.change === "added",
                    ).length,
                    removed: plan.templates.changes.filter(
                      (item) => item.change === "removed",
                    ).length,
                    changed: plan.templates.changes.filter(
                      (item) => item.change === "changed",
                    ).length,
                  }
                : plan.templates,
            // Role and capability identities only.
            roleCapabilityChanges: plan.roleCapabilityChanges,
            targetRoleCapabilities: plan.targetRoleCapabilities,
            // Capability IDs, operation names, modes and requirements only.
            capabilityContractChanges: plan.capabilityContractChanges,
            prospectiveConfigurationDigest:
              plan.prospectiveConfigurationDigest ?? null,
            result: "applied",
          },
          occurredAt: now,
        }),
      );
      return {
        result: "applied",
        planDigest: plan.planDigest,
        bindingRevision: replaced.binding.configurationRevision,
        definitionRevision: definitions.revision,
        packs: replaced.binding.packs,
      };
    });
  }
}
