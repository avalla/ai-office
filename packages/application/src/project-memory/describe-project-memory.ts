import type {
  ProjectMemoryProvider,
  ProjectMemoryProviderDiagnostic,
} from "../ports/project-memory-provider.port.ts";
import type { ProjectMemoryProvenanceRepository } from "../ports/project-memory-provenance-repository.port.ts";
import type { RepositoryIdentityRepository } from "../ports/repository-identity-repository.port.ts";
import { deriveProjectMemoryIdentity } from "./project-memory-identity.ts";

export interface ProjectMemoryDiagnosticReport {
  schemaVersion: 1;
  provider: ProjectMemoryProviderDiagnostic["provider"];
  state: ProjectMemoryProviderDiagnostic["state"];
  /** True only when this report performed a live provider probe. */
  probed: boolean;
  version: string | null;
  code: ProjectMemoryProviderDiagnostic["code"];
  message: string;
  project: {
    id: string;
    /** Derived from the portable repository ID; null without one. */
    memoryProjectId: string | null;
    lastRetrieval: {
      runId: string;
      outcome: "retrieved" | "empty" | "failed" | "skipped";
      errorCode: string | null;
      resultCount: number;
      injectedCount: number;
      createdAt: string;
    } | null;
  } | null;
}

/**
 * Read-only diagnostics for the optional project memory provider. Without
 * `probe` it inspects configuration and recorded evidence only and starts no
 * process; a probe is an explicit operator action. Provider state never
 * changes project health, authority, or run eligibility.
 */
export class DescribeProjectMemory {
  constructor(
    private readonly provider: ProjectMemoryProvider,
    private readonly identities: RepositoryIdentityRepository,
    private readonly provenance: ProjectMemoryProvenanceRepository,
  ) {}

  async execute(input: {
    projectId: string | null;
    probe: boolean;
    signal?: AbortSignal;
  }): Promise<ProjectMemoryDiagnosticReport> {
    const diagnostic = input.probe
      ? await this.provider.probe(input.signal)
      : this.provider.describe();
    let project: ProjectMemoryDiagnosticReport["project"] = null;
    if (input.projectId !== null) {
      const repositoryId = await this.identities.findRepositoryId(
        input.projectId,
      );
      const latest = await this.provenance.findLatestRetrieval(input.projectId);
      project = {
        id: input.projectId,
        memoryProjectId:
          repositoryId === null
            ? null
            : deriveProjectMemoryIdentity(repositoryId).memoryProjectId,
        lastRetrieval:
          latest === null
            ? null
            : {
                runId: latest.runId,
                outcome: latest.outcome,
                errorCode: latest.errorCode,
                resultCount: latest.resultCount,
                injectedCount: latest.injectedCount,
                createdAt: latest.createdAt.toISOString(),
              },
      };
    }
    return {
      schemaVersion: 1,
      provider: diagnostic.provider,
      state: diagnostic.state,
      probed:
        input.probe &&
        diagnostic.state !== "disabled" &&
        diagnostic.state !== "misconfigured",
      version: diagnostic.version,
      code: diagnostic.code,
      message: diagnostic.message,
      project,
    };
  }
}
