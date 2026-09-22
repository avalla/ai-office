import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe } from "vitest";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import type { OfficeManifestContractFixture } from "../contracts/office-manifest-repository.contract.ts";
import { defineOfficeManifestRepositoryContracts } from "../contracts/office-manifest-repository.contract.ts";
import type { PipelineRunContractFixture } from "../contracts/pipeline-run-repository.contract.ts";
import { definePipelineRunRepositoryContracts } from "../contracts/pipeline-run-repository.contract.ts";

const migrationDirectory = join(process.cwd(), "migrations", "project");

async function createFixture(): Promise<
  OfficeManifestContractFixture & PipelineRunContractFixture
> {
  const root = mkdtempSync(
    join(tmpdir(), "ai-office-office-pipeline-contract-"),
  );
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, migrationDirectory);
  const projects = new SqliteProjectRepository(database);
  const tasks = new SqliteTaskRepository(database);
  const manifests = new SqliteOfficeManifestRepository(database);
  const pipelines = new SqlitePipelineRunRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  const transactions = new SqliteTransactionRunner(database);
  return {
    projects,
    tasks,
    manifests,
    pipelines,
    transactions,
    async prepareAgents(projectId: string): Promise<void> {
      const now = new Date("2026-09-22T00:00:00.000Z");
      for (const [key, id] of [
        ["developer", "agent-1"],
        ["reviewer", "agent-2"],
      ] as const) {
        const role = Role.create({
          id: `${projectId}-role-${key}`,
          projectId,
          key,
          name: key,
          version: 1,
          capabilities: [],
          tools: [],
          modelPolicy: "default",
          limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
          sourcePath: `${key}.yaml`,
          now,
        });
        await runtime.saveRole(role);
        await runtime.saveAgent({
          id: `${projectId}-${id}`,
          projectId,
          roleId: role.snapshot().id,
          name: key,
          enabled: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    },
    async close(): Promise<void> {
      database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("SQLite OfficeManifestRepository and PipelineRunRepository", () => {
  defineOfficeManifestRepositoryContracts(createFixture);
  definePipelineRunRepositoryContracts(createFixture);
});
