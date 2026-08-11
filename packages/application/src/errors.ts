export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectQuestionNotFoundError extends Error {
  constructor(projectId: string, questionId: string) {
    super(`Question ${questionId} was not found for project ${projectId}`);
    this.name = "ProjectQuestionNotFoundError";
  }
}

export class ProjectQuestionAlreadyAnsweredError extends Error {
  constructor(questionId: string) {
    super(`Question ${questionId} has already been answered`);
    this.name = "ProjectQuestionAlreadyAnsweredError";
  }
}

export class InvalidProjectAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidProjectAnswerError";
  }
}

export class OnboardingProviderUnavailableError extends Error {
  constructor() {
    super("LLM provider unavailable for onboarding");
    this.name = "OnboardingProviderUnavailableError";
  }
}

export class InvalidOnboardingGenerationError extends Error {
  constructor(message: string) {
    super(`Invalid LLM onboarding output: ${message}`);
    this.name = "InvalidOnboardingGenerationError";
  }
}

export class OnboardingRoundLimitError extends Error {
  constructor(limit: number) {
    super(
      `Project onboarding reached the maximum of ${limit} generated rounds`,
    );
    this.name = "OnboardingRoundLimitError";
  }
}
