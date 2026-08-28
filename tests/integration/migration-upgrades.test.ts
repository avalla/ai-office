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

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("migration upgrades", () => {
  test.each([
    ["M2", "0005_audit_event.sql"],
    ["M3", "0006_agent_runtime.sql"],
    ["M4", "0007_llm_cost.sql"],
    ["M5", "0011_governance_hardening.sql"],
  ])(
    "upgrades an existing %s database without losing project data",
    (_, cutoff) => {
      const root = mkdtempSync(join(tmpdir(), "ai-office-migration-upgrade-"));
      roots.push(root);
      const partial = join(root, "partial-migrations");
      mkdirSync(partial);
      for (const file of readdirSync(migrations).sort()) {
        if (file <= cutoff)
          copyFileSync(join(migrations, file), join(partial, file));
      }
      const database = openDatabase(join(root, "project.sqlite"));
      migrate(database, partial);
      database
        .prepare(
          `INSERT INTO project(id,name,description,created_at,updated_at)
         VALUES (?,?,?,?,?)`,
        )
        .run(
          "project",
          "Preserved",
          null,
          "2026-08-05T00:00:00.000Z",
          "2026-08-05T00:00:00.000Z",
        );

      expect(migrate(database, migrations).applied.at(-1)).toBe(
        "0020_pipeline_enforcement.sql",
      );
      expect(
        database
          .query<{ name: string }, [string]>(
            "SELECT name FROM project WHERE id=?",
          )
          .get("project")?.name,
      ).toBe("Preserved");
      expect(migrate(database, migrations).applied).toEqual([]);
      database.close();
    },
  );

  test("preserves legacy deterministic onboarding questions with explicit provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-onboarding-upgrade-"));
    roots.push(root);
    const partial = join(root, "partial-migrations");
    mkdirSync(partial);
    for (const file of readdirSync(migrations).sort()) {
      if (file <= "0014_trusted_local_execution.sql") {
        copyFileSync(join(migrations, file), join(partial, file));
      }
    }
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, partial);
    database
      .prepare(
        `INSERT INTO project(id,name,description,created_at,updated_at)
         VALUES ('project','Legacy',NULL,?,?)`,
      )
      .run("2026-08-05T00:00:00.000Z", "2026-08-05T00:00:00.000Z");
    database
      .prepare(
        `INSERT INTO project_question(
           id, project_id, scan_id, key, question, reason, answer_json,
           answered_at, answer_category
         ) VALUES ('question','project',NULL,'agent_permissions',?,?,NULL,NULL,'permission')`,
      )
      .run("Which operations?", "Legacy deterministic question");

    expect(migrate(database, migrations).applied).toEqual([
      "0015_llm_assisted_onboarding.sql",
      "0016_agent_controlled_actions.sql",
      "0017_skill_first_office.sql",
      "0018_reusable_memory_references.sql",
      "0019_repository_identity.sql",
      "0020_pipeline_enforcement.sql",
    ]);
    expect(
      database
        .query<
          {
            source: string;
            generation_id: string | null;
            answer_type: string;
            options_json: string;
          },
          []
        >(
          `SELECT source, generation_id, answer_type, options_json
           FROM project_question WHERE id = 'question'`,
        )
        .get(),
    ).toMatchObject({
      source: "deterministic",
      generation_id: null,
      answer_type: "multi_select",
    });
    database.close();
  });

  test("adds immutable office manifest revisions to an existing M6D database", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-office-upgrade-"));
    roots.push(root);
    const partial = join(root, "partial-migrations");
    mkdirSync(partial);
    for (const file of readdirSync(migrations).sort()) {
      if (file <= "0016_agent_controlled_actions.sql") {
        copyFileSync(join(migrations, file), join(partial, file));
      }
    }
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, partial);
    database
      .prepare(
        `INSERT INTO project(id,name,description,created_at,updated_at)
         VALUES ('project','Existing',NULL,?,?)`,
      )
      .run("2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");

    expect(migrate(database, migrations).applied).toEqual([
      "0017_skill_first_office.sql",
      "0018_reusable_memory_references.sql",
      "0019_repository_identity.sql",
      "0020_pipeline_enforcement.sql",
    ]);
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='office_manifest_revision'",
        )
        .get()?.name,
    ).toBe("office_manifest_revision");
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM project WHERE id='project'",
        )
        .get()?.name,
    ).toBe("Existing");
    database.close();
  });

  test("adds portable repository identity and checkout detachment state without changing projects", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-identity-upgrade-"));
    roots.push(root);
    const partial = join(root, "partial-migrations");
    mkdirSync(partial);
    for (const file of readdirSync(migrations).sort()) {
      if (file <= "0018_reusable_memory_references.sql")
        copyFileSync(join(migrations, file), join(partial, file));
    }
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, partial);
    const createdAt = "2026-08-23T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO project(id,name,description,created_at,updated_at)
         VALUES ('project','Existing',NULL,?,?)`,
      )
      .run(createdAt, createdAt);

    expect(migrate(database, migrations).applied).toEqual([
      "0019_repository_identity.sql",
      "0020_pipeline_enforcement.sql",
    ]);
    database
      .prepare(
        `INSERT INTO project_repository_identity(repository_id,project_id,created_at)
         VALUES ('repo_portable','project',?)`,
      )
      .run(createdAt);
    database
      .prepare(
        `INSERT INTO project_checkout_detachment(local_path,project_id,detached_at)
         VALUES ('/canonical/checkout','project',?)`,
      )
      .run(createdAt);

    expect(
      database
        .query<{ project_id: string }, []>(
          "SELECT project_id FROM project_repository_identity WHERE repository_id='repo_portable'",
        )
        .get(),
    ).toEqual({ project_id: "project" });
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    database.prepare("DELETE FROM project WHERE id='project'").run();
    expect(
      database
        .query<{ count: number }, []>(
          `SELECT
             (SELECT COUNT(*) FROM project_repository_identity) +
             (SELECT COUNT(*) FROM project_checkout_detachment) AS count`,
        )
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("enforces generation ownership and completed status for LLM questions", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-onboarding-integrity-"));
    roots.push(root);
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, migrations);
    const insertProject = database.prepare(
      `INSERT INTO project(id,name,description,created_at,updated_at)
       VALUES (?,?,NULL,?,?)`,
    );
    const createdAt = "2026-08-05T00:00:00.000Z";
    insertProject.run("project-a", "Project A", createdAt, createdAt);
    insertProject.run("project-b", "Project B", createdAt, createdAt);

    const insertGeneration = database.prepare(
      `INSERT INTO onboarding_generation(
         id, project_id, provider, model, prompt_version, input_hash, round,
         status, batch_status, failure_code, created_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    insertGeneration.run(
      "generation-a",
      "project-a",
      "mock",
      "model",
      "project-onboarding-v1",
      "a".repeat(64),
      1,
      "completed",
      "needs_more_context",
      null,
      createdAt,
    );
    insertGeneration.run(
      "generation-b-failed",
      "project-b",
      "mock",
      "model",
      "project-onboarding-v1",
      "b".repeat(64),
      1,
      "failed",
      null,
      "ProviderError",
      createdAt,
    );
    insertGeneration.run(
      "generation-b-completed",
      "project-b",
      "mock",
      "model",
      "project-onboarding-v1",
      "c".repeat(64),
      1,
      "completed",
      "needs_more_context",
      null,
      createdAt,
    );

    const insertQuestion = database.prepare(
      `INSERT INTO project_question(
         id, project_id, key, question, normalized_question, reason,
         answer_category, answer_type, priority, source, generation_id
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    expect(() =>
      insertQuestion.run(
        "cross-project",
        "project-b",
        "cross-project",
        "Cross-project question?",
        "goal:cross-project question?",
        "Must be rejected",
        "goal",
        "text",
        50,
        "llm",
        "generation-a",
      ),
    ).toThrow("question source and generation do not match");
    expect(() =>
      insertQuestion.run(
        "failed-generation",
        "project-b",
        "failed-generation",
        "Failed generation question?",
        "goal:failed generation question?",
        "Must be rejected",
        "goal",
        "text",
        50,
        "llm",
        "generation-b-failed",
      ),
    ).toThrow("question source and generation do not match");
    expect(() =>
      insertQuestion.run(
        "llm-without-generation",
        "project-b",
        "llm-without-generation",
        "Missing generation question?",
        "goal:missing generation question?",
        "Must be rejected",
        "goal",
        "text",
        50,
        "llm",
        null,
      ),
    ).toThrow("question source and generation do not match");
    expect(() =>
      insertQuestion.run(
        "deterministic-with-generation",
        "project-b",
        "deterministic-with-generation",
        "Deterministic question?",
        "goal:deterministic question?",
        "Must be rejected",
        "goal",
        "text",
        50,
        "deterministic",
        "generation-b-completed",
      ),
    ).toThrow("question source and generation do not match");
    expect(() =>
      insertQuestion.run(
        "valid-question",
        "project-b",
        "valid-question",
        "Valid question?",
        "goal:valid question?",
        "Accepted",
        "goal",
        "text",
        50,
        "llm",
        "generation-b-completed",
      ),
    ).not.toThrow();
    expect(() =>
      database
        .prepare(
          `UPDATE onboarding_generation
           SET status='failed', batch_status=NULL, failure_code='ProviderError'
           WHERE id='generation-b-completed'`,
        )
        .run(),
    ).toThrow("generation update violates question ownership");

    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      database
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get(),
    ).toEqual({ integrity_check: "ok" });
    database.close();
  });

  test("deletes generated LLM questions with their project and generation", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-onboarding-delete-"));
    roots.push(root);
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, migrations);
    const createdAt = "2026-08-05T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO project(id,name,description,created_at,updated_at)
         VALUES ('project','Project',NULL,?,?)`,
      )
      .run(createdAt, createdAt);
    database
      .prepare(
        `INSERT INTO onboarding_generation(
           id, project_id, provider, model, prompt_version, input_hash, round,
           status, batch_status, failure_code, created_at
         ) VALUES ('generation','project','mock','model','project-onboarding-v1',?,1,
                   'completed','needs_more_context',NULL,?)`,
      )
      .run("d".repeat(64), createdAt);
    database
      .prepare(
        `INSERT INTO project_question(
           id, project_id, key, question, normalized_question, reason,
           answer_category, answer_type, priority, source, generation_id
         ) VALUES (
           'question','project','question','Question?','goal:question?',
           'Generated question','goal','text',50,'llm','generation'
         )`,
      )
      .run();

    expect(() =>
      database.prepare("DELETE FROM project WHERE id='project'").run(),
    ).not.toThrow();
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM onboarding_generation",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM project_question",
        )
        .get()?.count,
    ).toBe(0);
    expect(
      database.query<{ id: string }, []>("PRAGMA foreign_key_check").all(),
    ).toEqual([]);
    expect(
      database
        .query<{ integrity_check: string }, []>("PRAGMA integrity_check")
        .get(),
    ).toEqual({ integrity_check: "ok" });
    database.close();
  });
});
