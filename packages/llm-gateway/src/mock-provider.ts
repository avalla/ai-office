import type { LlmProvider, ModelRequest, ModelResponse } from "./provider.ts";

export class MockLlmProvider implements LlmProvider {
  readonly id = "mock";
  readonly requests: ModelRequest[] = [];
  constructor(
    private readonly response: ModelResponse = {
      text: "Mock response",
      usage: {
        inputTokens: 1,
        cachedInputTokens: 0,
        outputTokens: 1,
        reasoningTokens: 0,
      },
    },
  ) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    return this.response;
  }
}
