import { describe, expect, test } from "vitest";
import { LangChainModelProvider } from "@ai-office/llm-gateway/langchain-model-provider.ts";
import {
  createDefaultModelProviderRegistry,
  ModelProviderConfigurationError,
  ModelProviderRegistry,
  parseModelRef,
} from "@ai-office/llm-gateway/model-provider-registry.ts";
import { GatewayOnboardingQuestionGenerator } from "@ai-office/llm-gateway/onboarding-question-generator.ts";
import { MockLlmProvider } from "@ai-office/llm-gateway/mock-provider.ts";
import {
  InvalidProviderResponseError,
  ProviderCancelledError,
} from "@ai-office/llm-gateway/provider.ts";

describe("model provider registry", () => {
  test("resolves an OpenAI model ref through the LangChain adapter", () => {
    const resolved = createDefaultModelProviderRegistry().resolve({
      AI_OFFICE_LLM_MODEL: "openai:gpt-5.4",
      OPENAI_API_KEY: "test-openai-key",
    });

    expect(resolved).toMatchObject({
      modelRef: "openai:gpt-5.4",
      providerId: "openai",
      model: "gpt-5.4",
      compatibilityConfiguration: false,
    });
    expect(resolved.provider).toBeInstanceOf(LangChainModelProvider);
    expect(resolved.provider.id).toBe("openai");
  });

  test("resolves an Anthropic model ref through the same provider port", () => {
    const resolved = createDefaultModelProviderRegistry().resolve({
      AI_OFFICE_LLM_MODEL: "anthropic:claude-sonnet-4-6",
      ANTHROPIC_API_KEY: "test-anthropic-key",
    });

    expect(resolved).toMatchObject({
      modelRef: "anthropic:claude-sonnet-4-6",
      providerId: "anthropic",
      model: "claude-sonnet-4-6",
      compatibilityConfiguration: false,
    });
    expect(resolved.provider).toBeInstanceOf(LangChainModelProvider);
    expect(resolved.provider.id).toBe("anthropic");
  });

  test("fails clearly for an unsupported provider", () => {
    expect(() =>
      createDefaultModelProviderRegistry().resolve({
        AI_OFFICE_LLM_MODEL: "ollama:qwen3",
      }),
    ).toThrow('Unsupported LLM provider "ollama" in model "ollama:qwen3"');
  });

  test("reports missing credentials before constructing a provider", () => {
    let constructed = false;
    const registry = new ModelProviderRegistry([
      {
        providerId: "anthropic",
        requiredEnvironmentVariables: ["ANTHROPIC_API_KEY"],
        create: () => {
          constructed = true;
          return new MockLlmProvider();
        },
      },
    ]);

    expect(() =>
      registry.resolve({
        AI_OFFICE_LLM_MODEL: "anthropic:claude-sonnet-4-6",
      }),
    ).toThrowError(
      new ModelProviderConfigurationError(
        "No usable LLM provider configuration found.\n\nConfigured model:\n  anthropic:claude-sonnet-4-6\n\nMissing:\n  ANTHROPIC_API_KEY",
        "anthropic:claude-sonnet-4-6",
        ["ANTHROPIC_API_KEY"],
      ),
    );
    expect(constructed).toBe(false);
  });

  test("keeps the legacy provider plus bare model configuration compatible", () => {
    const resolved = createDefaultModelProviderRegistry().resolve({
      AI_OFFICE_LLM_PROVIDER: "openai",
      AI_OFFICE_LLM_MODEL: "gpt-5.4",
      OPENAI_API_KEY: "test-openai-key",
    });

    expect(resolved).toMatchObject({
      modelRef: "openai:gpt-5.4",
      providerId: "openai",
      model: "gpt-5.4",
      compatibilityConfiguration: true,
    });
  });

  test("requires the compatibility provider only for a bare model", () => {
    expect(() => parseModelRef("gpt-5.4")).toThrow("AI_OFFICE_LLM_PROVIDER");
    expect(parseModelRef("openai:gpt-5.4", "anthropic")).toMatchObject({
      providerId: "openai",
      model: "gpt-5.4",
      compatibilityConfiguration: false,
    });
  });

  test("provider switching does not change the onboarding adapter", () => {
    const registry = new ModelProviderRegistry(
      ["openai", "anthropic"].map((providerId) => ({
        providerId,
        requiredEnvironmentVariables: [],
        create: () =>
          new MockLlmProvider({
            providerId,
            text: "ok",
            usage: {
              inputTokens: 1,
              cachedInputTokens: 0,
              outputTokens: 1,
              reasoningTokens: 0,
            },
          }),
      })),
    );
    const gateway = {} as ConstructorParameters<
      typeof GatewayOnboardingQuestionGenerator
    >[0];

    for (const modelRef of ["openai:gpt-test", "anthropic:claude-test"]) {
      const resolved = registry.resolve({ AI_OFFICE_LLM_MODEL: modelRef });
      const generator = new GatewayOnboardingQuestionGenerator(
        gateway,
        resolved.providerId,
        resolved.model,
      );
      expect(generator.targetProvider).toBe(resolved.providerId);
      expect(generator.targetModel).toBe(resolved.model);
    }
  });
});

