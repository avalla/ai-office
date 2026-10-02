import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
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
import { PostgresProjectPackBindingRepository } from "@ai-office/storage-postgres/repositories/postgres-project-pack-binding.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { PostgresTaskDependencyRepository } from "@ai-office/storage-postgres/repositories/postgres-task-dependency.repository.ts";
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
      packBindings: new PostgresProjectPackBindingRepository(
        database,
        tenantId,
      ),
      tasks: new PostgresTaskRepository(database, tenantId),
      taskDependencies: new PostgresTaskDependencyRepository(
        database,
        tenantId,
      ),
      taskRequirements: new PostgresTaskRequirementRepository(
        database,
        tenantId,
      ),
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
    }), { packBindings: true });

    test("serializes concurrent inverse dependency edges so no cycle commits", async () => {
      const first = new PostgresClient(connectionString!);
      const second = new PostgresClient(connectionString!);
      const observer = new PostgresClient(connectionString!);
      const projectId = `cycle-${randomUUID()}`;
      const taskA = `cycle-a-${randomUUID()}`;
      const taskB = `cycle-b-${randomUUID()}`;
      const now = new Date("2026-10-01T00:00:00.000Z");
      try {
        const projects = new PostgresProjectRepository(observer, tenantId);
        const tasks = new PostgresTaskRepository(observer, tenantId);
        await projects.save(
          Project.create({ id: projectId, name: "Concurrent cycle", now }),
        );
        for (const id of [taskA, taskB])
          await tasks.save(Task.create({ id, projectId, title: id, now }));

        let releaseFirst!: () => void;
        const firstMayCommit = new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        let firstInserted!: () => void;
        const firstInsertDone = new Promise<void>((resolve) => {
          firstInserted = resolve;
        });
        const firstWrite = first.transaction(async () => {
          expect(
            await new PostgresTaskDependencyRepository(first, tenantId).link({
              projectId,
              taskId: taskA,
              dependsOnTaskId: taskB,
              createdAt: now,
            }),
          ).toBe(true);
          firstInserted();
          await firstMayCommit;
        });
        await firstInsertDone;
        let secondAttempting!: () => void;
        const secondAttemptStarted = new Promise<void>((resolve) => {
          secondAttempting = resolve;
        });
        const secondWrite = second.transaction(async () => {
          secondAttempting();
          return new PostgresTaskDependencyRepository(second, tenantId).link({
            projectId,
            taskId: taskB,
            dependsOnTaskId: taskA,
            createdAt: now,
          });
        });
        await secondAttemptStarted;
        // The second transaction must wait for the project graph lock while the first is open.
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(
          await new PostgresTaskDependencyRepository(
            observer,
            tenantId,
          ).listByProject(projectId),
        ).toEqual([]);
        releaseFirst();
        await firstWrite;
        await expect(secondWrite).rejects.toThrow("cycle");
        expect(
          await new PostgresTaskDependencyRepository(
            observer,
            tenantId,
          ).listByProject(projectId),
        ).toEqual([
          { projectId, taskId: taskA, dependsOnTaskId: taskB, createdAt: now },
        ]);
        await expect(
          observer.query(
            "UPDATE core.task_dependency SET created_at = $1 WHERE task_id = $2",
            [new Date("2026-10-02T00:00:00.000Z"), taskA],
          ),
        ).rejects.toThrow("immutable");
      } finally {
        await Promise.all([first.close(), second.close(), observer.close()]);
      }
    }, 15000);

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
            await new PostgresProjectRepository(observer, tenantId).findById(
              projectId,
            ),
          ).toBeNull();
        });
        expect(
          await new PostgresProjectRepository(observer, tenantId).findById(
            projectId,
          ),
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
    test("upgrades execution history from local authority and keeps it monotonic across concurrent entries", async () => {
      const databaseName = `ai_office_history_${randomUUID().replaceAll("-", "")}`;
      const partialRoot = mkdtempSync(
        join(tmpdir(), "ai-office-postgres-history-upgrade-"),
      );
      const partial = join(partialRoot, "migrations");
      mkdirSync(partial);
      for (const file of readdirSync(migrationDirectory).filter(
        (name) =>
          name.endsWith(".sql") &&
          name < "20261001000400_task_execution_history.sql",
      ))
        copyFileSync(join(migrationDirectory, file), join(partial, file));
      const admin = new PostgresClient(connectionString!);
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      await admin.close();
      const isolated = new URL(connectionString!);
      isolated.pathname = `/${databaseName}`;
      const database = new PostgresClient(isolated.toString());
      const first = new PostgresClient(isolated.toString());
      const second = new PostgresClient(isolated.toString());
      const at = new Date("2026-09-30T10:00:00.000Z");
      try {
        await migratePostgres(database, partial);
        await database.query(
          "INSERT INTO core.tenant(id,name,created_at,updated_at) VALUES ('history-tenant','Tenant',$1,$1)",
          [at],
        );
        await database.query(
          "INSERT INTO core.project(id,tenant_id,name,created_at,updated_at) VALUES ('history-project','history-tenant','Project',$1,$1)",
          [at],
        );
        for (const id of [
          "pristine",
          "start",
          "run",
          "pipeline",
          "returned",
          "status-only",
          "earliest",
          "concurrent",
          "crash",
          "prerequisite",
        ])
          await database.query(
            `INSERT INTO core.task(id,project_id,title,status,priority,created_at,updated_at)
            VALUES ($1,'history-project',$1,'pending',0,$2,$2)`,
            [id, at],
          );
        for (const id of ["start", "returned"])
          await database.query(
            `INSERT INTO core.audit_event(id,project_id,event_type,actor_type,
            aggregate_type,aggregate_id,payload_json,occurred_at)
            VALUES ($1,'history-project','task.status_changed','system','task',$2,
              '{"operation":"start"}'::jsonb,$3)`,
            [`audit-${id}`, id, at],
          );
        await database.query(
          "UPDATE core.task SET status='running' WHERE id='returned'",
        );
        await database.query(
          "UPDATE core.task SET status='pending' WHERE id='returned'",
        );
        await database.query(
          "UPDATE core.task SET status='waiting_review' WHERE id='status-only'",
        );
        await database.query(
          `INSERT INTO core.role(id,project_id,role_key,name,version,
          capabilities_json,tools_json,model_policy,limits_json,source_path,created_at,updated_at)
          VALUES ('history-role','history-project','role','Role',1,'[]'::jsonb,'[]'::jsonb,
            'default','{"maxIterations":1,"maxCostMicros":"0","timeoutSeconds":60}'::jsonb,
            'fixture',$1,$1)`,
          [at],
        );
        await database.query(
          `INSERT INTO core.agent(id,project_id,role_id,name,enabled,created_at,updated_at)
          VALUES ('history-agent','history-project','history-role','Agent',true,$1,$1)`,
          [at],
        );
        await database.query(
          `INSERT INTO core.agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at)
          VALUES ('history-run','history-project','run','history-agent','cancelled',$1,$1)`,
          [at],
        );
        await database.query(
          `INSERT INTO core.pipeline_run(id,project_id,task_id,status,current_stage_index,
          version,created_at,updated_at) VALUES ('history-pipeline','history-project','pipeline',
          'cancelled',0,1,$1,$1)`,
          [at],
        );
        expect(await migratePostgres(database, migrationDirectory)).toEqual([
          "20261001000400_task_execution_history.sql",
          "20261002000100_project_pack_binding.sql",
        ]);
        expect(await migratePostgres(database, migrationDirectory)).toEqual([]);
        const rows = await database.query<{
          task_id: string;
          state: string;
          first_known_at: Date | null;
        }>(
          "SELECT task_id,state,first_known_at FROM core.task_execution_history ORDER BY task_id",
        );
        expect(
          rows.map((row) => [
            row.task_id,
            row.state,
            row.first_known_at?.toISOString() ?? null,
          ]),
        ).toEqual([
          ...["pipeline", "returned", "run", "start"].map((id) => [
            id,
            "executed",
            at.toISOString(),
          ]),
          ["status-only", "executed", null],
        ]);
        const repository = new PostgresTaskDependencyRepository(
          database,
          "history-tenant",
        );
        expect(
          await repository.hasExecutionHistory("history-project", "pristine"),
        ).toBe(false);
        expect(
          await repository.hasExecutionHistory("history-project", "returned"),
        ).toBe(true);
        expect(
          await new PostgresTaskDependencyRepository(
            database,
            "other-tenant",
          ).hasExecutionHistory("history-project", "returned"),
        ).toBe(false);
        expect(
          await database.query<{ relrowsecurity: boolean }>(
            "SELECT relrowsecurity FROM pg_class WHERE oid='core.task_execution_history'::regclass",
          ),
        ).toEqual([{ relrowsecurity: true }]);
        await expect(
          database.query(
            "DELETE FROM core.task_execution_history WHERE task_id='start'",
          ),
        ).rejects.toThrow("append-only");
        await expect(
          database.query(
            "UPDATE core.task_execution_history SET state='unknown' WHERE task_id='start'",
          ),
        ).rejects.toThrow("monotonic");
        const later = new Date("2026-09-30T12:00:00.000Z");
        await database.query(
          "UPDATE core.task SET status='running', updated_at=$1 WHERE id='earliest'",
          [later],
        );
        expect(
          (
            await database.query<{ first_known_at: Date | null }>(
              "SELECT first_known_at FROM core.task_execution_history WHERE task_id='earliest'",
            )
          )[0]?.first_known_at?.toISOString(),
        ).toBe(later.toISOString());
        await database.query(
          `INSERT INTO core.agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at)
          VALUES ('earliest-run','history-project','earliest','history-agent','cancelled',$1,$1)`,
          [at],
        );
        expect(
          (
            await database.query<{ first_known_at: Date | null }>(
              "SELECT first_known_at FROM core.task_execution_history WHERE task_id='earliest'",
            )
          )[0]?.first_known_at?.toISOString(),
        ).toBe(at.toISOString());
        await expect(
          database.query(
            "UPDATE core.task_execution_history SET first_known_at=$1 WHERE task_id='earliest'",
            [later],
          ),
        ).rejects.toThrow("monotonic");
        await expect(
          database.query(
            `INSERT INTO core.task_dependency(project_id,task_id,depends_on_task_id,created_at)
          VALUES ('history-project','returned','prerequisite',$1)`,
            [at],
          ),
        ).rejects.toThrow("execution history");
        await expect(
          database.transaction(async () => {
            await database.query(
              "UPDATE core.task SET status='running' WHERE id='crash'",
            );
            expect(
              await repository.hasExecutionHistory("history-project", "crash"),
            ).toBe(true);
            throw new Error("abort");
          }),
        ).rejects.toThrow("abort");
        expect(
          await repository.hasExecutionHistory("history-project", "crash"),
        ).toBe(false);
        await Promise.all([
          first.transaction(async () => {
            await first.query(
              "UPDATE core.task SET status='running' WHERE id='concurrent'",
            );
          }),
          second.transaction(async () => {
            await second.query(
              `INSERT INTO core.agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at)
              VALUES ('concurrent-run','history-project','concurrent','history-agent','queued',$1,$1)`,
              [at],
            );
          }),
        ]);
        expect(
          await database.query<{ count: string }>(
            "SELECT count(*) FROM core.task_execution_history WHERE task_id='concurrent'",
          ),
        ).toEqual([{ count: "1" }]);
        for (const id of ["race-task", "race-prerequisite"])
          await database.query(
            `INSERT INTO core.task(id,project_id,title,status,priority,created_at,updated_at)
            VALUES ($1,'history-project',$1,'pending',0,$2,$2)`,
            [id, at],
          );
        let edgeInserted!: () => void;
        const edgeReady = new Promise<void>((resolve) => {
          edgeInserted = resolve;
        });
        let releaseEdge!: () => void;
        const holdEdge = new Promise<void>((resolve) => {
          releaseEdge = resolve;
        });
        const edgeWrite = first.transaction(async () => {
          await first.query(
            `INSERT INTO core.task_dependency(project_id,task_id,depends_on_task_id,created_at)
            VALUES ('history-project','race-task','race-prerequisite',$1)`,
            [at],
          );
          edgeInserted();
          await holdEdge;
        });
        await edgeReady;
        const startWrite = second.query(
          "UPDATE core.task SET status='running' WHERE id='race-task'",
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        releaseEdge();
        await edgeWrite;
        await expect(startWrite).rejects.toThrow("incomplete prerequisites");
        expect(
          await database.query<{ status: string }>(
            "SELECT status FROM core.task WHERE id='race-task'",
          ),
        ).toEqual([{ status: "pending" }]);
        expect(
          await database.query(
            "SELECT task_id FROM core.task_execution_history WHERE task_id='race-task'",
          ),
        ).toEqual([]);
        await database.query(
          `INSERT INTO core.project(id,tenant_id,name,created_at,updated_at)
          VALUES ('cascade-project','history-tenant','Cascade',$1,$1)`,
          [at],
        );
        await database.query(
          `INSERT INTO core.task(id,project_id,title,status,priority,created_at,updated_at)
          VALUES ('cascade-task','cascade-project','Cascade','pending',0,$1,$1)`,
          [at],
        );
        await database.query(
          "UPDATE core.task SET status='running' WHERE id='cascade-task'",
        );
        await database.query(
          "DELETE FROM core.project WHERE id='cascade-project'",
        );
        expect(
          await database.query(
            "SELECT task_id FROM core.task_execution_history WHERE task_id='cascade-task'",
          ),
        ).toEqual([]);
      } finally {
        await Promise.allSettled([
          database.close(),
          first.close(),
          second.close(),
        ]);
        const cleanup = new PostgresClient(connectionString!);
        try {
          await cleanup.query(`DROP DATABASE "${databaseName}"`);
        } finally {
          await cleanup.close();
          rmSync(partialRoot, { recursive: true, force: true });
        }
      }
    });

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
                'core.governance_event', 'core.role', 'core.agent',
                'core.office_manifest_revision', 'core.pipeline_run',
                'core.pipeline_stage_run', 'core.pipeline_override', 'core.task_lock',
                'core.agent_run_event', 'core.audit_event'
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
          { relation: "core.role" },
          { relation: "core.agent" },
          { relation: "core.office_manifest_revision" },
          { relation: "core.pipeline_run" },
          { relation: "core.pipeline_stage_run" },
          { relation: "core.pipeline_override" },
          { relation: "core.task_lock" },
          { relation: "core.agent_run_event" },
          { relation: "core.audit_event" },
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

    test("recovers a staged NULL-tenant migration after authoritative assignment", async () => {
      const databaseName = `ai_office_orphan_${randomUUID().replaceAll("-", "")}`;
      const partialRoot = mkdtempSync(
        join(tmpdir(), "ai-office-postgres-migration-recovery-"),
      );
      const partialMigrationDirectory = join(partialRoot, "migrations");
      mkdirSync(partialMigrationDirectory);
      const requiredMigration = "20260919050000_project_tenant_required.sql";
      for (const file of readdirSync(migrationDirectory)
        .filter((value) => value.endsWith(".sql"))
        .sort()) {
        if (file < requiredMigration)
          copyFileSync(
            join(migrationDirectory, file),
            join(partialMigrationDirectory, file),
          );
      }

      const admin = new PostgresClient(connectionString!);
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      await admin.close();
      const isolatedConnection = new URL(connectionString!);
      isolatedConnection.pathname = `/${databaseName}`;
      const database = new PostgresClient(isolatedConnection.toString());
      const tenantId = `recovery-tenant-${randomUUID()}`;
      const projectId = `recovery-project-${randomUUID()}`;

      try {
        expect(
          (await migratePostgres(database, partialMigrationDirectory)).at(-1),
        ).toBe("20260919040000_governance_authority_boundary.sql");
        await database.query(
          "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)",
          [tenantId, "Recovery Tenant", new Date("2026-09-19T00:00:00.000Z")],
        );
        await database.query(
          "INSERT INTO core.project(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3)",
          [projectId, "Orphan Project", new Date("2026-09-19T00:00:00.000Z")],
        );

        await expect(
          migratePostgres(database, migrationDirectory),
        ).rejects.toThrow(
          "cannot make core.project.tenant_id NOT NULL while NULL-tenant projects exist",
        );
        expect(
          await database.query<{ count: string }>(
            "SELECT count(*) FROM core.schema_migration WHERE version = $1",
            [requiredMigration],
          ),
        ).toEqual([{ count: "0" }]);
        expect(
          await database.query<{ is_nullable: string }>(
            `
              SELECT is_nullable
              FROM information_schema.columns
              WHERE table_schema = 'core'
                AND table_name = 'project'
                AND column_name = 'tenant_id'
            `,
          ),
        ).toEqual([{ is_nullable: "YES" }]);
        expect(
          await database.query<{ tenant_id: string | null }>(
            "SELECT tenant_id FROM core.project WHERE id = $1",
            [projectId],
          ),
        ).toEqual([{ tenant_id: null }]);

        await database.query(
          "UPDATE core.project SET tenant_id = $1 WHERE id = $2",
          [tenantId, projectId],
        );
        expect(await migratePostgres(database, migrationDirectory)).toEqual([
          requiredMigration,
          "20260922000000_agent_runtime_audit_authority.sql",
          "20260922010000_agent_runtime_audit_hardening.sql",
          "20260922020000_office_manifest_pipeline_authority.sql",
          "20260925000100_governance_milestone_title_event.sql",
          "20261001000100_task_dependencies.sql",
          "20261001000200_milestone_description_changed_event.sql",
          "20261001000300_task_dependency_immutable_edges.sql",
          "20261001000400_task_execution_history.sql",
          "20261002000100_project_pack_binding.sql",
        ]);
        expect(
          await database.query<{ is_nullable: string }>(
            `
              SELECT is_nullable
              FROM information_schema.columns
              WHERE table_schema = 'core'
                AND table_name = 'project'
                AND column_name = 'tenant_id'
            `,
          ),
        ).toEqual([{ is_nullable: "NO" }]);
        expect(
          await database.query<{ tenant_id: string }>(
            "SELECT tenant_id FROM core.project WHERE id = $1",
            [projectId],
          ),
        ).toEqual([{ tenant_id: tenantId }]);
      } finally {
        await database.close();
        rmSync(partialRoot, { recursive: true, force: true });
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
