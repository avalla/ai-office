import type { LlmProvider, ModelRequest, ModelResponse } from "./provider.ts";

export class MockLlmProvider implements LlmProvider {
  readonly id = "mock";
  readonly requests: ModelRequest[] = [];
  constructor(
    private readonly response: Omit<ModelResponse, "providerId" | "model"> &
      Partial<Pick<ModelResponse, "providerId" | "model">> = {
      text: "Mock response",
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
    },
  ) {}
  pricingCandidates(request: ModelRequest) {
    return [{ providerId: this.id, model: request.model }];
  }
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return {
      ...this.response,
      providerId: this.response.providerId ?? this.id,
      model: this.response.model ?? request.model,
    };
  }
}
