import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { OfficePipeline } from "@ai-office/domain/office/office-manifest.ts";
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

  test("round-trips a pipeline run's pack-configuration pin (M16.5 first slice)", async () => {
    const fixture = await createFixture();
    const now = new Date("2026-09-22T00:00:00.000Z");
    const projectId = "pin-contract-project";
    const taskId = "pin-contract-task";
    const manifestId = "pin-contract-manifest";
    const definition: OfficePipeline = {
      id: "delivery",
      name: "Delivery",
      description: "Pin contract",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "build",
          name: "Build",
          roleId: "developer",
          objective: "Build",
          checks: [],
          requiresApproval: false,
          capabilities: [],
        },
      ],
    };
    try {
      await fixture.projects.save(
        Project.create({ id: projectId, name: projectId, now }),
      );
      await fixture.tasks.save(
        Task.create({ id: taskId, projectId, title: "Feature", now }),
      );
      await fixture.manifests.save({
        id: manifestId,
        projectId,
        revision: 1,
        manifest: {
          schemaVersion: 1,
          provenance: {
            host: "codex",
            skill: "ai-office",
            skillVersion: "1.0.0",
          },
          project: {
            mission: "Pin contract",
            goals: ["Ship"],
            constraints: [],
            preferences: [],
            permissionPreferences: [],
          },
          office: {
            name: "Pin contract office",
            roles: [
              {
                id: "developer",
                title: "Developer",
                purpose: "Build",
                responsibilities: ["Build"],
              },
            ],
          },
          pipelines: [definition],
        },
        appliedAt: now,
      });
      const pack = {
        id: "org.ai-office.legal",
        version: "0.2.0",
        manifestDigest: `sha256:${"c".repeat(64)}`,
      };
      const run = PipelineRun.create({
        id: "pin-contract-run",
        projectId,
        taskId,
        manifestRevisionId: manifestId,
        manifestRevision: 1,
        definition,
        startedBy: "operator",
        stageRunIds: ["pin-contract-stage"],
        configurationPin: {
          configurationDigest: `sha256:${"d".repeat(64)}`,
          coreContractVersion: 1,
          bindingRevision: 1,
          definitionRevision: 0,
          selectedPacks: [pack],
          resolvedPacks: [pack],
        },
        now,
      });
      await fixture.pipelines.insert(run);
      const restored = await fixture.pipelines.findById(
        run.snapshot().id,
        projectId,
      );
      expect(restored?.snapshot().configurationPin).toEqual(
        run.snapshot().configurationPin,
      );
    } finally {
      await fixture.close();
    }
  });
});
