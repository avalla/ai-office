import type { ModelUsage } from "@ai-office/domain/cost/cost.ts";

/**
 * Provider-neutral execution parameters. A provider either applies every
 * parameter it receives exactly or rejects the request before contacting the
 * vendor; it never drops one silently.
 */
export interface ModelExecutionParameters {
  reasoningEffort?: string;
  maxOutputTokens?: number;
}

export interface ModelRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  parameters?: ModelExecutionParameters;
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
      | "UNSUPPORTED_PARAMETER"
      | "MODEL_MISMATCH"
      | "PROVIDER_ERROR" = "PROVIDER_ERROR",
  ) {
    super(message);
    this.name = "LlmProviderError";
  }
}

/**
 * The vendor answered, but the answer cannot be used. Provider work may already
 * have been billed, so the gateway keeps it accounted rather than free.
 */
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

/** Raised before any vendor request when a parameter cannot be applied exactly. */
export class UnsupportedModelParameterError extends LlmProviderError {
  constructor(
    providerId: string,
    readonly parameter: keyof ModelExecutionParameters,
  ) {
    super(
      providerId,
      `Provider ${providerId} cannot apply execution parameter ${parameter}`,
      false,
      "UNSUPPORTED_PARAMETER",
    );
    this.name = "UnsupportedModelParameterError";
  }
}

/**
 * The required model could not be used. `response` is set when the vendor had
 * already answered with another model: that request may have been billed.
 */
export class ModelMismatchError extends LlmProviderError {
  constructor(
    providerId: string,
    readonly response?: ModelResponse,
  ) {
    super(
      providerId,
      `Provider ${providerId} reported a model other than the requested model`,
      false,
      "MODEL_MISMATCH",
    );
    this.name = "ModelMismatchError";
  }
}

/**
 * Enforces an exact effective model. Substitution (aliases resolving to
 * snapshots, silent fallbacks) is not part of any approved provider contract,
 * so a different reported provider or model fails closed.
 */
export class ExactModelProvider implements LlmProvider {
  constructor(
    private readonly provider: LlmProvider,
    private readonly required: { providerId: string; model: string },
  ) {}
  get id(): string {
    return this.provider.id;
  }
  pricingCandidates(request: ModelRequest) {
    return this.provider.pricingCandidates(request);
  }
  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    if (
      request.model !== this.required.model ||
      this.provider.id !== this.required.providerId
    )
      throw new ModelMismatchError(this.provider.id);
    const response = await this.provider.complete(request, signal);
    if (
      response.providerId !== this.required.providerId ||
      response.model !== this.required.model
    )
      throw new ModelMismatchError(this.provider.id, response);
    return response;
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
  // Details are subsets of their totals (see ModelUsage).
  if (response.usage.cachedInputTokens > response.usage.inputTokens)
    throw new InvalidProviderResponseError(
      providerId,
      "usage.cachedInputTokens must not exceed usage.inputTokens",
    );
  if (response.usage.reasoningTokens > response.usage.outputTokens)
    throw new InvalidProviderResponseError(
      providerId,
      "usage.reasoningTokens must not exceed usage.outputTokens",
    );
}

/**
 * Whether `error` means the vendor had already answered. Returns the rejected
 * response when one is available (`null` response: answered, usage unknown),
 * or `undefined` when no answer was received and nothing is known to be billed.
 */
export function rejectedProviderResponse(
  error: unknown,
): { response: ModelResponse | null } | undefined {
  if (error instanceof ModelMismatchError)
    return error.response === undefined
      ? undefined
      : { response: error.response };
  if (error instanceof InvalidProviderResponseError) return { response: null };
  return undefined;
}
