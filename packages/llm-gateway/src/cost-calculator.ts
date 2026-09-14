import {
  billableTokens,
  type CostAmount,
  type Currency,
  type ModelUsage,
  type ModelUsageBound,
} from "@ai-office/domain/cost/cost.ts";

export interface ModelPrice {
  currency: Currency;
  inputPerMillionMicros: bigint;
  cachedInputPerMillionMicros: bigint;
  outputPerMillionMicros: bigint;
  reasoningPerMillionMicros: bigint;
}

const million = 1_000_000n;

/**
 * Prices inclusive usage by its mutually exclusive buckets:
 *
 * ```text
 * ( (inputTokens  - cachedInputTokens) * inputPerMillionMicros
 *   + cachedInputTokens                * cachedInputPerMillionMicros
 *   + (outputTokens - reasoningTokens)  * outputPerMillionMicros
 *   + reasoningTokens                  * reasoningPerMillionMicros
 * ) / 1_000_000   (integer division)
 * ```
 */
export function calculateCost(
  usage: ModelUsage,
  price: ModelPrice,
): CostAmount {
  const tokens = billableTokens(usage);
  const micros =
    (BigInt(tokens.uncachedInputTokens) * price.inputPerMillionMicros +
      BigInt(tokens.cachedInputTokens) * price.cachedInputPerMillionMicros +
      BigInt(tokens.nonReasoningOutputTokens) * price.outputPerMillionMicros +
      BigInt(tokens.reasoningTokens) * price.reasoningPerMillionMicros) /
    million;
  return { micros, currency: price.currency };
}

const larger = (left: bigint, right: bigint): bigint =>
  left > right ? left : right;

/**
 * The highest {@link calculateCost} of any valid usage within the bound. Every
 * input token is either cached or not and every output token either reasoning
 * or not, so each total is priced once at its dearer rate; alternative
 * compositions are never added together.
 */
export function calculateMaximumCost(
  bound: ModelUsageBound,
  price: ModelPrice,
): CostAmount {
  for (const value of [bound.inputTokens, bound.outputTokens])
    if (!Number.isSafeInteger(value) || value < 0)
      throw new RangeError("Usage bounds must be non-negative safe integers");
  const micros =
    (BigInt(bound.inputTokens) *
      larger(price.inputPerMillionMicros, price.cachedInputPerMillionMicros) +
      BigInt(bound.outputTokens) *
        larger(price.outputPerMillionMicros, price.reasoningPerMillionMicros)) /
    million;
  return { micros, currency: price.currency };
}
