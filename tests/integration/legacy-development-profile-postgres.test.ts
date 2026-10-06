import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { ApplyOfficeManifest } from "@ai-office/application/commands/apply-office-manifest.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { SyncAgentDefinitions } from "@ai-office/application/commands/sync-agent-definitions.ts";
import {
  canonicalLegacyDevelopmentProfile,
  type LegacyDevelopmentProfile,
} from "@ai-office/application/domain-pack/legacy-development-profile.ts";
import { ReadLegacyDevelopmentProfile } from "@ai-office/application/domain-pack/read-legacy-development-profile.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import type { AgentRuntimeRepository } from "@ai-office/application/ports/agent-runtime-repository.port.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type { OfficeManifestRepository } from "@ai-office/application/ports/office-manifest-repository.port.ts";
import type { ProjectPackBindingRepository } from "@ai-office/application/ports/project-pack-binding-repository.port.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresAgentRuntimeRepository } from "@ai-office/storage-postgres/repositories/postgres-agent-runtime.repository.ts";
import { PostgresAuditEventRepository } from "@ai-office/storage-postgres/repositories/postgres-audit-event.repository.ts";
import { PostgresOfficeManifestRepository } from "@ai-office/storage-postgres/repositories/postgres-office-manifest.repository.ts";
import { PostgresProjectPackBindingRepository } from "@ai-office/storage-postgres/repositories/postgres-project-pack-binding.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqliteProjectPackBindingRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-pack-binding.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import {
  parseDomainPackId,
  parseDomainPackVersion,
  parseManifestDigest,
} from "../../packages/domain-pack-contracts/src/index.ts";
import {
  legacyAgentDefinitions,
  legacyExpectedProfile,
  legacyOfficeManifest,
  legacyRolesWithoutAgent,
  projectMigrations,
} from "../helpers/legacy-development-fixture.ts";

// GP-09 on both backends: the committed legacy office is written through the
// same application services and read back through the same reader. The
// profile and its digest must not depend on the store or on the project ID.

const fixtureDigest =
  "sha256:96ad6eab62fd50dd9290df6c3c2f471604b9290cc7fb5ee2e4c13ba3c9002efa";
const now = new Date("2026-09-01T00:00:00.000Z");
const clock = { now: () => new Date(now) };
const ids = { generate: () => randomUUID() };

interface Backend {
  projects: ProjectRepository;
  officeManifests: OfficeManifestRepository;
  runtime: AgentRuntimeRepository;
  bindings: ProjectPackBindingRepository;
  auditEvents: AuditEventRepository;
  transactions: TransactionRunner;
}

/** Project, office revision 1, synced agents, and a role no agent uses. */
async function seed(backend: Backend, projectId: string): Promise<void> {
  await backend.projects.save(
    Project.create({ id: projectId, name: "Legacy office", now }),
  );
  await new ApplyOfficeManifest(
    backend.projects,
    backend.officeManifests,
    new RecordAuditEvent(backend.auditEvents, ids, clock),
    ids,
    clock,
    backend.transactions,
  ).execute(projectId, legacyOfficeManifest());
  await new SyncAgentDefinitions(
    backend.projects,
    backend.runtime,
    ids,
    clock,
    backend.transactions,
  ).execute(projectId, legacyAgentDefinitions());
  for (const item of legacyRolesWithoutAgent())
    await backend.runtime.saveRole(
      Role.create({
        id: `role:${projectId}:${item.definition.roleKey}`,
        projectId,
        key: item.definition.roleKey,
        name: item.definition.role,
        version: item.definition.version,
        capabilities: item.definition.capabilities,
        tools: item.definition.tools,
        modelPolicy: item.definition.modelPolicy,
        limits: item.definition.limits,
        sourcePath: item.sourcePath,
        guidanceText: item.definition.roleGuidance,
        guidanceVersion: item.definition.version,
        now,
      }),
    );
}

function read(
  backend: Backend,
  projectId: string,
): Promise<LegacyDevelopmentProfile> {
  return new ReadLegacyDevelopmentProfile({
    projects: backend.projects,
    officeManifests: backend.officeManifests,
    runtime: backend.runtime,
    bindings: backend.bindings,
    transactions: backend.transactions,
  }).read(projectId);
}

