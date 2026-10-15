import { ProjectNotFoundError } from "../errors.ts";
import type { InstalledDomainPackCatalog } from "../ports/installed-domain-pack-catalog.port.ts";
import type { OperationProviderCatalog } from "../ports/operation-provider-catalog.port.ts";
import type { ProjectPackBindingRepository } from "../ports/project-pack-binding-repository.port.ts";
import type { ProjectDefinitionRepository } from "../ports/project-definition-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import {
  ProjectConfigurationResolutionError,
  resolveProjectConfiguration,
  type ResolvedProjectConfiguration,
} from "./resolve-project-configuration.ts";

/** Reads both authoritative revision streams over an overlapping interval. */
export class ReadProjectConfiguration {
  constructor(
    private readonly ports: {
      readonly projects: ProjectRepository;
      readonly bindings: ProjectPackBindingRepository;
      readonly definitions: ProjectDefinitionRepository;
      readonly transactions: TransactionRunner;
      readonly catalog: InstalledDomainPackCatalog;
      /** Absent means no registered provider; see the resolver. */
      readonly providers?: OperationProviderCatalog;
    },
  ) {}

  /**
   * Whether the project's pack selection is nonempty, read outside any
   * transaction. Advisory only: a caller may use it to keep a cheap, lock-free
   * pre-check for projects with no pack, and must decide again under its own
   * transaction.
   */
  async selectsPacks(projectId: string): Promise<boolean> {
    return (await this.ports.bindings.get(projectId)).packs.length > 0;
  }

  async read(projectId: string): Promise<ResolvedProjectConfiguration> {
    const revisions = await this.ports.transactions.run(() =>
      this.readRevisions(projectId),
    );
    return this.resolve(projectId, revisions);
  }

  /**
   * The staleness-checked configuration pin, for a caller that already holds
   * an active transaction opened by the same `TransactionRunner` as
   * `this.ports.transactions` (for example a service pinning a run inside its
   * own write transaction). Opening a second transaction here would throw
   * `TransactionAlreadyActiveError`, and reading outside that transaction
   * would reopen the race the staleness check exists to close.
   *
   * Provider binding is skipped: the pin is provider-independent, and gating
   * a run on registered providers is a separate, deferred decision (GP-16).
   */
  async readPinWithinActiveTransaction(
    projectId: string,
  ): Promise<ResolvedProjectConfiguration> {
    const revisions = await this.readRevisions(projectId);
    return this.resolve(projectId, revisions, { bindProviders: false });
  }

  private async readRevisions(projectId: string): Promise<{
    binding: Awaited<ReturnType<ProjectPackBindingRepository["get"]>>;
    definitions: Awaited<ReturnType<ProjectDefinitionRepository["get"]>>;
  }> {
    if (!(await this.ports.projects.findById(projectId)))
      throw new ProjectNotFoundError(projectId);
    const binding = await this.ports.bindings.get(projectId);
    const definitions = await this.ports.definitions.get(projectId);
    const bindingCheck = await this.ports.bindings.get(projectId);
    const definitionsCheck = await this.ports.definitions.get(projectId);
    if (
      binding.configurationRevision !== bindingCheck.configurationRevision ||
      definitions.revision !== definitionsCheck.revision
    )
      throw new ProjectConfigurationResolutionError(
        "stale_resolution",
        "Project configuration changed during the read",
      );
    return { binding, definitions };
  }

  private resolve(
    projectId: string,
    revisions: {
      binding: Awaited<ReturnType<ProjectPackBindingRepository["get"]>>;
      definitions: Awaited<ReturnType<ProjectDefinitionRepository["get"]>>;
    },
    options: { readonly bindProviders?: boolean } = {},
  ): ResolvedProjectConfiguration {
    return resolveProjectConfiguration({
      projectId,
      binding: revisions.binding,
      definitions: revisions.definitions,
      catalog: this.ports.catalog,
      coreContractVersion: this.ports.catalog.coreContractVersion,
      ...(options.bindProviders === undefined
        ? {}
        : { bindProviders: options.bindProviders }),
      ...(this.ports.providers === undefined
        ? {}
        : { providers: this.ports.providers }),
    });
  }
}
