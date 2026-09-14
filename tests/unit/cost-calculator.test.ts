import { describe, expect, test } from "vitest";
import {
  billableTokens,
  InvalidModelUsageError,
  type ModelUsage,
} from "@ai-office/domain/cost/cost.ts";
import {
  calculateCost,
  calculateMaximumCost,
  type ModelPrice,
} from "@ai-office/llm-gateway/cost-calculator.ts";
import { validateModelResponse } from "@ai-office/llm-gateway/provider.ts";

/**
 * OpenAI-like pricing in micros per million tokens: $1.25 uncached input,
 * $0.125 cached input, $10 output, and reasoning billed as ordinary output.
 */
const openAi: ModelPrice = {
  currency: "USD",
  inputPerMillionMicros: 1_250_000n,
  cachedInputPerMillionMicros: 125_000n,
  outputPerMillionMicros: 10_000_000n,
  reasoningPerMillionMicros: 10_000_000n,
};

const reported: ModelUsage = {
  inputTokens: 900,
  cachedInputTokens: 100,
  outputTokens: 300,
  reasoningTokens: 120,
};

describe("inclusive model usage accounting", () => {
  test("decomposes provider totals into mutually exclusive billable buckets", () => {
    expect(billableTokens(reported)).toEqual({
      uncachedInputTokens: 800,
      cachedInputTokens: 100,
      nonReasoningOutputTokens: 180,
      reasoningTokens: 120,
    });
  });

  test("charges cached input once, at the cached rate only", () => {
    // 800 * 1.25 + 100 * 0.125 + 180 * 10 + 120 * 10 = 4012.5 micros.
    expect(calculateCost(reported, openAi)).toEqual({
      micros: 4012n,
      currency: "USD",
    });
    // Pricing every counter additively would have charged 5337 micros. Without
    // the cache the same 900 input tokens cost 1125 instead of 1012.5.
    expect(
      calculateCost({ ...reported, cachedInputTokens: 0 }, openAi).micros,
    ).toBe(4125n);
  });

  test("reasoning billed as output adds no surcharge", () => {
    expect(calculateCost({ ...reported, reasoningTokens: 0 }, openAi)).toEqual(
      calculateCost(reported, openAi),
    );
    expect(
      calculateCost({ ...reported, reasoningTokens: 300 }, openAi),
    ).toEqual(calculateCost(reported, openAi));
  });

  test("a distinct reasoning rate replaces the output rate for reasoning tokens", () => {
    const price = { ...openAi, reasoningPerMillionMicros: 20_000_000n };
    // 1000 + 12.5 + 180 * 10 + 120 * 20 = 5212.5 micros.
    expect(calculateCost(reported, price).micros).toBe(5212n);
  });

  test("zero cached and reasoning tokens keep ordinary pricing", () => {
    expect(
      calculateCost(
        {
          inputTokens: 900,
          cachedInputTokens: 0,
          outputTokens: 300,
          reasoningTokens: 0,
        },
        openAi,
      ).micros,
    ).toBe(1125n + 3000n);
  });

  test("rejects details larger than their totals", () => {
    for (const usage of [
      { ...reported, cachedInputTokens: 901 },
      { ...reported, reasoningTokens: 301 },
      { ...reported, inputTokens: -1 },
      { ...reported, outputTokens: 1.5 },
    ]) {
      expect(() => billableTokens(usage)).toThrow(InvalidModelUsageError);
      expect(() => calculateCost(usage, openAi)).toThrow(
        InvalidModelUsageError,
      );
    }
  });

  test("provider responses with impossible subsets are invalid", () => {
    const response = {
      providerId: "openai",
      model: "model",
      text: "ok",
      usage: reported,
    };
    expect(() => validateModelResponse(response, "openai")).not.toThrow();
    expect(() =>
      validateModelResponse(
        { ...response, usage: { ...reported, cachedInputTokens: 901 } },
        "openai",
      ),
    ).toThrow("usage.cachedInputTokens must not exceed usage.inputTokens");
    expect(() =>
      validateModelResponse(
        { ...response, usage: { ...reported, reasoningTokens: 301 } },
        "openai",
      ),
    ).toThrow("usage.reasoningTokens must not exceed usage.outputTokens");
  });
});

describe("worst-case reservation envelope", () => {
  const bound = { inputTokens: 900, outputTokens: 300 };

  test("prices each total once at its dearer rate", () => {
    // 900 * max(1.25, 0.125) + 300 * max(10, 10).
    expect(calculateMaximumCost(bound, openAi).micros).toBe(1125n + 3000n);
    const cachedDearer = {
      ...openAi,
      cachedInputPerMillionMicros: 2_000_000n,
      reasoningPerMillionMicros: 15_000_000n,
    };
    expect(calculateMaximumCost(bound, cachedDearer).micros).toBe(
      1800n + 4500n,
    );
  });

  test("bounds every valid usage within the totals and is attained", () => {
    const prices = [
      openAi,
      { ...openAi, cachedInputPerMillionMicros: 3_000_000n },
      { ...openAi, reasoningPerMillionMicros: 30_000_000n },
      { ...openAi, reasoningPerMillionMicros: 0n },
    ];
    for (const price of prices) {
      const maximum = calculateMaximumCost(bound, price).micros;
      let highest = 0n;
      for (const input of [0, 450, 900])
        for (const cached of [0, Math.floor(input / 3), input])
          for (const output of [0, 150, 300])
            for (const reasoning of [0, Math.floor(output / 2), output]) {
              const micros = calculateCost(
                {
                  inputTokens: input,
                  cachedInputTokens: cached,
                  outputTokens: output,
                  reasoningTokens: reasoning,
                },
                price,
              ).micros;
              expect(micros).toBeLessThanOrEqual(maximum);
              if (micros > highest) highest = micros;
            }
      expect(highest).toBe(maximum);
    }
  });

  test("does not add mutually exclusive compositions together", () => {
    // The former envelope priced input as both uncached and cached, and output
    // as both ordinary and reasoning: 900 * 1.375 + 300 * 20 = 7237.5 micros.
    expect(calculateMaximumCost(bound, openAi).micros).toBeLessThan(7237n);
  });
});
