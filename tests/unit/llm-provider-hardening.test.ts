import { describe, expect, test } from "vitest";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type {
  AuthorizeReservationInput,
  CostRepository,
  RecordUsageAndCostInput,
} from "@ai-office/application/ports/cost-repository.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type {
  BudgetSnapshot,
  PricingVersion,
} from "@ai-office/domain/cost/cost.ts";
import { FallbackLlmProvider } from "@ai-office/llm-gateway/fallback-provider.ts";
import { MeteredLlmGateway } from "@ai-office/llm-gateway/metered-gateway.ts";
import { MockLlmProvider } from "@ai-office/llm-gateway/mock-provider.ts";
import { OpenAiResponsesProvider } from "@ai-office/llm-gateway/openai-provider.ts";
import {
  InvalidProviderResponseError,
  LlmProviderError,
  ProviderCancelledError,
  type LlmProvider,
  type ModelRequest,
} from "@ai-office/llm-gateway/provider.ts";

const usage = {
  inputTokens: 10,
  cachedInputTokens: 0,
  outputTokens: 5,
  reasoningTokens: 0,
};

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-08-05T00:00:00.000Z");
  }
}

class Ids implements IdGenerator {
  private next = 0;
  generate(): string {
    return `id-${++this.next}`;
  }
}

class MemoryCosts implements CostRepository {
  readonly pricing = new Map<string, PricingVersion>();
  recorded?: RecordUsageAndCostInput;
  released = 0;
  reserved?: AuthorizeReservationInput;

  async savePricing(value: PricingVersion): Promise<void> {
    this.pricing.set(`${value.provider}\0${value.model}`, value);
  }
  async saveBudget(): Promise<void> {}
  async findPricing(
    provider: string,
    model: string,
  ): Promise<PricingVersion | null> {
    return this.pricing.get(`${provider}\0${model}`) ?? null;
  }
  async findBudget(): Promise<BudgetSnapshot | null> {
    return null;
  }
  async authorizeAndReserve(input: AuthorizeReservationInput) {
    this.reserved = input;
    return {
      id: input.id,
      budgetId: "budget",
      reservedMicros: input.amountMicros,
      currency: input.currency,
      status: "active" as const,
      expiresAt: input.expiresAt,
    };
  }
  async releaseReservation() {
    this.released += 1;
    return "released" as const;
  }
  async releaseExpiredReservations() {
    return 0;
  }
  async recordUsageAndCost(input: RecordUsageAndCostInput) {
    this.recorded = input;
    return "recorded" as const;
  }
  async aggregate() {
    return [];
  }
}

const pricing = (provider: string, input: bigint): PricingVersion => ({
  id: `price-${provider}`,
  provider,
  model: "model",
  currency: "USD",
  inputPerMillionMicros: input,
  cachedInputPerMillionMicros: 0n,
  outputPerMillionMicros: input,
  reasoningPerMillionMicros: 0n,
  effectiveFrom: new Date(0),
});

const retryingProvider = (retryable: boolean): LlmProvider => ({
  id: "primary",
  pricingCandidates: (request: ModelRequest) => [
    { providerId: "primary", model: request.model },
  ],
  complete: async () => {
    throw new LlmProviderError("primary", "failed", retryable);
  },
});

