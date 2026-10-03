import type { InstalledDomainPackCatalog } from "../ports/installed-domain-pack-catalog.port.ts";
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
    },
  ) {}

  async read(projectId: string): Promise<ResolvedProjectConfiguration> {
    const { binding, definitions } = await this.ports.transactions.run(
      async () => {
        if (!(await this.ports.projects.findById(projectId)))
          throw new ProjectConfigurationResolutionError(
            "configuration_invariant",
            "Project does not exist",
          );
        const binding = await this.ports.bindings.get(projectId);
        const definitions = await this.ports.definitions.get(projectId);
        const bindingCheck = await this.ports.bindings.get(projectId);
        const definitionsCheck = await this.ports.definitions.get(projectId);
        if (
          binding.configurationRevision !==
            bindingCheck.configurationRevision ||
          definitions.revision !== definitionsCheck.revision
        )
          throw new ProjectConfigurationResolutionError(
            "stale_resolution",
            "Project configuration changed during the read",
          );
        return { binding, definitions };
      },
    );
    return resolveProjectConfiguration({
      projectId,
      binding,
      definitions,
      catalog: this.ports.catalog,
      coreContractVersion: this.ports.catalog.coreContractVersion,
    });
  }
}
