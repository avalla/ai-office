import * as z from "zod";
import {
  agentOperations,
  type OnboardingAnswerType,
  type ProjectAnswerCategory,
} from "@ai-office/domain/project/project-profile.ts";

export const onboardingPromptVersion = "project-onboarding-v1";
export const maxOnboardingQuestionsPerRound = 5;
export const maxOnboardingGenerationRounds = 3;

const categories = [
  "goal",
  "preference",
  "constraint",
  "permission",
] as const satisfies readonly ProjectAnswerCategory[];

const answerTypes = [
  "text",
  "boolean",
  "single_select",
  "multi_select",
] as const satisfies readonly OnboardingAnswerType[];

export function normalizeQuestionText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

const generatedQuestionSchema = z
  .strictObject({
    category: z.enum(categories),
    question: z.string().trim().min(1).max(500),
    rationale: z.string().trim().min(1).max(240),
    answerType: z.enum(answerTypes),
    options: z.array(z.string().trim().min(1).max(120)).max(16).optional(),
    priority: z.number().int().min(1).max(100),
  })
  .superRefine((question, context) => {
    const isSelect =
      question.answerType === "single_select" ||
      question.answerType === "multi_select";
    if (
      isSelect &&
      (question.options === undefined || question.options.length === 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Select questions require at least one option",
      });
    }
    if (!isSelect && question.options !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Non-select questions cannot define options",
      });
    }
    const normalizedOptions = (question.options ?? []).map((option) =>
      option.toLowerCase(),
    );
    if (new Set(normalizedOptions).size !== normalizedOptions.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Question options must be unique",
      });
    }
    if (question.category === "permission") {
      if (question.answerType !== "multi_select") {
        context.addIssue({
          code: "custom",
          path: ["answerType"],
          message: "Permission questions must use multi_select",
        });
      }
      const unsupported = (question.options ?? []).filter(
        (option) => !agentOperations.some((operation) => operation === option),
      );
      if (unsupported.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["options"],
          message:
            "Permission options must use the allowed operation vocabulary",
        });
      }
    }
  });

export const generatedOnboardingBatchSchema = z
  .strictObject({
    status: z.enum(["needs_more_context", "ready"]),
    questions: z
      .array(generatedQuestionSchema)
      .max(maxOnboardingQuestionsPerRound),
  })
  .superRefine((batch, context) => {
    if (batch.status === "ready" && batch.questions.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "A ready batch cannot contain questions",
      });
    }
    if (batch.status === "needs_more_context" && batch.questions.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "A needs_more_context batch must contain questions",
      });
    }
    const normalizedQuestions = batch.questions.map(
      (question) =>
        `${question.category}\0${normalizeQuestionText(question.question)}`,
    );
    if (new Set(normalizedQuestions).size !== normalizedQuestions.length) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Generated questions must be unique",
      });
    }
  });

export type GeneratedOnboardingBatch = z.infer<
  typeof generatedOnboardingBatchSchema
>;
