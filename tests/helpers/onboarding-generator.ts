import type {
  OnboardingGenerationPrompt,
  OnboardingGenerationResponse,
  OnboardingQuestionGenerator,
} from "@ai-office/application/ports/onboarding-question-generator.port.ts";

export class ScriptedOnboardingGenerator implements OnboardingQuestionGenerator {
  readonly targetProvider = "mock";
  readonly targetModel = "mock-onboarding";
  readonly prompts: OnboardingGenerationPrompt[] = [];

  constructor(
    private readonly outputs: unknown[] = [{ status: "ready", questions: [] }],
  ) {}

  async generate(
    prompt: OnboardingGenerationPrompt,
  ): Promise<OnboardingGenerationResponse> {
    this.prompts.push(prompt);
    const output = this.outputs.shift() ?? { status: "ready", questions: [] };
    if (output instanceof Error) throw output;
    return {
      provider: this.targetProvider,
      model: this.targetModel,
      rawOutput: typeof output === "string" ? output : JSON.stringify(output),
    };
  }
}

export function textQuestion(input: {
  category?: "goal" | "preference" | "constraint";
  question: string;
  rationale?: string;
  priority?: number;
}) {
  return {
    category: input.category ?? "goal",
    question: input.question,
    rationale: input.rationale ?? "Needed to guide project work.",
    answerType: "text" as const,
    priority: input.priority ?? 80,
  };
}
