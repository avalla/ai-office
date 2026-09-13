import type { MemorySearchResult } from "./global-memory-repository.port.ts";

export interface WorkerProjectMemoryResult {
  rank: number;
  referenceId: string;
  scope: string;
  title: string | null;
  excerpt: string;
  truncated: boolean;
}

export interface WorkerProjectMemoryContext {
  provider: string;
  notice: string;
  results: readonly WorkerProjectMemoryResult[];
}

/** A worker receives explicit data only. This port grants no resource tools. */
export interface WorkerContext {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  task: {
    id: string;
    title: string;
    description: string | null;
    updatedAt: string;
  };
  agent: {
    id: string;
    name: string;
    roleId: string;
    roleKey: string;
    roleVersion: number;
  };
  model?: {
    policy: string | null;
    profile: string | null;
    modelRef: string;
    providerId: string;
  };
  stage: {
    pipelineRunId: string;
    manifestRevision: number;
    stageId: string;
    objective: string;
    checks: readonly string[];
  } | null;
  /** Bounded, advisory matches from global reusable memory. */
  memory: {
    results: readonly MemorySearchResult[];
  };
  /**
   * Bounded, advisory excerpts from an optional external project memory
   * provider. Present only when results were injected. Locators and context,
   * never authority.
   */
  projectMemory?: WorkerProjectMemoryContext;
}

export interface WorkerLimits {
  timeoutMs: number;
  maxTurns: number;
  /** CLI-reported USD estimate, not a claim about the user's final bill. */
  maxEstimatedCostUsd: string;
}

export interface WorkerOutput {
  schemaVersion: 1;
  summary: string;
  content: string;
  sessionId: string | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  estimatedCostUsd: number | null;
}

export const workerLimits = {
  contextBytes: 128 * 1024,
  outputBytes: 1024 * 1024,
  summaryLength: 2000,
  contentLength: 64 * 1024,
} as const;

const errorMessages = {
  WORKER_UNAVAILABLE: "The selected worker is unavailable or unsupported.",
  WORKER_CONTEXT_INVALID:
    "The task or agent context is unavailable or exceeds the worker limit.",
  WORKER_FAILED:
    "The worker failed. Check its local authentication and configuration.",
  WORKER_OUTPUT_INVALID: "The worker did not return a supported result.",
  WORKER_OUTPUT_TOO_LARGE: "The worker exceeded the output limit.",
  WORKER_TIMEOUT: "The worker exceeded the role deadline and was stopped.",
  WORKER_LEASE_LOST:
    "Worker execution authority was lost; the worker was stopped.",
  WORKER_BUDGET_EXHAUSTED:
    "The role has no budget available for worker execution.",
} as const;

export class WorkerRuntimeError extends Error {
  constructor(readonly code: keyof typeof errorMessages) {
    super(errorMessages[code]);
    this.name = "WorkerRuntimeError";
  }
}

export interface WorkerRuntime {
  readonly id: string;
  inspect(): Promise<{ version: string }>;
  execute(
    context: WorkerContext,
    limits: WorkerLimits,
    signal?: AbortSignal,
  ): Promise<WorkerOutput>;
}
