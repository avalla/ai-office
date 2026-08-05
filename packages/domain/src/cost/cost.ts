export type Currency = "USD" | "EUR";

export interface CostAmount {
  micros: bigint;
  currency: Currency;
}

export interface ModelUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

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

export interface BudgetSnapshot {
  id: string;
  projectId: string;
  scopeType: "project" | "milestone" | "task" | "agent" | "agent_run";
  scopeId: string;
  limitMicros: bigint;
  currency: Currency;
  spentMicros: bigint;
  reservedMicros: bigint;
}
