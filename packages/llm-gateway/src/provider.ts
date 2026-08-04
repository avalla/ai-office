import type { ModelUsage } from "@ai-office/domain/cost/cost.ts";

export interface ModelRequest {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
}

export interface ModelResponse {
  text: string;
  usage: ModelUsage;
  providerRequestId?: string;
}

export interface LlmProvider {
  readonly id: string;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
