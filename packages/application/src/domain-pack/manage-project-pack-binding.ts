import { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import {
  DomainPackManifestError,
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
} from "../../../domain-pack-contracts/src/index.ts";
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
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { AuditEventRepository } from "../ports/audit-event-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import { resolveInstalledPacks } from "./resolve-installed-packs.ts";
import {
  CapturedPackManifestError,
  resolveInstalledPackManifests,
  type ResolvedPackManifest,
} from "./resolve-installed-pack-manifests.ts";
import {
  closureRoleIds,
  roleCapabilityDifferences,
  roleCapabilitySets,
  type RoleCapabilityDifference,
} from "./role-capability-changes.ts";

export class ProjectPackBindingProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} does not exist`);
    this.name = "ProjectPackBindingProjectNotFoundError";
  }
}

export const roleCapabilityChangeRequiresUpgrade =
  "role_capability_change_requires_upgrade" as const;

/**
 * A selection change this command does not carry out. A role capability
 * change is reviewed and approved through `project:pack:upgrade` only.
 */
export class ProjectPackBindingRefusedError extends Error {
  constructor(
    readonly code: typeof roleCapabilityChangeRequiresUpgrade,
    message: string,
  ) {
    super(message);
    this.name = "ProjectPackBindingRefusedError";
  }
}

export interface ProjectPackBindingPreview {
  readonly current: ProjectPackBinding;
  readonly proposed: readonly PackIdentity[];
  readonly added: readonly PackIdentity[];
  readonly removed: readonly PackIdentity[];
  readonly changed: readonly { before: PackIdentity; after: PackIdentity }[];
  /**
   * Role capability differences between the current and the proposed resolved
   * closures, computed as in the upgrade plan. Empty when the selection does
   * not change or cannot be resolved; `unavailable` when the current
   * artifacts are no longer installed.
   */
  readonly roleCapabilityChanges:
    | {
        readonly availability: "available";
        readonly changes: readonly RoleCapabilityDifference[];
      }
    | {
        readonly availability: "unavailable";
        readonly reason: "previous_closure_unresolved";
        readonly detail: string;
      };
  readonly issues: readonly { code: string; message: string }[];
}

/** Exact, structurally valid tuples, one per pack ID, in a stable order. */
export function normalizePackSelection(
  packs: readonly PackIdentity[],
): PackIdentity[] {
  if (!Array.isArray(packs))
    throw new DomainPackCatalogError(
      "malformed_request",
      "Expected an array of exact pack tuples",
    );
  const byId = new Set<string>();
  try {
    return packs
      .map((pack) => {
        const value = {
          id: parseDomainPackId(pack?.id),
          version: parseDomainPackVersion(pack?.version),
          manifestDigest: parseManifestDigest(pack?.manifestDigest),
        };
        if (byId.has(value.id))
          throw new DomainPackCatalogError(
            "version_conflict",
            `Pack ${value.id} is selected more than once`,
          );
        byId.add(value.id);
        return value;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (error instanceof DomainPackManifestError)
      throw new DomainPackCatalogError("malformed_request", error.message);
    throw error;
  }
}

function same(a: PackIdentity, b: PackIdentity): boolean {
  return (
    a.id === b.id &&
    a.version === b.version &&
    a.manifestDigest === b.manifestDigest
  );
}

const tupleKey = (pack: PackIdentity): string =>
  `${pack.id}\u0000${pack.version}\u0000${pack.manifestDigest}`;

/**
 * Target packs whose content is provably what the project already had: the
 * selected tuples that do not change and their exact-digest dependencies.
 */
function unchangedPackKeys(
  target: readonly ResolvedPackManifest[],
  unchanged: readonly PackIdentity[],
): Set<string> {
  const byKey = new Map(
    target.map((entry) => [tupleKey(entry.identity), entry]),
  );
  const seen = new Set<string>();
  const pending = unchanged.map(tupleKey);
  for (let key = pending.pop(); key !== undefined; key = pending.pop()) {
    if (seen.has(key)) continue;
    seen.add(key);
    for (const dependency of byKey.get(key)?.manifest.dependencies ?? [])
      pending.push(tupleKey(dependency));
  }
  return seen;
}

export class ManageProjectPackBinding {
  constructor(
    private readonly dependencies: {
      projects: ProjectRepository;
      bindings: ProjectPackBindingRepository;
      catalog: InstalledDomainPackCatalog;
      auditEvents: AuditEventRepository;
      transactions: TransactionRunner;
      clock: Clock;
      ids: IdGenerator;
    },
  ) {}

  async read(projectId: string): Promise<ProjectPackBinding> {
    if (!(await this.dependencies.projects.findById(projectId)))
      throw new ProjectPackBindingProjectNotFoundError(projectId);
    return this.dependencies.bindings.get(projectId);
  }

  async preview(
    projectId: string,
    desired: readonly PackIdentity[],
  ): Promise<ProjectPackBindingPreview> {
    const current = await this.read(projectId);
    const issues: { code: string; message: string }[] = [];
    let proposed: PackIdentity[];
    try {
      proposed = normalizePackSelection(desired);
    } catch (error) {
      if (
        !(error instanceof DomainPackCatalogError) ||
        error.code !== "version_conflict"
      )
        throw error;
      issues.push({ code: error.code, message: error.message });
      proposed = [...desired].sort((a, b) => a.id.localeCompare(b.id));
    }
    const currentById = new Map(current.packs.map((pack) => [pack.id, pack]));
    const proposedById = new Map(proposed.map((pack) => [pack.id, pack]));
    const added = proposed.filter((pack) => !currentById.has(pack.id));
    const removed = current.packs.filter((pack) => !proposedById.has(pack.id));
    const changed = proposed.flatMap((after) => {
      const before = currentById.get(after.id);
      return before && !same(before, after) ? [{ before, after }] : [];
    });
    if (issues.length === 0) {
      try {
        resolveInstalledPacks(this.dependencies.catalog, proposed);
      } catch (error) {
        if (error instanceof DomainPackCatalogError)
          issues.push({ code: error.code, message: error.message });
        else throw error;
      }
    }
    let roleCapabilityChanges: ProjectPackBindingPreview["roleCapabilityChanges"] =
      { availability: "available", changes: [] };
    // An unchanged selection reads no further artifact, as before GP-11.
    if (
      issues.length === 0 &&
      added.length + removed.length + changed.length > 0
    ) {
      const guard = this.roleCapabilityGuard(current.packs, proposed, changed);
      roleCapabilityChanges = guard.roleCapabilityChanges;
      if (guard.issue) issues.push(guard.issue);
    }
    return {
      current,
      proposed,
      added,
      removed,
      changed,
      roleCapabilityChanges,
      issues,
    };
  }

  /**
   * A role capability change is never incidental. This command refuses a
   * selection change that alters the capability set of a role present in both
   * closures, and one it cannot show to be capability-neutral; either goes
   * through the reviewed `project:pack:upgrade` plan.
   */
  private roleCapabilityGuard(
    currentPacks: readonly PackIdentity[],
    proposed: readonly PackIdentity[],
    changed: ProjectPackBindingPreview["changed"],
  ): {
    roleCapabilityChanges: ProjectPackBindingPreview["roleCapabilityChanges"];
    issue?: { code: string; message: string };
  } {
    const closure = (
      packs: readonly PackIdentity[],
    ): readonly ResolvedPackManifest[] | string => {
      try {
        return resolveInstalledPackManifests(this.dependencies.catalog, packs);
      } catch (error) {
        if (
          error instanceof DomainPackCatalogError ||
          error instanceof CapturedPackManifestError
        )
          return error.code;
        throw error;
      }
    };
    const refuse = (reason: string) => ({
      code: roleCapabilityChangeRequiresUpgrade,
      message: `${reason}; review and approve it with project:pack:upgrade`,
    });
    const target = closure(proposed);
    // The public resolver just accepted this closure; a manifest that cannot
    // be read back cannot be shown to be capability-neutral.
    if (typeof target === "string")
      return {
        roleCapabilityChanges: { availability: "available", changes: [] },
        issue: refuse(
          `Role capabilities of the proposed selection cannot be read (${target})`,
        ),
      };
    const previous = closure(currentPacks);
    if (typeof previous === "string") {
      const roleCapabilityChanges = {
        availability: "unavailable",
        reason: "previous_closure_unresolved",
        detail: previous,
      } as const;
      if (changed.length === 0) return { roleCapabilityChanges };
      // The old sets are unknown. Only tuples the project keeps, and their
      // exact dependencies, are known to declare what they declared before.
      const changedIds = new Set(changed.map(({ after }) => after.id));
      const known = unchangedPackKeys(
        target,
        proposed.filter((pack) => !changedIds.has(pack.id)),
      );
      // A newly selected pack is an explicit addition, not a version change.
      const currentIds = new Set(currentPacks.map((pack) => pack.id));
      const addedKeys = new Set(
        proposed.filter((pack) => !currentIds.has(pack.id)).map(tupleKey),
      );
      const unknown = roleCapabilitySets(
        target.filter(
          ({ identity }) =>
            !known.has(tupleKey(identity)) &&
            !addedKeys.has(tupleKey(identity)),
        ),
      );
      return {
        roleCapabilityChanges,
        ...(unknown[0]
          ? {
              issue: refuse(
                `The current pack artifacts are not installed, so the version change cannot be shown to keep the capabilities of ${unknown[0].roleId}`,
              ),
            }
          : {}),
      };
    }
    const changes = roleCapabilityDifferences(previous, target);
    const before = closureRoleIds(previous);
    const after = closureRoleIds(target);
    const altered = changes.find(
      ({ roleId }) => before.has(roleId) && after.has(roleId),
    );
    return {
      roleCapabilityChanges: { availability: "available", changes },
      ...(altered
        ? {
            issue: refuse(
              `The selection changes the capabilities of role ${altered.roleId}`,
            ),
          }
        : {}),
    };
  }

  async apply(input: {
    projectId: string;
    desired: readonly PackIdentity[];
    expectedRevision: number;
    actorId: string;
  }): Promise<ProjectPackBinding> {
    if (
      !Number.isSafeInteger(input.expectedRevision) ||
      input.expectedRevision < 0
    )
      throw new DomainPackCatalogError(
        "malformed_request",
        "Expected a nonnegative project pack configuration revision",
      );
    const desired = normalizePackSelection(input.desired);
    const current = await this.read(input.projectId);
    if (current.configurationRevision !== input.expectedRevision)
      throw new StaleProjectPackBindingError(
        input.projectId,
        current.configurationRevision,
      );
    if (JSON.stringify(current.packs) !== JSON.stringify(desired)) {
      const preview = await this.preview(input.projectId, desired);
      if (preview.issues[0]?.code === roleCapabilityChangeRequiresUpgrade)
        throw new ProjectPackBindingRefusedError(
          roleCapabilityChangeRequiresUpgrade,
          preview.issues[0].message,
        );
      if (preview.issues[0])
        throw new DomainPackCatalogError(
          preview.issues[0].code as DomainPackCatalogError["code"],
          preview.issues[0].message,
        );
      resolveInstalledPacks(this.dependencies.catalog, preview.proposed);
    }
    return this.dependencies.transactions.run(async () => {
      const previous = await this.dependencies.bindings.get(input.projectId);
      if (previous.configurationRevision !== input.expectedRevision)
        throw new StaleProjectPackBindingError(
          input.projectId,
          previous.configurationRevision,
        );
      const result = await this.dependencies.bindings.replace(
        input.projectId,
        input.expectedRevision,
        desired,
        this.dependencies.clock.now(),
      );
      if (result.changed)
        await this.dependencies.auditEvents.append(
          AuditEvent.create({
            id: this.dependencies.ids.generate(),
            eventType: "project.pack_binding_applied",
            actorType: "cli",
            actorId: input.actorId,
            aggregateType: "project",
            aggregateId: input.projectId,
            projectId: input.projectId,
            payload: {
              intent: "replace",
              previousRevision: previous.configurationRevision,
              newRevision: result.binding.configurationRevision,
              previousPacks: previous.packs,
              packs: result.binding.packs,
              result: "applied",
            },
            occurredAt: this.dependencies.clock.now(),
          }),
        );
      return result.binding;
    });
  }
}
