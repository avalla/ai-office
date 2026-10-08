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
import { SqliteProjectDefinitionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-definition.repository.ts";

const roots: string[] = [];
const migrations = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);
const migration = "0046_project_workflow_override.sql";
const digest = `sha256:${"a".repeat(64)}`;
const at = "2026-10-06T00:00:00.000Z";
const workflow =
  '{"id":"review","title":"Our review","taskType":"matter","stages":[{"id":"z-last","role":"counsel"},{"id":"a-first","role":"paralegal"}]}';

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

function insertOverride(
  database: Database,
  kind: string,
  localId: string,
  operation: string,
  payload: string | null,
  projectId = "legacy",
): void {
  database
    .query(
      `INSERT INTO project_definition_override(project_id, pack_id, pack_version, manifest_digest, kind, local_id, operation, revision, payload_json, actor_id, changed_at)
      VALUES (?, 'org.example.legal', '1.0.0', ?, ?, ?, ?, 1, ?, 'operator', ?)`,
    )
    .run(projectId, digest, kind, localId, operation, payload, at);
}

function seedProject(database: Database, projectId = "legacy"): void {
  database
    .query(
      "INSERT INTO project(id,name,created_at,updated_at) VALUES (?,?,?,?)",
    )
    .run(projectId, "Legacy", at, at);
  database
    .query(
      "INSERT INTO project_definition_head(project_id, revision, changed_at) VALUES (?, 3, ?)",
    )
    .run(projectId, at);
}

/** The constraint, not the application, is what these assertions exercise. */
function expectWorkflowConstraint(database: Database): void {
  // Every operation is admitted on a workflow.
  insertOverride(database, "workflows", "review", "replace", workflow);
  insertOverride(
    database,
    "workflows",
    "intake",
    "extend",
    '{"title":"Intake"}',
  );
  insertOverride(database, "workflows", "audit", "disable", null);
  // The stage list is stored as given.
  expect(
    database
      .query<{ payload_json: string }, []>(
        "SELECT payload_json FROM project_definition_override WHERE kind = 'workflows' AND local_id = 'review'",
      )
      .get()?.payload_json,
  ).toBe(workflow);
  // The earlier disable kinds are kept, and no other kind gains one.
  insertOverride(database, "agents", "disabled", "disable", null);
  insertOverride(database, "roles", "omitted", "disable", null);
  insertOverride(database, "prompts", "muted", "disable", null);
  for (const kind of [
    "taskTypes",
    "artifactTypes",
    "evidenceTypes",
    "knowledge",
  ])
    expect(() =>
      insertOverride(database, kind, "other", "disable", null),
    ).toThrow(/CHECK constraint failed/u);
  // Kinds without an override contract are still rejected for every operation.
  for (const kind of ["policies", "capabilities", "validators", "unknown"]) {
    expect(() =>
      insertOverride(database, kind, "any", "replace", '{"id":"any"}'),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      insertOverride(database, kind, "any", "extend", '{"title":"Any"}'),
    ).toThrow(/CHECK constraint failed/u);
    expect(() =>
      insertOverride(database, kind, "any", "disable", null),
    ).toThrow(/CHECK constraint failed/u);
  }
  // A disable has no payload; a replacement or extension needs one.
  expect(() =>
    insertOverride(database, "workflows", "with-payload", "disable", workflow),
  ).toThrow(/CHECK constraint failed/u);
  expect(() =>
    insertOverride(database, "workflows", "no-payload", "replace", null),
  ).toThrow(/CHECK constraint failed/u);
  expect(() =>
    insertOverride(database, "workflows", "no-payload", "extend", null),
  ).toThrow(/CHECK constraint failed/u);
  // Every other 0042 constraint is still enforced on the rebuilt table.
  expect(() =>
    insertOverride(database, "workflows", "merged", "merge", workflow),
  ).toThrow(/CHECK constraint failed/u);
  expect(() =>
    insertOverride(database, "workflows", "broken", "replace", "{not json"),
  ).toThrow(/CHECK constraint failed/u);
  expect(() =>
    insertOverride(database, "workflows", "review", "disable", null),
  ).toThrow(/UNIQUE constraint failed/u);
  expect(() =>
    insertOverride(database, "workflows", "bad id", "replace", workflow),
  ).toThrow(/CHECK constraint failed/u);
  expect(() =>
    insertOverride(database, "workflows", "orphan", "disable", null, "missing"),
  ).toThrow(/FOREIGN KEY constraint failed/u);
}

