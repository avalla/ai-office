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

/** The literal search text is supplied by the application caller; only case folding is allowed in an adapter. */
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
    typeof scope !== "object" || scope === null ||
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
  return typeof value === "string" && value.length > 0 &&
    value.length <= knowledgeRetrievalLimits.identifierCharacters && value.trim() === value;
}

export function assertKnowledgeIdentifier(value: unknown): asserts value is string {
  if (!isKnowledgeIdentifier(value)) {
    throw new KnowledgeStoreError("KNOWLEDGE_INVALID_QUERY");
  }
}

export function assertKnowledgeSearchQuery(query: KnowledgeSearchQuery): void {
  if (
    typeof query !== "object" || query === null ||
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
  kind: "requirement" | "task" | "decision" | "run" | "external";
  label: string;
  locator?: string;
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

export interface KnowledgeProvenance {
  knowledge: KnowledgeHit;
  source: KnowledgeSourceReference;
  runId: string;
  taskId: string;
  agentId: string;
}

/**
 * Secondary knowledge persistence; this port does not confer Runtime authority.
 * Search uses one case-insensitive literal substring supplied by the caller,
 * excludes superseded decisions, and returns at most `limit` hits ordered by
 * creation time descending, then kind and ID ascending. An omitted limit uses
 * the fixed maximum of five. No match returns `[]`;
 * infrastructure and malformed-result failures throw a typed error instead.
 * The adapter must validate the scope on every returned hit.
 */
export interface AgentKnowledgeStore {
  recordMemory(input: MemoryInput): Promise<void>;
  recordDecision(input: DecisionInput): Promise<void>;
  supersedeDecision(scope: KnowledgeScope, currentId: string, priorId: string): Promise<void>;
  addTaskDependency(scope: KnowledgeScope, taskId: string, dependencyId: string): Promise<void>;
  findKnowledge(
    scope: KnowledgeScope,
    query: KnowledgeSearchQuery,
  ): Promise<KnowledgeHit[]>;
  /** Null means the scoped record is absent; malformed persisted provenance throws KNOWLEDGE_INVALID_RESULT. */
  traceMemoryProvenance(scope: KnowledgeScope, memoryId: string): Promise<KnowledgeProvenance | null>;
  traceDecisionProvenance(scope: KnowledgeScope, decisionId: string): Promise<KnowledgeProvenance | null>;
  findCurrentDecisions(scope: KnowledgeScope, taskId: string, limit?: number): Promise<KnowledgeHit[]>;
  listTaskDependencies(scope: KnowledgeScope, taskId: string, limit?: number): Promise<string[]>;
  listAgentKnowledge(scope: KnowledgeScope, agentId: string, limit?: number): Promise<KnowledgeHit[]>;
  deleteProjectKnowledge(scope: KnowledgeScope): Promise<void>;
}
