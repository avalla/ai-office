import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";

test("upgrading admits review-submitted prerequisites without admitting pending ones", () => {
  const root = mkdtempSync(
    join(tmpdir(), "ai-office-review-prerequisite-upgrade-"),
  );
  const migrations = join(process.cwd(), "migrations", "project");
  const prior = join(root, "prior");
  mkdirSync(prior);
  for (const file of readdirSync(migrations).filter(
    (name) =>
      name.endsWith(".sql") && name < "0048_review_ready_task_dependencies.sql",
  ))
    copyFileSync(join(migrations, file), join(prior, file));
  const database = openDatabase(join(root, "project.sqlite"));
  const at = "2026-10-08T00:00:00.000Z";
  try {
    migrate(database, prior);
    database
      .prepare(
        "INSERT INTO project(id,name,created_at,updated_at) VALUES ('p','Project',?,?)",
      )
      .run(at, at);
    for (const id of ["review", "pending", "dependent", "other"])
      database
        .prepare(
          "INSERT INTO task(id,project_id,title,status,priority,created_at,updated_at) VALUES (?,'p',?,'pending',0,?,?)",
        )
        .run(id, id, at, at);
    database
      .prepare(
        "INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,created_at) VALUES ('p','dependent','review',?)",
      )
      .run(at);
    database
      .prepare(
        "INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,created_at) VALUES ('p','other','pending',?)",
      )
      .run(at);
    database
      .prepare("UPDATE task SET status='running' WHERE id='review'")
      .run();
    database
      .prepare("UPDATE task SET status='waiting_review' WHERE id='review'")
      .run();
    expect(() =>
      database
        .prepare("UPDATE task SET status='running' WHERE id='dependent'")
        .run(),
    ).toThrow("incomplete prerequisites");

    expect(migrate(database, migrations).applied).toEqual([
      "0048_review_ready_task_dependencies.sql",
      "0049_task_completion_requires_completed_prerequisites.sql",
    ]);
    expect(migrate(database, migrations).applied).toEqual([]);
    expect(() =>
      database
        .prepare("UPDATE task SET status='running' WHERE id='dependent'")
        .run(),
    ).not.toThrow();
    database
      .prepare(
        `INSERT INTO role(id,project_id,role_key,name,version,capabilities_json,
         tools_json,model_policy,limits_json,source_path,created_at,updated_at)
         VALUES ('role','p','role','Role',1,'[]','[]','default','{}','fixture',?,?)`,
      )
      .run(at, at);
    database
      .prepare(
        `INSERT INTO agent(id,project_id,role_id,name,enabled,created_at,updated_at)
         VALUES ('agent','p','role','Agent',1,?,?)`,
      )
      .run(at, at);
    expect(() =>
      database
        .prepare(
          `INSERT INTO agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at)
           VALUES ('run','p','dependent','agent','queued',?,?)`,
        )
        .run(at, at),
    ).not.toThrow();
    expect(() =>
      database
        .prepare("UPDATE task SET status='running' WHERE id='other'")
        .run(),
    ).toThrow("incomplete prerequisites");
    database
      .prepare("UPDATE task SET status='blocked' WHERE id='review'")
      .run();
    expect(() =>
      database
        .prepare("UPDATE task SET status='running' WHERE id='other'")
        .run(),
    ).toThrow("incomplete prerequisites");
    expect(
      database
        .query<{ state: string }, []>(
          "SELECT state FROM task_execution_history WHERE task_id='dependent'",
        )
        .get()?.state,
    ).toBe("executed");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("completion requires completed prerequisites while start accepts review", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-office-completion-guard-"));
  const database = openDatabase(join(root, "project.sqlite"));
  const at = "2026-10-08T00:00:00.000Z";
  const status = (id: string, value: string) =>
    database.prepare("UPDATE task SET status=? WHERE id=?").run(value, id);
  try {
    migrate(database, join(process.cwd(), "migrations", "project"));
    database
      .prepare(
        "INSERT INTO project(id,name,created_at,updated_at) VALUES ('p','Project',?,?)",
      )
      .run(at, at);
    for (const id of [
      "review",
      "rejected",
      "dependent",
      "rejected-dep",
      "free",
    ])
      database
        .prepare(
          "INSERT INTO task(id,project_id,title,status,priority,created_at,updated_at) VALUES (?,'p',?,'pending',0,?,?)",
        )
        .run(id, id, at, at);
    for (const [task, prerequisite] of [
      ["dependent", "review"],
      ["rejected-dep", "rejected"],
    ] as const)
      database
        .prepare(
          "INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,created_at) VALUES ('p',?,?,?)",
        )
        .run(task, prerequisite, at);
    for (const id of ["review", "rejected"]) {
      status(id, "running");
      status(id, "waiting_review");
    }
    for (const id of ["dependent", "rejected-dep"]) status(id, "running");

    // Premature completion is refused while the prerequisite is in review.
    expect(() => status("dependent", "completed")).toThrow(
      "incomplete prerequisites",
    );
    // A rejected review never lets the dependent complete.
    status("rejected", "failed");
    expect(() => status("rejected-dep", "completed")).toThrow(
      "incomplete prerequisites",
    );
    expect(
      database
        .query<{ status: string }, []>(
          "SELECT status FROM task WHERE id='dependent'",
        )
        .get()?.status,
    ).toBe("running");

    status("review", "completed");
    expect(() => status("dependent", "completed")).not.toThrow();

    // Tasks without prerequisites, and historical corrections, are unaffected.
    status("free", "running");
    expect(() => status("free", "completed")).not.toThrow();
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a historical completion record is outside the completion guard", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-office-completion-history-"));
  const database = openDatabase(join(root, "project.sqlite"));
  const at = "2026-10-08T00:00:00.000Z";
  try {
    migrate(database, join(process.cwd(), "migrations", "project"));
    database
      .prepare(
        "INSERT INTO project(id,name,created_at,updated_at) VALUES ('p','Project',?,?)",
      )
      .run(at, at);
    for (const id of ["review", "attested"])
      database
        .prepare(
          "INSERT INTO task(id,project_id,title,status,priority,created_at,updated_at) VALUES (?,'p',?,'pending',0,?,?)",
        )
        .run(id, id, at, at);
    database
      .prepare(
        "INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,created_at) VALUES ('p','attested','review',?)",
      )
      .run(at);
    for (const status of ["running", "waiting_review"])
      database
        .prepare("UPDATE task SET status=? WHERE id='review'")
        .run(status);
    // pending -> completed is the historical correction path, not execution.
    expect(() =>
      database
        .prepare("UPDATE task SET status='completed' WHERE id='attested'")
        .run(),
    ).not.toThrow();
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
