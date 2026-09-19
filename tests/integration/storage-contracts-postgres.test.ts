import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { PostgresTaskRequirementRepository } from "@ai-office/storage-postgres/repositories/postgres-task-requirement.repository.ts";
import { defineProjectStorageContracts } from "../contracts/project-storage.contract.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const migrationDirectory = join(process.cwd(), "supabase", "migrations");

describe.skipIf(connectionString === undefined)(
  "PostgreSQL project storage contracts",
  () => {
    let database: PostgresClient;

    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(database, migrationDirectory);
      expect(await migratePostgres(database, migrationDirectory)).toEqual([]);
      expect(
        await database.query<{ exists: boolean }>(
          "SELECT to_regclass('core.project') IS NOT NULL AS exists",
        ),
      ).toEqual([{ exists: true }]);
    });

    afterAll(async () => {
      await database.close();
    });

    defineProjectStorageContracts(async () => ({
      projects: new PostgresProjectRepository(database),
      tasks: new PostgresTaskRepository(database),
      taskRequirements: new PostgresTaskRequirementRepository(database),
      transactions: new PostgresTransactionRunner(database),
      async seedRequirement(input: {
        id: string;
        projectId: string;
        key: string;
        title: string;
        status: RequirementStatus;
      }): Promise<void> {
        await database.query(
          `INSERT INTO core.requirement(
             id, project_id, requirement_key, title, status
           ) VALUES ($1, $2, $3, $4, $5)`,
          [input.id, input.projectId, input.key, input.title, input.status],
        );
      },
      async close(): Promise<void> {},
    }));

    test("keeps repository writes on one transaction-bound session", async () => {
      const subject = new PostgresClient(connectionString!);
      const observer = new PostgresClient(connectionString!);
      const projects = new PostgresProjectRepository(subject);
      const tasks = new PostgresTaskRepository(subject);
      const transactions = new PostgresTransactionRunner(subject);
      const projectId = `session-${randomUUID()}`;
      const taskId = `session-${randomUUID()}`;
      const now = new Date("2026-05-02T03:04:05.000Z");

      try {
        await transactions.run(async () => {
          await projects.save(
            Project.create({ id: projectId, name: "Session", now }),
          );
          await tasks.save(
            Task.create({ id: taskId, projectId, title: "Session task", now }),
          );
          expect(
            await new PostgresProjectRepository(observer).findById(projectId),
          ).toBeNull();
        });
        expect(
          await new PostgresProjectRepository(observer).findById(projectId),
        ).not.toBeNull();
        expect(
          await new PostgresTaskRepository(observer).findById(taskId),
        ).not.toBeNull();
      } finally {
        await subject.close();
        await observer.close();
      }
    });
  },
);
