/**
 * Explicit scope supplied by a trusted application caller for every operation.
 * `repositoryId` is the portable identity from the authoritative project
 * binding, not the Runtime-local project row ID, a checkout path, or model text.
 * The tenant is bound by trusted Runtime composition. The knowledge store does
 * not authenticate either value or confer operational authority.
 */
export interface KnowledgeScope {
  readonly tenantId: string;
  readonly repositoryId: string;
}

/** Fixed Runtime retrieval bounds; adapters may use smaller internal batches. */
export const knowledgeRetrievalLimits = {
  queryCharacters: 200,
  identifierCharacters: 256,
  maxResults: 5,
  maxGraphResults: 100,
} as const;

/** The literal search text is supplied by the application caller; the adapter may lowercase it. */
export interface KnowledgeSearchQuery {
  readonly text: string;
  readonly limit?: number;
  readonly agentId?: string;
}

export type KnowledgeStoreErrorCode =
  | "KNOWLEDGE_INVALID_SCOPE"
  | "KNOWLEDGE_INVALID_QUERY"
  | "KNOWLEDGE_INVALID_RESULT"
  | "KNOWLEDGE_UNAVAILABLE"
  | "KNOWLEDGE_MISCONFIGURED"
  | "KNOWLEDGE_QUERY_FAILED";

/** Sanitized boundary error: no database query, endpoint, or credential text. */
export class KnowledgeStoreError extends Error {
  constructor(readonly code: KnowledgeStoreErrorCode) {
    super(code);
    this.name = "KnowledgeStoreError";
  }
}

export function assertKnowledgeScope(scope: KnowledgeScope): void {
  if (
    typeof scope !== "object" ||
    scope === null ||
    typeof scope.tenantId !== "string" ||
    scope.tenantId.trim() !== scope.tenantId ||
    scope.tenantId.length === 0 ||
    scope.tenantId.length > knowledgeRetrievalLimits.identifierCharacters ||
    typeof scope.repositoryId !== "string" ||
    scope.repositoryId.trim() !== scope.repositoryId ||
    scope.repositoryId.length === 0 ||
    scope.repositoryId.length > knowledgeRetrievalLimits.identifierCharacters
  ) {
    throw new KnowledgeStoreError("KNOWLEDGE_INVALID_SCOPE");
  }
}

export function isKnowledgeIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= knowledgeRetrievalLimits.identifierCharacters &&
    value.trim() === value
  );
}

export function assertKnowledgeIdentifier(
  value: unknown,
): asserts value is string {
  if (!isKnowledgeIdentifier(value)) {
    throw new KnowledgeStoreError("KNOWLEDGE_INVALID_QUERY");
  }
}

export function assertKnowledgeSearchQuery(query: KnowledgeSearchQuery): void {
  if (
    typeof query !== "object" ||
    query === null ||
    typeof query.text !== "string" ||
    query.text.trim() !== query.text ||
    query.text.length === 0 ||
    [...query.text].length > knowledgeRetrievalLimits.queryCharacters ||
    (query.limit !== undefined &&
      (!Number.isInteger(query.limit) ||
        query.limit < 1 ||
        query.limit > knowledgeRetrievalLimits.maxResults)) ||
    (query.agentId !== undefined && !isKnowledgeIdentifier(query.agentId))
  ) {
    throw new KnowledgeStoreError("KNOWLEDGE_INVALID_QUERY");
  }
}

export function assertKnowledgeLimit(limit: number, maximum: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new KnowledgeStoreError("KNOWLEDGE_INVALID_QUERY");
  }
}

export interface KnowledgeSourceReference {
  id: string;
  kind:
    | "requirement"
    | "task"
    | "decision"
    | "run"
    | "external"
    | "handover"
    | "operator";
  label: string;
  locator?: string;
}

/**
 * Authoritative project records an operator-confirmed admission may cite. The
 * set is closed: the Runtime resolves each reference inside the project before
 * planning, so an identifier it cannot verify, such as a host-client session
 * ID, is never evidence.
 */