describe("fallback metering", () => {
  test("uses the first provider without invoking fallback", async () => {
    const costs = new MemoryCosts();
    costs.pricing.set("primary\0model", pricing("primary", 1_000_000n));
    costs.pricing.set("mock\0model", pricing("mock", 2_000_000n));
    const primary: LlmProvider = {
      id: "primary",
      pricingCandidates: (request) => [
        { providerId: "primary", model: request.model },
      ],
      complete: async (request) => ({
        providerId: "primary",
        model: request.model,
        providerRequestId: "primary-request",
        text: "primary",
        usage,
      }),
    };
    const secondary = new MockLlmProvider();
    const gateway = new MeteredLlmGateway(
      new FallbackLlmProvider([primary, secondary]),
      costs,
      new Ids(),
      new FixedClock(),
    );
    await gateway.complete(
      { model: "model", messages: [] },
      { projectId: "project", purpose: "test", estimatedUsage: usage },
    );
    expect(costs.recorded?.provider).toBe("primary");
    expect(costs.recorded?.pricingVersionId).toBe("price-primary");
    expect(secondary.requests).toHaveLength(0);
  });

  test("persists the provider and pricing that actually completed", async () => {
    const costs = new MemoryCosts();
    costs.pricing.set("primary\0model", pricing("primary", 4_000_000n));
    costs.pricing.set("mock\0model", pricing("mock", 1_000_000n));
    const secondary = new MockLlmProvider({
      providerId: "mock",
      model: "model",
      providerRequestId: "request-2",
      text: "fallback",
      usage,
    });
    const gateway = new MeteredLlmGateway(
      new FallbackLlmProvider([retryingProvider(true), secondary]),
      costs,
      new Ids(),
      new FixedClock(),
    );

    await gateway.complete(
      { model: "model", messages: [] },
      {
        projectId: "project",
        purpose: "test",
        estimatedUsage: usage,
        budgetScopeType: "project",
        budgetScopeId: "project",
      },
    );

    expect(costs.reserved?.amountMicros).toBe(60n);
    expect(costs.recorded).toMatchObject({
      provider: "mock",
      model: "model",
      providerRequestId: "request-2",
      pricingVersionId: "price-mock",
    });
    expect(costs.recorded?.actual.micros).toBe(15n);
  });

  test("does not fall back after a non-retryable error", async () => {
    const secondary = new MockLlmProvider();
    const provider = new FallbackLlmProvider([
      retryingProvider(false),
      secondary,
    ]);
    await expect(
      provider.complete({ model: "model", messages: [] }),
    ).rejects.toBeInstanceOf(LlmProviderError);
    expect(secondary.requests).toHaveLength(0);
  });

  test("abort stops fallback and releases the reservation without usage", async () => {
    const costs = new MemoryCosts();
    costs.pricing.set("primary\0model", pricing("primary", 1_000_000n));
    costs.pricing.set("mock\0model", pricing("mock", 1_000_000n));
    const secondary = new MockLlmProvider();
    const controller = new AbortController();
    const primary: LlmProvider = {
      ...retryingProvider(true),
      complete: async () => {
        controller.abort();
        throw new LlmProviderError("primary", "cancelled", true);
      },
    };
    const gateway = new MeteredLlmGateway(
      new FallbackLlmProvider([primary, secondary]),
      costs,
      new Ids(),
      new FixedClock(),
    );
    await expect(
      gateway.complete(
        { model: "model", messages: [] },
        {
          projectId: "project",
          purpose: "test",
          estimatedUsage: usage,
          budgetScopeType: "project",
          budgetScopeId: "project",
        },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ProviderCancelledError);
    expect(secondary.requests).toHaveLength(0);
    expect(costs.released).toBe(1);
    expect(costs.recorded).toBeUndefined();
  });

  test("provider failure releases the reservation", async () => {
    const costs = new MemoryCosts();
    costs.pricing.set("primary\0model", pricing("primary", 1_000_000n));
    const gateway = new MeteredLlmGateway(
      retryingProvider(false),
      costs,
      new Ids(),
      new FixedClock(),
    );
    await expect(
      gateway.complete(
        { model: "model", messages: [] },
        {
          projectId: "project",
          purpose: "test",
          estimatedUsage: usage,
          budgetScopeType: "project",
          budgetScopeId: "project",
        },
      ),
    ).rejects.toBeInstanceOf(LlmProviderError);
    expect(costs.released).toBe(1);
    expect(costs.recorded).toBeUndefined();
  });
});

describe("OpenAI provider response validation", () => {
  const valid = {
    id: "response-1",
    model: "gpt-test",
    output_text: "done",
    usage: { input_tokens: 1, output_tokens: 2 },
  };

  const provider = (body: unknown, status = 200) =>
    new OpenAiResponsesProvider(
      "test-key",
      "https://example.test/responses",
      async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    );

  test.each([
    [{ ...valid, id: undefined }, "request ID"],
    [{ ...valid, model: undefined }, "effective model"],
    [{ ...valid, output_text: undefined }, "text output"],
    [{ ...valid, usage: undefined }, "usage"],
    [
      { ...valid, usage: { input_tokens: -1, output_tokens: 2 } },
      "input_tokens",
    ],
    [
      { ...valid, usage: { input_tokens: 1.5, output_tokens: 2 } },
      "input_tokens",
    ],
    [
      { ...valid, usage: { input_tokens: 1, output_tokens: undefined } },
      "output_tokens",
    ],
  ])("rejects incomplete or invalid responses", async (body, message) => {
    await expect(
      provider(body).complete({ model: "gpt-test", messages: [] }),
    ).rejects.toThrow(message as string);
  });

  test("classifies invalid JSON and HTTP retryability", async () => {
    await expect(
      provider("not-json").complete({ model: "gpt-test", messages: [] }),
    ).rejects.toBeInstanceOf(InvalidProviderResponseError);
    await expect(
      provider({}, 429).complete({ model: "gpt-test", messages: [] }),
    ).rejects.toMatchObject({ retryable: true, code: "HTTP" });
    await expect(
      provider({}, 400).complete({ model: "gpt-test", messages: [] }),
    ).rejects.toMatchObject({ retryable: false, code: "HTTP" });
  });

  test("propagates cancellation without invoking fetch", async () => {
    let called = false;
    const value = new OpenAiResponsesProvider(
      "test-key",
      "https://example.test/responses",
      async () => {
        called = true;
        return Response.json(valid);
      },
    );
    const controller = new AbortController();
    controller.abort();
    await expect(
      value.complete({ model: "gpt-test", messages: [] }, controller.signal),
    ).rejects.toBeInstanceOf(ProviderCancelledError);
    expect(called).toBe(false);
  });

  test("classifies fetch timeouts separately from cancellation", async () => {
    const value = new OpenAiResponsesProvider(
      "test-key",
      "https://example.test/responses",
      async () => {
        const error = new Error("timed out");
        error.name = "TimeoutError";
        throw error;
      },
    );
    await expect(
      value.complete({ model: "gpt-test", messages: [] }),
    ).rejects.toMatchObject({ code: "TIMEOUT", retryable: true });
  });
});
