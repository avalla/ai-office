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