export const knowledgeEvidenceKinds = [
  "adr",
  "handover",
  "requirement",
  "review",
  "task",
] as const;
export type KnowledgeEvidenceKind = (typeof knowledgeEvidenceKinds)[number];
export const knowledgeEvidenceLimit = 8;

export interface KnowledgeEvidenceReference {
  readonly kind: KnowledgeEvidenceKind;
  readonly id: string;
  /** Runtime-derived stable label of the referenced record, never caller text. */
  readonly label: string;
}

/** Evidence of a handover repository review the user actually confirmed. */
export interface HandoverKnowledgeProvenance {
  readonly kind: "handover";
  readonly confirmationId: string;
  readonly fingerprint: string;
  readonly scanId: string | null;
  readonly confirmedAt: Date;
}

/**
 * Evidence the trusted-local operator explicitly confirmed. `confirmedBy` is
 * the supplied operator identity, not authenticated human presence, and no
 * external model session is represented.
 */
export interface OperatorConfirmedKnowledgeProvenance {
  readonly kind: "operator_confirmed";
  readonly confirmedBy: string;
  readonly evidence: readonly KnowledgeEvidenceReference[];
}

export type NonRunKnowledgeProvenance =
  HandoverKnowledgeProvenance | OperatorConfirmedKnowledgeProvenance;

export function isKnowledgeEvidenceReference(
  value: unknown,
): value is KnowledgeEvidenceReference {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 3 &&
    knowledgeEvidenceKinds.includes(candidate.kind as KnowledgeEvidenceKind) &&
    isKnowledgeIdentifier(candidate.id) &&
    isKnowledgeIdentifier(candidate.label)
  );
}

/** Source-specific fields are required and no other field is accepted. */
export function isNonRunKnowledgeProvenance(
  value: unknown,
): value is NonRunKnowledgeProvenance {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "handover") {
    return (
      Object.keys(candidate).length === 5 &&
      isKnowledgeIdentifier(candidate.confirmationId) &&
      typeof candidate.fingerprint === "string" &&
      /^[0-9a-f]{64}$/u.test(candidate.fingerprint) &&
      (candidate.scanId === null || isKnowledgeIdentifier(candidate.scanId)) &&
      candidate.confirmedAt instanceof Date &&
      !Number.isNaN(candidate.confirmedAt.getTime())
    );
  }
  if (candidate.kind === "operator_confirmed") {
    const evidence = candidate.evidence;
    return (
      Object.keys(candidate).length === 3 &&
      isKnowledgeIdentifier(candidate.confirmedBy) &&
      Array.isArray(evidence) &&
      evidence.length >= 1 &&
      evidence.length <= knowledgeEvidenceLimit &&
      evidence.every(isKnowledgeEvidenceReference) &&
      new Set(evidence.map((item) => `${item.kind}:${item.id}`)).size ===
        evidence.length
    );
  }
  return false;
}

export interface AgentKnowledgeInput extends KnowledgeScope {
  id: string;
  text: string;
  agentId: string;
  runId: string;
  taskId: string;
  source: KnowledgeSourceReference;
  createdAt: Date;
}

export type MemoryInput = AgentKnowledgeInput;

export interface DecisionInput extends AgentKnowledgeInput {
  title: string;
}

export interface KnowledgeHit extends KnowledgeScope {
  id: string;
  kind: "memory" | "decision";
  text: string;
  title: string | null;
  agentId: string;
  runId: string;
  taskId: string;
  source: KnowledgeSourceReference;
  createdAt: Date;
}

/** Imported records have no verified AI Office run, task, or agent provenance. */
export interface LegacyKnowledgeHit extends KnowledgeScope {
  id: string;
  kind: "memory";
  text: string;
  title: null;
  agentId: null;
  runId: null;
  taskId: null;
  source: KnowledgeSourceReference;
  createdAt: Date;
  legacy: { sourceScope: string; sourceKey: string; sourceSha256: string };
}

/**
 * Knowledge admitted from a confirmed handover review or explicit operator
 * confirmation. It never carries a run, task, or agent: none produced it.
 */
