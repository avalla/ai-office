import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import {
  ProjectStorageBootstrap,
  requireCompleteProjectStorage,
  StorageProviderIncompleteError,
} from "@ai-office/storage-bootstrap/project-storage-bootstrap.ts";
import { PostgresGovernanceRepository } from "@ai-office/storage-postgres/repositories/postgres-governance.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { PostgresTaskRequirementRepository } from "@ai-office/storage-postgres/repositories/postgres-task-requirement.repository.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const migrationDirectory = join(process.cwd(), "supabase", "migrations");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe.skipIf(connectionString === undefined)(
  "PostgreSQL storage provider bootstrap",
  () => {
    test("constructs the partial capability set and rejects full Runtime authority", async () => {
      const root = mkdtempSync(join(tmpdir(), "ai-office-postgres-bootstrap-"));
      roots.push(root);
      const bootstrap = new ProjectStorageBootstrap({
        sqliteDatabasePath: join(root, "unused.sqlite"),
        environment: {},
      });

      const configuration = {
        provider: "postgres" as const,
        connectionString: connectionString!,
        tenantId: "bootstrap-tenant",
      };
      await expect(
        bootstrap.open({
          configuration,
          postgresMigrationDirectory: migrationDirectory,
          requireComplete: true,
        }),
      ).rejects.toThrow(StorageProviderIncompleteError);

      const handle = await bootstrap.open({
        configuration,
        postgresMigrationDirectory: migrationDirectory,
      });
      try {
        expect(handle.provider).toBe("postgres");
        expect(handle.repositories.projects).toBeInstanceOf(
          PostgresProjectRepository,
        );
        expect(handle.repositories.tasks).toBeInstanceOf(
          PostgresTaskRepository,
        );
        expect(handle.repositories.taskRequirements).toBeInstanceOf(
          PostgresTaskRequirementRepository,
        );
        expect(handle.repositories.governance).toBeInstanceOf(
          PostgresGovernanceRepository,
        );
        expect(handle.repositories.transactions).toBeInstanceOf(
          PostgresTransactionRunner,
        );
        expect(
          Object.entries(handle.capabilities)
            .filter(([, implemented]) => implemented)
            .map(([capability]) => capability),
        ).toEqual([
          "projects",
          "tasks",
          "taskRequirements",
          "governance",
          "transactions",
        ]);
        expect(() => requireCompleteProjectStorage(handle)).toThrow(
          StorageProviderIncompleteError,
        );
        expect(() => requireCompleteProjectStorage(handle)).toThrow(
          "profiles, officeManifests, pipelines, runtime, costs, capabilities, controlled, auditEvents, repositoryIdentities, projectStates, memoryReferences, projectMemoryProvenance, operationalReads, jobOutbox",
        );
      } finally {
        await handle.close();
        await handle.close();
      }
    });
  },
);
