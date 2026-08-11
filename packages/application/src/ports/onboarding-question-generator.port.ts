export interface OnboardingGenerationPrompt {
  projectId: string;
  system: string;
  user: string;
}

export interface OnboardingGenerationResponse {
  provider: string;
  model: string;
  rawOutput: string;
}

export interface OnboardingQuestionGenerator {
  readonly targetProvider: string;
  readonly targetModel: string;
  generate(
    prompt: OnboardingGenerationPrompt,
    signal?: AbortSignal,
  ): Promise<OnboardingGenerationResponse>;
}

export class UnavailableOnboardingQuestionGenerator implements OnboardingQuestionGenerator {
  readonly targetProvider = "unavailable";
  readonly targetModel = "unavailable";

  async generate(): Promise<OnboardingGenerationResponse> {
    throw new OnboardingProviderUnavailableError();
  }
}
import { OnboardingProviderUnavailableError } from "../errors.ts";