export interface NonRunKnowledgeHit extends KnowledgeScope {
  id: string;
  kind: "memory" | "decision";
  text: string;
  title: string | null;
  agentId: null;
  runId: null;
  taskId: null;
  source: KnowledgeSourceReference;
  createdAt: Date;
  provenance: NonRunKnowledgeProvenance;
}

export interface NonRunKnowledgeInput extends KnowledgeScope {
  id: string;
  kind: "memory" | "decision";
  text: string;
  /** Required for a decision and absent for a memory. */
  title?: string;
  source: KnowledgeSourceReference;
  createdAt: Date;
  provenance: NonRunKnowledgeProvenance;
}

export type SearchKnowledgeHit =
  KnowledgeHit | NonRunKnowledgeHit | LegacyKnowledgeHit;

export interface RunKnowledgeProvenance {
  knowledge: KnowledgeHit;
  source: KnowledgeSourceReference;
  runId: string;
  taskId: string;
  agentId: string;
}

export interface NonRunKnowledgeTrace {
  knowledge: NonRunKnowledgeHit;
  source: KnowledgeSourceReference;
  runId: null;
  taskId: null;
  agentId: null;
}

export type KnowledgeProvenance = RunKnowledgeProvenance | NonRunKnowledgeTrace;

/**
 * Secondary knowledge persistence; this port does not confer Runtime authority.
 * Search uses one caller-supplied literal substring with default Unicode
 * lowercasing on both sides (not full Unicode case folding),
 * excludes superseded decisions, and returns at most `limit` hits ordered by
 * creation time descending, then kind and ID ascending. An omitted limit uses
 * the fixed maximum of five. No match returns `[]`;
 * infrastructure and malformed-result failures throw a typed error instead.
 * The adapter must validate the scope on every returned hit.
 */
export interface AgentKnowledgeStore {
  recordMemory(input: MemoryInput): Promise<void>;
  recordDecision(input: DecisionInput): Promise<void>;
  /**
   * Writes one record and its typed provenance atomically, without any run,
   * task, or agent node. An existing record with the same ID and different
   * content or provenance is rejected.
   */
  recordNonRunKnowledge(input: NonRunKnowledgeInput): Promise<void>;
  traceLegacyMemory(
    scope: KnowledgeScope,
    id: string,
  ): Promise<LegacyKnowledgeHit | null>;
  supersedeDecision(
    scope: KnowledgeScope,
    currentId: string,
    priorId: string,
  ): Promise<void>;
  addTaskDependency(
    scope: KnowledgeScope,
    taskId: string,
    dependencyId: string,
  ): Promise<void>;
  findKnowledge(
    scope: KnowledgeScope,
    query: KnowledgeSearchQuery,
  ): Promise<SearchKnowledgeHit[]>;
  /** Null means the scoped record is absent; malformed persisted provenance throws KNOWLEDGE_INVALID_RESULT. */
  traceMemoryProvenance(
    scope: KnowledgeScope,
    memoryId: string,
  ): Promise<KnowledgeProvenance | null>;
  traceDecisionProvenance(
    scope: KnowledgeScope,
    decisionId: string,
  ): Promise<KnowledgeProvenance | null>;
  findCurrentDecisions(
    scope: KnowledgeScope,
    taskId: string,
    limit?: number,
  ): Promise<KnowledgeHit[]>;
  listTaskDependencies(
    scope: KnowledgeScope,
    taskId: string,
    limit?: number,
  ): Promise<string[]>;
  listAgentKnowledge(
    scope: KnowledgeScope,
    agentId: string,
    limit?: number,
  ): Promise<KnowledgeHit[]>;
  deleteProjectKnowledge(scope: KnowledgeScope): Promise<void>;
}

/** Trusted Runtime composition binds tenant identity before a use case supplies repositoryId. */
export type RuntimeAgentKnowledge =
  | { readonly state: "disabled" }
  | { readonly state: "misconfigured"; readonly error: KnowledgeStoreError }
  | { readonly state: "unavailable"; readonly error: KnowledgeStoreError }
  | {
      readonly state: "connected";
      readonly tenantId: string;
      readonly store: AgentKnowledgeStore;
    };
