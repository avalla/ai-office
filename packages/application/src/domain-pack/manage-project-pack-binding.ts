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

export class ProjectPackBindingProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} does not exist`);
    this.name = "ProjectPackBindingProjectNotFoundError";
  }
}

export interface ProjectPackBindingPreview {
  readonly current: ProjectPackBinding;
  readonly proposed: readonly PackIdentity[];
  readonly added: readonly PackIdentity[];
  readonly removed: readonly PackIdentity[];
  readonly changed: readonly { before: PackIdentity; after: PackIdentity }[];
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
    return { current, proposed, added, removed, changed, issues };
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
