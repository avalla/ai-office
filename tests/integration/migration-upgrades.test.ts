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
        "0015_llm_assisted_onboarding.sql",
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
});
