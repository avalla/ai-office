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
        "0014_trusted_local_execution.sql",
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
});
