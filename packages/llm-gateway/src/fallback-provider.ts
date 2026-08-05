import {
  LlmProviderError,
  ProviderCancelledError,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
} from "./provider.ts";

export class FallbackLlmProvider implements LlmProvider {
  readonly id = "fallback";
  constructor(private readonly providers: readonly LlmProvider[]) {
    if (providers.length === 0)
      throw new Error("At least one LLM provider is required");
  }
  pricingCandidates(request: ModelRequest) {
    return this.providers.flatMap((provider) =>
      provider.pricingCandidates(request),
    );
  }
  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const isAborted = () => signal?.aborted ?? false;
    let last: unknown;
    for (const provider of this.providers) {
      if (isAborted()) throw new ProviderCancelledError(provider.id);
      try {
        return await provider.complete(request, signal);
      } catch (error) {
        last = error;
        if (isAborted()) throw new ProviderCancelledError(provider.id);
        if (error instanceof LlmProviderError && error.code === "CANCELLED")
          throw error;
        if (!(error instanceof LlmProviderError) || !error.retryable)
          throw error;
      }
    }
    throw last;
  }
}
