import type { ModelUsage } from "@ai-office/domain/cost/cost.ts";

export interface ModelRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export interface ModelResponse {
  providerId: string;
  model: string;
  text: string;
  usage: ModelUsage;
  providerRequestId?: string;
  latencyMs?: number;
  providerMetadata?: Record<string, unknown>;
}

export interface LlmProvider {
  readonly id: string;
  pricingCandidates(
    request: ModelRequest,
  ): ReadonlyArray<{ providerId: string; model: string }>;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

export class LlmProviderError extends Error {
  constructor(
    readonly providerId: string,
    message: string,
    readonly retryable: boolean,
    readonly code:
      | "CANCELLED"
      | "TIMEOUT"
      | "HTTP"
      | "NETWORK"
      | "INVALID_RESPONSE"
      | "PROVIDER_ERROR" = "PROVIDER_ERROR",
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

export class InvalidProviderResponseError extends LlmProviderError {
  constructor(providerId: string, message: string) {
    super(providerId, message, false, "INVALID_RESPONSE");
    this.name = "InvalidProviderResponseError";
  }
}
export class ProviderCancelledError extends LlmProviderError {
  constructor(providerId: string) {
    super(providerId, "Provider request was cancelled", false, "CANCELLED");
    this.name = "ProviderCancelledError";
  }
}

export function validateModelResponse(
  response: ModelResponse,
  fallbackProviderId: string,
): void {
  const providerId =
    typeof response.providerId === "string" && response.providerId.trim() !== ""
      ? response.providerId
      : fallbackProviderId;
  if (
    typeof response.providerId !== "string" ||
    response.providerId.trim() === ""
  )
    throw new InvalidProviderResponseError(
      providerId,
      "providerId is required",
    );
  if (typeof response.model !== "string" || response.model.trim() === "")
    throw new InvalidProviderResponseError(providerId, "model is required");
  if (typeof response.text !== "string")
    throw new InvalidProviderResponseError(providerId, "text must be a string");
  if (
    response.providerRequestId !== undefined &&
    (typeof response.providerRequestId !== "string" ||
      response.providerRequestId.trim() === "")
  )
    throw new InvalidProviderResponseError(
      providerId,
      "providerRequestId must be a non-empty string",
    );
  if (
    response.latencyMs !== undefined &&
    (!Number.isFinite(response.latencyMs) || response.latencyMs < 0)
  )
    throw new InvalidProviderResponseError(
      providerId,
      "latencyMs must be a non-negative finite number",
    );
  if (
    response.providerMetadata !== undefined &&
    (typeof response.providerMetadata !== "object" ||
      response.providerMetadata === null ||
      Array.isArray(response.providerMetadata))
  )
    throw new InvalidProviderResponseError(
      providerId,
      "providerMetadata must be an object",
    );
  if (typeof response.usage !== "object" || response.usage === null)
    throw new InvalidProviderResponseError(providerId, "usage is required");
  const requiredUsageFields = [
    "inputTokens",
    "cachedInputTokens",
    "outputTokens",
    "reasoningTokens",
  ] as const;
  for (const field of requiredUsageFields) {
    const value = response.usage[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      throw new InvalidProviderResponseError(
        providerId,
        `usage.${field} must be a non-negative safe integer`,
      );
  }
}
