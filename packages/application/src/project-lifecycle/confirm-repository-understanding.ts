import { ProjectNotFoundError } from "../errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import {
  handoverReviewCategory,
  handoverReviewContractVersion,
  handoverReviewKey,
  repositoryFactsFromProfile,
  repositoryUnderstandingFingerprint,
  type RecordedRepositoryReview,
} from "./repository-understanding.ts";

export class RepositoryUnderstandingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryUnderstandingError";
  }
}

export const maximumRepositoryReviewSummaryLength = 4000;

export interface RepositoryUnderstandingConfirmation {
  schemaVersion: 1;
  projectId: string;
  fingerprint: string;
  scanId: string | null;
  confirmedAt: string;
  summary: string;
}

/**
 * Records that a handover repository review was performed and confirmed by the
 * user. This is evidence about the project, not authority: it grants no
 * capability, approves no action, and changes no policy. The office manifest
 * records the approved organizational model and never certifies this.
 */
export class ConfirmRepositoryUnderstanding {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly profiles: ProjectProfileRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(input: {
    projectId: string;
    summary: string;
  }): Promise<RepositoryUnderstandingConfirmation> {
    const project = await this.projects.findById(input.projectId);
    if (project === null) throw new ProjectNotFoundError(input.projectId);

    const summary = input.summary.trim();
    if (summary === "")
      throw new RepositoryUnderstandingError(
        "A repository review summary is required: record what the office understood",
      );
    if (summary.length > maximumRepositoryReviewSummaryLength)
      throw new RepositoryUnderstandingError(
        `A repository review summary must not exceed ${maximumRepositoryReviewSummaryLength} characters`,
      );

    const [entries, scan] = await Promise.all([
      this.profiles.listActiveProfileEntries(input.projectId),
      this.profiles.findLatestScan(input.projectId),
    ]);
    const facts = repositoryFactsFromProfile(entries);
    if (facts === null)
      throw new RepositoryUnderstandingError(
        "This repository has not been scanned yet. Run ai-office project:import . before confirming a review.",
      );

    const now = this.clock.now();
    const review: RecordedRepositoryReview = {
      contractVersion: handoverReviewContractVersion,
      fingerprint: repositoryUnderstandingFingerprint(facts),
      scanId: scan?.id ?? null,
      summary,
    };

    await this.transactions.run(async () => {
      await this.profiles.supersedeProfileEntries(
        input.projectId,
        handoverReviewCategory,
        handoverReviewKey,
        now,
      );
      await this.profiles.saveProfileEntry({
        id: this.ids.generate(),
        projectId: input.projectId,
        category: handoverReviewCategory,
        key: handoverReviewKey,
        value: review,
        origin: "user",
        confidence: 1,
        ...(review.scanId === null ? {} : { sourceReference: review.scanId }),
        confirmedAt: now,
        createdAt: now,
      });
    });

    return {
      schemaVersion: 1,
      projectId: input.projectId,
      fingerprint: review.fingerprint,
      scanId: review.scanId,
      confirmedAt: now.toISOString(),
      summary,
    };
  }
}
