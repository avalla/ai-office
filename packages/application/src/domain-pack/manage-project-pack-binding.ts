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
  noOperationProviders,
  type OperationProviderCatalog,
} from "../ports/operation-provider-catalog.port.ts";
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
import { resolveInstalledPacks } from "./resolve-installed-packs.ts";
import {
  CapturedPackManifestError,
  resolveInstalledPackManifests,
  type ResolvedPackManifest,
} from "./resolve-installed-pack-manifests.ts";
import {
  packDefinitionCollision,
  packDefinitionCollisions,
} from "./pack-definition-collisions.ts";
import {
  closureKnowledgeIds,
  knowledgeGuidanceDifferences,
  type KnowledgeGuidanceDifference,
} from "./pack-knowledge-changes.ts";
import {
  closureWorkflowIds,
  workflowPolicyDifferences,
  type WorkflowPolicyDifference,
} from "./pack-policy-changes.ts";
import type { ProjectOwnedDefinition } from "./project-definition.ts";
import {
  bindCapabilityContracts,
  capabilityContractDifferences,
  closureCapabilityIds,
  type CapabilityBindingIssueCode,
  type CapabilityContractDifference,
} from "./capability-contracts.ts";
import {
  closureRoleIds,
  roleCapabilityDifferences,
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

export const capabilityContractChangeRequiresUpgrade =
  "capability_contract_change_requires_upgrade" as const;

export const policyChangeRequiresUpgrade =
  "policy_change_requires_upgrade" as const;

export const knowledgeChangeRequiresUpgrade =
  "knowledge_change_requires_upgrade" as const;

/**
 * A selection change this command does not carry out. A role capability
 * change, a change to the operation contract of an existing capability
 * (GP-16), a change to the policy of an existing workflow (GP-25) and a
 * change to the typed guidance of an existing knowledge entry (GP-15) are
 * reviewed and approved through `project:pack:upgrade` only.
 */
export class ProjectPackBindingRefusedError extends Error {
  constructor(
    readonly code:
      | typeof roleCapabilityChangeRequiresUpgrade
      | typeof capabilityContractChangeRequiresUpgrade
      | typeof policyChangeRequiresUpgrade
      | typeof knowledgeChangeRequiresUpgrade,
    message: string,
  ) {
    super(message);
    this.name = "ProjectPackBindingRefusedError";
  }
}

/**
 * The proposed resolved closure declares an operation this host cannot
 * provide as declared (GP-16). The selection is not applied; the code is the
 * one resolution reports for the same closure.
 */
export class ProjectPackBindingProviderError extends Error {
  constructor(
    readonly code: CapabilityBindingIssueCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectPackBindingProviderError";
  }
}

const providerIssueCodes: ReadonlySet<string> = new Set([
  "missing_required_capability_provider",
  "capability_provider_mismatch",
  "configuration_invariant",
] satisfies CapabilityBindingIssueCode[]);

const isProviderIssueCode = (
  code: string,
): code is CapabilityBindingIssueCode => providerIssueCodes.has(code);

/**
 * The proposed resolved closure contains a definition with the kind and local
 * ID of a project-owned definition (GP-22). The selection is not applied; the
 * code is the one GP-07 reports for the same conflict.
 */
export class ProjectPackBindingCollisionError extends Error {
  constructor(
    readonly code: typeof packDefinitionCollision,
    message: string,
  ) {
    super(message);
    this.name = "ProjectPackBindingCollisionError";
  }
}

/**
 * A policy change is never incidental (GP-25). A selection change that alters
 * the policy of a workflow present in both closures is refused: a changed
 * policy, a policy added to an existing workflow and a policy removed from
 * one. A workflow that only one closure provides is an addition or a removal
 * of the workflow, which stays an explicit selection change.
 */
function policyChangeGuard(
  previous: readonly ResolvedPackManifest[],
  target: readonly ResolvedPackManifest[],
): {
  changes: WorkflowPolicyDifference[];
  issue?: { code: string; message: string };
} {
  const changes = workflowPolicyDifferences(previous, target);
  const before = closureWorkflowIds(previous);
  const after = closureWorkflowIds(target);
  const altered = changes.find(
    ({ workflowId }) => before.has(workflowId) && after.has(workflowId),
  );
  return {
    changes,
    ...(altered
      ? {
          issue: {
            code: policyChangeRequiresUpgrade,
            message: `The selection changes the policy of workflow ${altered.workflowId}; review and approve it with project:pack:upgrade`,
          },
        }
      : {}),
  };
}

/**
 * A knowledge guidance change is never incidental (GP-15). A selection change
 * that alters the typed guidance of an entry present in both closures is
 * refused: changed guidance, guidance added to an existing entry and guidance
 * removed from one. An entry that only one closure provides is an addition or
 * a removal of the entry, which stays an explicit selection change.
 */
function knowledgeChangeGuard(
  previous: readonly ResolvedPackManifest[],
  target: readonly ResolvedPackManifest[],
): {
  changes: KnowledgeGuidanceDifference[];
  issue?: { code: string; message: string };
} {
  const changes = knowledgeGuidanceDifferences(previous, target);
  const before = closureKnowledgeIds(previous);
  const after = closureKnowledgeIds(target);
  const altered = changes.find(
    ({ knowledgeId }) => before.has(knowledgeId) && after.has(knowledgeId),
  );
  return {
    changes,
    ...(altered
      ? {
          issue: {
            code: knowledgeChangeRequiresUpgrade,
            message: `The selection changes the guidance of knowledge ${altered.knowledgeId}; review and approve it with project:pack:upgrade`,
          },
        }
      : {}),
  };
}

function collisionIssues(
  closure: readonly ResolvedPackManifest[],
  owned: readonly ProjectOwnedDefinition[],
): { code: typeof packDefinitionCollision; message: string }[] {
  return packDefinitionCollisions(closure, owned).map(({ kind, id, pack }) => ({
    code: packDefinitionCollision,
    message: `Project definition ${kind}/${id} collides with pack ${pack} in the proposed pack closure`,
  }));
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
   * artifacts are no longer installed or the proposed manifests cannot be
   * read back.
   */
  readonly roleCapabilityChanges:
    | {
        readonly availability: "available";
        readonly changes: readonly RoleCapabilityDifference[];
      }
    | {
        readonly availability: "unavailable";
        readonly reason:
          "previous_closure_unresolved" | "proposed_closure_unreadable";
        readonly detail: string;
      };
  /**
   * Operation contract differences between the current and the proposed
   * resolved closures (GP-16), computed as in the upgrade plan and available
   * under the same conditions as `roleCapabilityChanges`.
   */
  readonly capabilityContractChanges:
    | {
        readonly availability: "available";
        readonly changes: readonly CapabilityContractDifference[];
      }
    | {
        readonly availability: "unavailable";
        readonly reason:
          "previous_closure_unresolved" | "proposed_closure_unreadable";
        readonly detail: string;
      };
  /**
   * Workflow policy differences between the current and the proposed
   * resolved closures (GP-25), computed as in the upgrade plan and with the
   * availability of `roleCapabilityChanges`.
   */
  readonly policyChanges:
    | {
        readonly availability: "available";
        readonly changes: readonly WorkflowPolicyDifference[];
      }
    | {
        readonly availability: "unavailable";
        readonly reason:
          "previous_closure_unresolved" | "proposed_closure_unreadable";
        readonly detail: string;
      };
  /**
   * Knowledge guidance differences between the current and the proposed
   * resolved closures (GP-15), computed as in the upgrade plan and with the
   * availability of `roleCapabilityChanges`.
   */
  readonly knowledgeChanges:
    | {
        readonly availability: "available";
        readonly changes: readonly KnowledgeGuidanceDifference[];
      }
    | {
        readonly availability: "unavailable";
        readonly reason:
          "previous_closure_unresolved" | "proposed_closure_unreadable";
        readonly detail: string;
      };
  /**
   * In order: a GP-04 selection or availability failure, alone; then one
   * `pack_definition_collision` for each project-owned definition that the
   * proposed closure also contains; then the GP-16 provider issues of the
   * proposed closure; then the GP-11 capability refusal; then the GP-16
   * contract change refusal; then the GP-25 policy refusal; then the GP-15
   * knowledge guidance refusal. Apply raises the first.
   */
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

export class ManageProjectPackBinding {
  constructor(
    private readonly dependencies: {
      projects: ProjectRepository;
      bindings: ProjectPackBindingRepository;
      definitions: ProjectDefinitionRepository;
      catalog: InstalledDomainPackCatalog;
      /** Absent means no registered provider, so nothing is bound by omission. */
      providers?: OperationProviderCatalog;
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
    return (await this.examine(projectId, desired)).preview;
  }

  /**
   * The preview, and the proposed closure it was computed from when that
   * closure resolved and its manifests could be read. Resolution and catalog
   * access happen here, outside any transaction.
   */
  private async examine(
    projectId: string,
    desired: readonly PackIdentity[],
  ): Promise<{
    preview: ProjectPackBindingPreview;
    closure?: readonly ResolvedPackManifest[];
  }> {
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
    // The one GP-04 resolution of the proposed selection. It also captures
    // the manifests the composition preflight compares, so the artifacts are
    // read once and no second resolver is involved.
    let resolved = false;
    let closure: readonly ResolvedPackManifest[] | undefined;
    if (issues.length === 0) {
      try {
        closure = resolveInstalledPackManifests(
          this.dependencies.catalog,
          proposed,
        );
        resolved = true;
      } catch (error) {
        if (error instanceof DomainPackCatalogError)
          issues.push({ code: error.code, message: error.message });
        // GP-04 accepted the closure but a manifest could not be read back.
        // The capability guard below refuses a changed selection for that.
        else if (error instanceof CapturedPackManifestError) resolved = true;
        else throw error;
      }
    }
    // GP-22: every project-owned definition against the proposed closure. An
    // unchanged selection is compared too, so a latent collision stays
    // visible here.
    if (closure !== undefined)
      issues.push(
        ...collisionIssues(
          closure,
          (await this.dependencies.definitions.get(projectId)).owned,
        ),
      );
    // GP-16: every operation the proposed closure declares against this
    // host's providers. Like the collisions, an unchanged selection is checked
    // too, so a provider that went missing stays visible here.
    if (closure !== undefined) {
      const bound = bindCapabilityContracts(
        closure,
        this.dependencies.providers ?? noOperationProviders,
      );
      if ("issues" in bound) issues.push(...bound.issues);
    }
    let roleCapabilityChanges: ProjectPackBindingPreview["roleCapabilityChanges"] =
      { availability: "available", changes: [] };
    let capabilityContractChanges: ProjectPackBindingPreview["capabilityContractChanges"] =
      { availability: "available", changes: [] };
    let policyChanges: ProjectPackBindingPreview["policyChanges"] = {
      availability: "available",
      changes: [],
    };
    let knowledgeChanges: ProjectPackBindingPreview["knowledgeChanges"] = {
      availability: "available",
      changes: [],
    };
    // An unchanged selection reads no further artifact, as before GP-11. A
    // collision does not hide the capability refusal; it is listed first.
    if (resolved && added.length + removed.length + changed.length > 0) {
      const guard = this.roleCapabilityGuard(current.packs, proposed);
      roleCapabilityChanges = guard.roleCapabilityChanges;
      capabilityContractChanges = guard.capabilityContractChanges;
      if (guard.issue) issues.push(guard.issue);
      if (guard.contractIssue) issues.push(guard.contractIssue);
      // GP-25: the same two closures. Where they cannot be read the GP-11
      // rule above already refused everything but a pure removal.
      if (guard.roleCapabilityChanges.availability === "unavailable") {
        policyChanges = guard.roleCapabilityChanges;
        knowledgeChanges = guard.roleCapabilityChanges;
      } else if (guard.closures !== undefined) {
        const policy = policyChangeGuard(
          guard.closures.previous,
          guard.closures.target,
        );
        policyChanges = { availability: "available", changes: policy.changes };
        if (policy.issue) issues.push(policy.issue);
        // GP-15: the same two closures.
        const knowledge = knowledgeChangeGuard(
          guard.closures.previous,
          guard.closures.target,
        );
        knowledgeChanges = {
          availability: "available",
          changes: knowledge.changes,
        };
        if (knowledge.issue) issues.push(knowledge.issue);
      }
    }
    return {
      preview: {
        current,
        proposed,
        added,
        removed,
        changed,
        roleCapabilityChanges,
        capabilityContractChanges,
        policyChanges,
        knowledgeChanges,
        issues,
      },
      ...(closure === undefined ? {} : { closure }),
    };
  }

  /**
   * A role capability change is never incidental. This command refuses a
   * selection change that alters the capability set of a role present in both
   * closures. When the current closure cannot be resolved it applies only a
   * pure removal. Everything else goes through the reviewed
   * `project:pack:upgrade` plan. The same holds, with its own code, for the
   * operation contract of a capability present in both closures (GP-16).
   */
  private roleCapabilityGuard(
    currentPacks: readonly PackIdentity[],
    proposed: readonly PackIdentity[],
  ): {
    roleCapabilityChanges: ProjectPackBindingPreview["roleCapabilityChanges"];
    capabilityContractChanges: ProjectPackBindingPreview["capabilityContractChanges"];
    issue?: { code: string; message: string };
    contractIssue?: { code: string; message: string };
    /** Both closures, when both could be read. */
    closures?: {
      previous: readonly ResolvedPackManifest[];
      target: readonly ResolvedPackManifest[];
    };
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
    if (typeof target === "string") {
      const unavailable = {
        availability: "unavailable",
        reason: "proposed_closure_unreadable",
        detail: target,
      } as const;
      return {
        roleCapabilityChanges: unavailable,
        capabilityContractChanges: unavailable,
        issue: refuse(
          `Role capabilities of the proposed selection cannot be read (${target})`,
        ),
      };
    }
    const previous = closure(currentPacks);
    if (typeof previous === "string") {
      const roleCapabilityChanges = {
        availability: "unavailable",
        reason: "previous_closure_unresolved",
        detail: previous,
      } as const;
      // Without the old manifests neither an added nor a removed role
      // capability can be ruled out: a role may have lost a set the target no
      // longer declares, and a newly selected pack may have been an old
      // dependency at another version. Only a pure removal, which leaves
      // nothing but tuples the project already selected, is applied here.
      const currentKeys = new Set(currentPacks.map(tupleKey));
      return {
        roleCapabilityChanges,
        // The same refusal covers the operation contracts: neither can be
        // compared without the old manifests.
        capabilityContractChanges: roleCapabilityChanges,
        ...(proposed.every((pack) => currentKeys.has(tupleKey(pack)))
          ? {}
          : {
              issue: refuse(
                "The current pack artifacts are not installed, so the selection change cannot be shown to leave role capabilities unchanged",
              ),
            }),
      };
    }
    const changes = roleCapabilityDifferences(previous, target);
    const before = closureRoleIds(previous);
    const after = closureRoleIds(target);
    const altered = changes.find(
      ({ roleId }) => before.has(roleId) && after.has(roleId),
    );
    const contractChanges = capabilityContractDifferences(previous, target);
    const capabilitiesBefore = closureCapabilityIds(previous);
    const capabilitiesAfter = closureCapabilityIds(target);
    const alteredContract = contractChanges.find(
      ({ capabilityId }) =>
        capabilitiesBefore.has(capabilityId) &&
        capabilitiesAfter.has(capabilityId),
    );
    return {
      roleCapabilityChanges: { availability: "available", changes },
      capabilityContractChanges: {
        availability: "available",
        changes: contractChanges,
      },
      ...(alteredContract
        ? {
            contractIssue: {
              code: capabilityContractChangeRequiresUpgrade,
              message: `The selection changes the operation contract of capability ${alteredContract.capabilityId}; review and approve it with project:pack:upgrade`,
            },
          }
        : {}),
      closures: { previous, target },
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
    // Set only for a changed selection. The unchanged active selection stays
    // the GP-05 no-op: no resolution and no composition preflight.
    let proposedClosure: readonly ResolvedPackManifest[] | undefined;
    if (JSON.stringify(current.packs) !== JSON.stringify(desired)) {
      const { preview, closure } = await this.examine(input.projectId, desired);
      if (preview.issues[0]?.code === packDefinitionCollision)
        throw new ProjectPackBindingCollisionError(
          packDefinitionCollision,
          preview.issues[0].message,
        );
      const first = preview.issues[0];
      if (first !== undefined && isProviderIssueCode(first.code))
        throw new ProjectPackBindingProviderError(first.code, first.message);
      if (
        first?.code === roleCapabilityChangeRequiresUpgrade ||
        first?.code === capabilityContractChangeRequiresUpgrade ||
        first?.code === policyChangeRequiresUpgrade ||
        first?.code === knowledgeChangeRequiresUpgrade
      )
        throw new ProjectPackBindingRefusedError(first.code, first.message);
      if (preview.issues[0])
        throw new DomainPackCatalogError(
          preview.issues[0].code as DomainPackCatalogError["code"],
          preview.issues[0].message,
        );
      resolveInstalledPacks(this.dependencies.catalog, preview.proposed);
      // Unreachable while the guard above refuses an unreadable closure; a
      // changed selection is never committed without its preflight.
      if (closure === undefined)
        throw new DomainPackCatalogError(
          "malformed_catalog_entry",
          "The proposed pack closure could not be read back for the composition preflight",
        );
      proposedClosure = closure;
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
      // A project-owned definition may have been committed since the
      // preflight. Re-read the definitions under this transaction and compare
      // them with the closure resolved before it; the catalog is not read
      // again. Throwing rolls the replacement back.
      if (proposedClosure !== undefined) {
        const collision = collisionIssues(
          proposedClosure,
          (await this.dependencies.definitions.get(input.projectId)).owned,
        )[0];
        if (collision)
          throw new ProjectPackBindingCollisionError(
            collision.code,
            collision.message,
          );
      }
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
