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
        "0023_project_snapshot_observations.sql",
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
      "0021_agent_action_provenance.sql",
      "0022_project_portability.sql",
      "0023_project_snapshot_observations.sql",
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

  test("migrates local export claims to local snapshot observations without changing lineage", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-observation-upgrade-"));
    roots.push(root);
    const partial = join(root, "partial-migrations");
    mkdirSync(partial);
    for (const file of readdirSync(migrations).sort()) {
      if (file <= "0022_project_portability.sql")
        copyFileSync(join(migrations, file), join(partial, file));
    }
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, partial);
    const createdAt = "2026-09-01T00:00:00.000Z";
    database
      .prepare(
        `INSERT INTO project(id,name,created_at,updated_at)
         VALUES ('project','Existing',?,?)`,
      )
      .run(createdAt, createdAt);
    database
      .prepare(
        `INSERT INTO project_state_revision(
           id,project_id,parent_revision_id,state_checksum,origin,created_at
         ) VALUES ('revision','project','unknown-parent',?,'local_export',?)`,
      )
      .run("a".repeat(64), createdAt);
    database
      .prepare(
        `INSERT INTO project_state_head(
           project_id,revision_id,base_revision_id,updated_at
         ) VALUES ('project','revision','known-base',?)`,
      )
      .run(createdAt);

    expect(migrate(database, migrations).applied).toEqual([
      "0023_project_snapshot_observations.sql",
    ]);
    expect(
      database
        .query<
          {
            origin: string;
            parent_revision_id: string | null;
            base_revision_id: string | null;
          },
          []
        >(
          `SELECT revision.origin, revision.parent_revision_id,
                  head.base_revision_id
           FROM project_state_revision revision
           JOIN project_state_head head
             ON head.project_id=revision.project_id
            AND head.revision_id=revision.id`,
        )
        .get(),
    ).toEqual({
      origin: "local_snapshot",
      parent_revision_id: "unknown-parent",
      base_revision_id: "known-base",
    });
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
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
      "0021_agent_action_provenance.sql",
      "0022_project_portability.sql",
      "0023_project_snapshot_observations.sql",
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

  test("assigns pre-feature projects one stable identity and adds revision state idempotently", () => {
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
      "0021_agent_action_provenance.sql",
      "0022_project_portability.sql",
      "0023_project_snapshot_observations.sql",
    ]);
    database
      .prepare(
        `INSERT INTO project_checkout_detachment(local_path,project_id,detached_at)
         VALUES ('/canonical/checkout','project',?)`,
      )
      .run(createdAt);

    const portableIdentity = database
      .query<{ repository_id: string }, []>(
        "SELECT repository_id FROM project_repository_identity WHERE project_id='project'",
      )
      .get()?.repository_id;
    expect(portableIdentity).toMatch(/^repo_[0-9a-f]{32}$/u);
    expect(migrate(database, migrations).applied).toEqual([]);
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM project_repository_identity WHERE project_id='project'",
        )
        .get()?.count,
    ).toBe(1);
    expect(
      database
        .query<{ repository_id: string }, []>(
          "SELECT repository_id FROM project_repository_identity WHERE project_id='project'",
        )
        .get()?.repository_id,
    ).toBe(portableIdentity);
    expect(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='project_state_revision'",
        )
        .get()?.name,
    ).toBe("project_state_revision");
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
