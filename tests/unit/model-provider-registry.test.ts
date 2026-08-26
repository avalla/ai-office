import { afterEach, describe, expect, test, vi } from "vitest";
import { LangChainModelProvider } from "@ai-office/llm-gateway/langchain-model-provider.ts";
import {
  createDefaultModelProviderRegistry,
  ModelProviderConfigurationError,
  ModelProviderRegistry,
  parseModelRef,
} from "@ai-office/llm-gateway/model-provider-registry.ts";
import { MockLlmProvider } from "@ai-office/llm-gateway/mock-provider.ts";
import {
  InvalidProviderResponseError,
  ProviderCancelledError,
} from "@ai-office/llm-gateway/provider.ts";

afterEach(() => vi.restoreAllMocks());

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

  test("does not emit configuration diagnostics when LLM debug is off", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    createDefaultModelProviderRegistry().resolve({
      AI_OFFICE_LLM_MODEL: "openai:gpt-5.4",
      OPENAI_API_KEY: "diagnostic-openai-key",
    });

    expect(error).not.toHaveBeenCalled();
  });

  test("emits deterministic redacted configuration diagnostics when enabled", () => {
    const apiKey = "diagnostic-openai-key";
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const environment = {
      AI_OFFICE_DEBUG_LLM: "1",
      AI_OFFICE_LLM_MODEL: "openai:gpt-5.4",
      OPENAI_API_KEY: apiKey,
    };

    createDefaultModelProviderRegistry().resolve(environment);
    createDefaultModelProviderRegistry().resolve(environment);

    const logs = error.mock.calls.flatMap((call) => call.map(String));
    expect(logs).toHaveLength(4);
    expect(logs[0]).toBe(
      `[llm:config] pid=${process.pid} provider=openai model=gpt-5.4`,
    );
    expect(logs[1]).toBe(
      "[llm:config] api_key_present=true api_key_length=21 api_key_fingerprint=0756f8d6f3fa",
    );
    expect(logs[3]).toBe(logs[1]);
    expect(logs.join("\n")).not.toContain(apiKey);
  });

  test("reports an absent API key without changing configuration validation", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(() =>
      createDefaultModelProviderRegistry().resolve({
        AI_OFFICE_DEBUG_LLM: "1",
        AI_OFFICE_LLM_MODEL: "openai:gpt-5.4",
      }),
    ).toThrow("OPENAI_API_KEY");

    expect(error.mock.calls.flatMap((call) => call.map(String))).toEqual([
      `[llm:config] pid=${process.pid} provider=openai model=gpt-5.4`,
      "[llm:config] api_key_present=false api_key_length=0 api_key_fingerprint=e3b0c44298fc",
    ]);
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

});

describe("LangChain model provider", () => {
  test("does not emit request or error diagnostics when LLM debug is off", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new LangChainModelProvider("openai", "gpt-test", {
      invoke: async () => {
        throw Object.assign(new Error("provider detail"), {
          status: 401,
          code: "invalid_api_key",
        });
      },
    });

    await expect(
      provider.complete({
        model: "gpt-requested",
        messages: [{ role: "user", content: "secret prompt" }],
      }),
    ).rejects.toMatchObject({ message: "openai returned HTTP 401" });
    expect(error).not.toHaveBeenCalled();
  });

  test("logs only request dimensions immediately before invocation", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = new LangChainModelProvider(
      "openai",
      "gpt-configured",
      {
        invoke: async () =>
          ({
            text: "done",
            usage_metadata: {
              input_tokens: 1,
              output_tokens: 1,
              total_tokens: 2,
            },
            response_metadata: {},
          }) as never,
      },
      undefined,
      true,
    );

    await provider.complete({
      model: "gpt-requested",
      messages: [
        { role: "system", content: "private-system" },
        { role: "user", content: "private-user" },
      ],
    });

    const logs = error.mock.calls.flatMap((call) => call.map(String));
    expect(logs).toEqual([
      "[llm:request] provider=openai configured_model=gpt-configured requested_model=gpt-requested message_count=2 message_character_count=26",
    ]);
    expect(logs.join("\n")).not.toContain("private-system");
    expect(logs.join("\n")).not.toContain("private-user");
  });

  test("logs selected provider error fields without raw sensitive objects", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const rawKey = "sk-proj-rawapikeymustnotappear";
    const providerError = Object.assign(
      new Error(`Incorrect API key ${rawKey} provided`),
      {
        name: "AuthenticationError",
        status: 401,
        code: "invalid_api_key",
        type: "invalid_request_error",
        request_id: "req_diagnostic",
        authorization: `Bearer ${rawKey}`,
        apiKey: rawKey,
        headers: { authorization: `Bearer ${rawKey}` },
        body: { raw: rawKey },
        cause: Object.assign(new Error("upstream rejected request"), {
          statusCode: 502,
          code: "ECONNRESET",
          requestID: "req_cause",
          authorization: `Bearer ${rawKey}`,
        }),
      },
    );
    const provider = new LangChainModelProvider(
      "openai",
      "gpt-test",
      {
        invoke: async () => {
          throw providerError;
        },
      },
      undefined,
      true,
    );

    await expect(
      provider.complete({ model: "gpt-test", messages: [] }),
    ).rejects.toMatchObject({
      message: "openai returned HTTP 401",
      retryable: false,
      code: "HTTP",
    });

    const logs = error.mock.calls
      .flatMap((call) => call.map(String))
      .join("\n");
    expect(logs).toContain(
      "[llm:error] provider=openai name=AuthenticationError status=401 code=invalid_api_key type=invalid_request_error request_id=req_diagnostic",
    );
    expect(logs).toContain(
      '[llm:error] message="Incorrect API key [REDACTED] provided"',
    );
    expect(logs).toContain(
      "[llm:error] cause name=Error status=502 code=ECONNRESET request_id=req_cause",
    );
    expect(logs).not.toContain(rawKey);
    expect(logs).not.toContain("authorization");
    expect(logs).not.toContain("headers");
    expect(logs).not.toContain("body");
    expect(logs).not.toContain("stack");
  });

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
