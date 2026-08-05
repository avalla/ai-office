import {
  agentOperations,
  type AgentOperation,
  type ProjectAnswer
} from "@ai-office/domain/project/project-profile.ts";
import {
  InvalidProjectAnswerError,
  ProjectQuestionAlreadyAnsweredError,
  ProjectQuestionNotFoundError
} from "../errors.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";
import type { ProjectProfileRepository } from "../ports/project-profile-repository.port.ts";
import type { TransactionRunner } from "../ports/transaction-runner.port.ts";

function isAgentOperation(value: string): value is AgentOperation {
  return agentOperations.some((operation) => operation === value);
}

export function parsePermissionAnswer(value: string): AgentOperation[] {
  const normalized = value.trim().toLowerCase();
  if (normalized === "all") return [...agentOperations];
  if (normalized === "none") return [];

  const operations = [...new Set(
    normalized
      .split(",")
      .map((operation) => operation.trim())
      .filter((operation) => operation.length > 0)
  )];
  const unsupported = operations.filter((operation) => !isAgentOperation(operation));

  if (operations.length === 0 || unsupported.length > 0) {
    throw new InvalidProjectAnswerError(
      `Agent permissions must be "all", "none", or a comma-separated list of: ${agentOperations.join(", ")}`
    );
  }

  return agentOperations.filter((operation) => operations.includes(operation));
}

function structuredAnswer(category: ProjectAnswer["category"], value: string): ProjectAnswer {
  if (category === "permission") {
    return {
      category,
      value: { operations: parsePermissionAnswer(value) }
    };
  }

  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new InvalidProjectAnswerError("Project answers cannot be empty");
  }

  return { category, value: normalized };
}

export class AnswerProjectQuestion {
  constructor(
    private readonly profiles: ProjectProfileRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly transactions: TransactionRunner
  ) {}

  async execute(input: {
    projectId: string;
    questionId: string;
    value: string;
  }): Promise<ProjectAnswer> {
    return this.transactions.run(async () => {
      const question = await this.profiles.findQuestion(input.projectId, input.questionId);
      if (question === null) {
        throw new ProjectQuestionNotFoundError(input.projectId, input.questionId);
      }
      if (question.answer !== undefined) {
        throw new ProjectQuestionAlreadyAnsweredError(input.questionId);
      }

      const answer = structuredAnswer(question.answerCategory, input.value);
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
        createdAt: now
      });

      return answer;
    });
  }
}
