import { afterEach, describe, expect, test } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "bun:sqlite";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";

const roots: string[] = [];
const migrations = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);
const at = "2026-10-09T00:00:00.000Z";

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function temporaryDatabase(prefix: string): {
  root: string;
  database: Database;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return { root, database: openDatabase(join(root, "project.sqlite")) };
}

function seedProject(database: Database, projectId = "project"): void {
  database
    .query(
      "INSERT INTO project(id,name,created_at,updated_at) VALUES (?,?,?,?)",
    )
    .run(projectId, "Project", at, at);
}

function insertSetup(
  database: Database,
  scope: string,
  scopeRef: string | null,
  key: string,
  value: string,
  projectId = "project",
): void {
  database
    .query(
      `INSERT INTO task_delivery_setup(project_id, scope, scope_ref, key, value_json, updated_at, actor)
       VALUES (?, ?, ?, ?, ?, ?, 'operator')`,
    )
    .run(projectId, scope, scopeRef, key, value, at);
}

/** The constraint set, not the repository, is what these assertions exercise. */
function expectSetupConstraints(database: Database): void {
  insertSetup(database, "project", null, "checkpointFrequency", '"every-gate"');
  insertSetup(database, "run", "run-1", "checkpointFrequency", '"handoff-only"');
  insertSetup(database, "task", "task-1", "contextThreshold", "0.5");
  // A second project-scope row for the same key replaces nothing: it conflicts.
  expect(() =>
    insertSetup(database, "project", null, "checkpointFrequency", '"stage-boundaries"'),
  ).toThrow(/UNIQUE constraint failed/u);
  // A run scope without a reference, and a project scope with one, are refused.
  expect(() =>
    insertSetup(database, "run", null, "handoffMode", '"offer"'),
  ).toThrow(/CHECK constraint failed/u);
  expect(() =>
    insertSetup(database, "task", null, "handoffMode", '"offer"'),
  ).toThrow(/CHECK constraint failed/u);
  expect(() =>
    insertSetup(database, "project", "task-1", "handoffMode", '"offer"'),
  ).toThrow(/CHECK constraint failed/u);
  for (const scope of ["session", "global", ""])
    expect(() =>
      insertSetup(database, scope, "x", "handoffMode", '"offer"'),
    ).toThrow(/CHECK constraint failed/u);
  // Values must be JSON; a bare word or broken object is refused.
  expect(() =>
    insertSetup(database, "project", null, "resumeDetail", "standard"),
  ).toThrow(/CHECK constraint failed/u);
  expect(() =>
    insertSetup(database, "project", null, "resumeDetail", "{"),
  ).toThrow(/CHECK constraint failed/u);
  // Deleting the project cascades through its setup rows.
  database.exec("DELETE FROM project WHERE id = 'project'");
  expect(
    database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM task_delivery_setup",
      )
      .get()?.count,
  ).toBe(0);
}

describe("M19-T4 task-delivery setup migration", () => {
  test("a fresh database constrains scope, JSON and identity and cascades on delete", () => {
    const { database } = temporaryDatabase("ai-office-setup-fresh-");
    try {
      expect(migrate(database, migrations).applied.at(-1)).toBe(
        "0050_task_delivery_setup.sql",
      );
      expect(migrate(database, migrations).applied).toEqual([]);
      seedProject(database);
      expectSetupConstraints(database);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(
        database
          .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
          .get(),
      ).toEqual({ integrity_check: "ok" });
      expect(migrate(database, migrations).applied).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("an upgrade from 0049 adds the empty table without rewriting existing rows", () => {
    const { root, database } = temporaryDatabase("ai-office-setup-upgrade-");
    const partial = join(root, "pre-m19-t4");
    mkdirSync(partial);
    for (const file of readdirSync(migrations).sort())
      if (file <= "0049_task_completion_requires_completed_prerequisites.sql")
        copyFileSync(join(migrations, file), join(partial, file));
    try {
      migrate(database, partial);
      seedProject(database);
      database
        .query(
          "INSERT INTO task(id,project_id,title,status,created_at,updated_at) VALUES ('task','project','Existing','pending',?,?)",
        )
        .run(at, at);
      const taskBefore = database
        .query("SELECT * FROM task WHERE id='task'")
        .get();

      expect(migrate(database, migrations).applied).toEqual([
        "0050_task_delivery_setup.sql",
      ]);
      expect(database.query("SELECT * FROM task WHERE id='task'").get()).toEqual(
        taskBefore,
      );
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM task_delivery_setup",
          )
          .get()?.count,
      ).toBe(0);
      expectSetupConstraints(database);
      expect(migrate(database, migrations).applied).toEqual([]);
    } finally {
      database.close();
    }
  });
});
