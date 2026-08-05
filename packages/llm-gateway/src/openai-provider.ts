import {
  LlmProviderError,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
} from "./provider.ts";

interface OpenAiResponse {
  id?: unknown;
  output_text?: unknown;
  output?: unknown;
  usage?: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown };
    output_tokens_details?: { reasoning_tokens?: unknown };
  };
}
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;

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
  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    let response: Response;
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
      throw new LlmProviderError(
        this.id,
        error instanceof Error ? error.message : "OpenAI request failed",
        true,
      );
    }
    if (!response.ok)
      throw new LlmProviderError(
        this.id,
        `OpenAI returned HTTP ${response.status}`,
        response.status === 429 || response.status >= 500,
      );
    const value = (await response.json()) as OpenAiResponse;
    const text = responseText(value);
    if (text === null)
      throw new LlmProviderError(
        this.id,
        "OpenAI response did not contain text output",
        false,
      );
    return {
      text,
      usage: {
        inputTokens: count(value.usage?.input_tokens),
        cachedInputTokens: count(
          value.usage?.input_tokens_details?.cached_tokens,
        ),
        outputTokens: count(value.usage?.output_tokens),
        reasoningTokens: count(
          value.usage?.output_tokens_details?.reasoning_tokens,
        ),
      },
      ...(typeof value.id === "string" ? { providerRequestId: value.id } : {}),
    };
  }
}
