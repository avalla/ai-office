import {
  LlmProviderError,
  type LlmProvider,
  type ModelRequest,
  type ModelResponse,
} from "./provider.ts";

export class FallbackLlmProvider implements LlmProvider {
  readonly id: string;
  constructor(private readonly providers: readonly LlmProvider[]) {
    if (providers.length === 0)
      throw new Error("At least one LLM provider is required");
    this.id = providers.map((provider) => provider.id).join("->");
  }
  async complete(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    let last: unknown;
    for (const provider of this.providers) {
      try {
        return await provider.complete(request, signal);
      } catch (error) {
        last = error;
        if (!(error instanceof LlmProviderError) || !error.retryable)
          throw error;
      }
    }
    throw last;
  }
}
