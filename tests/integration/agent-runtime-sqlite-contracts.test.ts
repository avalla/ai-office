import { afterEach, describe } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "@ai-office/domain/project/project.ts";
import { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { defineAgentRuntimeRepositoryContracts } from "../contracts/agent-runtime-repository.contract.ts";
import { defineAuditEventRepositoryContracts } from "../contracts/audit-event-repository.contract.ts";

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

describe("SQLite AuditEventRepository shared contract", () => {
  defineAuditEventRepositoryContracts(async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-audit-contract-"));
    roots.push(root);
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, migrationDirectory);
    const now = new Date("2026-09-22T10:00:00.000Z");
    const projectId = "audit-contract-project";
    await new SqliteProjectRepository(database).save(
      Project.create({ id: projectId, name: "Audit", now }),
    );
    const repository = new SqliteAuditEventRepository(database);
    return {
      repository,
      projectId,
      idPrefix: "sqlite-audit-contract",
      now,
      async findById(id: string) {
        const row = database
          .query<
            {
              event_type: string;
              actor_type: string;
              actor_id: string | null;
              aggregate_type: string | null;
              aggregate_id: string | null;
              project_id: string | null;
              payload_json: string;
            },
            [string]
          >(
            "SELECT event_type, actor_type, actor_id, aggregate_type, aggregate_id, project_id, payload_json FROM audit_event WHERE id=?",
          )
          .get(id);
        if (row === null) return null;
        return {
          event_type: row.event_type,
          actor_type: row.actor_type,
          actor_id: row.actor_id,
          aggregate_type: row.aggregate_type,
          aggregate_id: row.aggregate_id,
          project_id: row.project_id,
          payload: JSON.parse(row.payload_json) as Record<string, unknown>,
        };
      },
      async countById(id: string) {
        return (
          database
            .query<{ count: number }, [string]>(
              "SELECT COUNT(*) count FROM audit_event WHERE id=?",
            )
            .get(id)?.count ?? 0
        );
      },
      async appendAndRollback(event: AuditEvent) {
        return Promise.resolve().then(() =>
          database.transaction(() => {
            repository.append(event);
            throw new Error("contract rollback");
          })(),
        );
      },
      async close() {
        database.close();
      },
    };
  });
});
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
