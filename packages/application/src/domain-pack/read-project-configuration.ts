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

  async read(projectId: string): Promise<ResolvedProjectConfiguration> {
    const revisions = await this.ports.transactions.run(() =>
      this.readRevisions(projectId),
    );
    return this.resolve(projectId, revisions);
  }

  /**
   * Same authoritative, staleness-checked read as `read()`, but assumes the
   * caller already holds an active transaction opened by the same
   * `TransactionRunner`/connection as `this.ports.transactions` (for example
   * another application service resolving a configuration pin inside its
   * own write transaction). Opening a second transaction here would throw
   * `TransactionAlreadyActiveError`, and reading outside that transaction
   * would reopen the race this staleness check exists to close.
   */
  async readWithinActiveTransaction(
    projectId: string,
  ): Promise<ResolvedProjectConfiguration> {
    const revisions = await this.readRevisions(projectId);
    return this.resolve(projectId, revisions);
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
  ): ResolvedProjectConfiguration {
    return resolveProjectConfiguration({
      projectId,
      binding: revisions.binding,
      definitions: revisions.definitions,
      catalog: this.ports.catalog,
      coreContractVersion: this.ports.catalog.coreContractVersion,
      ...(this.ports.providers === undefined
        ? {}
        : { providers: this.ports.providers }),
    });
  }
}
