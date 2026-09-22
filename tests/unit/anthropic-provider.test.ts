import { describe, expect, test } from "vitest";
import { AnthropicMessagesProvider } from "@ai-office/llm-gateway/anthropic-provider.ts";
import {
  InvalidProviderResponseError,
  LlmProviderError,
  ProviderCancelledError,
  UnsupportedModelParameterError,
} from "@ai-office/llm-gateway/provider.ts";

const request = {
  model: "claude-test",
  messages: [
    { role: "system" as const, content: "system" },
    { role: "user" as const, content: "hello" },
  ],
  parameters: { maxOutputTokens: 123 },
};

describe("Anthropic native provider", () => {
  test("applies max_output_tokens and reports effective model and request id", async () => {
    let captured: { headers: Headers; body: Record<string, unknown> } | null =
      null;
    const provider = new AnthropicMessagesProvider(
      "test-key",
      "https://provider.test/v1/messages",
      async (_input, init) => {
        captured = {
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        };
        return new Response(
          JSON.stringify({
            id: "msg_1",
            model: "claude-effective",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "answer" }],
            usage: {
              input_tokens: 20,
              cache_read_input_tokens: 3,
              output_tokens: 7,
            },
          }),
          { status: 200 },
        );
      },
    );

    await expect(provider.complete(request)).resolves.toMatchObject({
      providerId: "anthropic",
      model: "claude-effective",
      providerRequestId: "msg_1",
      text: "answer",
      providerMetadata: {
        status: "completed",
        stopReason: "end_turn",
      },
      usage: {
        inputTokens: 23,
        cachedInputTokens: 3,
        outputTokens: 7,
        reasoningTokens: 0,
      },
    });
    const sent = captured as unknown as {
      headers: Headers;
      body: Record<string, unknown>;
    };
    expect(sent.headers.get("x-api-key")).toBe("test-key");
    expect(sent.body).toMatchObject({
      model: "claude-test",
      system: "system",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 123,
    });
  });

  test("keeps ordinary input totals when prompt caching is absent", async () => {
    const provider = new AnthropicMessagesProvider(
      "test-key",
      "https://provider.test/v1/messages",
      async () =>
        Response.json({
          id: "msg_no_cache",
          model: "claude-test",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "answer" }],
          usage: { input_tokens: 20, output_tokens: 7 },
        }),
    );
    await expect(provider.complete(request)).resolves.toMatchObject({
      usage: {
        inputTokens: 20,
        cachedInputTokens: 0,
        outputTokens: 7,
      },
    });
  });

  test("normalizes cache-read input into inclusive input totals", async () => {
    const provider = new AnthropicMessagesProvider(
      "test-key",
      "https://provider.test/v1/messages",
      async () =>
        Response.json({
          id: "msg_cache",
          model: "claude-test",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "answer" }],
          usage: {
            input_tokens: 20,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 0,
            output_tokens: 7,
          },
        }),
    );
    const response = await provider.complete(request);
    expect(response.usage).toMatchObject({
      inputTokens: 23,
      cachedInputTokens: 3,
    });
    expect(response.usage.cachedInputTokens).toBeLessThanOrEqual(
      response.usage.inputTokens,
    );
  });

  test("rejects cache creation because pricing cannot represent it", async () => {
    const provider = new AnthropicMessagesProvider(
      "test-key",
      "https://provider.test/v1/messages",
      async () =>
        Response.json({
          id: "msg_cache_write",
          model: "claude-test",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "answer" }],
          usage: {
            input_tokens: 20,
            cache_creation_input_tokens: 3,
            output_tokens: 7,
          },
        }),
    );
    await expect(provider.complete(request)).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
      message: expect.stringContaining("cache creation"),
    });
  });

  for (const stopReason of [
    "max_tokens",
    "model_context_window_exceeded",
    "tool_use",
    "pause_turn",
    "refusal",
  ])
    test(`marks Anthropic stop_reason ${stopReason} as incomplete`, async () => {
      const provider = new AnthropicMessagesProvider(
        "test-key",
        "https://provider.test/v1/messages",
        async () =>
          Response.json({
            id: "msg_incomplete",
            model: "claude-test",
            stop_reason: stopReason,
            content:
              stopReason === "tool_use"
                ? [{ type: "tool_use", id: "toolu_1", name: "tool" }]
                : [{ type: "text", text: '{"summary":"valid","content":"valid"}' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
      );
      await expect(provider.complete(request)).resolves.toMatchObject({
        text: stopReason === "tool_use" ? "" : '{"summary":"valid","content":"valid"}',
        providerMetadata: { status: "incomplete", stopReason },
      });
    });

  test("rejects reasoning_effort before contacting Anthropic", async () => {
    let calls = 0;
    const provider = new AnthropicMessagesProvider(
      "test-key",
      "https://provider.test/v1/messages",
      async () => {
        calls += 1;
        return new Response("{}");
      },
    );

    await expect(
      provider.complete({
        ...request,
        parameters: { reasoningEffort: "high", maxOutputTokens: 123 },
      }),
    ).rejects.toBeInstanceOf(UnsupportedModelParameterError);
    expect(calls).toBe(0);
  });

  for (const status of [408, 409, 429, 500, 503])
    test("classifies HTTP " + status + " as retryable", async () => {
      const provider = new AnthropicMessagesProvider(
        "test-key",
        "https://provider.test/v1/messages",
        async () => new Response("{}", { status }),
      );
      await expect(provider.complete(request)).rejects.toMatchObject({
        code: "HTTP",
        retryable: true,
      });
    });

  test("classifies other HTTP errors as non-retryable", async () => {
    const provider = new AnthropicMessagesProvider(
      "test-key",
      "https://provider.test/v1/messages",
      async () => new Response("{}", { status: 400 }),
    );
    await expect(provider.complete(request)).rejects.toMatchObject({
      code: "HTTP",
      retryable: false,
    });
  });

  test("requires effective model, request id and valid usage", async () => {
    const base = {
      id: "msg_1",
      model: "claude-effective",
      content: [{ type: "text", text: "answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    for (const value of [
      { ...base, id: undefined },
      { ...base, model: undefined },
      { ...base, usage: { input_tokens: "bad", output_tokens: 1 } },
    ]) {
      const provider = new AnthropicMessagesProvider(
        "test-key",
        "https://provider.test/v1/messages",
        async () => Response.json(value),
      );
      await expect(provider.complete(request)).rejects.toBeInstanceOf(
        InvalidProviderResponseError,
      );
    }
  });

  test("passes AbortSignal and never leaks the API key on transport failure", async () => {
    const key = "anthropic-secret-key";
    const controller = new AbortController();
    let signal: AbortSignal | undefined;
    const provider = new AnthropicMessagesProvider(
      key,
      "https://provider.test/v1/messages",
      async (_input, init) => {
        signal = init?.signal as AbortSignal | undefined;
        throw new Error(key);
      },
    );
    const failure = provider.complete(request, controller.signal);
    await expect(failure).rejects.toBeInstanceOf(LlmProviderError);
    await expect(failure).rejects.not.toThrow(key);
    await expect(failure).rejects.toMatchObject({
      code: "NETWORK",
      retryable: true,
    });
    expect(signal).toBe(controller.signal);
  });

  test("maps AbortError to cancellation", async () => {
    const provider = new AnthropicMessagesProvider(
      "test-key",
      "https://provider.test/v1/messages",
      async () => {
        throw new DOMException("aborted", "AbortError");
      },
    );
    await expect(provider.complete(request)).rejects.toBeInstanceOf(
      ProviderCancelledError,
    );
  });
});
