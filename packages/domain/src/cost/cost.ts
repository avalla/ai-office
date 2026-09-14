import { DomainValidationError } from "../errors.ts";

export type Currency = "USD" | "EUR";

export interface CostAmount {
  micros: bigint;
  currency: Currency;
}

/**
 * Normalized provider usage for one request: inclusive totals plus subset
 * details, as the provider reports them.
 *
 * - `inputTokens` is every input token processed, cached or not;
 * - `cachedInputTokens` is the part of `inputTokens` read from a prompt cache;
 * - `outputTokens` is every output token generated, reasoning included;
 * - `reasoningTokens` is the part of `outputTokens` spent on reasoning.
 *
 * A detail never exceeds its total, and cost is computed from the mutually
 * exclusive buckets of {@link billableTokens}, so no token is charged twice.
 */
export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

/** Upper bounds on a request's inclusive input and output totals. */
export interface ModelUsageBound {
  inputTokens: number;
  outputTokens: number;
}

/** Mutually exclusive billable quantities derived from {@link ModelUsage}. */
export interface BillableTokens {
  uncachedInputTokens: number;
  cachedInputTokens: number;
  nonReasoningOutputTokens: number;
  reasoningTokens: number;
}

export class InvalidModelUsageError extends DomainValidationError {
  constructor(readonly field: keyof ModelUsage) {
    super(
      field === "cachedInputTokens"
        ? "usage.cachedInputTokens must not exceed usage.inputTokens"
        : field === "reasoningTokens"
          ? "usage.reasoningTokens must not exceed usage.outputTokens"
          : `usage.${field} must be a non-negative safe integer`,
    );
    this.name = "InvalidModelUsageError";
  }
}

const usageFields = [
  "inputTokens",
  "cachedInputTokens",
  "outputTokens",
  "reasoningTokens",
] as const;

/** Splits inclusive usage into billable buckets; impossible subsets are rejected. */
export function billableTokens(usage: ModelUsage): BillableTokens {
  for (const field of usageFields) {
    const value = usage[field];
    if (!Number.isSafeInteger(value) || value < 0)
      throw new InvalidModelUsageError(field);
  }
  if (usage.cachedInputTokens > usage.inputTokens)
    throw new InvalidModelUsageError("cachedInputTokens");
  if (usage.reasoningTokens > usage.outputTokens)
    throw new InvalidModelUsageError("reasoningTokens");
  return {
    uncachedInputTokens: usage.inputTokens - usage.cachedInputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    nonReasoningOutputTokens: usage.outputTokens - usage.reasoningTokens,
    reasoningTokens: usage.reasoningTokens,
  };
}

/**
 * Per-million-token rates, one per billable bucket:
 *
 * - `inputPerMillionMicros` prices uncached input;
 * - `cachedInputPerMillionMicros` prices cached input (instead of, not on top
 *   of, the input rate);
 * - `outputPerMillionMicros` prices non-reasoning output;
 * - `reasoningPerMillionMicros` prices reasoning output (instead of the output
 *   rate). Set it equal to the output rate for vendors that bill reasoning as
 *   ordinary output.
 */
export interface PricingVersion {
  id: string;
  provider: string;
  model: string;
  currency: Currency;
  inputPerMillionMicros: bigint;
  cachedInputPerMillionMicros: bigint;
  outputPerMillionMicros: bigint;
  reasoningPerMillionMicros: bigint;
  effectiveFrom: Date;
  effectiveTo?: Date;
}

/**
 * How a cost event's amount was determined:
 *
 * - `reported_usage`: the provider's usage priced with the pricing version;
 * - `reserved_envelope`: a provider response was received but rejected (for
 *   example another model answered, or the response was malformed), so its
 *   usage cannot be priced reliably and the worst-case envelope reserved
 *   before the request is charged instead of treating the call as free.
 */
export type CostChargeBasis = "reported_usage" | "reserved_envelope";

export interface BudgetSnapshot {
  id: string;
  projectId: string;
  scopeType: BudgetScopeType;
  scopeId: string;
  limitMicros: bigint;
  currency: Currency;
  spentMicros: bigint;
  reservedMicros: bigint;
}

export type BudgetScopeType = "project" | "task" | "agent" | "agent_run";

export interface BudgetReservation {
  id: string;
  budgetId: string;
  reservedMicros: bigint;
  currency: Currency;
  status: "active" | "consumed" | "released";
  expiresAt: Date;
}
