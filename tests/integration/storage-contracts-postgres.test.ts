import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, test } from "vitest";
import type { RequirementStatus } from "@ai-office/domain/governance/governance.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { ManageProjectPackBinding } from "@ai-office/application/domain-pack/manage-project-pack-binding.ts";
import { ManageProjectDefinitions } from "@ai-office/application/domain-pack/manage-project-definitions.ts";
import { StaleProjectDefinitionError } from "@ai-office/application/domain-pack/project-definition.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import { StaleProjectPackBindingError } from "@ai-office/application/ports/project-pack-binding-repository.port.ts";
import { computeArtifactDigest } from "../../packages/domain-pack-contracts/src/index.ts";
import { InMemoryInstalledDomainPackCatalog } from "@ai-office/runtime-host/installed-domain-pack-catalog.ts";
import {
  PostgresClient,
  TransactionContextExpiredError,
} from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresProjectPackBindingRepository } from "@ai-office/storage-postgres/repositories/postgres-project-pack-binding.repository.ts";
import { PostgresProjectDefinitionRepository } from "@ai-office/storage-postgres/repositories/postgres-project-definition.repository.ts";
import { PostgresAuditEventRepository } from "@ai-office/storage-postgres/repositories/postgres-audit-event.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { PostgresTaskDependencyRepository } from "@ai-office/storage-postgres/repositories/postgres-task-dependency.repository.ts";
import { PostgresTaskRequirementRepository } from "@ai-office/storage-postgres/repositories/postgres-task-requirement.repository.ts";
import { defineProjectStorageContracts } from "../contracts/project-storage.contract.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const migrationDirectory = join(process.cwd(), "supabase", "migrations");
const tenantId = "contract-tenant";

function installedBindingFixtures() {
  const catalog = new InMemoryInstalledDomainPackCatalog(1, [
    "local-distribution",
  ]);
  const register = (name: "custom" | "legal") => {
    const bytes = readFileSync(
      new URL(`../fixtures/domain-pack/${name}.json`, import.meta.url),
    );
    return catalog.register({
      bytes,
      artifactDigest: computeArtifactDigest(bytes),
      provenance: {
        installerId: "local-distribution",
        reference: `bundled/${name}`,
      },
    });
  };
  return { catalog, custom: register("custom"), legal: register("legal") };
}

function bindingService(
  database: PostgresClient,
  catalog: ReturnType<typeof installedBindingFixtures>["catalog"],
  auditEvents: AuditEventRepository = new PostgresAuditEventRepository(
    database,
    tenantId,
  ),
  transactions: TransactionRunner = new PostgresTransactionRunner(database),
) {
  return new ManageProjectPackBinding({
    projects: new PostgresProjectRepository(database, tenantId),
    bindings: new PostgresProjectPackBindingRepository(database, tenantId),
    definitions: new PostgresProjectDefinitionRepository(database, tenantId),
    catalog,
    auditEvents,
    transactions,
    clock: { now: () => new Date("2026-10-02T00:00:00.000Z") },
    ids: { generate: randomUUID },
  });
}

