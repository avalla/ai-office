import {
  agentOperations,
  type AgentOperation,
  type ProjectAnswer,
  type ProjectQuestion,
} from "@ai-office/domain/project/project-profile.ts";
import {
  InvalidProjectAnswerError,
  ProjectQuestionAlreadyAnsweredError,
  ProjectQuestionNotFoundError,
} from "../errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";

function isAgentOperation(value: string): value is AgentOperation {
  return agentOperations.some((operation) => operation === value);
}

export function parsePermissionAnswer(
  value: string,
  allowed: readonly AgentOperation[] = agentOperations,
): AgentOperation[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return [...allowed];
  if (normalized === "none") return [];

  const operations = [
    ...new Set(
      normalized
        .split(",")
        .map((operation) => operation.trim())
        .filter((operation) => operation.length > 0),
    ),
  ];
  const unsupported = operations.filter(
    (operation) =>
      !isAgentOperation(operation) ||
      !allowed.some((candidate) => candidate === operation),
  );

  if (operations.length === 0 || unsupported.length > 0) {
    throw new InvalidProjectAnswerError(
      `Agent permissions must be "all", "none", or a comma-separated list of: ${agentOperations.join(", ")}`,
    );
  }

  return agentOperations.filter((operation) => operations.includes(operation));
}

function selectValues(question: ProjectQuestion, value: string): string[] {
  const options = question.options ?? [];
  const byNormalized = new Map(
    options.map((option) => [option.trim().toLowerCase(), option]),
  );
  const values = [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0),
    ),
  ];
  if (values.length === 0 || values.some((entry) => !byNormalized.has(entry))) {
    throw new InvalidProjectAnswerError(
      `Answer must use ${question.answerType === "single_select" ? "one option" : "a comma-separated list"} from: ${options.join(", ")}`,
    );
  }
  if (question.answerType === "single_select" && values.length !== 1) {
    throw new InvalidProjectAnswerError(
      "Single-select questions accept exactly one option",
    );
  }
  return values.map((entry) => byNormalized.get(entry)!);
}

function structuredAnswer(
  question: ProjectQuestion,
  value: string,
): ProjectAnswer {
  if (question.answerCategory === "permission") {
    const allowed = (question.options ?? agentOperations).filter(
      isAgentOperation,
    );
    return {
      category: "permission",
      value: { operations: parsePermissionAnswer(value, allowed) },
    };
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new InvalidProjectAnswerError("Project answers cannot be empty");
  }

  if (question.answerType === "boolean") {
    if (["true", "yes", "y"].includes(normalized.toLowerCase())) {
      return { category: question.answerCategory, value: true };
    }
    if (["false", "no", "n"].includes(normalized.toLowerCase())) {
      return { category: question.answerCategory, value: false };
    }
    throw new InvalidProjectAnswerError(
      "Boolean answers must be true/false or yes/no",
    );
  }
  if (
    question.answerType === "single_select" ||
    question.answerType === "multi_select"
  ) {
    const selected = selectValues(question, normalized);
    return {
      category: question.answerCategory,
      value: question.answerType === "single_select" ? selected[0]! : selected,
    };
  }
  return { category: question.answerCategory, value: normalized };
}

export class AnswerProjectQuestion {
  constructor(
    private readonly profiles: ProjectProfileRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner,
  ) {}

  async execute(input: {
    projectId: string;
    questionId: string;
    value: string;
  }): Promise<ProjectAnswer> {
    return this.transactions.run(async () => {
      const question = await this.profiles.findQuestion(
        input.projectId,
        input.questionId,
      );
      if (question === null) {
        throw new ProjectQuestionNotFoundError(
          input.projectId,
          input.questionId,
        );
      }
      if (question.answer !== undefined) {
        throw new ProjectQuestionAlreadyAnsweredError(input.questionId);
      }

      const answer = structuredAnswer(question, input.value);
      const now = this.clock.now();

      await this.profiles.answerQuestion(question.id, answer, now);
      await this.profiles.saveProfileEntry({
        id: this.ids.generate(),
        projectId: input.projectId,
        category: answer.category,
        key: question.key,
        value: answer.value,
        origin: "user",
        confidence: 1,
        sourceReference: `project_question:${question.id}`,
        confirmedAt: now,
        createdAt: now,
      });

      return answer;
    });
  }
}
