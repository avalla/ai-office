import { ProjectNotFoundError } from "../errors.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { OfficeManifestRepository } from "../ports/office-manifest-repository.port.ts";
import type { ProjectPackBindingRepository } from "../ports/project-pack-binding-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import {
  deriveLegacyDevelopmentProfile,
  type LegacyDevelopmentProfile,
} from "./legacy-development-profile.ts";

/**
 * Reads the legacy state of one project in one short transaction and derives
 * its GP-09 profile outside it. Read-only: it writes no row and records no
 * audit event. The project ID selects the rows and goes no further.
 */
export class ReadLegacyDevelopmentProfile {
  constructor(
    private readonly ports: {
      readonly projects: ProjectRepository;
      readonly officeManifests: Pick<OfficeManifestRepository, "findLatest">;
      readonly runtime: Pick<
        AgentRuntimeRepository,
        "listRoles" | "listAgents"
      >;
      readonly bindings: Pick<ProjectPackBindingRepository, "get">;
      readonly transactions: TransactionRunner;
    },
  ) {}

  async read(projectId: string): Promise<LegacyDevelopmentProfile> {
    const state = await this.ports.transactions.run(async () => {
      if (!(await this.ports.projects.findById(projectId)))
        throw new ProjectNotFoundError(projectId);
      return {
        office: await this.ports.officeManifests.findLatest(projectId),
        roles: await this.ports.runtime.listRoles(projectId),
        agents: await this.ports.runtime.listAgents(projectId),
        binding: await this.ports.bindings.get(projectId),
      };
    });
    return deriveLegacyDevelopmentProfile({
      office:
        state.office === null
          ? null
          : {
              revision: state.office.revision,
              manifest: state.office.manifest,
            },
      roles: state.roles.map((role) => role.snapshot()),
      agents: state.agents,
      packBindingPresent: state.binding.packs.length > 0,
    });
  }
}
