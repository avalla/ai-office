import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import {
  PostgresClient,
  TransactionContextExpiredError,
} from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { PostgresTaskRequirementRepository } from "@ai-office/storage-postgres/repositories/postgres-task-requirement.repository.ts";
import { defineProjectStorageContracts } from "../contracts/project-storage.contract.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const migrationDirectory = join(process.cwd(), "supabase", "migrations");
const tenantId = "contract-tenant";

describe.skipIf(connectionString === undefined)(
  "PostgreSQL project storage contracts",
  () => {
    let database: PostgresClient;

    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(database, migrationDirectory);
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING",
        [tenantId, "Contract Tenant", new Date("2026-01-01T00:00:00.000Z")],
      );
      expect(await migratePostgres(database, migrationDirectory)).toEqual([]);
      expect(
        await database.query<{ exists: boolean }>(
          "SELECT to_regclass('core.project') IS NOT NULL AS exists",
        ),
      ).toEqual([{ exists: true }]);
      expect(
        await database.query<{ column_name: string }>(
          `
            SELECT column_name
            FROM information_schema.columns
            WHERE table_schema = 'core' AND table_name = 'requirement'
            ORDER BY ordinal_position
          `,
        ),
      ).toEqual([
        { column_name: "id" },
        { column_name: "project_id" },
        { column_name: "requirement_key" },
        { column_name: "title" },
        { column_name: "description" },
        { column_name: "status" },
        { column_name: "created_at" },
        { column_name: "updated_at" },
        { column_name: "milestone_id" },
      ]);
      expect(
        await database.query<{ exists: boolean }>(
          "SELECT to_regclass('core.task_requirement_requirement_idx') IS NOT NULL AS exists",
        ),
      ).toEqual([{ exists: true }]);
    });

    afterAll(async () => {
      await database.close();
    });

    defineProjectStorageContracts(async () => ({
      projects: new PostgresProjectRepository(database, tenantId),
      tasks: new PostgresTaskRepository(database, tenantId),
      taskRequirements: new PostgresTaskRequirementRepository(database, tenantId),
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
             id, project_id, requirement_key, title, description, status,
             created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
          [
            input.id,
            input.projectId,
            input.key,
            input.title,
            input.title,
            input.status,
            new Date("2026-01-01T00:00:00.000Z"),
          ],
        );
      },
      async close(): Promise<void> {},
    }));

    test("keeps repository writes on one transaction-bound session", async () => {
      const subject = new PostgresClient(connectionString!);
      const observer = new PostgresClient(connectionString!);
      const projects = new PostgresProjectRepository(subject, tenantId);
      const tasks = new PostgresTaskRepository(subject, tenantId);
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
            await new PostgresProjectRepository(observer, tenantId).findById(projectId),
          ).toBeNull();
        });
        expect(
          await new PostgresProjectRepository(observer, tenantId).findById(projectId),
        ).not.toBeNull();
        expect(
          await new PostgresTaskRepository(observer, tenantId).findById(taskId),
        ).not.toBeNull();
      } finally {
        await subject.close();
        await observer.close();
      }
    });

    test("allows concurrent independent top-level transactions", async () => {
      const subject = new PostgresClient(connectionString!);
      const transactions = new PostgresTransactionRunner(subject);
      let callbacksStarted = 0;
      let releaseCallbacks!: () => void;
      const callbacksReady = new Promise<void>((resolve) => {
        releaseCallbacks = resolve;
      });

      try {
        const work = (value: number) =>
          transactions.run(async () => {
            callbacksStarted += 1;
            if (callbacksStarted === 2) releaseCallbacks();
            await callbacksReady;
            const [row] = await subject.query<{ value: number }>(
              "SELECT $1::integer AS value",
              [value],
            );
            return row?.value;
          });

        await expect(Promise.all([work(1), work(2)])).resolves.toEqual([1, 2]);
      } finally {
        await subject.close();
      }
    });

    test("fails closed for an escaped transaction context", async () => {
      const subject = new PostgresClient(connectionString!);
      const projects = new PostgresProjectRepository(subject, tenantId);
      const transactions = new PostgresTransactionRunner(subject);
      let releaseEscapedWork!: () => void;
      const escapedGate = new Promise<void>((resolve) => {
        releaseEscapedWork = resolve;
      });
      let escapedWork!: Promise<unknown>;

      try {
        await transactions.run(async () => {
          escapedWork = (async () => {
            await escapedGate;
            return projects.findById("escaped-context-project");
          })();
        });

        releaseEscapedWork();
        await expect(escapedWork).rejects.toBeInstanceOf(
          TransactionContextExpiredError,
        );
        await expect(escapedWork).rejects.toThrow(
          "The PostgreSQL transaction context is no longer active",
        );
      } finally {
        await subject.close();
      }
    });
  },
);

describe.skipIf(connectionString === undefined)(
  "PostgreSQL migration concurrency",
  () => {
    test("applies a fresh migration set exactly once under concurrent bootstrap", async () => {
      const databaseName = `ai_office_migration_${randomUUID().replaceAll("-", "")}`;
      const admin = new PostgresClient(connectionString!);
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      await admin.close();

      const isolatedConnection = new URL(connectionString!);
      isolatedConnection.pathname = `/${databaseName}`;
      const first = new PostgresClient(isolatedConnection.toString());
      const second = new PostgresClient(isolatedConnection.toString());
      const migrationFiles = readdirSync(migrationDirectory)
        .filter((file) => file.endsWith(".sql"))
        .sort();

      try {
        const [firstApplied, secondApplied] = await Promise.all([
          migratePostgres(first, migrationDirectory),
          migratePostgres(second, migrationDirectory),
        ]);
        expect([...firstApplied, ...secondApplied].sort()).toEqual(
          migrationFiles,
        );
        expect(new Set([...firstApplied, ...secondApplied]).size).toBe(
          migrationFiles.length,
        );

        const rows = await first.query<{ version: string }>(
          "SELECT version FROM core.schema_migration ORDER BY version",
        );
        expect(rows.map((row) => row.version)).toEqual(migrationFiles);
        expect(new Set(rows.map((row) => row.version)).size).toBe(
          migrationFiles.length,
        );
        expect(
          await first.query<{ relation: string | null }>(
            `
              SELECT to_regclass(relation_name) AS relation
              FROM unnest(ARRAY[
                'core.project', 'core.task', 'core.requirement',
                'core.task_requirement', 'core.milestone',
                'core.architecture_decision', 'core.review', 'core.approval',
                'core.governance_event'
              ]) AS relation_name
            `,
          ),
        ).toEqual([
          { relation: "core.project" },
          { relation: "core.task" },
          { relation: "core.requirement" },
          { relation: "core.task_requirement" },
          { relation: "core.milestone" },
          { relation: "core.architecture_decision" },
          { relation: "core.review" },
          { relation: "core.approval" },
          { relation: "core.governance_event" },
        ]);
      } finally {
        await Promise.allSettled([first.close(), second.close()]);
        const cleanup = new PostgresClient(connectionString!);
        try {
          await cleanup.query(`DROP DATABASE "${databaseName}"`);
        } finally {
          await cleanup.close();
        }
      }
    });
  },
);
