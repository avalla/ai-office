import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = join(
  testDirectory,
  "..",
  "..",
  "migrations",
  "project",
);
const temporaryDirectories: string[] = [];

function createTemporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "ai-office-storage-"));
  temporaryDirectories.push(directory);
  return openDatabase(join(directory, "project.sqlite"));
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("project database migrations", () => {
  test("applies pending migrations once", () => {
    const database = createTemporaryDatabase();

    expect(migrate(database, migrationDirectory).applied).toEqual([
      "0001_initial.sql",
      "0002_project_import.sql",
      "0003_project_import_idempotency.sql",
      "0004_project_onboarding.sql",
      "0005_audit_event.sql",
      "0006_agent_runtime.sql",
      "0007_llm_cost.sql",
      "0008_governance.sql",
      "0009_agent_runtime_hardening.sql",
      "0010_llm_cost_hardening.sql",
      "0011_governance_hardening.sql",
      "0012_capability_policy.sql",
    ]);
    expect(migrate(database, migrationDirectory).applied).toEqual([]);

    const rows = database
      .query<{ version: string }, []>(
        "SELECT version FROM schema_migration ORDER BY version",
      )
      .all();

    expect(rows).toEqual([
      { version: "0001_initial.sql" },
      { version: "0002_project_import.sql" },
      { version: "0003_project_import_idempotency.sql" },
      { version: "0004_project_onboarding.sql" },
      { version: "0005_audit_event.sql" },
      { version: "0006_agent_runtime.sql" },
      { version: "0007_llm_cost.sql" },
      { version: "0008_governance.sql" },
      { version: "0009_agent_runtime_hardening.sql" },
      { version: "0010_llm_cost_hardening.sql" },
      { version: "0011_governance_hardening.sql" },
      { version: "0012_capability_policy.sql" },
    ]);
    database.close();
  });
});

describe("SQLite project and task repositories", () => {
  test("round-trips projects and lists tasks in deterministic priority order", async () => {
    const database = createTemporaryDatabase();
    migrate(database, migrationDirectory);
    const projects = new SqliteProjectRepository(database);
    const tasks = new SqliteTaskRepository(database);
    const now = new Date("2026-08-05T00:00:00.000Z");
    const project = Project.create({
      id: "project-1",
      name: "Demo",
      description: "Vertical slice",
      now,
    });

    await projects.save(project);
    await tasks.save(
      Task.create({
        id: "task-low",
        projectId: "project-1",
        title: "Low",
        priority: 1,
        now,
      }),
    );
    await tasks.save(
      Task.create({
        id: "task-high-b",
        projectId: "project-1",
        title: "High B",
        priority: 5,
        now,
      }),
    );
    await tasks.save(
      Task.create({
        id: "task-high-a",
        projectId: "project-1",
        title: "High A",
        priority: 5,
        now,
      }),
    );

    expect((await projects.findById("project-1"))?.snapshot()).toEqual(
      project.snapshot(),
    );
    expect(
      (await tasks.listByProject("project-1")).map(
        (task) => task.snapshot().id,
      ),
    ).toEqual(["task-high-a", "task-high-b", "task-low"]);
    database.close();
  });

  test("enforces project foreign keys", async () => {
    const database = createTemporaryDatabase();
    migrate(database, migrationDirectory);
    const tasks = new SqliteTaskRepository(database);
    const task = Task.create({
      id: "task-1",
      projectId: "missing",
      title: "Orphan",
      now: new Date("2026-08-05T00:00:00.000Z"),
    });

    await expect(tasks.save(task)).rejects.toThrow(
      "FOREIGN KEY constraint failed",
    );

    const profiles = new SqliteProjectProfileRepository(database);
    await expect(
      profiles.saveSource({
        id: "source-1",
        projectId: "missing",
        sourceType: "local",
        localPath: "/missing/project",
        createdAt: new Date("2026-08-05T00:00:00.000Z"),
      }),
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    database.close();
  });
});
