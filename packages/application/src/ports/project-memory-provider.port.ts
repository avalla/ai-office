/**
 * Optional, non-authoritative durable project memory.
 *
 * A provider remembers contextual knowledge about one logical repository.
 * AI Office decides: nothing returned through this port is project state,
 * policy, a capability, an approval, or evidence that work was done. Results
 * are locators and context that the current repository and authoritative
 * AI Office records always override.
 *
 * The port is read-only by design. It exposes no write, delete, supersede, or
 * import operation; a future reviewed-memory workflow must add its own
 * explicitly approved port rather than widen this one.
 */

/** Deterministic, bounded, path-free identity of one logical repository's memory. */
export interface ProjectMemoryIdentity {
  /** Namespaced digest derived only from the portable repository ID. */
  readonly memoryProjectId: string;
}

export interface ProjectMemoryQuery {
  readonly identity: ProjectMemoryIdentity;
  /** Already bounded by {@link projectMemoryLimits.queryCharacters}. */
  readonly text: string;
  /** Already bounded by {@link projectMemoryLimits.maxResults}. */
  readonly limit: number;
  readonly signal?: AbortSignal;
}

/** One normalized, bounded provider result. Never a full provider record. */
export interface ProjectMemoryHit {
  /** Provider-stable locator of the remembered record, when supplied. */
  readonly referenceId: string;
  /** Provider-supplied chunk/content digest, when supplied. */
  readonly contentDigest: string | null;
  /** Provider scope label such as `project`; informational only. */
  readonly scope: string;
  readonly title: string | null;
  /** Bounded excerpt/abstract text that may be injected into worker context. */
  readonly excerpt: string;
  /** True when the adapter shortened the excerpt to the per-result limit. */
  readonly truncated: boolean;
}

export interface ProjectMemorySearch {
  readonly provider: ProjectMemoryProviderDescriptor;
  /** Deterministic provider/adapter order, rank 1 first. */
  readonly hits: readonly ProjectMemoryHit[];
}

export interface ProjectMemoryProviderDescriptor {
  /** Stable provider kind, for example `cairnkeep`. */
  readonly id: string;
  /** Provider-reported version when available. */
  readonly version: string | null;
}

export type ProjectMemoryProviderState =
  "disabled" | "configured" | "available" | "unavailable" | "misconfigured";

export interface ProjectMemoryProviderDiagnostic {
  /** `none` when disabled, otherwise the provider kind. */
  readonly provider: string;
  readonly state: ProjectMemoryProviderState;
  /** Provider-reported version, only after a successful probe. */
  readonly version: string | null;
  /** Typed failure code; never raw provider output. */
  readonly code: ProjectMemoryErrorCode | null;
  readonly message: string;
}

export interface ProjectMemoryProvider {
  readonly id: string;
  /**
   * Performs exactly one bounded, project-scoped search. Implementations must
   * fail with {@link ProjectMemoryError} for every provider problem and must
   * never return unvalidated provider data.
   */
  search(query: ProjectMemoryQuery): Promise<ProjectMemorySearch>;
  /** Static configuration state; must not start processes or touch the network. */
  describe(): ProjectMemoryProviderDiagnostic;
  /** Explicit live health probe used only by the operator diagnostic command. */
  probe(signal?: AbortSignal): Promise<ProjectMemoryProviderDiagnostic>;
}

/**
 * Conservative, documented retrieval bounds. They are deliberately constants:
 * a first read-only slice does not need operator tuning, and fixed bounds keep
 * the pinned worker input digest reproducible.
 */
export const projectMemoryLimits = {
  /** Maximum characters in the single derived query. */
  queryCharacters: 200,
  /** Maximum results requested from and accepted from a provider. */
  maxResults: 5,
  /** Maximum characters of one injected excerpt. */
  excerptCharacters: 1_200,
  /** Maximum characters of one result title. */
  titleCharacters: 200,
  /** Maximum characters across all injected excerpts. */
  totalExcerptCharacters: 4_000,
  /**
   * Maximum UTF-8 bytes of the serialized `projectMemory` context block. The
   * caller may lower it further so the whole worker context stays in bounds.
   */
  contextBytes: 16 * 1024,
  /** Below this many available bytes no retrieval is attempted. */
  minimumContextBytes: 1024,
  /** Maximum characters of a provider reference ID or digest. */
  referenceCharacters: 256,
  /** Maximum UTF-8 bytes of one raw provider message accepted by an adapter. */
  responseBytes: 512 * 1024,
  /** Default and maximum whole-retrieval deadline, including process start. */
  defaultTimeoutMs: 5_000,
  maxTimeoutMs: 30_000,
} as const;

const errorMessages = {
  PROJECT_MEMORY_UNAVAILABLE:
    "The project memory provider is not installed or could not be started.",
  PROJECT_MEMORY_MISCONFIGURED:
    "The project memory provider configuration is invalid.",
  PROJECT_MEMORY_INCOMPATIBLE:
    "The project memory provider does not offer the required read-only search contract.",
  PROJECT_MEMORY_TIMEOUT: "The project memory provider exceeded its deadline.",
  PROJECT_MEMORY_INVALID_RESPONSE:
    "The project memory provider returned a malformed response.",
  PROJECT_MEMORY_RESPONSE_TOO_LARGE:
    "The project memory provider response exceeded the size limit.",
  PROJECT_MEMORY_FAILED: "The project memory provider reported a failure.",
  PROJECT_MEMORY_CANCELLED: "Project memory retrieval was cancelled.",
} as const;

export type ProjectMemoryErrorCode = keyof typeof errorMessages;

export class ProjectMemoryError extends Error {
  constructor(readonly code: ProjectMemoryErrorCode) {
    super(errorMessages[code]);
    this.name = "ProjectMemoryError";
  }
}

export function projectMemoryErrorMessage(
  code: ProjectMemoryErrorCode,
): string {
  return errorMessages[code];
}

/** The default: no provider is configured and nothing is ever invoked. */
export class DisabledProjectMemoryProvider implements ProjectMemoryProvider {
  readonly id = "none";

  search(): Promise<ProjectMemorySearch> {
    return Promise.reject(
      new ProjectMemoryError("PROJECT_MEMORY_MISCONFIGURED"),
    );
  }

  describe(): ProjectMemoryProviderDiagnostic {
    return {
      provider: "none",
      state: "disabled",
      version: null,
      code: null,
      message: "Project memory is disabled.",
    };
  }

  probe(): Promise<ProjectMemoryProviderDiagnostic> {
    return Promise.resolve(this.describe());
  }
}
