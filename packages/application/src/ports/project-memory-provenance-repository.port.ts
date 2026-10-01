import type { KnowledgeStoreErrorCode } from "./agent-knowledge-store.port.ts";

/**
 * Runtime-local evidence of which external memory records were retrieved for
 * one agent run, and whether they entered its pinned worker context.
 *
 * It never stores memory bodies, the query text, prompts, provider paths, or
 * configuration. It records influence, not authority.
 */
export interface ProjectMemoryRetrievalRecord {
  readonly runId: string;
  readonly projectId: string;
  readonly provider: string;
  readonly providerVersion: string | null;
  /** Null when retrieval was skipped before an identity existed. */
  readonly memoryProjectId: string | null;
  readonly scope: "project";
  readonly outcome: "retrieved" | "empty" | "failed" | "skipped";
  readonly errorCode:
    | LegacyProjectMemoryErrorCode
    | KnowledgeStoreErrorCode
    | KnowledgeRetrievalErrorCode
    | ProjectMemorySkipCode
    | null;
  /**
   * Lowercase SHA-256 hex of the bounded query AI Office derived from the task
   * and handed to the provider port. Null when no query was derived.
   */
  readonly contextQuerySha256: string | null;
  /**
   * Lowercase SHA-256 hex of the exact literal term supplied to native
   * findKnowledge once it was invoked, including failed and timed-out calls.
   * Legacy providers report their own outbound-query digest. Null when no
   * search was attempted or the legacy adapter could not report one.
   * Neither query text is ever kept.
   */
  readonly providerQuerySha256: string | null;
  readonly resultCount: number;
  readonly injectedCount: number;
  readonly injectedCharacters: number;
  readonly createdAt: Date;
  readonly references: readonly ProjectMemoryReferenceRecord[];
}

export type ProjectMemorySkipCode =
  | "REPOSITORY_IDENTITY_UNAVAILABLE"
  | "QUERY_UNAVAILABLE"
  | "CONTEXT_BUDGET_EXHAUSTED";

export type KnowledgeRetrievalErrorCode =
  "KNOWLEDGE_TIMEOUT" | "KNOWLEDGE_CANCELLED";

/** Historical error values remain readable in persisted run provenance. */
export type LegacyProjectMemoryErrorCode =
  | "PROJECT_MEMORY_UNAVAILABLE"
  | "PROJECT_MEMORY_MISCONFIGURED"
  | "PROJECT_MEMORY_INCOMPATIBLE"
  | "PROJECT_MEMORY_TIMEOUT"
  | "PROJECT_MEMORY_INVALID_RESPONSE"
  | "PROJECT_MEMORY_RESPONSE_TOO_LARGE"
  | "PROJECT_MEMORY_FAILED"
  | "PROJECT_MEMORY_CANCELLED";

export interface ProjectMemoryReferenceRecord {
  readonly rank: number;
  readonly referenceId: string;
  readonly contentDigest: string | null;
  readonly scope: string;
  readonly injected: boolean;
  readonly truncated: boolean;
}

export interface ProjectMemoryProvenanceRepository {
  /** Appends one retrieval and its references atomically. */
  recordRetrieval(record: ProjectMemoryRetrievalRecord): Promise<void>;
  findRetrieval(runId: string): Promise<ProjectMemoryRetrievalRecord | null>;
  /** Most recent retrieval for diagnostics; never authoritative state. */
  findLatestRetrieval(
    projectId: string,
  ): Promise<ProjectMemoryRetrievalRecord | null>;
}
