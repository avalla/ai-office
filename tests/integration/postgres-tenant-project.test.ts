import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import {
  PostgresTenantContextError,
  PostgresTenantScopeError,
} from "@ai-office/storage-postgres/database/postgres-tenant-context.ts";
import {
  PostgresProjectRepository,
  PostgresProjectTenantConflictError,
} from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";

const connectionString = process.env.AI_OFFICE_TEST_POSTGRES_URL;
const migrationDirectory = join(process.cwd(), "supabase", "migrations");
const tenantA = "tenant-project-test-a";
const tenantB = "tenant-project-test-b";
const now = new Date("2026-09-19T00:00:00.000Z");

describe.skipIf(connectionString === undefined)(
  "PostgreSQL tenant-bound project authority",
  () => {
    let database: PostgresClient;

    beforeAll(async () => {
      database = new PostgresClient(connectionString!);
      await migratePostgres(database, migrationDirectory);
      await database.query(
        "INSERT INTO core.tenant(id, name, created_at, updated_at) VALUES ($1, $2, $3, $3), ($4, $5, $3, $3) ON CONFLICT DO NOTHING",
        [tenantA, "Tenant A", now, tenantB, "Tenant B"],
      );
    });

    afterAll(async () => {
      await database.close();
    });

    test("requires explicit non-empty tenant composition context", () => {
      expect(
        () => new PostgresProjectRepository(database, ""),
      ).toThrow(PostgresTenantContextError);
      expect(
        () => new PostgresProjectRepository(database, " tenant-a"),
      ).toThrow(PostgresTenantContextError);
    });

    test("provisions atomically with tenant ownership and hides it from another tenant", async () => {
      const projectId = `tenant-project-${randomUUID()}`;
      const project = Project.create({ id: projectId, name: "Tenant A", now });
      const tenantAProjects = new PostgresProjectRepository(database, tenantA);
      const tenantBProjects = new PostgresProjectRepository(database, tenantB);

      await tenantAProjects.save(project);
      expect(await tenantAProjects.findById(projectId)).not.toBeNull();
      expect(await tenantBProjects.findById(projectId)).toBeNull();

      await expect(
        tenantBProjects.save(
          Project.restore({
            ...project.snapshot(),
            name: "Adopted by B",
            updatedAt: new Date(now.getTime() + 1_000),
          }),
        ),
      ).rejects.toBeInstanceOf(PostgresProjectTenantConflictError);

      const [row] = await database.query<{ tenant_id: string }>(
        "SELECT tenant_id FROM core.project WHERE id = $1",
        [projectId],
      );
      expect(row?.tenant_id).toBe(tenantA);
      expect(
        await database.query(
          "SELECT id FROM core.project WHERE id = $1 AND tenant_id IS NULL",
          [projectId],
        ),
      ).toEqual([]);
    });

    test("repeated same-tenant provisioning is idempotent and concurrent", async () => {
      const projectId = `tenant-repeat-${randomUUID()}`;
      const project = Project.create({ id: projectId, name: "Repeat", now });
      const repository = new PostgresProjectRepository(database, tenantA);

      await expect(Promise.all([repository.save(project), repository.save(project)])).resolves.toEqual([
        undefined,
        undefined,
      ]);
      expect(
        await database.query(
          "SELECT id, tenant_id FROM core.project WHERE id = $1",
          [projectId],
        ),
      ).toEqual([{ id: projectId, tenant_id: tenantA }]);
    });

    test("tenant-bound project-owned repositories reject cross-tenant attachment", async () => {
      const projectA = Project.create({
        id: `tenant-owned-a-${randomUUID()}`,
        name: "A",
        now,
      });
      const projectB = Project.create({
        id: `tenant-owned-b-${randomUUID()}`,
        name: "B",
        now,
      });
      await new PostgresProjectRepository(database, tenantA).save(projectA);
      await new PostgresProjectRepository(database, tenantB).save(projectB);

      await expect(
        new PostgresTaskRepository(database, tenantB).save(
          Task.create({
            id: `tenant-task-${randomUUID()}`,
            projectId: projectA.snapshot().id,
            title: "Foreign task",
            now,
          }),
        ),
      ).rejects.toBeInstanceOf(PostgresTenantScopeError);
      expect(
        await new PostgresTaskRepository(database, tenantB).listByProject(
          projectA.snapshot().id,
        ),
      ).toEqual([]);
    });
  },
);
