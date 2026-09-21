import { describe, expect, test } from "vitest";
import { AnthropicMessagesProvider } from "@ai-office/llm-gateway/anthropic-provider.ts";
import { UnsupportedModelParameterError } from "@ai-office/llm-gateway/provider.ts";

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
      usage: {
        inputTokens: 20,
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
});