function definitionService(
  database: PostgresClient,
  catalog: ReturnType<typeof installedBindingFixtures>["catalog"],
  auditEvents: AuditEventRepository = new PostgresAuditEventRepository(
    database,
    tenantId,
  ),
) {
  return new ManageProjectDefinitions({
    projects: new PostgresProjectRepository(database, tenantId),
    definitions: new PostgresProjectDefinitionRepository(database, tenantId),
    bindings: new PostgresProjectPackBindingRepository(database, tenantId),
    catalog,
    auditEvents,
    transactions: new PostgresTransactionRunner(database),
    clock: { now: () => new Date("2026-10-03T00:00:00.000Z") },
    ids: { generate: randomUUID },
  });
}

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

    defineProjectStorageContracts(
      async () => ({
        projects: new PostgresProjectRepository(database, tenantId),
        packBindings: new PostgresProjectPackBindingRepository(
          database,
          tenantId,
        ),
        definitions: new PostgresProjectDefinitionRepository(
          database,
          tenantId,
        ),
        async deleteProject(projectId: string): Promise<void> {
          await database.query(
            "DELETE FROM core.project WHERE id = $1 AND tenant_id = $2",
            [projectId, tenantId],
          );
        },
        async bindingRowCounts(projectId: string) {
          const [head] = await database.query<{ count: string }>(
            "SELECT count(*) FROM core.project_pack_binding WHERE project_id = $1",
            [projectId],
          );
          const [pack] = await database.query<{ count: string }>(
            "SELECT count(*) FROM core.project_pack_binding_pack WHERE project_id = $1",
            [projectId],
          );
          return { heads: Number(head?.count), packs: Number(pack?.count) };
        },
        async definitionPayloadShapes(projectId: string) {
          return (
            await database.query<{
              table_name: "owned" | "override";
              local_id: string;
              json_type: string | null;
              title: string | null;
            }>(
              `SELECT 'owned' AS table_name, local_id,
                      jsonb_typeof(payload_json) AS json_type,
                      payload_json->>'title' AS title
                 FROM core.project_owned_definition WHERE project_id = $1
               UNION ALL
               SELECT 'override', local_id, jsonb_typeof(payload_json),
                      payload_json->>'title'
                 FROM core.project_definition_override WHERE project_id = $1`,
              [projectId],
            )
          ).map((row) => ({
            table: row.table_name,
            localId: row.local_id,
            jsonType: row.json_type,
            title: row.title,
          }));
        },
        async definitionRowCounts(projectId: string) {
          const count = async (
            table:
              | "project_definition_head"
              | "project_owned_definition"
              | "project_definition_override",
          ) => {
            const [row] = await database.query<{ count: string }>(
              `SELECT count(*) FROM core.${table} WHERE project_id = $1`,
              [projectId],
            );
            return Number(row?.count);
          };
          return {
            heads: await count("project_definition_head"),
            owned: await count("project_owned_definition"),
            overrides: await count("project_definition_override"),
          };
        },
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
      }),
      { packBindings: true, definitions: true },
    );

    test("application audit failure rolls back PostgreSQL binding and audit writes", async () => {
      const writer = new PostgresClient(connectionString!);
      const observer = new PostgresClient(connectionString!);
      const projectId = `pack-audit-${randomUUID()}`;
      const { catalog, custom } = installedBindingFixtures();
      try {
        await new PostgresProjectRepository(observer, tenantId).save(
          Project.create({
            id: projectId,
            name: "Pack audit rollback",
            now: new Date("2026-10-02T00:00:00.000Z"),
          }),
        );
        const writerBindings = new PostgresProjectPackBindingRepository(
          writer,
          tenantId,
        );
        const observerBindings = new PostgresProjectPackBindingRepository(
          observer,
          tenantId,
        );
        const realAudit = new PostgresAuditEventRepository(writer, tenantId);
        const failingAudit: AuditEventRepository = {
          append: async (event) => {
            expect(await writerBindings.get(projectId)).toMatchObject({
              configurationRevision: 1,
              packs: [custom],
            });
            expect(await observerBindings.get(projectId)).toEqual({
              projectId,
              configurationRevision: 0,
              packs: [],
            });
            await realAudit.append(event);
            throw new Error("audit append failed after insert");
          },
        };
        await expect(
          bindingService(writer, catalog, failingAudit).apply({
            projectId,
            desired: [custom],
            expectedRevision: 0,
            actorId: "local-operator",
          }),
        ).rejects.toThrow("audit append failed after insert");
        expect(await observerBindings.get(projectId)).toEqual({
          projectId,
          configurationRevision: 0,
          packs: [],
        });
        expect(
          await observer.query<{ count: string }>(
            "SELECT count(*) FROM core.project_pack_binding WHERE project_id = $1",
            [projectId],
          ),
        ).toEqual([{ count: "0" }]);
        expect(
          await observer.query<{ count: string }>(
            "SELECT count(*) FROM core.audit_event WHERE project_id = $1 AND event_type = 'project.pack_binding_applied'",
            [projectId],
          ),
        ).toEqual([{ count: "0" }]);
      } finally {
        await Promise.all([writer.close(), observer.close()]);
      }
    });

    test("binding composition preflight rejects a colliding selection before and inside the transaction (GP-22)", async () => {
      const writer = new PostgresClient(connectionString!);
      const observer = new PostgresClient(connectionString!);
      const { catalog, custom, legal } = installedBindingFixtures();
      const at = new Date("2026-10-06T00:00:00.000Z");
      const collision = {
        code: "pack_definition_collision",
        message:
          "Project definition roles/counsel collides with pack org.example.legal@1.0.0 in the proposed pack closure",
      };
      try {
        const bindings = new PostgresProjectPackBindingRepository(
          observer,
          tenantId,
        );
        const definitions = new PostgresProjectDefinitionRepository(
          observer,
          tenantId,
        );
        const ownCounsel = async (projectId: string, id: string) => {
          const current = await definitions.get(projectId);
          await definitions.replace(
            {
              ...current,
              owned: [
                {
                  origin: "project_owned",
                  kind: "roles",
                  id,
                  revision: 1,
                  enabled: true,
                  payload: { id },
                  actorId: "operator",
                  changedAt: at.toISOString(),
                },
              ],
            },
            current.revision,
            at,
          );
        };
        const create = async () => {
          const projectId = `pack-collision-${randomUUID()}`;
          await new PostgresProjectRepository(observer, tenantId).save(
            Project.create({ id: projectId, name: "Collision", now: at }),
          );
          return projectId;
        };
        const audits = (projectId: string) =>
          observer.query<{ count: string }>(
            "SELECT count(*) FROM core.audit_event WHERE project_id = $1 AND event_type = 'project.pack_binding_applied'",
            [projectId],
          );

        // Preflight: preview and apply agree and nothing is written.
        const projectId = await create();
        await ownCounsel(projectId, "counsel");
        expect(
          (await bindingService(writer, catalog).preview(projectId, [legal]))
            .issues,
        ).toEqual([collision]);
        await expect(
          bindingService(writer, catalog).apply({
            projectId,
            desired: [legal],
            expectedRevision: 0,
            actorId: "local-operator",
          }),
        ).rejects.toMatchObject(collision);
        expect(await bindings.get(projectId)).toEqual({
          projectId,
          configurationRevision: 0,
          packs: [],
        });
        expect(await audits(projectId)).toEqual([{ count: "0" }]);
        // Case and kind are part of the identity; a pack without the
        // definition can be selected.
        await ownCounsel(projectId, "Counsel");
        expect(
          await bindingService(writer, catalog).apply({
            projectId,
            desired: [custom, legal],
            expectedRevision: 0,
            actorId: "local-operator",
          }),
        ).toMatchObject({ configurationRevision: 1 });
        // The unchanged selection is a no-op even once it collides.
        await ownCounsel(projectId, "counsel");
        expect(
          await bindingService(writer, catalog).apply({
            projectId,
            desired: [custom, legal],
            expectedRevision: 1,
            actorId: "local-operator",
          }),
        ).toMatchObject({ configurationRevision: 1 });
        expect(await audits(projectId)).toEqual([{ count: "1" }]);

        // A definition committed between preflight and commit is caught by
        // the comparison inside the transaction, and the write rolls back.
        const racedId = await create();
        const real = new PostgresTransactionRunner(writer);
        const racing: TransactionRunner = {
          run: async (work) => {
            await ownCounsel(racedId, "counsel");
            return real.run(work);
          },
        };
        await expect(
          bindingService(writer, catalog, undefined, racing).apply({
            projectId: racedId,
            desired: [legal],
            expectedRevision: 0,
            actorId: "local-operator",
          }),
        ).rejects.toMatchObject(collision);
        expect(await bindings.get(racedId)).toEqual({
          projectId: racedId,
          configurationRevision: 0,
          packs: [],
        });
        expect(
          await observer.query<{ count: string }>(
            "SELECT count(*) FROM core.project_pack_binding WHERE project_id = $1",
            [racedId],
          ),
        ).toEqual([{ count: "0" }]);
        expect(await audits(racedId)).toEqual([{ count: "0" }]);
      } finally {
        await Promise.all([writer.close(), observer.close()]);
      }
    });

    test("concurrent application applies fence one revision and one complete audit", async () => {
      const firstClient = new PostgresClient(connectionString!);
      const secondClient = new PostgresClient(connectionString!);
      const observer = new PostgresClient(connectionString!);
      const projectId = `pack-race-${randomUUID()}`;
      const { catalog, custom, legal } = installedBindingFixtures();
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let signalFirstAudit!: () => void;
      const firstAtAudit = new Promise<void>((resolve) => {
        signalFirstAudit = resolve;
      });
      try {
        await new PostgresProjectRepository(observer, tenantId).save(
          Project.create({
            id: projectId,
            name: "Pack revision race",
            now: new Date("2026-10-02T00:00:00.000Z"),
          }),
        );
        await new PostgresProjectPackBindingRepository(
          observer,
          tenantId,
        ).replace(projectId, 0, [custom], new Date("2026-10-02T00:00:00.000Z"));
        const realAudit = new PostgresAuditEventRepository(
          firstClient,
          tenantId,
        );
        const first = bindingService(firstClient, catalog, {
          append: async (event) => {
            signalFirstAudit();
            await firstMayCommit;
            await realAudit.append(event);
          },
        }).apply({
          projectId,
          desired: [legal],
          expectedRevision: 1,
          actorId: "first-operator",
        });
        await Promise.race([
          firstAtAudit,
          first.then(() => {
            throw new Error("first apply completed before its audit barrier");
          }),
        ]);
        let secondSettled = false;
        const second = bindingService(secondClient, catalog)
          .apply({
            projectId,
            desired: [custom, legal],
            expectedRevision: 1,
            actorId: "second-operator",
          })
          .finally(() => {
            secondSettled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(secondSettled).toBe(false);
        releaseFirst();
        const [firstResult, secondResult] = await Promise.allSettled([
          first,
          second,
        ]);
        expect(firstResult).toMatchObject({ status: "fulfilled" });
        expect(secondResult).toMatchObject({
          status: "rejected",
          reason: expect.any(StaleProjectPackBindingError),
        });
        expect(
          await new PostgresProjectPackBindingRepository(
            observer,
            tenantId,
          ).get(projectId),
        ).toEqual({
          projectId,
          configurationRevision: 2,
          packs: [legal],
        });
        expect(
          await observer.query<{
            pack_id: string;
            pack_version: string;
            manifest_digest: string;
          }>(
            "SELECT pack_id, pack_version, manifest_digest FROM core.project_pack_binding_pack WHERE project_id = $1 ORDER BY pack_id",
            [projectId],
          ),
        ).toEqual([
          {
            pack_id: legal.id,
            pack_version: legal.version,
            manifest_digest: legal.manifestDigest,
          },
        ]);
        expect(
          await observer.query<{ count: string }>(
            "SELECT count(*) FROM core.audit_event WHERE project_id = $1 AND event_type = 'project.pack_binding_applied'",
            [projectId],
          ),
        ).toEqual([{ count: "1" }]);
      } finally {
        releaseFirst();
        await Promise.all([
          firstClient.close(),
          secondClient.close(),
          observer.close(),
        ]);
      }
    }, 15000);

    test("definition audit failure rolls back head, owned or override rows, and audit", async () => {
      const writer = new PostgresClient(connectionString!);
      const observer = new PostgresClient(connectionString!);
      const { catalog, legal } = installedBindingFixtures();
      try {
        for (const kind of ["owned", "override"] as const) {
          const projectId = `definition-audit-${randomUUID()}`;
          await new PostgresProjectRepository(observer, tenantId).save(
            Project.create({
              id: projectId,
              name: "Definition audit rollback",
              now: new Date("2026-10-03T00:00:00.000Z"),
            }),
          );
          if (kind === "override")
            await new PostgresProjectPackBindingRepository(
              observer,
              tenantId,
            ).replace(
              projectId,
              0,
              [legal],
              new Date("2026-10-03T00:00:00.000Z"),
            );
          const realAudit = new PostgresAuditEventRepository(writer, tenantId);
          const service = definitionService(writer, catalog, {
            append: async (event) => {
              expect(
                await new PostgresProjectDefinitionRepository(
                  writer,
                  tenantId,
                ).get(projectId),
              ).toMatchObject({ revision: 1 });
              expect(
                await new PostgresProjectDefinitionRepository(
                  observer,
                  tenantId,
                ).get(projectId),
              ).toMatchObject({ revision: 0, owned: [], overrides: [] });
              await realAudit.append(event);
              throw new Error("definition audit append failed after insert");
            },
          });
          const mutation =
            kind === "owned"
              ? {
                  action: "put_owned",
                  kind: "roles",
                  id: "custom",
                  enabled: true,
                  payload: { id: "custom" },
                }
              : {
                  action: "put_override",
                  source: { ...legal, kind: "roles", localId: "counsel" },
                  operation: "replace",
                  payload: { id: "counsel" },
                };
          await expect(
            service.apply({
              projectId,
              mutation,
              expectedRevision: 0,
              actorId: "operator",
            }),
          ).rejects.toThrow("definition audit append failed after insert");
          expect(
            await new PostgresProjectDefinitionRepository(
              observer,
              tenantId,
            ).get(projectId),
          ).toMatchObject({ revision: 0, owned: [], overrides: [] });
          expect(
            await observer.query<{ count: string }>(
              "SELECT count(*) FROM core.project_definition_head WHERE project_id = $1",
              [projectId],
            ),
          ).toEqual([{ count: "0" }]);
          expect(
            await observer.query<{ count: string }>(
              "SELECT count(*) FROM core.audit_event WHERE project_id = $1 AND event_type = 'project.definition_changed'",
              [projectId],
            ),
          ).toEqual([{ count: "0" }]);
        }
      } finally {
        await Promise.all([writer.close(), observer.close()]);
      }
    });

    test("concurrent same-entry definition updates fence one complete state and audit", async () => {
      const firstClient = new PostgresClient(connectionString!);
      const secondClient = new PostgresClient(connectionString!);
      const observer = new PostgresClient(connectionString!);
      const { catalog } = installedBindingFixtures();
      const projectId = `definition-race-${randomUUID()}`;
      let releaseFirst!: () => void;
      const firstMayCommit = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let signalFirstAudit!: () => void;
      const firstAtAudit = new Promise<void>((resolve) => {
        signalFirstAudit = resolve;
      });
      try {
        await new PostgresProjectRepository(observer, tenantId).save(
          Project.create({
            id: projectId,
            name: "Definition revision race",
            now: new Date("2026-10-03T00:00:00.000Z"),
          }),
        );
        const base = {
          action: "put_owned",
          kind: "roles",
          id: "custom",
          enabled: true,
          payload: { id: "custom", title: "Initial" },
        };
        await definitionService(observer, catalog).apply({
          projectId,
          mutation: base,
          expectedRevision: 0,
          actorId: "setup",
        });
        const realAudit = new PostgresAuditEventRepository(
          firstClient,
          tenantId,
        );
        const first = definitionService(firstClient, catalog, {
          append: async (event) => {
            signalFirstAudit();
            await firstMayCommit;
            await realAudit.append(event);
          },
        }).apply({
          projectId,
          mutation: {
            ...base,
            payload: { id: "custom", title: "First" },
            expectedEntryRevision: 1,
          },
          expectedRevision: 1,
          actorId: "first-operator",
        });
        await firstAtAudit;
        let secondSettled = false;
        const second = definitionService(secondClient, catalog)
          .apply({
            projectId,
            mutation: {
              ...base,
              payload: { id: "custom", title: "Second" },
              expectedEntryRevision: 1,
            },
            expectedRevision: 1,
            actorId: "second-operator",
          })
          .finally(() => {
            secondSettled = true;
          });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(secondSettled).toBe(false);
        releaseFirst();
        const [firstResult, secondResult] = await Promise.allSettled([
          first,
          second,
        ]);
        expect(firstResult).toMatchObject({ status: "fulfilled" });
        expect(secondResult).toMatchObject({
          status: "rejected",
          reason: expect.any(StaleProjectDefinitionError),
        });
        expect(
          await new PostgresProjectDefinitionRepository(observer, tenantId).get(
            projectId,
          ),
        ).toMatchObject({
          revision: 2,
          owned: [{ id: "custom", revision: 2, payload: { title: "First" } }],
          overrides: [],
        });
        expect(
          await observer.query<{ count: string }>(
            "SELECT count(*) FROM core.audit_event WHERE project_id = $1 AND event_type = 'project.definition_changed'",
            [projectId],
          ),
        ).toEqual([{ count: "2" }]);
      } finally {
        releaseFirst();
        await Promise.all([
          firstClient.close(),
          secondClient.close(),
          observer.close(),
        ]);
      }
    }, 15000);

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
          "20261003000100_project_definition_ownership.sql",
          "20261003000200_requirement_updated_event.sql",
          "20261005000100_project_role_omission.sql",
          "20261006000100_project_agent_disable.sql",
          "20261006000200_project_workflow_override.sql",
          "20261006000300_project_definition_payload_object.sql",
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
          "20261003000100_project_definition_ownership.sql",
          "20261003000200_requirement_updated_event.sql",
          "20261005000100_project_role_omission.sql",
          "20261006000100_project_agent_disable.sql",
          "20261006000200_project_workflow_override.sql",
          "20261006000300_project_definition_payload_object.sql",
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

const payloadMigration = "20261006000300_project_definition_payload_object.sql";

describe.skipIf(connectionString === undefined)(
  "PostgreSQL project definition payload objects",
  () => {
    const at = new Date("2026-10-06T00:00:00.000Z");
    const tenant = "payload-tenant";
    const project = "payload-project";
    const digest = `sha256:${"a".repeat(64)}`;
    const stages = [
      { id: "z-last", role: "paralegal" },
      { id: "a-first", role: "counsel" },
      { id: "m-middle", role: "auditor" },
    ];
    const ownedPayloads = [
      ["roles", "role", { id: "role", title: "Role", description: "Text" }],
      ["taskTypes", "matter", { id: "matter", title: "Matter" }],
      ["knowledge", "handbook", { id: "handbook" }],
      [
        "agents",
        "drafter",
        { id: "drafter", title: "Drafter", role: "role", prompts: ["b", "a"] },
      ],
      [
        "workflows",
        "intake",
        { id: "intake", title: "Intake", taskType: "matter", stages },
      ],
    ] as const;
    const overridePayloads = [
      ["roles", "counsel", "replace", { id: "counsel", title: "Counsel" }],
      ["roles", "clerk", "extend", { id: "clerk", description: "Ours é" }],
      [
        "agents",
        "filer",
        "replace",
        {
          id: "filer",
          title: "Filer",
          role: "counsel",
          prompts: ["brief", "cite"],
          knowledge: ["handbook", "statutes"],
          capabilities: ["draft", "file"],
        },
      ],
      [
        "workflows",
        "review",
        "replace",
        { id: "review", title: "Review", taskType: "matter", stages },
      ],
      ["workflows", "audit", "extend", { id: "audit", title: "Our audit" }],
    ] as const;

    interface StoredRow extends Record<string, unknown> {
      table_name: string;
      kind: string;
      local_id: string;
      json_type: string | null;
      payload_text: string | null;
      version: string;
    }
    const storedRows = (database: PostgresClient) =>
      database.query<StoredRow>(
        // xmin changes whenever a row is rewritten.
        `SELECT 'owned' AS table_name, kind, local_id,
                jsonb_typeof(payload_json) AS json_type,
                payload_json::text AS payload_text, xmin::text AS version
           FROM core.project_owned_definition
         UNION ALL
         SELECT 'override', kind, local_id, jsonb_typeof(payload_json),
                payload_json::text, xmin::text
           FROM core.project_definition_override
         ORDER BY 1, 2, 3`,
      );
    const schemaShape = async (database: PostgresClient) => ({
      constraints: await database.query<{ name: string; definition: string }>(
        `SELECT conrelid::regclass::text || '.' || conname AS name,
                pg_get_constraintdef(oid) AS definition
           FROM pg_constraint
          WHERE conrelid IN ('core.project_owned_definition'::regclass,
                             'core.project_definition_override'::regclass)
          ORDER BY 1`,
      ),
      columns: await database.query(
        `SELECT table_name, column_name, data_type, is_nullable
           FROM information_schema.columns
          WHERE table_schema = 'core'
            AND table_name IN ('project_owned_definition','project_definition_override')
          ORDER BY 1, ordinal_position`,
      ),
      policies: await database.query(
        `SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check
           FROM pg_policies
          WHERE schemaname = 'core'
            AND tablename IN ('project_owned_definition','project_definition_override')
          ORDER BY 1, 2`,
      ),
      rowSecurity: await database.query(
        `SELECT relname, relrowsecurity FROM pg_class
          WHERE oid IN ('core.project_owned_definition'::regclass,
                        'core.project_definition_override'::regclass)
          ORDER BY 1`,
      ),
    });

    /**
     * A database migrated up to, but not including, the payload migration,
     * with one project and its definition head.
     */
    async function withLegacyDatabase(
      work: (database: PostgresClient) => Promise<void>,
    ): Promise<void> {
      const databaseName = `ai_office_payload_${randomUUID().replaceAll("-", "")}`;
      const partialRoot = mkdtempSync(
        join(tmpdir(), "ai-office-postgres-payload-upgrade-"),
      );
      const partial = join(partialRoot, "migrations");
      mkdirSync(partial);
      for (const file of readdirSync(migrationDirectory).filter(
        (name) => name.endsWith(".sql") && name < payloadMigration,
      ))
        copyFileSync(join(migrationDirectory, file), join(partial, file));
      const admin = new PostgresClient(connectionString!);
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      await admin.close();
      const isolated = new URL(connectionString!);
      isolated.pathname = `/${databaseName}`;
      const database = new PostgresClient(isolated.toString());
      try {
        await migratePostgres(database, partial);
        await database.query(
          "INSERT INTO core.tenant(id,name,created_at,updated_at) VALUES ($1,'Tenant',$2,$2)",
          [tenant, at],
        );
        await database.query(
          "INSERT INTO core.project(id,tenant_id,name,created_at,updated_at) VALUES ($1,$2,'Project',$3,$3)",
          [project, tenant, at],
        );
        await database.query(
          "INSERT INTO core.project_definition_head(project_id,tenant_id,revision,changed_at) VALUES ($1,$2,1,$3)",
          [project, tenant, at],
        );
        await work(database);
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
    }

    // The statements and bindings of the repository before this change: a
    // JavaScript string bound to a jsonb parameter is stored by the driver as
    // a jsonb string scalar. Passing an object stores a jsonb object.
    const insertOwned = (
      database: PostgresClient,
      kind: string,
      localId: string,
      bound: unknown,
    ) =>
      database.query(
        `INSERT INTO core.project_owned_definition(project_id, tenant_id, kind, local_id, revision, enabled, payload_json, actor_id, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [project, tenant, kind, localId, 1, true, bound, "operator", at],
      );
    const insertOverride = (
      database: PostgresClient,
      kind: string,
      localId: string,
      operation: string,
      bound: unknown,
    ) =>
      database.query(
        `INSERT INTO core.project_definition_override(project_id, tenant_id, pack_id, pack_version, manifest_digest, kind, local_id, operation, revision, payload_json, actor_id, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
        [
          project,
          tenant,
          "org.example.legal",
          "1.0.0",
          digest,
          kind,
          localId,
          operation,
          1,
          bound,
          "operator",
          at,
        ],
      );

    test("converts every legacy string payload to the equal object and changes nothing else", async () => {
      await withLegacyDatabase(async (database) => {
        for (const [kind, localId, value] of ownedPayloads)
          await insertOwned(database, kind, localId, JSON.stringify(value));
        for (const [kind, localId, operation, value] of overridePayloads)
          await insertOverride(
            database,
            kind,
            localId,
            operation,
            JSON.stringify(value),
          );
        await insertOverride(database, "prompts", "greeting", "disable", null);
        // Rows that already hold an object must not be touched.
        await insertOwned(database, "prompts", "already", {
          id: "already",
          title: "Object",
        });
        await insertOverride(database, "taskTypes", "already", "extend", {
          id: "already",
          title: "Object",
        });

        const before = await storedRows(database);
        const shapeBefore = await schemaShape(database);
        expect(before).toHaveLength(13);
        expect(before.filter((row) => row.json_type === "string")).toHaveLength(
          ownedPayloads.length + overridePayloads.length,
        );
        expect(
          before
            .filter((row) => row.json_type === "object")
            .map((row) => [row.table_name, row.local_id]),
        ).toEqual([
          ["override", "already"],
          ["owned", "already"],
        ]);
        expect(
          before
            .filter((row) => row.json_type === null)
            .map((row) => [row.local_id, row.payload_text]),
        ).toEqual([["greeting", null]]);

        expect(await migratePostgres(database, migrationDirectory)).toEqual([
          payloadMigration,
        ]);

        const after = await storedRows(database);
        expect(
          after.map((row) => [row.table_name, row.kind, row.local_id]),
        ).toEqual(
          before.map((row) => [row.table_name, row.kind, row.local_id]),
        );
        for (const [index, row] of after.entries()) {
          const legacy = before[index]!;
          if (legacy.json_type === null) {
            expect(row).toEqual(legacy);
          } else if (legacy.json_type === "object") {
            // Not rewritten: same value, same row version.
            expect(row).toEqual(legacy);
          } else {
            expect(row.json_type).toBe("object");
            // The legacy value is a JSON string whose content is the JSON
            // text the old repository wrote.
            expect(JSON.parse(row.payload_text!)).toEqual(
              JSON.parse(JSON.parse(legacy.payload_text!) as string),
            );
          }
        }
        expect(
          await database.query(
            `SELECT local_id, array_agg(stage->>'id' ORDER BY position) AS stage_ids
               FROM (SELECT local_id, payload_json FROM core.project_owned_definition WHERE kind = 'workflows'
                     UNION ALL
                     SELECT local_id, payload_json FROM core.project_definition_override
                      WHERE kind = 'workflows' AND operation = 'replace') AS workflow,
                    jsonb_array_elements(payload_json->'stages') WITH ORDINALITY AS item(stage, position)
              GROUP BY local_id ORDER BY local_id`,
          ),
        ).toEqual([
          { local_id: "intake", stage_ids: ["z-last", "a-first", "m-middle"] },
          { local_id: "review", stage_ids: ["z-last", "a-first", "m-middle"] },
        ]);
        expect(
          await database.query(
            "SELECT payload_json->>'title' AS title, payload_json->'prompts' AS prompts FROM core.project_definition_override WHERE local_id = 'filer'",
          ),
        ).toEqual([{ title: "Filer", prompts: ["brief", "cite"] }]);

        // Only the two object checks are added; every earlier constraint,
        // column, policy and the row security flag is as it was.
        const shapeAfter = await schemaShape(database);
        const added = [
          {
            name: "core.project_definition_override.project_definition_override_payload_json_check",
            definition:
              "CHECK (((payload_json IS NULL) OR (jsonb_typeof(payload_json) = 'object'::text)))",
          },
          {
            name: "core.project_owned_definition.project_owned_definition_payload_json_check",
            definition: "CHECK ((jsonb_typeof(payload_json) = 'object'::text))",
          },
        ];
        expect(shapeAfter.constraints).toEqual(
          [...shapeBefore.constraints, ...added].sort((left, right) =>
            left.name < right.name ? -1 : 1,
          ),
        );
        expect({ ...shapeAfter, constraints: [] }).toEqual({
          ...shapeBefore,
          constraints: [],
        });
        expect(shapeAfter.rowSecurity).toEqual([
          { relname: "project_definition_override", relrowsecurity: true },
          { relname: "project_owned_definition", relrowsecurity: true },
        ]);

        // The repository returns what the old repository returned for the
        // same rows: the parsed payloads.
        const state = await new PostgresProjectDefinitionRepository(
          database,
          tenant,
        ).get(project);
        expect(state.revision).toBe(1);
        expect(
          Object.fromEntries(
            state.owned.map((item) => [
              `${item.kind}/${item.id}`,
              item.payload,
            ]),
          ),
        ).toEqual({
          ...Object.fromEntries(
            ownedPayloads.map(([kind, id, value]) => [`${kind}/${id}`, value]),
          ),
          "prompts/already": { id: "already", title: "Object" },
        });
        expect(
          Object.fromEntries(
            state.overrides.map((item) => [
              `${item.source.kind}/${item.source.localId}/${item.operation}`,
              "payload" in item ? item.payload : "absent",
            ]),
          ),
        ).toEqual({
          ...Object.fromEntries(
            overridePayloads.map(([kind, id, operation, value]) => [
              `${kind}/${id}/${operation}`,
              value,
            ]),
          ),
          "prompts/greeting/disable": "absent",
          "taskTypes/already/extend": { id: "already", title: "Object" },
        });

        // Tracked, so the runner does not apply it again; and applying the
        // file again by hand rewrites no row and changes no constraint.
        expect(await migratePostgres(database, migrationDirectory)).toEqual([]);
        await database.query(
          readFileSync(join(migrationDirectory, payloadMigration), "utf8"),
        );
        expect(await storedRows(database)).toEqual(after);
        expect(await schemaShape(database)).toEqual(shapeAfter);
      });
    });

    test.each([
      ["text that is not JSON", "not json: private-marker", "not JSON text"],
      [
        "JSON text of an array",
        JSON.stringify([{ id: "private-marker" }]),
        "JSON array, not a JSON object",
      ],
      ["JSON text of null", "null", "JSON null, not a JSON object"],
      [
        "JSON text with an escaped U+0000",
        JSON.stringify({ id: "nul", title: "private-marker a\u0000b" }),
        "JSON text holding an escaped U+0000, which jsonb cannot store",
      ],
      ["a jsonb number", 7, "jsonb number, not a JSON object"],
    ] as const)(
      "fails closed on %s and converts nothing",
      async (_name, bound, reason) => {
        await withLegacyDatabase(async (database) => {
          await insertOwned(
            database,
            "roles",
            "good",
            JSON.stringify({ id: "good", title: "Good" }),
          );
          await insertOverride(
            database,
            "roles",
            "good",
            "extend",
            JSON.stringify({ id: "good", title: "Good" }),
          );
          await insertOverride(database, "prompts", "off", "disable", null);
          await insertOwned(database, "knowledge", "bad-owned", bound);
          await insertOverride(
            database,
            "agents",
            "bad-override",
            "replace",
            bound,
          );
          const before = await storedRows(database);
          const shapeBefore = await schemaShape(database);

          const error: unknown = await migratePostgres(
            database,
            migrationDirectory,
          ).then(
            () => null,
            (failure: unknown) => failure,
          );
          expect(error).toMatchObject({
            code: "22000",
            message:
              "cannot convert 2 project definition payload(s) to jsonb objects",
          });
          const detail = (error as { detail: string }).detail;
          expect(detail).toContain(
            `core.project_owned_definition (project_id=${project}, kind=knowledge, local_id=bad-owned): ${reason}`,
          );
          expect(detail).toContain(
            `core.project_definition_override (project_id=${project}, pack=org.example.legal@1.0.0, manifest_digest=${digest}, kind=agents, local_id=bad-override): ${reason}`,
          );
          // The report names rows, never payload content.
          expect(JSON.stringify(error)).not.toContain("private-marker");
          expect(String((error as Error).message)).not.toContain(
            "private-marker",
          );
          expect((error as { hint: string }).hint).toContain(
            "supabase/README.md",
          );

          // Nothing is half-converted, tracked or constrained.
          expect(await storedRows(database)).toEqual(before);
          expect(await schemaShape(database)).toEqual(shapeBefore);
          expect(
            await database.query(
              "SELECT count(*)::integer AS count FROM core.schema_migration WHERE version = $1",
              [payloadMigration],
            ),
          ).toEqual([{ count: 0 }]);

          // The operator repairs the named rows; the migration then applies.
          await database.query(
            "DELETE FROM core.project_owned_definition WHERE local_id = 'bad-owned'",
          );
          await database.query(
            "UPDATE core.project_definition_override SET payload_json = $1::jsonb WHERE local_id = 'bad-override'",
            [{ id: "bad-override", title: "Repaired" }],
          );
          expect(await migratePostgres(database, migrationDirectory)).toEqual([
            payloadMigration,
          ]);
          expect(
            (await storedRows(database)).map((row) => [
              row.table_name,
              row.local_id,
              row.json_type,
            ]),
          ).toEqual([
            ["override", "bad-override", "object"],
            ["override", "off", null],
            ["override", "good", "object"],
            ["owned", "good", "object"],
          ]);
        });
      },
    );

    describe("after the migration", () => {
      let database: PostgresClient;
      const scopedTenant = tenantId;

      beforeAll(async () => {
        database = new PostgresClient(connectionString!);
        await migratePostgres(database, migrationDirectory);
        await database.query(
          "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING",
          [scopedTenant, "Contract Tenant", at],
        );
      });
      afterAll(async () => {
        await database.close();
      });

      const seed = async () => {
        const projectId = `payload-object-${randomUUID()}`;
        await new PostgresProjectRepository(database, scopedTenant).save(
          Project.create({
            id: projectId,
            name: "Payload object",
            now: at,
          }),
        );
        const repository = new PostgresProjectDefinitionRepository(
          database,
          scopedTenant,
        );
        const kept = await repository.replace(
          {
            projectId,
            revision: 0,
            owned: [
              {
                origin: "project_owned",
                kind: "roles",
                id: "kept",
                revision: 1,
                enabled: true,
                payload: { id: "kept", title: "Kept" },
                actorId: "operator",
                changedAt: at.toISOString(),
              },
            ],
            overrides: [],
          },
          0,
          at,
        );
        return { projectId, repository, kept };
      };

      test("a payload holding U+0000 written straight through the repository is refused whole", async () => {
        const { projectId, repository, kept } = await seed();
        const error: unknown = await repository
          .replace(
            {
              ...kept,
              owned: [
                ...kept.owned,
                {
                  ...kept.owned[0]!,
                  id: "nul",
                  payload: { id: "nul", title: "a\u0000b" },
                },
              ],
            },
            1,
            at,
          )
          .then(
            () => null,
            (failure: unknown) => failure,
          );
        // PostgreSQL refuses the value; jsonb cannot hold U+0000. The
        // application's project text rule (GP-07) rejects such text before
        // any repository is reached, so this is a storage backstop only.
        expect(error).toMatchObject({ code: "22P05" });
        // The replacement is one transaction: the earlier state is intact.
        expect(await repository.get(projectId)).toEqual(kept);
      });

      test("a writer that binds JSON text instead of an object is refused by the schema", async () => {
        const { projectId, repository, kept } = await seed();
        await expect(
          database.query(
            `INSERT INTO core.project_owned_definition(project_id, tenant_id, kind, local_id, revision, enabled, payload_json, actor_id, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
            [
              projectId,
              scopedTenant,
              "roles",
              "legacy",
              1,
              true,
              JSON.stringify({ id: "legacy" }),
              "operator",
              at,
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint_name: "project_owned_definition_payload_json_check",
        });
        await expect(
          database.query(
            `INSERT INTO core.project_definition_override(project_id, tenant_id, pack_id, pack_version, manifest_digest, kind, local_id, operation, revision, payload_json, actor_id, changed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
            [
              projectId,
              scopedTenant,
              "org.example.legal",
              "1.0.0",
              digest,
              "roles",
              "legacy",
              "extend",
              1,
              JSON.stringify({ id: "legacy" }),
              "operator",
              at,
            ],
          ),
        ).rejects.toMatchObject({
          code: "23514",
          constraint_name: "project_definition_override_payload_json_check",
        });
        expect(await repository.get(projectId)).toEqual(kept);
      });
    });
  },
);
