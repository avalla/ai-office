import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import { ReadProjectConfiguration } from "@ai-office/application/domain-pack/read-project-configuration.ts";
import { HookedPipelineRunRepository } from "../helpers/hooked-pipeline-run-repository.ts";
import type { PackIdentity } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresAgentRuntimeRepository } from "@ai-office/storage-postgres/repositories/postgres-agent-runtime.repository.ts";
import { PostgresAuditEventRepository } from "@ai-office/storage-postgres/repositories/postgres-audit-event.repository.ts";
import { PostgresOfficeManifestRepository } from "@ai-office/storage-postgres/repositories/postgres-office-manifest.repository.ts";
import {
  PostgresPipelineRunConfigurationPinUnsupportedError,
  PostgresPipelineRunRepository,
} from "@ai-office/storage-postgres/repositories/postgres-pipeline-run.repository.ts";
import { PostgresProjectDefinitionRepository } from "@ai-office/storage-postgres/repositories/postgres-project-definition.repository.ts";
import { PostgresProjectPackBindingRepository } from "@ai-office/storage-postgres/repositories/postgres-project-pack-binding.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import {
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
} from "../../packages/domain-pack-contracts/src/index.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const migrationDirectory = `${process.cwd()}/supabase/migrations`;
const tenantId = "pipeline-pin-race-tenant";
const now = new Date("2026-10-11T00:00:00.000Z");
const pack: PackIdentity = {
  id: parseDomainPackId("org.example.pin-race"),
  version: parseDomainPackVersion("1.0.0"),
  manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
};

class FixedClock implements Clock {
  now(): Date {
    return new Date(now);
  }
}

class PrefixedIds implements IdGenerator {
  private next = 0;
  constructor(private readonly prefix: string) {}
  generate(): string {
    this.next += 1;
    return `${this.prefix}-${this.next}`;
  }
}

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Pin race",
    goals: ["Ship"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Pin race office",
    roles: [
      {
        id: "developer",
        title: "Developer",
        purpose: "Build",
        responsibilities: ["Build"],
      },
    ],
  },
  pipelines: [
    {
      id: "delivery",
      name: "Delivery",
      description: "Pin race delivery",
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
    },
  ],
};

let runner: PostgresClient;
let concurrent: PostgresClient;

