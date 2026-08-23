import { afterEach, describe, expect, test } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ManageGlobalMemory } from "@ai-office/application/memory/manage-global-memory.ts";
import {
  GlobalMemoryDeprecatedError,
  GlobalMemoryVersionConflictError,
} from "@ai-office/application/memory-errors.ts";
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
  return { globalDatabase, projectDatabase, projects, tasks, memory, service };
}

describe("global memory storage", () => {
  test("migrates fresh and representative existing global databases", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-global-upgrade-"));
    roots.push(root);
    const partial = join(root, "partial");
    mkdirSync(partial);
    copyFileSync(
      join(globalMigrations, "0001_initial.sql"),
      join(partial, "0001_initial.sql"),
    );
    const database = openDatabase(join(root, "global.sqlite"));
    expect(migrateGlobal(database, partial).applied).toEqual([
      "0001_initial.sql",
    ]);
    database
      .prepare(
        `INSERT INTO lesson(
          id, source_project_id, source_task_id, title, content, confidence,
          status, created_at, updated_at
        ) VALUES ('lesson', NULL, NULL, 'Preserved', 'Existing', 0.8,
          'active', ?, ?)`,
      )
      .run("2026-08-23T09:00:00.000Z", "2026-08-23T09:00:00.000Z");

    expect(migrateGlobal(database, globalMigrations).applied).toEqual([
      "0002_memory_integrity.sql",
    ]);
    expect(
      database
        .query<{ title: string }, []>(
          "SELECT title FROM lesson WHERE id = 'lesson'",
        )
        .get()?.title,
    ).toBe("Preserved");
    expect(migrateGlobal(database, globalMigrations).applied).toEqual([]);
    database.close();
  });

  test("versions roles and searches, adopts, and deprecates patterns", async () => {
    const { globalDatabase, projectDatabase, projects, memory, service } =
      setup();
    const now = new Date("2026-08-23T09:00:00.000Z");
    await projects.save(Project.create({ id: "project", name: "Demo", now }));

    const roleInput = {
      name: "Reviewer",
      definition: {
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
      },
    } as const;
    const roleId = await service.createRole({ ...roleInput, version: 1 });
    expect(await service.createRole({ ...roleInput, version: 2 })).toBe(roleId);
    await expect(
      service.createRole({ ...roleInput, version: 2 }),
    ).rejects.toBeInstanceOf(GlobalMemoryVersionConflictError);

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

    expect((await memory.findRole(roleId))?.snapshot().version).toBe(2);
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
});
