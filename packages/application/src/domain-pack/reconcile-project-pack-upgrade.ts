import { createHash } from "node:crypto";
import { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import {
  contributionKinds,
  type Contribution,
  type ContributionKind,
  type DomainPackManifest,
} from "../../../domain-pack-contracts/src/index.ts";
import { canonicalizeJcsJson } from "../../../domain-pack-contracts/src/jcs.ts";
import { ProjectNotFoundError } from "../errors.ts";
import {
  DomainPackCatalogError,
  type InstalledDomainPackCatalog,
  type PackIdentity,
} from "../ports/installed-domain-pack-catalog.port.ts";
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
  parseExactSource,
  sourceKey,
  type ExactPackDefinitionSource,
  type OverrideOperation,
  type ProjectDefinitionOverride,
  type ProjectDefinitionState,
  type ProjectOwnedDefinition,
} from "./project-definition.ts";
import {
  CapturedPackManifestError,
  resolveInstalledPackManifests,
  type ResolvedPackManifest,
} from "./resolve-installed-pack-manifests.ts";
import {
  ProjectConfigurationResolutionError,
  resolveProjectConfiguration,
} from "./resolve-project-configuration.ts";

/**
 * An operator's reviewed answer to one override that cannot follow its pack.
 * Nothing is retained, moved or removed without one.
 */
export type OverrideResolutionAction =
  "retain_as_project_owned" | "remove_override";

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
  "malformed_request" | "upgrade_blocked" | "plan_not_approved";

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
      if (action !== "retain_as_project_owned" && action !== "remove_override")
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
      return { source, action };
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

/**
 * The definition state after the plan's override outcomes. Operation and
 * payload of every surviving project entry are carried over unchanged.
 */
function reconciledDefinitions(
  current: ProjectDefinitionState,
  overrides: readonly OverrideReconciliation[],
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
        revision: override.revision + 1,
        actorId,
        changedAt,
      });
    else if (
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
}): PackUpgradePlan {
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
  const finish = (
    rest: Pick<
      PackUpgradePlan,
      | "templates"
      | "overrides"
      | "ignoredResolutions"
      | "issues"
      | "noop"
      | "prospectiveConfigurationDigest"
    >,
  ): PackUpgradePlan => {
    const plan = { ...base, ...rest };
    return { ...plan, planDigest: digestOf(plan) };
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
  if (target && selectionChanged)
    try {
      templates = {
        availability: "available",
        changes: templateChanges(
          resolveInstalledPackManifests(catalog, currentPacks),
          target,
          definitions.overrides,
        ),
      };
    } catch (error) {
      const detail = closureFailure(error);
      if (detail === null) throw error;
      templates = {
        availability: "unavailable",
        reason: "previous_closure_unresolved",
        detail,
      };
    }

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
  const claimedTargets = new Set<string>();
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
      claimedTargets.has(sourceKey(retarget))
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
      claimedTargets.add(sourceKey(retarget));
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

  const definitionsChanged = overrides.some(
    (item) => item.outcome !== "unchanged" && item.outcome !== "conflict",
  );
  let prospectiveConfigurationDigest: string | undefined;
  if (issues.length === 0)
    try {
      const prospective = reconciledDefinitions(
        definitions,
        overrides,
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
          revision: definitions.revision + (definitionsChanged ? 1 : 0),
        },
        catalog,
        coreContractVersion: catalog.coreContractVersion,
      }).configurationDigest;
    } catch (error) {
      if (!(error instanceof ProjectConfigurationResolutionError)) throw error;
      issues.push({
        code: "prospective_configuration_invalid",
        detail: error.code,
        message: "The reconciled project configuration would not resolve",
      });
    }

  return finish({
    templates,
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
        throw new StaleProjectDefinitionError(input.projectId, state.revision);
      return { binding, state };
    });
    return planProjectPackUpgrade({
      binding: snapshot.binding,
      definitions: snapshot.state,
      desired,
      resolutions,
      catalog: this.dependencies.catalog,
    });
  }

  async apply(input: {
    projectId: string;
    desired: readonly PackIdentity[];
    resolutions?: unknown;
    approvedPlanDigest: string;
    actorId: string;
  }): Promise<PackUpgradeResult> {
    const plan = await this.preview(input);
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
    const definitionsChanged = plan.overrides.some(
      (item) => item.outcome !== "unchanged",
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
      const definitions = definitionsChanged
        ? await this.dependencies.definitions.replace(
            reconciledDefinitions(
              current,
              plan.overrides,
              input.actorId,
              now.toISOString(),
            ),
            plan.definitionRevision,
            now,
          )
        : current;
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