describe.skipIf(connectionString === undefined)(
  "PostgreSQL pipeline run configuration pin under concurrent rebinding",
  () => {
    beforeAll(async () => {
      runner = new PostgresClient(connectionString!);
      // A second pooled client stands in for a concurrent writer on its own
      // connection, so its statements never join the run-start transaction.
      concurrent = new PostgresClient(connectionString!);
      await migratePostgres(runner, migrationDirectory);
      await runner.query(
        `INSERT INTO core.tenant(id, name, created_at, updated_at)
         VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING`,
        [tenantId, "Pipeline pin race tenant", now],
      );
    });

    // Project ids are unique per run: audit events are append-only, so the
    // projects that own them are left in place, as in the storage contracts.
    afterAll(async () => {
      await concurrent.close();
      await runner.close();
    });

    function compose(
      projectId: string,
      hooks: ConstructorParameters<typeof HookedPipelineRunRepository>[1],
    ) {
      const ids = new PrefixedIds(projectId);
      const clock = new FixedClock();
      const projects = new PostgresProjectRepository(runner, tenantId);
      const tasks = new PostgresTaskRepository(runner, tenantId);
      const manifests = new PostgresOfficeManifestRepository(runner, tenantId);
      const pipelines = new PostgresPipelineRunRepository(runner, tenantId);
      const transactions = new PostgresTransactionRunner(runner);
      const configuration = new ReadProjectConfiguration({
        projects,
        bindings: new PostgresProjectPackBindingRepository(runner, tenantId),
        definitions: new PostgresProjectDefinitionRepository(runner, tenantId),
        transactions,
        catalog: new InMemoryInstalledDomainPackCatalog(1, []),
      });
      const manager = new ManagePipelineRuns(
        manifests,
        new HookedPipelineRunRepository(pipelines, hooks),
        tasks,
        new PostgresAgentRuntimeRepository(runner, tenantId),
        new RecordAuditEvent(
          new PostgresAuditEventRepository(runner, tenantId),
          ids,
          clock,
        ),
        ids,
        clock,
        transactions,
        undefined,
        undefined,
        configuration,
      );
      return { projects, tasks, manifests, pipelines, manager };
    }

    async function seed(
      parts: ReturnType<typeof compose>,
      projectId: string,
      taskId: string,
    ): Promise<void> {
      await parts.projects.save(
        Project.create({ id: projectId, name: projectId, now }),
      );
      await parts.tasks.save(
        Task.create({ id: taskId, projectId, title: "Feature", now }),
      );
      await parts.manifests.save({
        id: `${projectId}-manifest`,
        projectId,
        revision: 1,
        manifest,
        appliedAt: now,
      });
    }

    function concurrentBindings(): PostgresProjectPackBindingRepository {
      return new PostgresProjectPackBindingRepository(concurrent, tenantId);
    }

    test("a pack binding committed between the pin read and the run insert fails the start closed instead of persisting an unpinned run", async () => {
      const projectId = `pin-race-before-insert-${randomUUID()}`;
      const taskId = `${projectId}-task`;
      let rebound = false;
      const parts = compose(projectId, {
        // The run-start transaction has already resolved "no packs, no pin".
        // A writer on another connection now binds a pack and commits.
        beforeInsert: async () => {
          if (rebound) return;
          rebound = true;
          await concurrentBindings().replace(projectId, 0, [pack], now);
        },
      });
      await seed(parts, projectId, taskId);

      await expect(
        parts.manager.start({
          projectId,
          taskId,
          pipelineId: "delivery",
          principal: localOperatorPrincipal,
        }),
      ).rejects.toThrow(PostgresPipelineRunConfigurationPinUnsupportedError);

      expect(rebound).toBe(true);
      // The whole start rolled back: no run, task untouched.
      expect(
        await parts.pipelines.findActiveByTask(taskId, projectId),
      ).toBeNull();
      expect((await parts.tasks.findById(taskId))?.snapshot().status).toBe(
        "pending",
      );
      expect((await concurrentBindings().get(projectId)).packs).toEqual([pack]);
    });

    // The two lock steps `replace` takes before it can change the packs: the
    // head-row insert for a project's first binding, and the head row lock
    // once the row exists. Either must conflict with the open run start.
    test.each([
      {
        name: "the first binding's head insert",
        headExists: false,
        probe: async (projectId: string) => {
          // INSERT has no NOWAIT; the bound only turns "blocked until the run
          // start ends" into an observable error, it orders nothing.
          await concurrent.query("SET LOCAL lock_timeout = '250ms'");
          await concurrent.query(
            `INSERT INTO core.project_pack_binding(project_id, tenant_id)
             SELECT id, tenant_id FROM core.project WHERE id = $1 AND tenant_id = $2
             ON CONFLICT(project_id) DO NOTHING`,
            [projectId, tenantId],
          );
        },
      },
      {
        name: "an existing binding's head row lock",
        headExists: true,
        probe: async (projectId: string) => {
          await concurrent.query(
            `SELECT configuration_revision FROM core.project_pack_binding
             WHERE project_id = $1 AND tenant_id = $2 FOR UPDATE NOWAIT`,
            [projectId, tenantId],
          );
        },
      },
    ])(
      "a rebinding attempted after the run insert cannot take $name until the run start commits",
      async ({ headExists, probe }) => {
        const projectId = `pin-race-after-insert-${randomUUID()}`;
        const taskId = `${projectId}-task`;
        let lockError: unknown;
        const parts = compose(projectId, {
          // The run row is written but not committed.
          afterInsert: async () => {
            try {
              await concurrent.transaction(() => probe(projectId));
            } catch (error) {
              lockError = error;
            }
          },
        });
        await seed(parts, projectId, taskId);
        if (headExists) {
          // An empty `replace` commits the head row and changes nothing else.
          await concurrentBindings().replace(projectId, 0, [], now);
        }

        const run = await parts.manager.start({
          projectId,
          taskId,
          pipelineId: "delivery",
          principal: localOperatorPrincipal,
        });

        expect(lockError).toMatchObject({ code: "55P03" });
        expect(run.snapshot().configurationPin).toBeUndefined();
        // Once the start committed, the rebinding proceeds normally and the
        // committed run is unaffected by it.
        await concurrentBindings().replace(projectId, 0, [pack], now);
        const restored = await parts.pipelines.findById(
          run.snapshot().id,
          projectId,
        );
        expect(restored?.snapshot().configurationPin).toBeUndefined();
        expect(restored?.snapshot().status).toBe("active");
      },
    );

    test("a project whose committed binding already has packs fails the start closed and rolls it back", async () => {
      const projectId = `pin-race-bound-${randomUUID()}`;
      const taskId = `${projectId}-task`;
      const parts = compose(projectId, {});
      await seed(parts, projectId, taskId);
      await concurrentBindings().replace(projectId, 0, [pack], now);

      await expect(
        parts.manager.start({
          projectId,
          taskId,
          pipelineId: "delivery",
          principal: localOperatorPrincipal,
        }),
      ).rejects.toThrow();
      expect(
        await parts.pipelines.findActiveByTask(taskId, projectId),
      ).toBeNull();
      expect((await parts.tasks.findById(taskId))?.snapshot().status).toBe(
        "pending",
      );
    });
  },
);
