import type { AgentRunModelSelection } from "@ai-office/domain/agent/agent-run-model.ts";
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
  /** Captured from the synchronized role and pinned on AgentRun. */
  roleGuidance?: {
    version: number;
    text: string;
  };
  /**
   * The run's persisted model selection. Omitted for unrouted and historical
   * runs, so their context and input digest stay byte-identical.
   */
  model?: AgentRunModelSelection;
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
  /** The role's `maxCostMicros` (USD micros); a model choice never widens it. */
  maxCostMicros: bigint;
}

/**
 * Cost evidence recorded by the metered LLM gateway for a gateway-executed
 * run. Client-login workers never carry it: their cost is a client estimate
 * or unknown. Monetary values are integer micros as decimal strings.
 */
export interface WorkerGatewayMetering {
  kind: "gateway";
  providerId: string;
  model: string;
  providerRequestId: string | null;
  usage: {
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  appliedParameters: {
    reasoningEffort: string | null;
    maxOutputTokens: number;
  };
  currency: "USD" | "EUR";
  pricingVersionId: string;
  budgetScope: "agent_run";
  budgetLimitMicros: string;
  reservedMicros: string;
  estimatedMicros: string;
  actualMicros: string;
}

export interface WorkerOutput {
  schemaVersion: 1;
  summary: string;
  content: string;
  sessionId: string | null;
  model: string | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  estimatedCostUsd: number | null;
  metering?: WorkerGatewayMetering;
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
  WORKER_MODEL_UNSUPPORTED:
    "The selected worker cannot execute the run's assigned model or its execution parameters.",
  WORKER_MODEL_CONFLICT:
    "The run's assigned model cannot be replaced by a worker model option.",
  WORKER_MODEL_REQUIRED:
    "The selected worker executes only runs with an assigned model; this run has none.",
  WORKER_MODEL_MISMATCH:
    "The provider reported a different model than the run's assigned model; the result was rejected.",
  WORKER_PRICING_UNAVAILABLE:
    "No active pricing exists for the run's assigned model; metered execution fails closed.",
  WORKER_CREDENTIALS_MISSING:
    "The Runtime host has no provider credentials for the run's assigned model.",
} as const;

export class WorkerRuntimeError extends Error {
  constructor(readonly code: keyof typeof errorMessages) {
    super(errorMessages[code]);
    this.name = "WorkerRuntimeError";
  }
}

export interface WorkerRuntime {
  readonly id: string;
  /**
   * True for an adapter with no default model of its own: unrouted and
   * historical runs fail with `WORKER_MODEL_REQUIRED` before dispatch.
   */
  readonly requiresModelSelection?: boolean;
  inspect(): Promise<{ version: string }>;
  /**
   * Whether this adapter can honor a persisted model selection exactly,
   * including its execution parameters. An adapter without this method cannot
   * execute routed runs; it is never allowed to substitute its own model.
   */
  supportsModel?(selection: AgentRunModelSelection):
    | { supported: true }
    | {
        supported: false;
        code: "WORKER_MODEL_UNSUPPORTED" | "WORKER_MODEL_CONFLICT";
      };
  execute(
    context: WorkerContext,
    limits: WorkerLimits,
    signal?: AbortSignal,
  ): Promise<WorkerOutput>;
}
