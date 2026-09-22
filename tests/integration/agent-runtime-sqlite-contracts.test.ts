import { afterEach, describe } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "@ai-office/domain/project/project.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { defineAgentRuntimeRepositoryContracts } from "../contracts/agent-runtime-repository.contract.ts";

const migrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);
const roots: string[] = [];

describe("SQLite AgentRuntimeRepository shared contract", () => {
  defineAgentRuntimeRepositoryContracts(async () => {
    const root = mkdtempSync(
      join(tmpdir(), "ai-office-agent-runtime-contract-"),
    );
    roots.push(root);
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, migrationDirectory);
    const now = new Date("2026-09-22T10:00:00.000Z");
    const projectId = "contract-project";
    const taskId = "contract-task";
    const roleId = "contract-role";
    const agentId = "contract-agent";
    await new SqliteProjectRepository(database).save(
      Project.create({ id: projectId, name: "Contract", now }),
    );
    await new SqliteTaskRepository(database).save(
      Task.create({ id: taskId, projectId, title: "Contract task", now }),
    );
    const runtime = new SqliteAgentRuntimeRepository(database);
    await runtime.saveRole(
      Role.create({
        id: roleId,
        projectId,
        key: "contract",
        name: "Contract",
        version: 1,
        capabilities: [],
        tools: [],
        modelPolicy: "mock",
        limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 1 },
        sourcePath: "contract.yaml",
        now,
      }),
    );
    await runtime.saveAgent({
      id: agentId,
      projectId,
      roleId,
      name: "Contract",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    return {
      runtime,
      projectId,
      taskId,
      agentId,
      roleId,
      idPrefix: "sqlite-contract",
      now,
      close: async () => database.close(),
    };
  });
});

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
