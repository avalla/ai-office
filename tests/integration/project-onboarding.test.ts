import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnswerProjectQuestion } from "@ai-office/application/commands/answer-project-question.ts";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { GetProjectProfile } from "@ai-office/application/queries/get-project-profile.ts";
import { renderProjectProfileMarkdown } from "@ai-office/application/queries/render-project-profile-markdown.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";
import { LocalProjectScanner } from "../../apps/cli/src/local-project-scanner.ts";

const temporaryDirectories: string[] = [];
const migrationDirectory = join(process.cwd(), "migrations", "project");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("legacy project-question compatibility", () => {
  test("answers stored questions and renders the categorized profile deterministically", async () => {
    const repositoryRoot = mkdtempSync(
      join(tmpdir(), "ai-office-onboarding-repository-"),
    );
    const databaseRoot = mkdtempSync(
      join(tmpdir(), "ai-office-onboarding-database-"),
    );
    const databasePath = join(databaseRoot, "project.sqlite");
    temporaryDirectories.push(repositoryRoot, databaseRoot);
    writeFileSync(join(repositoryRoot, "index.ts"), "export const value = 1;");

    let database = openDatabase(databasePath);
    migrate(database, migrationDirectory);
    let profiles = new SqliteProjectProfileRepository(database);
    let projects = new SqliteProjectRepository(database);
    const ids = new CryptoIdGenerator();
    const clock = new SystemClock();
    const imported = await new ImportProject(
      projects,
      profiles,
      new LocalProjectScanner(),
      new SqliteRepositoryIdentityRepository(database),
      ids,
      clock,
      new SqliteTransactionRunner(database),
    ).execute({ rootPath: repositoryRoot });
    expect(imported.questions).toEqual([]);
    const legacyGenerationId = ids.generate();
    database
      .prepare(
        `INSERT INTO onboarding_generation(
           id, project_id, provider, model, prompt_version, input_hash,
           round, status, batch_status, created_at
         ) VALUES (?, ?, 'legacy', 'legacy', 'project-onboarding-v1', ?, 1,
                   'completed', 'needs_more_context', ?)`,
      )
      .run(
        legacyGenerationId,
        imported.projectId,
        "0".repeat(64),
        clock.now().toISOString(),
      );
    await profiles.ensureQuestions(
      [
        {
          answerCategory: "goal" as const,
          question: "What outcome is next?",
          reason: "Legacy stored project knowledge.",
          answerType: "text" as const,
          priority: 100,
        },
        {
          answerCategory: "permission" as const,
          question: "Which operations may agents perform?",
          reason: "Legacy stored project knowledge.",
          answerType: "multi_select" as const,
          options: ["read_files", "modify_files", "run_tests"],
          priority: 90,
        },
        {
          answerCategory: "constraint" as const,
          question: "Which architecture must remain?",
          reason: "Legacy stored project knowledge.",
          answerType: "text" as const,
          priority: 80,
        },
        {
          answerCategory: "preference" as const,
          question: "Which testing strategy is expected?",
          reason: "Legacy stored project knowledge.",
          answerType: "text" as const,
          priority: 70,
        },
        {
          answerCategory: "preference" as const,
          question: "Where should decisions be documented?",
          reason: "Legacy stored project knowledge.",
          answerType: "text" as const,
          priority: 60,
        },
      ].map((question) => ({
        id: ids.generate(),
        projectId: imported.projectId,
        generationId: legacyGenerationId,
        key: `legacy_${question.answerCategory}_${question.priority}`,
        normalizedQuestion: `${question.answerCategory}:${question.question.toLowerCase()}`,
        source: "llm" as const,
        ...question,
      })),
    );
    const questions = await profiles.listOpenQuestions(imported.projectId);
    const questionByText = new Map(
      questions.map((question) => [question.question, question]),
    );
    const answer = new AnswerProjectQuestion(
      profiles,
      ids,
      clock,
      new SqliteTransactionRunner(database),
    );

    await answer.execute({
      projectId: imported.projectId,
      questionId: questionByText.get("What outcome is next?")!.id,
      value: "Consegnare M1.5",
    });
    await answer.execute({
      projectId: imported.projectId,
      questionId: questionByText.get("Which operations may agents perform?")!
        .id,
      value: "run_tests, read_files, modify_files",
    });
    await answer.execute({
      projectId: imported.projectId,
      questionId: questionByText.get("Which architecture must remain?")!.id,
      value: "Mantenere TypeScript strict e SQL esplicito",
    });
    await answer.execute({
      projectId: imported.projectId,
      questionId: questionByText.get("Which testing strategy is expected?")!.id,
      value: "Vitest per unità e integrazione",
    });

    database.close();
    database = openDatabase(databasePath);
    migrate(database, migrationDirectory);
    profiles = new SqliteProjectProfileRepository(database);
    projects = new SqliteProjectRepository(database);

    const profile = await new GetProjectProfile(projects, profiles).execute(
      imported.projectId,
    );
    expect(profile.goals.map((entry) => entry.value)).toEqual([
      "Consegnare M1.5",
    ]);
    expect(profile.constraints.map((entry) => entry.value)).toEqual([
      "Mantenere TypeScript strict e SQL esplicito",
    ]);
    expect(profile.permissions.map((entry) => entry.value)).toEqual([
      { operations: ["read_files", "modify_files", "run_tests"] },
    ]);
    expect(profile.confirmedPreferences.map((entry) => entry.value)).toEqual([
      "Vitest per unità e integrazione",
    ]);
    expect(profile.detectedFacts.length).toBeGreaterThan(0);
    expect(profile.inferences).toEqual([]);
    expect(profile.openQuestions.map((question) => question.key)).toEqual([
      questionByText.get("Where should decisions be documented?")!.key,
    ]);

    const storedPermission = database
      .query<{ answer_json: string }, [string]>(
        "SELECT answer_json FROM project_question WHERE id = ?",
      )
      .get(questionByText.get("Which operations may agents perform?")!.id);
    expect(JSON.parse(storedPermission!.answer_json)).toEqual({
      category: "permission",
      value: { operations: ["read_files", "modify_files", "run_tests"] },
    });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM capability_grants",
        )
        .get()?.count,
    ).toBe(0);

    const firstMarkdown = renderProjectProfileMarkdown(profile);
    const secondMarkdown = renderProjectProfileMarkdown(
      await new GetProjectProfile(projects, profiles).execute(
        imported.projectId,
      ),
    );
    expect(secondMarkdown).toBe(firstMarkdown);
    expect(firstMarkdown).toContain("## Detected facts");
    expect(firstMarkdown).toContain("## Inferences");
    expect(firstMarkdown).toContain("## Confirmed preferences");
    expect(firstMarkdown).toContain("## Constraints");
    expect(firstMarkdown).toContain("## Goals");
    expect(firstMarkdown).toContain("## Agent permissions");
    expect(firstMarkdown).toContain("## Historical onboarding questions");
    expect(firstMarkdown).toContain("## Open questions");
    expect(profile.generatedOnboardingQuestions).toHaveLength(5);
    expect(
      profile.generatedOnboardingQuestions.every(
        (question) => question.source === "llm",
      ),
    ).toBe(true);
    database.close();
  });
});
