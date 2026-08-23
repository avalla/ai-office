import { afterEach, describe, expect, test } from "vitest";
import type { Database } from "bun:sqlite";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ManageGlobalMemory } from "@ai-office/application/memory/manage-global-memory.ts";
import {
  GlobalMemoryDeprecatedError,
  GlobalMemoryVersionConflictError,
} from "@ai-office/application/memory-errors.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { migrateGlobal } from "@ai-office/storage-sqlite/database/migrate-global.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteGlobalMemoryRepository } from "@ai-office/storage-sqlite/repositories/sqlite-global-memory.repository.ts";
import { SqliteMemoryReferenceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-memory-reference.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";

const roots: string[] = [];
const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const globalMigrations = join(repositoryRoot, "migrations", "global");
const projectMigrations = join(repositoryRoot, "migrations", "project");

class SequenceIds implements IdGenerator {
  private next = 0;
  generate(): string {
    this.next += 1;
    return `memory-${this.next}`;
  }
}

class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-08-23T09:00:00.000Z");
  }
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-global-memory-"));
  roots.push(root);
  const globalDatabase = openDatabase(join(root, "global.sqlite"));
  const projectDatabase = openDatabase(join(root, "project.sqlite"));
  migrateGlobal(globalDatabase, globalMigrations);
  migrate(projectDatabase, projectMigrations);
  const projects = new SqliteProjectRepository(projectDatabase);
  const tasks = new SqliteTaskRepository(projectDatabase);
  const memory = new SqliteGlobalMemoryRepository(globalDatabase);
  const references = new SqliteMemoryReferenceRepository(projectDatabase);
  const service = new ManageGlobalMemory(
    memory,
    references,
    projects,
    tasks,
    new SequenceIds(),
    new FixedClock(),
  );
  return {
    globalDatabase,
    projectDatabase,
    projects,
    tasks,
    memory,
    references,
    service,
  };
}

const roleDefinition = {
  key: "reviewer",
  description: "Independent review",
  responsibilities: ["review"],
  capabilities: ["repository.read"],
  tools: ["git"],
  modelPolicy: "balanced",
  limits: {
    maxIterations: 5,
    maxCostMicros: "1000000",
    timeoutSeconds: 300,
  },
} as const;

function partialMigrations(
  root: string,
  name: string,
  files: readonly string[],
): string {
  const directory = join(root, name);
  mkdirSync(directory);
  for (const file of files)
    copyFileSync(join(globalMigrations, file), join(directory, file));
  return directory;
}

function insertLegacyRole(database: Database, id: string, version = 1): void {
  database
    .prepare(
      `INSERT INTO global_role(
        id, name, version, definition_json, status, created_at, updated_at
      ) VALUES (?, 'Reviewer', ?, ?, 'active', ?, ?)`,
    )
    .run(
      id,
      version,
      JSON.stringify(roleDefinition),
      "2026-08-23T09:00:00.000Z",
      "2026-08-23T09:00:00.000Z",
    );
}

