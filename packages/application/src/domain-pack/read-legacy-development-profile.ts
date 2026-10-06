import { isDeepStrictEqual } from "node:util";
import { ProjectNotFoundError } from "../errors.ts";
import type { AgentRuntimeRepository } from "../ports/agent-runtime-repository.port.ts";
import type { OfficeManifestRepository } from "../ports/office-manifest-repository.port.ts";
import type { ProjectPackBindingRepository } from "../ports/project-pack-binding-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import {
  deriveLegacyDevelopmentProfile,
  LegacyDevelopmentProfileError,
  type LegacyDevelopmentProfile,
} from "./legacy-development-profile.ts";

/**
 * Reads the legacy state of one project in one short transaction and derives
 * its GP-09 profile outside it. Read-only: it writes no row and records no
 * audit event. The project ID selects the rows and goes no further.
 *
 * A PostgreSQL transaction is read committed, so each read sees what is
 * committed when it runs. Every source is therefore read twice, in the same
 * order. When no confirming read differs from its first read, every source
 * held its value from the last first read to the first confirming read, and
 * the profile is of the state at that moment. Otherwise the read fails with
 * `stale_legacy_state` and may be repeated. The office and the binding are
 * compared by revision; roles and agents have no revision and are compared
 * row for row, so a change that is undone inside the window, leaving every
 * row equal including `updatedAt`, is not seen.
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
      const observed = await this.observe(projectId);
      const confirmed = await this.observe(projectId);
      if (
        observed.office?.id !== confirmed.office?.id ||
        observed.office?.revision !== confirmed.office?.revision ||
        observed.binding.configurationRevision !==
          confirmed.binding.configurationRevision ||
        !isDeepStrictEqual(observed.roles, confirmed.roles) ||
        !isDeepStrictEqual(observed.agents, confirmed.agents)
      )
        throw new LegacyDevelopmentProfileError(
          "stale_legacy_state",
          "Legacy state changed during the read; run the command again",
        );
      return observed;
    });
    return deriveLegacyDevelopmentProfile({
      office:
        state.office === null
          ? null
          : {
              revision: state.office.revision,
              manifest: state.office.manifest,
            },
      roles: state.roles,
      agents: state.agents,
      packBindingPresent: state.binding.packs.length > 0,
    });
  }

  private async observe(projectId: string) {
    return {
      office: await this.ports.officeManifests.findLatest(projectId),
      roles: (await this.ports.runtime.listRoles(projectId)).map((role) =>
        role.snapshot(),
      ),
      agents: await this.ports.runtime.listAgents(projectId),
      binding: await this.ports.bindings.get(projectId),
    };
  }
}
