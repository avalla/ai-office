import {
  InvalidProviderResponseError,
  LlmProviderError,
  ProviderCancelledError,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
} from "./provider.ts";

interface OpenAiResponse {
  id?: unknown;
  model?: unknown;
  output_text?: unknown;
  output?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
  };
}
const count = (
  value: unknown,
  providerId: string,
  field: string,
  optional = false,
): number => {
  if (optional && value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InvalidProviderResponseError(
      providerId,
      `${field} must be a non-negative safe integer`,
    );
  return value;
};

function responseText(value: OpenAiResponse): string | null {
  if (typeof value.output_text === "string") return value.output_text;
  if (!Array.isArray(value.output)) return null;
  const chunks: string[] = [];
  for (const item of value.output) {
    if (typeof item !== "object" || item === null) continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const text = (part as Record<string, unknown>).text;
      if (typeof text === "string") chunks.push(text);
    }
  }
  return chunks.length === 0 ? null : chunks.join("");
}

export class OpenAiResponsesProvider implements LlmProvider {
  readonly id = "openai";
  constructor(
    private readonly apiKey: string,
    private readonly endpoint = "https://api.openai.com/v1/responses",
    private readonly fetcher: (
      input: string | URL | Request,
      init?: RequestInit,
    ) => Promise<Response> = fetch,
  ) {
    if (apiKey.trim() === "")
      throw new LlmProviderError(this.id, "OpenAI API key is required", false);
  }
  pricingCandidates(request: ModelRequest) {
    return [{ providerId: this.id, model: request.model }];
  }
  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const isAborted = () => signal?.aborted ?? false;
    let response: Response;
    if (isAborted()) throw new ProviderCancelledError(this.id);
    try {
      response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ model: request.model, input: request.messages }),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      if (
        isAborted() ||
        (error instanceof DOMException && error.name === "AbortError") ||
        (error instanceof Error && error.name === "AbortError")
      )
        throw new ProviderCancelledError(this.id);
      if (error instanceof Error && error.name === "TimeoutError")
        throw new LlmProviderError(
          this.id,
          "OpenAI request timed out",
          true,
          "TIMEOUT",
        );
      throw new LlmProviderError(
        this.id,
        error instanceof Error ? error.message : "OpenAI request failed",
        true,
        "NETWORK",
      );
    }
    if (!response.ok)
      throw new LlmProviderError(
        this.id,
        `OpenAI returned HTTP ${response.status}`,
        response.status === 408 ||
          response.status === 409 ||
          response.status === 429 ||
          response.status >= 500,
        "HTTP",
      );
    let value: OpenAiResponse;
    try {
      value = (await response.json()) as OpenAiResponse;
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
    if (typeof value.usage !== "object" || value.usage === null)
      throw new InvalidProviderResponseError(
        this.id,
        "Provider response did not contain usage",
      );
    const text = responseText(value);
    if (text === null)
      throw new InvalidProviderResponseError(
        this.id,
        "Provider response did not contain text output",
      );
    return {
      providerId: this.id,
      model: value.model,
      text,
      usage: {
        inputTokens: count(
          value.usage.input_tokens,
          this.id,
          "usage.input_tokens",
        ),
        cachedInputTokens: count(
          value.usage.input_tokens_details?.cached_tokens,
          this.id,
          "usage.input_tokens_details.cached_tokens",
          true,
        ),
        outputTokens: count(
          value.usage.output_tokens,
          this.id,
          "usage.output_tokens",
        ),
        reasoningTokens: count(
          value.usage.output_tokens_details?.reasoning_tokens,
          this.id,
          "usage.output_tokens_details.reasoning_tokens",
          true,
        ),
      },
      providerRequestId: value.id,
    };
  }
}
