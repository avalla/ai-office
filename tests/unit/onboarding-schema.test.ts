import { describe, expect, test } from "vitest";
import { generatedOnboardingBatchSchema } from "@ai-office/application/onboarding/generated-onboarding-schema.ts";

const validQuestion = {
  category: "goal",
  question: "What is the next concrete outcome?",
  rationale: "Agents need a concrete target.",
  answerType: "text",
  priority: 90,
};

function rejected(question: Record<string, unknown>): boolean {
  return !generatedOnboardingBatchSchema.safeParse({
    status: "needs_more_context",
    questions: [question],
  }).success;
}

describe("generated onboarding output schema", () => {
  test("accepts a strict structured batch", () => {
    expect(
      generatedOnboardingBatchSchema.parse({
        status: "needs_more_context",
        questions: [validQuestion],
      }),
    ).toEqual({ status: "needs_more_context", questions: [validQuestion] });
  });

  test("rejects invalid categories and answer types", () => {
    expect(rejected({ ...validQuestion, category: "security_grant" })).toBe(
      true,
    );
    expect(rejected({ ...validQuestion, answerType: "markdown" })).toBe(true);
  });

  test("requires unique options only for select questions", () => {
    expect(rejected({ ...validQuestion, answerType: "single_select" })).toBe(
      true,
    );
    expect(
      rejected({
        ...validQuestion,
        answerType: "multi_select",
        options: ["one", "One"],
      }),
    ).toBe(true);
    expect(rejected({ ...validQuestion, options: ["unexpected"] })).toBe(true);
  });

  test("fails closed for permission options outside the allowed vocabulary", () => {
    expect(
      rejected({
        ...validQuestion,
        category: "permission",
        answerType: "multi_select",
        options: ["run_tests", "grant_admin"],
      }),
    ).toBe(true);
  });

  test("enforces batch size, priorities, duplicate questions, and ready shape", () => {
    expect(
      generatedOnboardingBatchSchema.safeParse({
        status: "needs_more_context",
        questions: Array.from({ length: 6 }, (_, index) => ({
          ...validQuestion,
          question: `Question ${index}`,
        })),
      }).success,
    ).toBe(false);
    expect(rejected({ ...validQuestion, priority: 101 })).toBe(true);
    expect(
      generatedOnboardingBatchSchema.safeParse({
        status: "needs_more_context",
        questions: [
          validQuestion,
          { ...validQuestion, question: ` ${validQuestion.question} ` },
        ],
      }).success,
    ).toBe(false);
    expect(
      generatedOnboardingBatchSchema.safeParse({
        status: "ready",
        questions: [validQuestion],
      }).success,
    ).toBe(false);
    expect(
      generatedOnboardingBatchSchema.safeParse({
        status: "ready",
        questions: [],
      }).success,
    ).toBe(true);
  });

  test("rejects unknown output fields", () => {
    expect(
      generatedOnboardingBatchSchema.safeParse({
        status: "ready",
        questions: [],
        capabilityGrant: "all",
      }).success,
    ).toBe(false);
  });
});
