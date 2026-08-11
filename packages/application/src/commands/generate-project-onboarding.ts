import { createHash } from "node:crypto";
import type {
  ProjectProfileEntry,
  ProjectQuestion,
} from "@ai-office/domain/project/project-profile.ts";
import {
  InvalidOnboardingGenerationError,
  OnboardingRoundLimitError,
} from "../errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { OnboardingQuestionGenerator } from "../ports/onboarding-question-generator.port.ts";
import type {
  NewProjectQuestion,
  OnboardingGeneration,
  ProjectProfileRepository,
} from "../ports/project-profile-repository.port.ts";
import type { ProjectRepository } from "../ports/project-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";
import { ProjectNotFoundError } from "../errors.ts";
import {
  generatedOnboardingBatchSchema,
  maxOnboardingGenerationRounds,
  normalizeQuestionText,
  onboardingPromptVersion,
  type GeneratedOnboardingBatch,
} from "../onboarding/generated-onboarding-schema.ts";
import { onboardingInputHash } from "../onboarding/onboarding-input-hash.ts";
import {
  buildOnboardingPrompt,
  type OnboardingPromptContext,
} from "../onboarding/onboarding-prompt.ts";

export type ProjectOnboardingGenerationResult =
  | {
      status: "awaiting_answers";
      round: number;
      generated: false;
      questions: ProjectQuestion[];
    }
  | {
      status: "needs_more_context";
      round: number;
      generated: boolean;
      questions: ProjectQuestion[];
    }
  | {
      status: "ready";
      round: number;
      generated: boolean;
      questions: [];
    };

function semanticQuestionKey(category: string, question: string): string {
  return `${category}:${normalizeQuestionText(question)}`;
}

function generatedQuestionKey(category: string, question: string): string {
  return `llm_${createHash("sha256")
    .update(semanticQuestionKey(category, question), "utf8")
    .digest("hex")}`;
}

function orderedEntries(entries: ProjectProfileEntry[]): ProjectProfileEntry[] {
  return [...entries].sort((left, right) =>
    `${left.origin}\0${left.category}\0${left.key}\0${left.id}`.localeCompare(
      `${right.origin}\0${right.category}\0${right.key}\0${right.id}`,
    ),
  );
}

function orderedQuestions(questions: ProjectQuestion[]): ProjectQuestion[] {
  return [...questions].sort((left, right) =>
    `${left.source}\0${left.answerCategory}\0${normalizeQuestionText(left.question)}\0${left.id}`.localeCompare(
      `${right.source}\0${right.answerCategory}\0${normalizeQuestionText(right.question)}\0${right.id}`,
    ),
  );
}

function promptContext(input: {
  project: { id: string; name: string };
  entries: ProjectProfileEntry[];
  questions: ProjectQuestion[];
  round: number;
}): OnboardingPromptContext {
  const entries = orderedEntries(input.entries);
  return {
    project: input.project,
    facts: entries
      .filter(
        (
          entry,
        ): entry is ProjectProfileEntry & {
          origin: "detected" | "inferred";
        } => entry.origin === "detected" || entry.origin === "inferred",
      )
      .map((entry) => ({
        category: entry.category,
        key: entry.key,
        value: entry.value,
        origin: entry.origin,
        confidence: entry.confidence,
      })),
    answers: entries
      .filter((entry) => entry.origin === "user")
      .map((entry) => ({
        category: entry.category,
        key: entry.key,
        value: entry.value,
      })),
    questions: orderedQuestions(input.questions).map((question) => ({
      category: question.answerCategory,
      question: question.question,
      answered: question.answer !== undefined,
      source: question.source,
    })),
    round: input.round,
  };
}

function parseBatch(rawOutput: string): GeneratedOnboardingBatch {
  let value: unknown;
  try {
    value = JSON.parse(rawOutput) as unknown;
  } catch {
    throw new InvalidOnboardingGenerationError("response is not valid JSON");
  }
  const parsed = generatedOnboardingBatchSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new InvalidOnboardingGenerationError(
      issue === undefined
        ? "response does not match the schema"
        : `${issue.path.join(".") || "response"}: ${issue.message}`,
    );
  }
  return parsed.data;
}

function restoredResult(
  generation: OnboardingGeneration,
  questions: ProjectQuestion[],
): ProjectOnboardingGenerationResult {
  if (generation.batchStatus === "ready") {
    return {
      status: "ready",
      round: generation.round,
      generated: false,
      questions: [],
    };
  }
  if (questions.length === 0) {
    return {
      status: "ready",
      round: generation.round,
      generated: false,
      questions: [],
    };
  }
  return {
    status: "needs_more_context",
    round: generation.round,
    generated: false,
    questions,
  };
}

