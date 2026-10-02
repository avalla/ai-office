import type { DomainPackDependency } from "../../../domain-pack-contracts/src/index.ts";

/** Explicit portable selection. Availability belongs to the installed catalog. */
export interface ProjectPackBinding {
  readonly projectId: string;
  /** Project pack configuration revision; zero is the legacy empty selection. */
  readonly configurationRevision: number;
  readonly packs: readonly DomainPackDependency[];
}

export class StaleProjectPackBindingError extends Error {
  constructor(
    readonly projectId: string,
    readonly actualRevision: number,
  ) {
    super(
      `Project pack binding revision is stale (current: ${actualRevision})`,
    );
    this.name = "StaleProjectPackBindingError";
  }
}

export interface ProjectPackBindingRepository {
  get(projectId: string): Promise<ProjectPackBinding>;
  /** Must run atomically with the caller's audit append. Same state is a no-op. */
  replace(
    projectId: string,
    expectedRevision: number,
    packs: readonly DomainPackDependency[],
    changedAt: Date,
  ): Promise<{ binding: ProjectPackBinding; changed: boolean }>;
}