describe("GP-13 workflow override migration", () => {
  test("a fresh database accepts workflow overrides and still constrains every other kind", () => {
    const { database } = temporaryDatabase("ai-office-gp13-fresh-");
    try {
      expect(migrate(database, migrations).applied.at(-1)).toBe(
        "0049_task_completion_requires_completed_prerequisites.sql",
      );
      expect(migrate(database, migrations).applied).toEqual([]);
      seedProject(database);
      expectWorkflowConstraint(database);
    } finally {
      database.close();
    }
  });

  test("an upgrade from 0045 preserves every existing override row, key and constraint", async () => {
    const { root, database } = temporaryDatabase("ai-office-gp13-upgrade-");
    const partial = join(root, "pre-gp13");
    mkdirSync(partial);
    for (const file of readdirSync(migrations).sort())
      if (file < migration)
        copyFileSync(join(migrations, file), join(partial, file));
    try {
      expect(migrate(database, partial).applied.at(-1)).toBe(
        "0045_project_agent_disable.sql",
      );
      seedProject(database);
      seedProject(database, "other");
      // The GP-12 agent disable and reference payload, the GP-11 role
      // omission and the GP-07 entries are carried over.
      insertOverride(database, "agents", "drafter", "disable", null);
      insertOverride(
        database,
        "agents",
        "filer",
        "replace",
        '{"id":"filer","role":"counsel","prompts":["brief","tone"],"capabilities":["draft"]}',
      );
      insertOverride(database, "roles", "clerk", "disable", null);
      insertOverride(database, "prompts", "greeting", "disable", null);
      insertOverride(
        database,
        "roles",
        "counsel",
        "replace",
        '{"id":"counsel","title":"Our counsel"}',
      );
      insertOverride(
        database,
        "taskTypes",
        "matter",
        "extend",
        '{"description":"A case"}',
      );
      insertOverride(
        database,
        "knowledge",
        "handbook",
        "replace",
        '{"id":"handbook"}',
        "other",
      );
      // Before the migration no operation on a workflow passes 0045.
      for (const [operation, payload] of [
        ["replace", workflow],
        ["extend", '{"title":"Review"}'],
        ["disable", null],
      ] as const)
        expect(() =>
          insertOverride(database, "workflows", "review", operation, payload),
        ).toThrow(/CHECK constraint failed/u);
      database
        .query(
          `INSERT INTO project_owned_definition(project_id, kind, local_id, revision, enabled, payload_json, actor_id, changed_at)
          VALUES ('legacy', 'workflows', 'house', 1, 1, '{"id":"house","taskType":"errand","stages":[{"id":"only","role":"liaison"}]}', 'operator', ?)`,
        )
        .run(at);
      const rows = (table: string) =>
        database
          .query(`SELECT * FROM ${table}`)
          .all()
          .map((row) => JSON.stringify(row))
          .sort();
      const tables = [
        "project_definition_override",
        "project_owned_definition",
        "project_definition_head",
        "project",
      ];
      const before = tables.map(rows);
      expect(before[0]).toHaveLength(7);
      const repository = new SqliteProjectDefinitionRepository(database);
      const stateBefore = await repository.get("legacy");

      expect(migrate(database, migrations).applied).toEqual([
        migration,
        "0047_milestone_archived_status.sql",
        "0048_review_ready_task_dependencies.sql",
        "0049_task_completion_requires_completed_prerequisites.sql",
      ]);

      expect(tables.map(rows)).toEqual(before);
      expect(await repository.get("legacy")).toEqual(stateBefore);
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      expect(database.query("PRAGMA integrity_check").all()).toEqual([
        { integrity_check: "ok" },
      ]);
      // The rebuild leaves no helper table behind.
      expect(
        database
          .query<{ name: string }, []>(
            "SELECT name FROM sqlite_master WHERE name LIKE 'project_definition_override%' ORDER BY name",
          )
          .all()
          .map((row) => row.name)
          .filter((name) => !name.startsWith("sqlite_autoindex_")),
      ).toEqual(["project_definition_override"]);
      expectWorkflowConstraint(database);
      // Deleting the project still cascades through the head to the overrides.
      database.exec("DELETE FROM project WHERE id = 'legacy'");
      expect(
        database
          .query(
            "SELECT * FROM project_definition_override WHERE project_id = 'legacy'",
          )
          .all(),
      ).toEqual([]);
      expect(
        database
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM project_definition_override WHERE project_id = 'other'",
          )
          .get()?.count,
      ).toBe(1);
      expect(migrate(database, migrations).applied).toEqual([]);
    } finally {
      database.close();
    }
  });
});