export class GenerateProjectOnboarding {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly profiles: ProjectProfileRepository,
    private readonly generator: OnboardingQuestionGenerator,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(
    projectId: string,
    signal?: AbortSignal,
  ): Promise<ProjectOnboardingGenerationResult> {
    const project = await this.projects.findById(projectId);
    if (project === null) throw new ProjectNotFoundError(projectId);

    const [entries, questions, generations] = await Promise.all([
      this.profiles.listActiveProfileEntries(projectId),
      this.profiles.listQuestions(projectId),
      this.profiles.listOnboardingGenerations(projectId),
    ]);
    const openQuestions = questions.filter(
      (question) => question.answer === undefined,
    );
    const completed = generations.filter(
      (generation) => generation.status === "completed",
    );
    const currentRound = completed.length;

    if (openQuestions.length > 0) {
      return {
        status: "awaiting_answers",
        round: Math.max(currentRound, 1),
        generated: false,
        questions: openQuestions,
      };
    }

    const latestCompleted = completed.at(-1);
    if (latestCompleted?.batchStatus === "ready") {
      return restoredResult(latestCompleted, []);
    }
    if (completed.length >= maxOnboardingGenerationRounds) {
      throw new OnboardingRoundLimitError(maxOnboardingGenerationRounds);
    }

    const round = completed.length + 1;
    const snapshot = project.snapshot();
    const context = promptContext({
      project: { id: snapshot.id, name: snapshot.name },
      entries,
      questions,
      round,
    });
    const inputHash = onboardingInputHash(context);
    const existing = await this.profiles.findCompletedOnboardingGeneration(
      projectId,
      inputHash,
    );
    if (existing !== null) {
      return restoredResult(
        existing,
        questions.filter((question) => question.generationId === existing.id),
      );
    }

    const prompt = buildOnboardingPrompt(context);
    let response: Awaited<ReturnType<OnboardingQuestionGenerator["generate"]>>;
    let batch: GeneratedOnboardingBatch;
    try {
      response = await this.generator.generate(
        { projectId, system: prompt.system, user: prompt.user },
        signal,
      );
      batch = parseBatch(response.rawOutput);
      const existingKeys = new Set(
        questions.map((question) =>
          semanticQuestionKey(question.answerCategory, question.question),
        ),
      );
      const duplicate = batch.questions.find((question) =>
        existingKeys.has(
          semanticQuestionKey(question.category, question.question),
        ),
      );
      if (duplicate !== undefined) {
        throw new InvalidOnboardingGenerationError(
          "response repeats an existing or answered question",
        );
      }
    } catch (error) {
      const failure: OnboardingGeneration = {
        id: this.ids.generate(),
        projectId,
        provider: this.generator.targetProvider,
        model: this.generator.targetModel,
        promptVersion: onboardingPromptVersion,
        inputHash,
        round,
        status: "failed",
        failureCode: error instanceof Error ? error.name : "UnknownError",
        createdAt: this.clock.now(),
      };
      try {
        await this.transactions.run(() =>
          this.profiles.saveOnboardingGeneration(failure),
        );
      } catch {
        // Preserve the provider/validation error if failure auditing itself fails.
      }
      throw error;
    }

    const generationId = this.ids.generate();
    const generation: OnboardingGeneration = {
      id: generationId,
      projectId,
      provider: response.provider,
      model: response.model,
      promptVersion: onboardingPromptVersion,
      inputHash,
      round,
      status: "completed",
      batchStatus: batch.status,
      createdAt: this.clock.now(),
    };
    const newQuestions: NewProjectQuestion[] = batch.questions.map(
      (question) => ({
        id: this.ids.generate(),
        projectId,
        generationId,
        key: generatedQuestionKey(question.category, question.question),
        question: question.question,
        normalizedQuestion: semanticQuestionKey(
          question.category,
          question.question,
        ),
        reason: question.rationale,
        answerCategory: question.category,
        answerType: question.answerType,
        ...(question.options === undefined
          ? {}
          : { options: [...question.options] }),
        priority: question.priority,
        source: "llm",
      }),
    );

    await this.transactions.run(async () => {
      await this.profiles.saveOnboardingGeneration(generation);
      await this.profiles.ensureQuestions(newQuestions);
    });

    const persisted = await this.profiles.listOpenQuestions(projectId);
    const generatedQuestions = persisted.filter(
      (question) => question.generationId === generationId,
    );
    return batch.status === "ready"
      ? { status: "ready", round, generated: true, questions: [] }
      : {
          status: "needs_more_context",
          round,
          generated: true,
          questions: generatedQuestions,
        };
  }
}
