import {
  InvalidProviderResponseError,
  LlmProviderError,
  ProviderCancelledError,
  UnsupportedModelParameterError,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
} from "./provider.ts";

interface AnthropicResponse {
  id?: unknown;
  model?: unknown;
  stop_reason?: unknown;
  content?: unknown;
  usage?: {
    input_tokens?: unknown;
    cache_read_input_tokens?: unknown;
    cache_creation_input_tokens?: unknown;
    output_tokens?: unknown;
  };
}

const count = (
  value: unknown,
  providerId: string,
  field: string,
  optional = false,
): number => {
  if (optional && value === undefined) return 0;
  if (!Number.isSafeInteger(value) || typeof value !== "number" || value < 0)
    throw new InvalidProviderResponseError(
      providerId,
      `${field} must be a non-negative safe integer`,
    );
  return value;
};

function responseText(value: AnthropicResponse): string | null {
  if (!Array.isArray(value.content)) return null;
  const chunks: string[] = [];
  for (const block of value.content) {
    if (typeof block !== "object" || block === null) continue;
    const item = block as Record<string, unknown>;
    if (item.type === "text" && typeof item.text === "string")
      chunks.push(item.text);
  }
  return chunks.length === 0 ? null : chunks.join("");
}

export class AnthropicMessagesProvider implements LlmProvider {
  readonly id = "anthropic";

  constructor(
    private readonly apiKey: string,
    private readonly endpoint = "https://api.anthropic.com/v1/messages",
    private readonly fetcher: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {
    if (apiKey.trim() === "")
      throw new LlmProviderError(
        this.id,
        "Anthropic API key is required",
        false,
      );
  }

  pricingCandidates(request: ModelRequest) {
    return [{ providerId: this.id, model: request.model }];
  }

  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    if (signal?.aborted === true) throw new ProviderCancelledError(this.id);
    const effort = request.parameters?.reasoningEffort;
    const maxOutputTokens = request.parameters?.maxOutputTokens;
    // Anthropic's thinking budget is not equivalent to AI Office's
    // provider-neutral reasoning_effort contract, so fail closed before I/O.
    if (effort !== undefined)
      throw new UnsupportedModelParameterError(this.id, "reasoningEffort");
    if (
      maxOutputTokens !== undefined &&
      (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1)
    )
      throw new UnsupportedModelParameterError(this.id, "maxOutputTokens");

    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const messages = request.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role === "assistant" ? "assistant" : "user",
        content: message.content,
      }));
    if (messages.length === 0)
      throw new InvalidProviderResponseError(
        this.id,
        "Anthropic request requires at least one user or assistant message",
      );

    let response: Response;
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          "x-api-key": this.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.model,
          ...(system === "" ? {} : { system }),
          messages,
          max_tokens: maxOutputTokens ?? 32_000,
        }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (
        signal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError")
      )
        throw new ProviderCancelledError(this.id);
      if (error instanceof Error && error.name === "TimeoutError")
        throw new LlmProviderError(
          this.id,
          "Anthropic request timed out",
          true,
          "TIMEOUT",
        );
      throw new LlmProviderError(
        this.id,
        "Anthropic request failed",
        true,
        "NETWORK",
      );
    }
    if (!response.ok)
      throw new LlmProviderError(
        this.id,
        `Anthropic returned HTTP ${response.status}`,
        response.status === 408 ||
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500,
        "HTTP",
      );

    let value: AnthropicResponse;
    try {
      value = (await response.json()) as AnthropicResponse;
    } catch {
      throw new InvalidProviderResponseError(
        this.id,
        "Provider response was not valid JSON",
      );
    }
    if (typeof value.id !== "string" || value.id.trim() === "")
      throw new InvalidProviderResponseError(
        this.id,
        "Provider response did not contain a request ID",
      );
    if (typeof value.model !== "string" || value.model.trim() === "")
      throw new InvalidProviderResponseError(
        this.id,
        "Provider response did not contain the effective model",
      );
    if (
      typeof value.stop_reason !== "string" ||
      value.stop_reason.trim() === ""
    )
      throw new InvalidProviderResponseError(
        this.id,
        "Provider response did not contain stop_reason",
      );
    if (typeof value.usage !== "object" || value.usage === null)
      throw new InvalidProviderResponseError(
        this.id,
        "Provider response did not contain usage",
      );
    const inputTokens = count(
      value.usage.input_tokens,
      this.id,
      "usage.input_tokens",
    );
    const cachedInputTokens = count(
      value.usage.cache_read_input_tokens,
      this.id,
      "usage.cache_read_input_tokens",
      true,
    );
    const cacheCreationInputTokens = count(
      value.usage.cache_creation_input_tokens,
      this.id,
      "usage.cache_creation_input_tokens",
      true,
    );
    if (cacheCreationInputTokens > 0)
      throw new InvalidProviderResponseError(
        this.id,
        "Anthropic cache creation usage is not representable by the configured pricing contract",
      );
    const inclusiveInputTokens = inputTokens + cachedInputTokens;
    if (!Number.isSafeInteger(inclusiveInputTokens))
      throw new InvalidProviderResponseError(
        this.id,
        "usage input token total must be a non-negative safe integer",
      );
    const text = responseText(value);
    const completed = value.stop_reason === "end_turn";
    if (completed && text === null)
      throw new InvalidProviderResponseError(
        this.id,
        "Provider response did not contain text output",
      );
    return {
      providerId: this.id,
      model: value.model,
      // Non-normal stop reasons may have no text (for example tool_use). The
      // gateway rejects them from worker execution using this status, after it
      // has recorded the provider-reported usage.
      text: text ?? "",
      providerMetadata: {
        status: completed ? "completed" : "incomplete",
        stopReason: value.stop_reason,
      },
      usage: {
        inputTokens: inclusiveInputTokens,
        cachedInputTokens,
        outputTokens: count(
          value.usage.output_tokens,
          this.id,
          "usage.output_tokens",
        ),
        reasoningTokens: 0,
      },
      providerRequestId: value.id,
    };
  }
}
