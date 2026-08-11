import { describe, expect, test } from "vitest";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type { CostRepository } from "@ai-office/application/ports/cost-repository.port.ts";
import type {
  BudgetSnapshot,
  PricingVersion,
} from "@ai-office/domain/cost/cost.ts";
import { MockLlmProvider } from "@ai-office/llm-gateway/mock-provider.ts";
import { MeteredLlmGateway } from "@ai-office/llm-gateway/metered-gateway.ts";
import { BudgetExceededError } from "@ai-office/application/cost-errors.ts";
import { OpenAiResponsesProvider } from "@ai-office/llm-gateway/openai-provider.ts";
import { FallbackLlmProvider } from "@ai-office/llm-gateway/fallback-provider.ts";
import { LlmProviderError } from "@ai-office/llm-gateway/provider.ts";
import { LangChainModelProvider } from "@ai-office/llm-gateway/langchain-model-provider.ts";

class FixedClock implements Clock {
  now() {
    return new Date("2026-08-05T00:00:00Z");
  }
}
class Ids implements IdGenerator {
  private n = 0;
  generate() {
    return `id-${++this.n}`;
  }
}
class Costs implements CostRepository {
  pricing: PricingVersion = {
    id: "price",
    provider: "mock",
    model: "model",
    currency: "USD",
    inputPerMillionMicros: 1_000_000n,
    cachedInputPerMillionMicros: 500_000n,
    outputPerMillionMicros: 2_000_000n,
    reasoningPerMillionMicros: 3_000_000n,
    effectiveFrom: new Date(0),
  };
  budget: BudgetSnapshot = {
    id: "budget",
    projectId: "p",
    scopeType: "project",
    scopeId: "p",
    currency: "USD",
    limitMicros: 100n,
    spentMicros: 0n,
    reservedMicros: 0n,
  };
  recorded: Parameters<CostRepository["recordUsageAndCost"]>[0] | undefined;
  async savePricing() {}
  async saveBudget() {}
  async findPricing() {
    return this.pricing;
  }
  async findBudget() {
    return this.budget;
  }
  async listBudgetCurrencies() {
    return [this.budget.currency];
  }
  async authorizeAndReserve(
    v: Parameters<CostRepository["authorizeAndReserve"]>[0],
  ) {
    if (
      this.budget.spentMicros + this.budget.reservedMicros + v.amountMicros >
      this.budget.limitMicros
    )
      throw new BudgetExceededError();
    this.budget = { ...this.budget, reservedMicros: v.amountMicros };
    return {
      id: v.id,
      budgetId: this.budget.id,
      reservedMicros: v.amountMicros,
      currency: v.currency,
      status: "active" as const,
      expiresAt: v.expiresAt,
    };
  }
  async releaseReservation() {
    return "released" as const;
  }
  async releaseExpiredReservations() {
    return 0;
  }
  async recordUsageAndCost(
    v: Parameters<CostRepository["recordUsageAndCost"]>[0],
  ) {
    this.recorded = v;
    return "recorded" as const;
  }
  async aggregate() {
    return [];
  }
}
describe("metered LLM gateway", () => {
  test("reserves, records normalized usage and prices the actual response", async () => {
    const costs = new Costs();
    const provider = new MockLlmProvider({
      text: "ok",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningTokens: 1,
      },
    });
    const gateway = new MeteredLlmGateway(
      provider,
      costs,
      new Ids(),
      new FixedClock(),
    );
    const response = await gateway.complete(
      { model: "model", messages: [{ role: "user", content: "hello" }] },
      {
        projectId: "p",
        purpose: "test",
        estimatedUsage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
        budgetScopeType: "project",
        budgetScopeId: "p",
      },
    );
    expect(response.text).toBe("ok");
    expect(costs.recorded?.actual.micros).toBe(24n);
    expect(costs.recorded?.pricingVersionId).toBe("price");
  });
  test("rejects before provider execution when reservations exceed budget", async () => {
    const costs = new Costs();
    costs.budget = { ...costs.budget, limitMicros: 1n };
    const provider = new MockLlmProvider();
    const gateway = new MeteredLlmGateway(
      provider,
      costs,
      new Ids(),
      new FixedClock(),
    );
    await expect(
      gateway.complete(
        { model: "model", messages: [] },
        {
          projectId: "p",
          purpose: "test",
          estimatedUsage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 10,
            reasoningTokens: 0,
          },
          budgetScopeType: "project",
          budgetScopeId: "p",
        },
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
    expect(provider.requests).toHaveLength(0);
  });
  test("records normalized usage returned through the LangChain adapter", async () => {
    const costs = new Costs();
    costs.pricing = { ...costs.pricing, provider: "anthropic" };
    const provider = new LangChainModelProvider("anthropic", "model", {
      invoke: async () =>
        ({
          id: "request-langchain",
          text: "ok",
          usage_metadata: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_token_details: { cache_read: 2 },
            output_token_details: { reasoning: 1 },
          },
          response_metadata: { model: "model" },
        }) as never,
    });
    const response = await new MeteredLlmGateway(
      provider,
      costs,
      new Ids(),
      new FixedClock(),
    ).complete(
      { model: "model", messages: [{ role: "user", content: "hello" }] },
      {
        projectId: "p",
        purpose: "test",
        estimatedUsage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
      },
    );

    expect(response.providerId).toBe("anthropic");
    expect(costs.recorded).toMatchObject({
      provider: "anthropic",
      model: "model",
      providerRequestId: "request-langchain",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningTokens: 1,
      },
    });
  });
  test("normalizes a Responses API result without making a network call", async () => {
    const fake = async () =>
      Response.json({
        id: "resp-1",
        model: "gpt-test",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "done" }],
          },
        ],
        usage: {
          input_tokens: 8,
          output_tokens: 3,
          input_tokens_details: { cached_tokens: 2 },
          output_tokens_details: { reasoning_tokens: 1 },
        },
      });
    const provider = new OpenAiResponsesProvider(
      "test-key",
      "https://example.test/responses",
      fake,
    );
    await expect(
      provider.complete({
        model: "gpt-test",
        messages: [{ role: "user", content: "hello" }],
      }),
    ).resolves.toEqual({
      providerId: "openai",
      model: "gpt-test",
      text: "done",
      providerRequestId: "resp-1",
      usage: {
        inputTokens: 8,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
      },
    });
  });
  test("falls back only after retryable provider failures", async () => {
    const failing = {
      id: "primary",
      pricingCandidates: (request: { model: string }) => [
        { providerId: "primary", model: request.model },
      ],
      complete: async () => {
        throw new LlmProviderError("primary", "busy", true);
      },
    };
    const fallback = new MockLlmProvider();
    const provider = new FallbackLlmProvider([failing, fallback]);
    expect(
      (await provider.complete({ model: "model", messages: [] })).text,
    ).toBe("Mock response");
    expect(fallback.requests).toHaveLength(1);
  });
});
