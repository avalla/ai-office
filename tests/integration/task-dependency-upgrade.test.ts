import {
  copyFileSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "vitest";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteTaskDependencyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-dependency.repository.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";

test("forward migration preserves existing tasks and starts with an empty dependency graph", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-office-dependency-upgrade-"));
  const migrations = join(process.cwd(), "migrations", "project");
  const prior = join(root, "prior");
  mkdirSync(prior);
  for (const file of readdirSync(migrations).filter(
    (name) =>
      name.endsWith(".sql") &&
      name !== "0037_task_dependencies.sql" &&
      name !== "0038_milestone_description_changed_event.sql" &&
      name !== "0039_task_dependency_immutable_edges.sql" &&
      name !== "0040_task_execution_history.sql" &&
      name !== "0041_project_pack_binding.sql" &&
      name !== "0042_project_definition_ownership.sql",
  ))
    copyFileSync(join(migrations, file), join(prior, file));
  const database = openDatabase(join(root, "project.sqlite"));
  try {
    migrate(database, prior);
    const now = new Date("2026-10-01T00:00:00.000Z");
    await new SqliteProjectRepository(database).save(
      Project.create({ id: "project", name: "Existing", now }),
    );
    await new SqliteTaskRepository(database).save(
      Task.create({
        id: "task",
        projectId: "project",
        title: "Existing task",
        now,
      }),
    );
    expect(migrate(database, migrations).applied).toEqual([
      "0037_task_dependencies.sql",
      "0038_milestone_description_changed_event.sql",
      "0039_task_dependency_immutable_edges.sql",
      "0040_task_execution_history.sql",
      "0041_project_pack_binding.sql",
      "0042_project_definition_ownership.sql",
    ]);
    expect(migrate(database, migrations).applied).toEqual([]);
    expect(
      (await new SqliteTaskRepository(database).findById("task"))?.snapshot()
        .title,
    ).toBe("Existing task");
    expect(
      await new SqliteTaskDependencyRepository(database).listByProject(
        "project",
      ),
    ).toEqual([]);
    await new SqliteTaskRepository(database).save(
      Task.create({ id: "other", projectId: "project", title: "Other", now }),
    );
    const dependencies = new SqliteTaskDependencyRepository(database);
    expect(
      await dependencies.link({
        projectId: "project",
        taskId: "task",
        dependsOnTaskId: "other",
        createdAt: now,
      }),
    ).toBe(true);
    expect(() =>
      database
        .prepare("UPDATE task_dependency SET task_id = ? WHERE task_id = ?")
        .run("other", "task"),
    ).toThrow("immutable");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
