import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe } from "vitest";
import { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresAgentRuntimeRepository } from "@ai-office/storage-postgres/repositories/postgres-agent-runtime.repository.ts";
import { PostgresAuditEventRepository } from "@ai-office/storage-postgres/repositories/postgres-audit-event.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { defineAgentRuntimeRepositoryContracts } from "../contracts/agent-runtime-repository.contract.ts";
import { defineAuditEventRepositoryContracts } from "../contracts/audit-event-repository.contract.ts";

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
    defineAuditEventRepositoryContracts(async () => {
      const suffix = randomUUID();
      const tenantId = `audit-contract-tenant-${suffix}`;
      const projectId = `audit-contract-project-${suffix}`;
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)",
        [tenantId, tenantId, now],
      );
      await new PostgresProjectRepository(database, tenantId).save(
        Project.create({ id: projectId, name: projectId, now }),
      );
      const repository = new PostgresAuditEventRepository(database, tenantId);
      return {
        repository,
        projectId,
        idPrefix: `postgres-audit-contract-${suffix}`,
        now,
        async findById(id: string) {
          const [row] = await database.query<{
            event_type: string;
            actor_type: string;
            actor_id: string | null;
            aggregate_type: string | null;
            aggregate_id: string | null;
            project_id: string | null;
            payload_json: unknown;
          }>(
            "SELECT event_type, actor_type, actor_id, aggregate_type, aggregate_id, project_id, payload_json FROM core.audit_event WHERE id=$1",
            [id],
          );
          return row === undefined
            ? null
            : {
                event_type: row.event_type,
                actor_type: row.actor_type,
                actor_id: row.actor_id,
                aggregate_type: row.aggregate_type,
                aggregate_id: row.aggregate_id,
                project_id: row.project_id,
                payload:
                  typeof row.payload_json === "string"
                    ? (JSON.parse(row.payload_json) as Record<string, unknown>)
                    : (row.payload_json as Record<string, unknown>),
              };
        },
        async countById(id: string) {
          return Number(
            (
              await database.query<{ count: string }>(
                "SELECT COUNT(*)::text AS count FROM core.audit_event WHERE id=$1",
                [id],
              )
            )[0]?.count ?? "0",
          );
        },
        async appendAndRollback(event: AuditEvent) {
          return new PostgresTransactionRunner(database).run(async () => {
            await repository.append(event);
            throw new Error("contract rollback");
          });
        },
        async close() {},
      };
    });
  },
);
