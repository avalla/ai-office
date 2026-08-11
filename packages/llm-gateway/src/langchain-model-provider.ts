import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessageLike,
  type UsageMetadata,
} from "@langchain/core/messages";
import {
  InvalidProviderResponseError,
  LlmProviderError,
  ProviderCancelledError,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
} from "./provider.ts";

export interface LangChainChatModel {
  invoke(
    input: BaseMessageLike[],
    options?: { signal?: AbortSignal },
  ): Promise<AIMessage>;
}

function count(
  value: unknown,
  providerId: string,
  field: string,
  optional = false,
): number {
  if (optional && value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
    throw new InvalidProviderResponseError(
      providerId,
      `${field} must be a non-negative safe integer`,
    );
  return value;
}

function statusFrom(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as Record<string, unknown>;
  if (typeof value.status === "number") return value.status;
  if (typeof value.statusCode === "number") return value.statusCode;
  return undefined;
}

function codeFrom(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = error as Record<string, unknown>;
  if (typeof value.code === "string") return value.code;
  return codeFrom(value.cause);
}

function nameFrom(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const name = (error as Record<string, unknown>).name;
  return typeof name === "string" ? name : undefined;
}

function isAbort(error: unknown): boolean {
  return ["AbortError", "APIUserAbortError"].includes(nameFrom(error) ?? "");
}

function isTimeout(error: unknown): boolean {
  if (
    ["TimeoutError", "APITimeoutError", "APIConnectionTimeoutError"].includes(
      nameFrom(error) ?? "",
    )
  )
    return true;
  return ["ETIMEDOUT", "ESOCKETTIMEDOUT"].includes(codeFrom(error) ?? "");
}

function isNetwork(error: unknown): boolean {
  if (["APIConnectionError", "FetchError"].includes(nameFrom(error) ?? ""))
    return true;
  return ["ECONNRESET", "ECONNREFUSED", "ENETUNREACH", "EAI_AGAIN"].includes(
    codeFrom(error) ?? "",
  );
}

function messages(request: ModelRequest): BaseMessageLike[] {
  return request.messages.map((message) => {
    switch (message.role) {
      case "system":
        return new SystemMessage(message.content);
      case "user":
        return new HumanMessage(message.content);
      case "assistant":
        return new AIMessage(message.content);
    }
  });
}

function metadataString(
  metadata: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

export class LangChainModelProvider implements LlmProvider {
  constructor(
    readonly id: string,
    readonly configuredModel: string,
    private readonly model: LangChainChatModel,
    private readonly now: () => number = () => performance.now(),
  ) {}

  pricingCandidates(request: ModelRequest) {
    return [{ providerId: this.id, model: request.model }];
  }

  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    if (signal?.aborted === true) throw new ProviderCancelledError(this.id);
    const startedAt = this.now();
    let response: AIMessage;
    try {
      response = await this.model.invoke(
        messages(request),
        signal === undefined ? undefined : { signal },
      );
    } catch (error) {
      if (signal?.aborted || isAbort(error))
        throw new ProviderCancelledError(this.id);
      if (isTimeout(error))
        throw new LlmProviderError(
          this.id,
          `${this.id} request timed out`,
          true,
          "TIMEOUT",
        );
      const status = statusFrom(error);
      if (status !== undefined)
        throw new LlmProviderError(
          this.id,
          `${this.id} returned HTTP ${status}`,
          status === 408 || status === 409 || status === 429 || status >= 500,
          "HTTP",
        );
      throw new LlmProviderError(
        this.id,
        `${this.id} request failed`,
        isNetwork(error),
        isNetwork(error) ? "NETWORK" : "PROVIDER_ERROR",
      );
    }

    // LangChain's default MessageStructure currently narrows this field to
    // `undefined` even though provider integrations populate UsageMetadata.
    const usage = response.usage_metadata as UsageMetadata | undefined;
    if (usage === undefined)
      throw new InvalidProviderResponseError(
        this.id,
        "Provider response did not contain usage metadata",
      );
    const providerMetadata = { ...response.response_metadata };
    const effectiveModel =
      metadataString(providerMetadata, "model_name", "model") ??
      this.configuredModel;
    const providerRequestId =
      metadataString(providerMetadata, "id", "request_id", "requestId") ??
      (typeof response.id === "string" && response.id.trim() !== ""
        ? response.id
        : undefined);

    return {
      providerId: this.id,
      model: effectiveModel,
      text: response.text,
      usage: {
        inputTokens: count(
          usage.input_tokens,
          this.id,
          "usage_metadata.input_tokens",
        ),
        cachedInputTokens: count(
          usage.input_token_details?.cache_read,
          this.id,
          "usage_metadata.input_token_details.cache_read",
          true,
        ),
        outputTokens: count(
          usage.output_tokens,
          this.id,
          "usage_metadata.output_tokens",
        ),
        reasoningTokens: count(
          usage.output_token_details?.reasoning,
          this.id,
          "usage_metadata.output_token_details.reasoning",
          true,
        ),
      },
      ...(providerRequestId === undefined ? {} : { providerRequestId }),
      latencyMs: Math.max(0, this.now() - startedAt),
      providerMetadata,
    };
  }
}
