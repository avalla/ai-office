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
import { SqliteTaskDependencyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-dependency.repository.ts";

const migrations = join(process.cwd(), "migrations", "project");
const at = "2026-09-30T10:00:00.000Z";

test("SQLite upgrade backfills authoritative execution and keeps the marker monotonic", async () => {
  const root = mkdtempSync(join(tmpdir(), "ai-office-history-upgrade-"));
  const prior = join(root, "prior");
  mkdirSync(prior);
  for (const file of readdirSync(migrations).filter(
    (name) => name.endsWith(".sql") && name < "0040_task_execution_history.sql",
  ))
    copyFileSync(join(migrations, file), join(prior, file));
  const database = openDatabase(join(root, "project.sqlite"));
  try {
    migrate(database, prior);
    database
      .prepare(
        "INSERT INTO project(id,name,created_at,updated_at) VALUES ('p','Project',?,?)",
      )
      .run(at, at);
    database
      .prepare(
        "INSERT INTO project(id,name,created_at,updated_at) VALUES ('restored','Restored',?,?)",
      )
      .run(at, at);
    database
      .prepare(
        `INSERT INTO task(id,project_id,title,status,priority,created_at,updated_at)
      VALUES ('legacy-pending','restored','Legacy pending','pending',0,?,?)`,
      )
      .run(at, at);
    database
      .prepare(
        `INSERT INTO project_state_revision(id,project_id,state_checksum,origin,created_at)
      VALUES ('legacy-revision','restored',?,'portable_import',?)`,
      )
      .run("0".repeat(64), at);
    for (const id of [
      "pristine",
      "start",
      "run",
      "pipeline",
      "returned",
      "status-only",
      "earliest",
      "prerequisite",
    ])
      database
        .prepare(
          `INSERT INTO task(id,project_id,title,status,priority,created_at,updated_at)
        VALUES (?,'p',?,'pending',0,?,?)`,
        )
        .run(id, id, at, at);
    for (const taskId of ["start", "returned"])
      database
        .prepare(
          `INSERT INTO audit_event(id,project_id,event_type,actor_type,aggregate_type,
        aggregate_id,payload_json,occurred_at) VALUES (?,'p','task.status_changed','system','task',?,
        '{"operation":"start"}',?)`,
        )
        .run(`audit-${taskId}`, taskId, at);
    database
      .prepare("UPDATE task SET status='running' WHERE id='returned'")
      .run();
    database
      .prepare("UPDATE task SET status='pending' WHERE id='returned'")
      .run();
    database
      .prepare("UPDATE task SET status='waiting_review' WHERE id='status-only'")
      .run();
    database
      .prepare(
        `INSERT INTO role(id,project_id,role_key,name,version,capabilities_json,tools_json,
      model_policy,limits_json,source_path,created_at,updated_at)
      VALUES ('role','p','role','Role',1,'[]','[]','default','{}','fixture',?,?)`,
      )
      .run(at, at);
    database
      .prepare(
        `INSERT INTO agent(id,project_id,role_id,name,enabled,created_at,updated_at)
      VALUES ('agent','p','role','Agent',1,?,?)`,
      )
      .run(at, at);
    database
      .prepare(
        `INSERT INTO agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at)
      VALUES ('run-1','p','run','agent','cancelled',?,?)`,
      )
      .run(at, at);
    database
      .prepare(
        `INSERT INTO office_manifest_revision(id,project_id,revision,schema_version,
      manifest_json,source_host,source_skill,source_skill_version,applied_at)
      VALUES ('manifest','p',1,1,'{}','codex','ai-office','1',?)`,
      )
      .run(at);
    database
      .prepare(
        `INSERT INTO pipeline_run(id,project_id,task_id,manifest_revision_id,
      manifest_revision,definition_json,status,current_stage_index,started_by,version,
      created_at,updated_at,cancelled_at)
      VALUES ('pipeline-1','p','pipeline','manifest',1,'{}','cancelled',0,'operator',1,?,?,?)`,
      )
      .run(at, at, at);

    expect(migrate(database, migrations).applied).toEqual([
      "0040_task_execution_history.sql",
      "0041_project_pack_binding.sql",
      "0042_project_definition_ownership.sql",
      "0043_requirement_updated_event.sql",
      "0044_project_role_omission.sql",
      "0045_project_agent_disable.sql",
      "0046_project_workflow_override.sql",
      "0047_milestone_archived_status.sql",
      "0048_review_ready_task_dependencies.sql",
      "0049_task_completion_requires_completed_prerequisites.sql",
    ]);
    expect(migrate(database, migrations).applied).toEqual([]);
    const rows = database
      .query<
        { task_id: string; state: string; first_known_at: string | null },
        []
      >(
        "SELECT task_id,state,first_known_at FROM task_execution_history ORDER BY task_id",
      )
      .all();
    expect(rows.filter((row) => row.state === "executed")).toEqual([
      ...["pipeline", "returned", "run", "start"].map((taskId) => ({
        task_id: taskId,
        state: "executed",
        first_known_at: at,
      })),
      { task_id: "status-only", state: "executed", first_known_at: null },
    ]);
    const edges = new SqliteTaskDependencyRepository(database);
    expect(await edges.hasExecutionHistory("p", "pristine")).toBe(false);
    expect(
      database
        .query<{ state: string }, []>(
          "SELECT state FROM task_execution_history WHERE task_id='legacy-pending'",
        )
        .get()?.state,
    ).toBe("unknown");
    expect(await edges.hasExecutionHistory("restored", "legacy-pending")).toBe(
      true,
    );
    expect(
      await edges.link({
        projectId: "p",
        taskId: "pristine",
        dependsOnTaskId: "prerequisite",
        createdAt: new Date(at),
      }),
    ).toBe(true);
    expect(await edges.unlink("p", "pristine", "prerequisite")).toBe(true);
    for (const taskId of ["pipeline", "returned", "run", "start"]) {
      expect(await edges.hasExecutionHistory("p", taskId)).toBe(true);
      await expect(
        edges.link({
          projectId: "p",
          taskId,
          dependsOnTaskId: "prerequisite",
          createdAt: new Date(at),
        }),
      ).rejects.toThrow("execution history");
    }
    expect(() =>
      database
        .prepare("DELETE FROM task_execution_history WHERE task_id='start'")
        .run(),
    ).toThrow("append-only");
    expect(() =>
      database
        .prepare(
          "UPDATE task_execution_history SET state='unknown' WHERE task_id='start'",
        )
        .run(),
    ).toThrow("monotonic");
    const later = "2026-09-30T12:00:00.000Z";
    database
      .prepare(
        "UPDATE task SET status='running', updated_at=? WHERE id='earliest'",
      )
      .run(later);
    expect(
      database
        .query<{ first_known_at: string | null }, []>(
          "SELECT first_known_at FROM task_execution_history WHERE task_id='earliest'",
        )
        .get()?.first_known_at,
    ).toBe(later);
    database
      .prepare(
        `INSERT INTO agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at)
      VALUES ('earliest-run','p','earliest','agent','cancelled',?,?)`,
      )
      .run(at, at);
    expect(
      database
        .query<{ first_known_at: string | null }, []>(
          "SELECT first_known_at FROM task_execution_history WHERE task_id='earliest'",
        )
        .get()?.first_known_at,
    ).toBe(at);
    expect(() =>
      database
        .prepare(
          "UPDATE task_execution_history SET first_known_at=? WHERE task_id='earliest'",
        )
        .run(later),
    ).toThrow("monotonic");
    database
      .prepare(
        `INSERT INTO task_execution_history(task_id,project_id,state)
      VALUES ('pristine','p','unknown')`,
      )
      .run();
    expect(await edges.hasExecutionHistory("p", "pristine")).toBe(true);
    database
      .prepare("UPDATE task SET status='running' WHERE id='pristine'")
      .run();
    database
      .prepare("UPDATE task SET status='pending' WHERE id='pristine'")
      .run();
    expect(
      database
        .query<{ state: string }, []>(
          "SELECT state FROM task_execution_history WHERE task_id='pristine'",
        )
        .get()?.state,
    ).toBe("executed");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SQLite execution authority and history commit or roll back together", () => {
  const root = mkdtempSync(join(tmpdir(), "ai-office-history-transaction-"));
  const database = openDatabase(join(root, "project.sqlite"));
  try {
    migrate(database, migrations);
    database
      .prepare(
        "INSERT INTO project(id,name,created_at,updated_at) VALUES ('p','Project',?,?)",
      )
      .run(at, at);
    database
      .prepare(
        `INSERT INTO task(id,project_id,title,status,priority,created_at,updated_at)
      VALUES ('task','p','Task','pending',0,?,?)`,
      )
      .run(at, at);
    database
      .prepare(
        `INSERT INTO task(id,project_id,title,status,priority,created_at,updated_at)
      VALUES ('prerequisite','p','Prerequisite','pending',0,?,?)`,
      )
      .run(at, at);
    database
      .prepare(
        `INSERT INTO task_dependency(project_id,task_id,depends_on_task_id,created_at)
      VALUES ('p','task','prerequisite',?)`,
      )
      .run(at);
    expect(() =>
      database
        .prepare("UPDATE task SET status='running' WHERE id='task'")
        .run(),
    ).toThrow("incomplete prerequisites");
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM task_execution_history",
        )
        .get()?.count,
    ).toBe(0);
    database.prepare("DELETE FROM task_dependency WHERE task_id='task'").run();
    expect(() =>
      database.transaction(() => {
        database
          .prepare("UPDATE task SET status='running' WHERE id='task'")
          .run();
        expect(
          database
            .query<{ state: string }, []>(
              "SELECT state FROM task_execution_history WHERE task_id='task'",
            )
            .get()?.state,
        ).toBe("executed");
        throw new Error("abort");
      })(),
    ).toThrow("abort");
    expect(
      database
        .query<{ status: string }, []>(
          "SELECT status FROM task WHERE id='task'",
        )
        .get()?.status,
    ).toBe("pending");
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM task_execution_history",
        )
        .get()?.count,
    ).toBe(0);
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
      database.transaction(() => {
        database
          .prepare(
            `INSERT INTO agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at)
        VALUES ('rollback-run','p','task','agent','queued',?,?)`,
          )
          .run(at, at);
        expect(
          database
            .query<{ state: string }, []>(
              "SELECT state FROM task_execution_history WHERE task_id='task'",
            )
            .get()?.state,
        ).toBe("executed");
        throw new Error("abort run");
      })(),
    ).toThrow("abort run");
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM agent_run WHERE id='rollback-run'",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM task_execution_history",
        )
        .get()?.count,
    ).toBe(0);
    database.prepare("UPDATE task SET status='running' WHERE id='task'").run();
    expect(() =>
      database.prepare("DELETE FROM project WHERE id='p'").run(),
    ).not.toThrow();
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM task_execution_history",
        )
        .get()?.count,
    ).toBe(0);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