const roots: string[] = [];
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function sqliteBackend(): Backend {
  const root = mkdtempSync(join(tmpdir(), "ai-office-gp09-parity-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  closers.push(() => database.close());
  migrate(database, projectMigrations);
  return {
    projects: new SqliteProjectRepository(database),
    officeManifests: new SqliteOfficeManifestRepository(database),
    runtime: new SqliteAgentRuntimeRepository(database),
    bindings: new SqliteProjectPackBindingRepository(database),
    auditEvents: new SqliteAuditEventRepository(database),
    transactions: new SqliteTransactionRunner(database),
  };
}

const expectedProfile = () => legacyExpectedProfile("expected-profile.json");

test("SQLite: the committed legacy office reads back as the pinned profile", async () => {
  const backend = sqliteBackend();
  await seed(backend, "sqlite-legacy-project");
  const profile = await read(backend, "sqlite-legacy-project");
  expect(profile.profileDigest).toBe(fixtureDigest);
  expect(JSON.parse(JSON.stringify(profile))).toEqual(expectedProfile());
});

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;

describe.skipIf(connectionString === undefined)(
  "GP-09 legacy development profile on PostgreSQL",
  () => {
    const tenantId = "gp09-tenant";
    let database: PostgresClient;
    let backend: Backend;

    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(
        database,
        join(process.cwd(), "supabase", "migrations"),
      );
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING",
        [tenantId, "GP-09 Tenant", now],
      );
      backend = {
        projects: new PostgresProjectRepository(database, tenantId),
        officeManifests: new PostgresOfficeManifestRepository(
          database,
          tenantId,
        ),
        runtime: new PostgresAgentRuntimeRepository(database, tenantId),
        bindings: new PostgresProjectPackBindingRepository(database, tenantId),
        auditEvents: new PostgresAuditEventRepository(database, tenantId),
        transactions: new PostgresTransactionRunner(database),
      };
    });

    afterAll(async () => {
      await database.close();
    });

    const stored = async (projectId: string) =>
      JSON.stringify(
        await Promise.all(
          [
            "SELECT * FROM core.office_manifest_revision WHERE project_id = $1 ORDER BY id",
            "SELECT * FROM core.role WHERE project_id = $1 ORDER BY id",
            "SELECT * FROM core.agent WHERE project_id = $1 ORDER BY id",
            "SELECT * FROM core.audit_event WHERE project_id = $1 ORDER BY id",
            "SELECT * FROM core.project_pack_binding WHERE project_id = $1",
            "SELECT * FROM core.project_pack_binding_pack WHERE project_id = $1 ORDER BY pack_id",
            "SELECT * FROM core.project WHERE id = $1",
          ].map((sql) => database.query(sql, [projectId])),
        ),
        (_key, value: unknown) =>
          typeof value === "bigint" ? value.toString() : value,
      );

    test("the same legacy state gives the same normalized profile and digest as SQLite", async () => {
      const projectId = randomUUID();
      await seed(backend, projectId);
      const sqlite = sqliteBackend();
      await seed(sqlite, "sqlite-legacy-project");

      const before = await stored(projectId);
      const onPostgres = await read(backend, projectId);
      const onSqlite = await read(sqlite, "sqlite-legacy-project");
      expect(canonicalLegacyDevelopmentProfile(onPostgres)).toBe(
        canonicalLegacyDevelopmentProfile(onSqlite),
      );
      expect(JSON.stringify(onPostgres)).toBe(JSON.stringify(onSqlite));
      expect(onPostgres.profileDigest).toBe(fixtureDigest);
      expect(JSON.parse(JSON.stringify(onPostgres))).toEqual(expectedProfile());
      // The role no agent uses is read on PostgreSQL too.
      expect(onPostgres.runtimeOnly.roles.map((role) => role.key)).toEqual([
        "release-engineer",
        "security-reviewer",
      ]);
      expect(JSON.stringify(onPostgres)).not.toContain(projectId);
      // Read-only on PostgreSQL: the project's rows are the same afterwards.
      expect(await stored(projectId)).toBe(before);
      expect(before).toContain("office.manifest.applied");
    });

    test("a pack binding and a changed agent behave as on SQLite", async () => {
      const projectId = randomUUID();
      await seed(backend, projectId);
      const sqlite = sqliteBackend();
      await seed(sqlite, "sqlite-legacy-project");
      const pack = {
        id: parseDomainPackId("org.example.custom"),
        version: parseDomainPackVersion("1.0.0"),
        manifestDigest: parseManifestDigest(`sha256:${"a".repeat(64)}`),
      };
      for (const [store, id] of [
        [backend, projectId],
        [sqlite, "sqlite-legacy-project"],
      ] as const) {
        await store.bindings.replace(id, 0, [pack], now);
        const qa = (await store.runtime.listAgents(id)).find(
          (agent) => agent.name === "qa",
        )!;
        await store.runtime.saveAgent({ ...qa, enabled: false });
      }
      const onPostgres = await read(backend, projectId);
      const onSqlite = await read(sqlite, "sqlite-legacy-project");
      expect(canonicalLegacyDevelopmentProfile(onPostgres)).toBe(
        canonicalLegacyDevelopmentProfile(onSqlite),
      );
      expect(onPostgres.metadata.packBinding).toEqual({ present: true });
      expect(onPostgres.profileDigest).not.toBe(fixtureDigest);
      expect(
        onPostgres.pipelines
          .find((pipeline) => pipeline.id === "delivery")!
          .stages.map((stage) => stage.eligibleAgents),
      ).toEqual([["architect"], ["developer"], ["reviewer"], []]);
    });

    test("an unknown project is not found and a project without an office is the empty view", async () => {
      await expect(read(backend, randomUUID())).rejects.toBeInstanceOf(
        ProjectNotFoundError,
      );
      const projectId = randomUUID();
      await backend.projects.save(
        Project.create({ id: projectId, name: "No office", now }),
      );
      expect(await read(backend, projectId)).toMatchObject({
        profileDigest:
          "sha256:5f040cf62cdf54e2cacf480c04166469a56f75c473b5d6623da8b7a716c114ab",
        office: null,
        roles: [],
        runtimeOnly: { roles: [], agents: [] },
      });
    });

    test("another tenant cannot read the project's legacy state", async () => {
      const projectId = randomUUID();
      await seed(backend, projectId);
      const otherTenant = "gp09-other-tenant";
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3) ON CONFLICT DO NOTHING",
        [otherTenant, "GP-09 Other Tenant", now],
      );
      await expect(
        read(
          {
            ...backend,
            projects: new PostgresProjectRepository(database, otherTenant),
            officeManifests: new PostgresOfficeManifestRepository(
              database,
              otherTenant,
            ),
            runtime: new PostgresAgentRuntimeRepository(database, otherTenant),
            bindings: new PostgresProjectPackBindingRepository(
              database,
              otherTenant,
            ),
          },
          projectId,
        ),
      ).rejects.toBeInstanceOf(ProjectNotFoundError);
      expect(
        await new PostgresAgentRuntimeRepository(
          database,
          otherTenant,
        ).listRoles(projectId),
      ).toEqual([]);
    });
  },
);
