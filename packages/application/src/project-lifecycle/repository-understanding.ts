import { createHash } from "node:crypto";
import {
  repositoryDocumentation,
  repositoryUnderstandingFingerprintSource,
  type RepositorySignals,
  type RepositoryUnderstandingFacts,
} from "@ai-office/domain/project/project-handover.ts";
import type { ProjectProfileEntry } from "@ai-office/domain/project/project-profile.ts";

/**
 * A confirmed handover repository review is project knowledge, so it lives in
 * the existing project profile as a user-origin entry rather than in a new
 * table. It travels with portable project snapshots and survives repository
 * re-imports, which only replace detected evidence.
 */
export const handoverReviewCategory = "handover";
export const handoverReviewKey = "repository_review";
export const handoverReviewContractVersion = 1;

export interface RecordedRepositoryReview {
  contractVersion: typeof handoverReviewContractVersion;
  fingerprint: string;
  scanId: string | null;
  summary: string;
}

function detectedValue(
  entries: readonly ProjectProfileEntry[],
  category: string,
  key: string,
): unknown {
  return entries.find(
    (entry) =>
      entry.origin === "detected" &&
      entry.category === category &&
      entry.key === key,
  )?.value;
}

function textList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function flag(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

/**
 * Builds the material repository facts from detected profile evidence.
 * Returns null when the repository was never scanned into this project.
 */
export function repositoryFactsFromProfile(
  entries: readonly ProjectProfileEntry[],
): RepositoryUnderstandingFacts | null {
  if (!entries.some((entry) => entry.origin === "detected")) return null;
  return {
    languages: textList(detectedValue(entries, "stack", "languages")),
    frameworks: textList(detectedValue(entries, "stack", "frameworks")),
    databases: textList(detectedValue(entries, "stack", "databases")),
    testing: textList(detectedValue(entries, "quality", "testing")),
    documentation: repositoryDocumentation(
      textList(detectedValue(entries, "documentation", "files")),
    ),
    packageManager: text(detectedValue(entries, "tooling", "package_manager")),
    remoteUrl: text(detectedValue(entries, "repository", "remote_url")),
    sourceFileCount: count(
      detectedValue(entries, "repository", "source_file_count"),
    ),
    hasCommitHistory: flag(
      detectedValue(entries, "repository", "has_commit_history"),
    ),
  };
}

export function repositorySignalsFromFacts(
  facts: RepositoryUnderstandingFacts,
): RepositorySignals {
  return {
    languageCount: facts.languages.length,
    frameworkCount: facts.frameworks.length,
    documentationCount: facts.documentation.length,
    sourceFileCount: facts.sourceFileCount,
    hasCommitHistory: facts.hasCommitHistory,
  };
}

export function repositoryUnderstandingFingerprint(
  facts: RepositoryUnderstandingFacts,
): string {
  return createHash("sha256")
    .update(repositoryUnderstandingFingerprintSource(facts), "utf8")
    .digest("hex");
}

function isRecordedReview(value: unknown): value is RecordedRepositoryReview {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.contractVersion === handoverReviewContractVersion &&
    typeof candidate.fingerprint === "string" &&
    candidate.fingerprint !== "" &&
    (candidate.scanId === null || typeof candidate.scanId === "string") &&
    typeof candidate.summary === "string"
  );
}

/**
 * Returns the most recently recorded confirmation. Older entries are
 * superseded on write, so at most one is normally active; the newest wins if a
 * restored snapshot ever carries more than one.
 */
export function readRecordedRepositoryReview(
  entries: readonly ProjectProfileEntry[],
): { review: RecordedRepositoryReview; confirmedAt: Date } | null {
  const candidates = entries
    .filter(
      (entry) =>
        entry.category === handoverReviewCategory &&
        entry.key === handoverReviewKey &&
        entry.origin === "user" &&
        isRecordedReview(entry.value),
    )
    .sort(
      (left, right) =>
        left.createdAt.getTime() - right.createdAt.getTime() ||
        left.id.localeCompare(right.id),
    );
  const latest = candidates[candidates.length - 1];
  return latest === undefined
    ? null
    : {
        review: latest.value as RecordedRepositoryReview,
        confirmedAt: latest.confirmedAt ?? latest.createdAt,
      };
}
