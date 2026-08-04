import type { CostAmount, Currency, ModelUsage } from "@ai-office/domain/cost/cost.ts";

export interface ModelPrice {
  currency: Currency;
  inputPerMillionMicros: bigint;
  cachedInputPerMillionMicros: bigint;
  outputPerMillionMicros: bigint;
  reasoningPerMillionMicros: bigint;
}

export function calculateCost(usage: ModelUsage, price: ModelPrice): CostAmount {
  const million = 1_000_000n;

  const micros =
    (BigInt(usage.inputTokens) * price.inputPerMillionMicros +
      BigInt(usage.cachedInputTokens) * price.cachedInputPerMillionMicros +
      BigInt(usage.outputTokens) * price.outputPerMillionMicros +
      BigInt(usage.reasoningTokens) * price.reasoningPerMillionMicros) /
    million;

  return { micros, currency: price.currency };
}
