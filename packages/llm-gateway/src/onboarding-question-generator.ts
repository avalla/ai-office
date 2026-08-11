import type {
  OnboardingGenerationPrompt,
  OnboardingGenerationResponse,
  OnboardingQuestionGenerator,
} from "@ai-office/application/ports/onboarding-question-generator.port.ts";
import type { MeteredLlmGateway } from "./metered-gateway.ts";

export class GatewayOnboardingQuestionGenerator implements OnboardingQuestionGenerator {
  constructor(
    private readonly gateway: MeteredLlmGateway,
    readonly targetProvider: string,
    readonly targetModel: string,
  ) {}

  async generate(
    prompt: OnboardingGenerationPrompt,
    signal?: AbortSignal,
  ): Promise<OnboardingGenerationResponse> {
    const response = await this.gateway.complete(
      {
        model: this.targetModel,
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
      },
      {
        projectId: prompt.projectId,
        purpose: "project_onboarding",
        estimatedUsage: {
          inputTokens: 4_000,
          cachedInputTokens: 0,
          outputTokens: 1_200,
          reasoningTokens: 0,
        },
        useProjectBudgetIfConfigured: true,
      },
      signal,
    );
    return {
      provider: response.providerId,
      model: response.model,
      rawOutput: response.text,
    };
  }
}
