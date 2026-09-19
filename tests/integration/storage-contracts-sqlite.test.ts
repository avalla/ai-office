import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe } from "vitest";
import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteTaskRequirementRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-requirement.repository.ts";
import { defineProjectStorageContracts } from "../contracts/project-storage.contract.ts";

const migrationDirectory = join(process.cwd(), "migrations", "project");

describe("SQLite project storage contracts", () => {
  defineProjectStorageContracts(async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-sqlite-contract-"));
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, migrationDirectory);

    return {
      projects: new SqliteProjectRepository(database),
      tasks: new SqliteTaskRepository(database),
      taskRequirements: new SqliteTaskRequirementRepository(database),
      transactions: new SqliteTransactionRunner(database),
      async seedRequirement(input: {
        id: string;
        projectId: string;
        key: string;
        title: string;
        status: RequirementStatus;
      }): Promise<void> {
        database
          .prepare(
            `INSERT INTO requirement(
              id, project_id, requirement_key, title, description, status,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.id,
            input.projectId,
            input.key,
            input.title,
            input.title,
            input.status,
            "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
          );
      },
      async close(): Promise<void> {
        database.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  });
});
