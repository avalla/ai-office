import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresAgentRuntimeRepository } from "@ai-office/storage-postgres/repositories/postgres-agent-runtime.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { defineAgentRuntimeRepositoryContracts } from "../contracts/agent-runtime-repository.contract.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const now = new Date("2026-09-22T10:00:00.000Z");

describe.skipIf(connectionString === undefined)(
  "PostgreSQL AgentRuntimeRepository shared contract",
  () => {
    let database: PostgresClient;

    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(database, "supabase/migrations");
    });

    afterAll(async () => {
      await database.close();
    });

    defineAgentRuntimeRepositoryContracts(async () => {
      const suffix = randomUUID();
      const tenantId = `contract-tenant-${suffix}`;
      const projectId = `contract-project-${suffix}`;
      const taskId = `contract-task-${suffix}`;
      const roleId = `contract-role-${suffix}`;
      const agentId = `contract-agent-${suffix}`;
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)",
        [tenantId, tenantId, now],
      );
      const projects = new PostgresProjectRepository(database, tenantId);
      const tasks = new PostgresTaskRepository(database, tenantId);
      const runtime = new PostgresAgentRuntimeRepository(database, tenantId);
      await projects.save(
        Project.create({ id: projectId, name: projectId, now }),
      );
      await tasks.save(
        Task.create({ id: taskId, projectId, title: "Contract task", now }),
      );
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
        idPrefix: `postgres-contract-${suffix}`,
        now,
        close: async () => {},
      };
    });
  },
);
