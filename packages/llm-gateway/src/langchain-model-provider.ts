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
  const status = propertyFrom(error, "status");
  if (typeof status === "number") return status;
  const statusCode = propertyFrom(error, "statusCode");
  if (typeof statusCode === "number") return statusCode;
  return undefined;
}

function propertyFrom(error: unknown, key: string): unknown {
  if (
    (typeof error !== "object" && typeof error !== "function") ||
    error === null
  )
    return undefined;
  try {
    return Reflect.get(error, key);
  } catch {
    return undefined;
  }
}

function stringPropertyFrom(
  error: unknown,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = propertyFrom(error, key);
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function codeFrom(
  error: unknown,
  seen: ReadonlySet<unknown> = new Set(),
): string | undefined {
  if (seen.has(error)) return undefined;
  const code = stringPropertyFrom(error, "code");
  if (code !== undefined) return code;
  const cause = propertyFrom(error, "cause");
  return codeFrom(cause, new Set([...seen, error]));
}

function nameFrom(error: unknown): string | undefined {
  return stringPropertyFrom(error, "name");
}

interface ProviderErrorDiagnostics {
  readonly name?: string;
  readonly message?: string;
  readonly status?: number;
  readonly code?: string;
  readonly type?: string;
  readonly requestId?: string;
}

function providerErrorDiagnostics(error: unknown): ProviderErrorDiagnostics {
  const name = nameFrom(error);
  const message = stringPropertyFrom(error, "message");
  const status = statusFrom(error);
  const code = stringPropertyFrom(error, "code");
  const type = stringPropertyFrom(error, "type");
  const requestId = stringPropertyFrom(
    error,
    "request_id",
    "requestId",
    "requestID",
  );
  return {
    ...(name === undefined ? {} : { name }),
    ...(message === undefined ? {} : { message }),
    ...(status === undefined ? {} : { status }),
    ...(code === undefined ? {} : { code }),
    ...(type === undefined ? {} : { type }),
    ...(requestId === undefined ? {} : { requestId }),
  };
}

function safeDiagnosticToken(value: string): string {
  return safeDiagnosticMessage(value)
    .replaceAll("\\", "\\\\")
    .replaceAll(/\s/g, "_");
}

function safeDiagnosticMessage(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]");
}

function logProviderError(providerId: string, error: unknown): void {
  const details = providerErrorDiagnostics(error);
  const fields = [`provider=${safeDiagnosticToken(providerId)}`];
  if (details.name !== undefined)
    fields.push(`name=${safeDiagnosticToken(details.name)}`);
  if (details.status !== undefined) fields.push(`status=${details.status}`);
  if (details.code !== undefined)
    fields.push(`code=${safeDiagnosticToken(details.code)}`);
  if (details.type !== undefined)
    fields.push(`type=${safeDiagnosticToken(details.type)}`);
  if (details.requestId !== undefined)
    fields.push(`request_id=${safeDiagnosticToken(details.requestId)}`);
  console.error(`[llm:error] ${fields.join(" ")}`);
  if (details.message !== undefined)
    console.error(
      `[llm:error] message=${JSON.stringify(safeDiagnosticMessage(details.message))}`,
    );

  const cause = propertyFrom(error, "cause");
  if (cause === undefined || cause === error) return;
  const causeDetails = providerErrorDiagnostics(cause);
  const causeFields: string[] = [];
  if (causeDetails.name !== undefined)
    causeFields.push(`name=${safeDiagnosticToken(causeDetails.name)}`);
  if (causeDetails.status !== undefined)
    causeFields.push(`status=${causeDetails.status}`);
  if (causeDetails.code !== undefined)
    causeFields.push(`code=${safeDiagnosticToken(causeDetails.code)}`);
  if (causeDetails.type !== undefined)
    causeFields.push(`type=${safeDiagnosticToken(causeDetails.type)}`);
  if (causeDetails.requestId !== undefined)
    causeFields.push(
      `request_id=${safeDiagnosticToken(causeDetails.requestId)}`,
    );
  if (causeFields.length > 0)
    console.error(`[llm:error] cause ${causeFields.join(" ")}`);
  if (causeDetails.message !== undefined)
    console.error(
      `[llm:error] cause_message=${JSON.stringify(safeDiagnosticMessage(causeDetails.message))}`,
    );
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
    private readonly debug = false,
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
      const normalizedMessages = messages(request);
      if (this.debug) {
        const characterCount = request.messages.reduce(
          (total, message) => total + message.content.length,
          0,
        );
        console.error(
          `[llm:request] provider=${this.id} configured_model=${this.configuredModel} requested_model=${request.model} message_count=${request.messages.length} message_character_count=${characterCount}`,
        );
      }
      response = await this.model.invoke(
        normalizedMessages,
        signal === undefined ? undefined : { signal },
      );
    } catch (error) {
      if (this.debug) logProviderError(this.id, error);
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
