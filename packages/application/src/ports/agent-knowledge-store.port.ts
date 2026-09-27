/** Explicit scope supplied by a trusted application caller for every operation. */
export interface KnowledgeScope {
  tenantId: string;
  projectId: string;
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

/** Secondary knowledge persistence; this port does not confer runtime authority. */
export interface AgentKnowledgeStore {
  recordMemory(input: MemoryInput): Promise<void>;
  recordDecision(input: DecisionInput): Promise<void>;
  supersedeDecision(scope: KnowledgeScope, currentId: string, priorId: string): Promise<void>;
  addTaskDependency(scope: KnowledgeScope, taskId: string, dependencyId: string): Promise<void>;
  findKnowledge(
    scope: KnowledgeScope,
    query: { text: string; agentId?: string; limit?: number },
  ): Promise<KnowledgeHit[]>;
  traceMemoryProvenance(scope: KnowledgeScope, memoryId: string): Promise<KnowledgeProvenance | null>;
  traceDecisionProvenance(scope: KnowledgeScope, decisionId: string): Promise<KnowledgeProvenance | null>;
  findCurrentDecisions(scope: KnowledgeScope, taskId: string): Promise<KnowledgeHit[]>;
  listTaskDependencies(scope: KnowledgeScope, taskId: string): Promise<string[]>;
  listAgentKnowledge(scope: KnowledgeScope, agentId: string): Promise<KnowledgeHit[]>;
  deleteProjectKnowledge(scope: KnowledgeScope): Promise<void>;
}