describe("LangChain model provider", () => {
  test("normalizes messages, usage, metadata, request ID, and latency", async () => {
    let input: unknown[] = [];
    const ticks = [100, 142];
    const provider = new LangChainModelProvider(
      "openai",
      "gpt-test",
      {
        invoke: async (messages) => {
          input = messages;
          return {
            id: "langchain-message-id",
            text: "done",
            usage_metadata: {
              input_tokens: 8,
              output_tokens: 3,
              total_tokens: 11,
              input_token_details: { cache_read: 2 },
              output_token_details: { reasoning: 1 },
            },
            response_metadata: {
              id: "provider-request-id",
              model_name: "gpt-test",
              finish_reason: "stop",
            },
          } as never;
        },
      },
      () => ticks.shift()!,
    );

    await expect(
      provider.complete({
        model: "gpt-test",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "question" },
          { role: "assistant", content: "answer" },
        ],
      }),
    ).resolves.toEqual({
      providerId: "openai",
      model: "gpt-test",
      text: "done",
      providerRequestId: "provider-request-id",
      latencyMs: 42,
      providerMetadata: {
        id: "provider-request-id",
        model_name: "gpt-test",
        finish_reason: "stop",
      },
      usage: {
        inputTokens: 8,
        cachedInputTokens: 2,
        outputTokens: 3,
        reasoningTokens: 1,
      },
    });
    expect((input[0] as { getType(): string }).getType()).toBe("system");
    expect((input[1] as { getType(): string }).getType()).toBe("human");
    expect((input[2] as { getType(): string }).getType()).toBe("ai");
  });

  test("uses required zero values when optional usage detail is unavailable", async () => {
    const provider = new LangChainModelProvider("anthropic", "claude-test", {
      invoke: async () =>
        ({
          text: "done",
          usage_metadata: {
            input_tokens: 5,
            output_tokens: 2,
            total_tokens: 7,
          },
          response_metadata: { model: "claude-test" },
        }) as never,
    });

    await expect(
      provider.complete({ model: "claude-test", messages: [] }),
    ).resolves.toMatchObject({
      providerId: "anthropic",
      model: "claude-test",
      usage: {
        inputTokens: 5,
        cachedInputTokens: 0,
        outputTokens: 2,
        reasoningTokens: 0,
      },
    });
  });

  test("rejects responses without total input and output usage", async () => {
    const provider = new LangChainModelProvider("openai", "gpt-test", {
      invoke: async () => ({ text: "done", response_metadata: {} }) as never,
    });

    await expect(
      provider.complete({ model: "gpt-test", messages: [] }),
    ).rejects.toBeInstanceOf(InvalidProviderResponseError);
  });

  test("normalizes provider HTTP errors and cancellation", async () => {
    const provider = new LangChainModelProvider("anthropic", "claude-test", {
      invoke: async () => {
        throw Object.assign(new Error("secret provider detail"), {
          status: 429,
        });
      },
    });
    await expect(
      provider.complete({ model: "claude-test", messages: [] }),
    ).rejects.toMatchObject({
      message: "anthropic returned HTTP 429",
      retryable: true,
      code: "HTTP",
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      provider.complete(
        { model: "claude-test", messages: [] },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(ProviderCancelledError);
  });
});