describe("global memory storage", () => {
  test("migrates fresh databases with the versioned role key and indexes", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-global-fresh-"));
    roots.push(root);
    const database = openDatabase(join(root, "global.sqlite"));

    expect(migrateGlobal(database, globalMigrations).applied).toEqual([
      "0001_initial.sql",
      "0002_memory_integrity.sql",
      "0003_versioned_global_roles.sql",
    ]);
    expect(migrateGlobal(database, globalMigrations).applied).toEqual([]);
    expect(
      database
        .query<{ name: string; pk: number }, []>(
          "PRAGMA table_info(global_role)",
        )
        .all()
        .filter((column) => column.pk > 0)
        .map((column) => [column.name, column.pk]),
    ).toEqual([
      ["id", 1],
      ["version", 2],
    ]);
    expect(
      database
        .query<{ name: string }, []>("PRAGMA index_list(global_role)")
        .all()
        .map((index) => index.name),
    ).toEqual(
      expect.arrayContaining([
        "global_role_key_version_unique",
        "global_role_latest_key_idx",
        "global_role_status_name_idx",
      ]),
    );
    expect(() => insertLegacyRole(database, "invalid-role", 0)).toThrow(
      "CHECK constraint failed",
    );
    database.close();
  });

  test("upgrades 0001 and preserves an existing role", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-global-upgrade-"));
    roots.push(root);
    const partial = partialMigrations(root, "from-0001", ["0001_initial.sql"]);
    const database = openDatabase(join(root, "global.sqlite"));
    expect(migrateGlobal(database, partial).applied).toEqual([
      "0001_initial.sql",
    ]);
    insertLegacyRole(database, "role-from-0001");

    expect(migrateGlobal(database, globalMigrations).applied).toEqual([
      "0002_memory_integrity.sql",
      "0003_versioned_global_roles.sql",
    ]);
    expect(
      (
        await new SqliteGlobalMemoryRepository(database).findRole(
          "role-from-0001",
          1,
        )
      )?.snapshot().definition.key,
    ).toBe("reviewer");
    expect(migrateGlobal(database, globalMigrations).applied).toEqual([]);
    database.close();
  });

  test("upgrades 0002, preserves data, and enforces logical role identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-global-upgrade-"));
    roots.push(root);
    const partial = partialMigrations(root, "from-0002", [
      "0001_initial.sql",
      "0002_memory_integrity.sql",
    ]);
    const database = openDatabase(join(root, "global.sqlite"));
    expect(migrateGlobal(database, partial).applied).toEqual([
      "0001_initial.sql",
      "0002_memory_integrity.sql",
    ]);
    insertLegacyRole(database, "role-from-0002", 2);

    expect(migrateGlobal(database, globalMigrations).applied).toEqual([
      "0003_versioned_global_roles.sql",
    ]);
    const repository = new SqliteGlobalMemoryRepository(database);
    expect(
      (await repository.findRole("role-from-0002", 2))?.snapshot().name,
    ).toBe("Reviewer");
    expect(() =>
      database
        .prepare(
          `INSERT INTO global_role(
            id, name, version, definition_json, status, created_at, updated_at
          ) SELECT 'different-id', name, 2, definition_json, status,
              created_at, updated_at
            FROM global_role WHERE id = 'role-from-0002' AND version = 2`,
        )
        .run(),
    ).toThrow("global role key cannot change logical id");
    expect(() =>
      database
        .prepare(
          `INSERT INTO global_role(
            id, name, version, definition_json, status, created_at, updated_at
          ) SELECT id, name, 2,
              json_set(definition_json, '$.key', 'different-key'), status,
              created_at, updated_at
            FROM global_role WHERE id = 'role-from-0002' AND version = 2`,
        )
        .run(),
    ).toThrow("global role id cannot change logical key");
    database
      .prepare(
        `INSERT INTO global_role(
          id, name, version, definition_json, status, created_at, updated_at
        ) SELECT id, name, 4, definition_json, status, created_at, updated_at
          FROM global_role WHERE id = 'role-from-0002' AND version = 2`,
      )
      .run();
    expect(() =>
      database
        .prepare(
          `INSERT INTO global_role(
            id, name, version, definition_json, status, created_at, updated_at
          ) SELECT id, name, 3, definition_json, status, created_at, updated_at
            FROM global_role WHERE id = 'role-from-0002' AND version = 2`,
        )
        .run(),
    ).toThrow("global role version must be newer than history");
    expect(() =>
      database
        .prepare(
          `UPDATE global_role SET name = 'Mutable history'
           WHERE id = 'role-from-0002' AND version = 2`,
        )
        .run(),
    ).toThrow("global role revisions are immutable");
    expect(() =>
      database
        .prepare(
          "DELETE FROM global_role WHERE id = 'role-from-0002' AND version = 2",
        )
        .run(),
    ).toThrow("global role revisions cannot be deleted");
    database.close();
  });

  test("versions roles and searches, adopts, and deprecates patterns", async () => {
    const { globalDatabase, projectDatabase, projects, memory, service } =
      setup();
    const now = new Date("2026-08-23T09:00:00.000Z");
    await projects.save(Project.create({ id: "project", name: "Demo", now }));

    const roleInput = {
      name: "Reviewer",
      definition: roleDefinition,
    } as const;
    const roleId = await service.createRole({ ...roleInput, version: 1 });
    const roleV2Input = {
      ...roleInput,
      definition: {
        ...roleDefinition,
        key: " reviewer ",
        description: "Independent review with security checks",
      },
    } as const;
    expect(await service.createRole({ ...roleV2Input, version: 2 })).toBe(
      roleId,
    );
    await expect(
      service.createRole({ ...roleV2Input, version: 2 }),
    ).rejects.toBeInstanceOf(GlobalMemoryVersionConflictError);
    await expect(
      service.createRole({ ...roleInput, version: 1 }),
    ).rejects.toBeInstanceOf(GlobalMemoryVersionConflictError);
    expect((await service.getRole(roleId, 1)).snapshot()).toMatchObject({
      version: 1,
      definition: { description: "Independent review" },
    });
    expect((await service.getRole(roleId, 2)).snapshot()).toMatchObject({
      version: 2,
      definition: {
        key: "reviewer",
        description: "Independent review with security checks",
      },
    });
    expect((await service.getLatestRole(roleId)).snapshot().version).toBe(2);
    expect(
      (await memory.findLatestRoleByKey("reviewer"))?.snapshot().version,
    ).toBe(2);
    expect(
      globalDatabase
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM global_role WHERE id = ?",
        )
        .get(roleId)?.count,
    ).toBe(2);

    await service.deprecate({ type: "role", id: roleId, version: 1 });
    expect((await service.getRole(roleId, 1)).snapshot().status).toBe(
      "deprecated",
    );
    expect((await service.getRole(roleId, 2)).snapshot().status).toBe("active");

    const patternId = await service.createPattern({
      id: "short-transactions",
      name: "Short transactions",
      version: 1,
      problem: "External calls inside transactions",
      context: "SQLite services",
      solution: "Persist intent before external work",
      applicability: ["sqlite"],
      sourceProjectId: "project",
    });
    expect(
      (await service.search({ query: "transactions", limit: 10 }))[0],
    ).toMatchObject({
      type: "pattern",
      id: patternId,
      version: 1,
    });

    const referenceId = await service.adoptPattern({
      projectId: "project",
      patternId,
      version: 1,
      query: "transactions",
    });
    expect(
      await service.adoptPattern({
        projectId: "project",
        patternId,
        version: 1,
      }),
    ).toBe(referenceId);
    expect(
      (await service.listReferences("project"))[0]?.snapshot(),
    ).toMatchObject({
      id: referenceId,
      usageCount: 2,
      query: "transactions",
    });
    expect(
      await service.adoptPattern({
        projectId: "project",
        patternId,
        version: 1,
        query: "sqlite transactions",
      }),
    ).toBe(referenceId);
    expect(
      (await service.listReferences("project"))[0]?.snapshot(),
    ).toMatchObject({
      id: referenceId,
      usageCount: 3,
      query: "sqlite transactions",
    });

    await service.deprecate({ type: "pattern", id: patternId, version: 1 });
    expect(await service.search({ query: "transactions", limit: 10 })).toEqual(
      [],
    );
    await expect(
      service.adoptPattern({ projectId: "project", patternId, version: 1 }),
    ).rejects.toBeInstanceOf(GlobalMemoryDeprecatedError);

    expect(() =>
      projectDatabase
        .prepare(
          `INSERT INTO project_memory_reference(
            id, project_id, target_type, target_id, target_version,
            reference_type, usage_count, created_at, updated_at
          ) VALUES ('invalid', 'missing-project', 'pattern', 'missing', 1,
            'adopted', 1, ?, ?)`,
        )
        .run(now.toISOString(), now.toISOString()),
    ).toThrow("FOREIGN KEY constraint failed");

    globalDatabase.close();
    projectDatabase.close();
  });

  test("validates lesson task ownership across the project boundary", async () => {
    const { globalDatabase, projectDatabase, projects, tasks, service } =
      setup();
    const now = new Date("2026-08-23T09:00:00.000Z");
    await projects.save(Project.create({ id: "a", name: "A", now }));
    await projects.save(Project.create({ id: "b", name: "B", now }));
    await tasks.save(
      Task.create({ id: "task", projectId: "a", title: "Task", now }),
    );

    await expect(
      service.extractLesson({
        sourceProjectId: "b",
        sourceTaskId: "task",
        title: "Lesson",
        content: "Keep project ownership explicit",
        confidence: 0.8,
      }),
    ).rejects.toThrow("does not belong to project b");
    globalDatabase.close();
    projectDatabase.close();
  });

  test("rejects semantically corrupt storage rows during restore", async () => {
    const {
      globalDatabase,
      projectDatabase,
      projects,
      memory,
      references,
      service,
    } = setup();
    const now = new Date("2026-08-23T09:00:00.000Z");
    await projects.save(Project.create({ id: "project", name: "Demo", now }));
    await service.createPattern({
      id: "pattern",
      version: 1,
      name: "Pattern",
      problem: "Problem",
      context: "Context",
      solution: "Solution",
    });
    globalDatabase
      .prepare(
        "UPDATE pattern SET success_count = -1 WHERE id = 'pattern' AND version = 1",
      )
      .run();
    await expect(memory.findPattern("pattern", 1)).rejects.toBeInstanceOf(
      DomainValidationError,
    );
    globalDatabase
      .prepare(
        "UPDATE pattern SET success_count = 0 WHERE id = 'pattern' AND version = 1",
      )
      .run();

    globalDatabase
      .prepare(
        `INSERT INTO lesson(
          id, source_project_id, source_task_id, title, content, confidence,
          status, created_at, updated_at
        ) VALUES ('orphan-lesson', NULL, 'missing-task', 'Lesson', 'Content',
          0.8, 'active', ?, ?)`,
      )
      .run(now.toISOString(), now.toISOString());
    await expect(memory.findLesson("orphan-lesson")).rejects.toBeInstanceOf(
      DomainValidationError,
    );

    globalDatabase
      .prepare(
        `INSERT INTO global_role(
          id, name, version, definition_json, status, created_at, updated_at
        ) VALUES ('corrupt-role', '   ', 1, ?, 'active', ?, ?)`,
      )
      .run(
        JSON.stringify({ ...roleDefinition, key: "corrupt-role" }),
        now.toISOString(),
        now.toISOString(),
      );
    await expect(memory.findRole("corrupt-role", 1)).rejects.toBeInstanceOf(
      DomainValidationError,
    );

    await service.adoptPattern({
      projectId: "project",
      patternId: "pattern",
      version: 1,
    });
    projectDatabase.exec("PRAGMA ignore_check_constraints = ON");
    projectDatabase
      .prepare(
        "UPDATE project_memory_reference SET usage_count = 0 WHERE project_id = 'project'",
      )
      .run();
    projectDatabase.exec("PRAGMA ignore_check_constraints = OFF");
    await expect(references.listReferences("project")).rejects.toBeInstanceOf(
      DomainValidationError,
    );
    globalDatabase.close();
    projectDatabase.close();
  });
});
