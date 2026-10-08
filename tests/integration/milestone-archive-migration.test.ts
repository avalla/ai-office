import { afterEach, expect, test } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";

const roots: string[] = [];
const migrations = join(process.cwd(), "migrations", "project");
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("archive migration preserves milestones, requirement links and review subjects", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-office-milestone-archive-"));
  roots.push(root);
  const oldMigrations = join(root, "old-migrations");
  mkdirSync(oldMigrations);
  for (const file of readdirSync(migrations).sort())
    if (file <= "0046_project_workflow_override.sql")
      copyFileSync(join(migrations, file), join(oldMigrations, file));
  const database = openDatabase(join(root, "project.sqlite"));
  try {
    migrate(database, oldMigrations);
    const at = "2026-10-01T00:00:00.000Z";
    database
      .query(
        "INSERT INTO project(id,name,created_at,updated_at) VALUES ('p','Project',?,?)",
      )
      .run(at, at);
    database
      .query(
        "INSERT INTO milestone(id,project_id,title,status,created_at,updated_at) VALUES ('m','p','Milestone','completed',?,?)",
      )
      .run(at, at);
    database
      .query(
        "INSERT INTO requirement(id,project_id,milestone_id,requirement_key,title,description,status,created_at,updated_at) VALUES ('r','p','m','R','Requirement','Description','verified',?,?)",
      )
      .run(at, at);
    database
      .query(
        "INSERT INTO review(id,project_id,subject_type,subject_id,reviewer_actor_type,reviewer_actor_id,status,created_at) VALUES ('v','p','milestone','m','user','operator','pending',?)",
      )
      .run(at);

    expect(migrate(database, migrations).applied).toEqual([
      "0047_milestone_archived_status.sql",
      "0048_review_ready_task_dependencies.sql",
      "0049_task_completion_requires_completed_prerequisites.sql",
    ]);
    expect(migrate(database, migrations).applied).toEqual([]);
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .query<{ milestone_id: string }, []>(
          "SELECT milestone_id FROM requirement WHERE id='r'",
        )
        .get()?.milestone_id,
    ).toBe("m");
    expect(
      database
        .query<{ subject_id: string }, []>(
          "SELECT subject_id FROM review WHERE id='v'",
        )
        .get()?.subject_id,
    ).toBe("m");
    database.query("UPDATE milestone SET archived_at=? WHERE id='m'").run(at);
    expect(
      (await new SqliteGovernanceRepository(database).getSnapshot("p"))
        .milestones[0]?.status,
    ).toBe("archived");
  } finally {
    database.close();
  }
});
