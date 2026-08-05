import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ImportProject } from "@ai-office/application/commands/import-project.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import type { ProjectScan } from "@ai-office/application/ports/project-profile-repository.port.ts";
import { LocalProjectScanner } from "../../apps/cli/src/local-project-scanner.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("ImportProject", () => {
  test("reuses an existing project when the same canonical path is imported twice", async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "ai-office-repository-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "ai-office-database-"));
    temporaryDirectories.push(repositoryRoot, databaseRoot);

    writeFileSync(join(repositoryRoot, "package.json"), JSON.stringify({ name: "demo" }));
    writeFileSync(join(repositoryRoot, "index.ts"), "export const value = 1;");

    const database = openDatabase(join(databaseRoot, "project.sqlite"));
    migrate(database, join(process.cwd(), "migrations", "project"));

    const command = new ImportProject(
      new SqliteProjectRepository(database),
      new SqliteProjectProfileRepository(database),
      new LocalProjectScanner(),
      new CryptoIdGenerator(),
      new SystemClock(),
      new SqliteTransactionRunner(database)
    );

    const first = await command.execute({ rootPath: repositoryRoot });
    writeFileSync(join(repositoryRoot, "worker.py"), "value = 2\n");
    const second = await command.execute({ rootPath: repositoryRoot });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.projectId).toBe(first.projectId);

    const projects = database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project")
      .get();
    const sources = database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project_source")
      .get();
    const scans = database
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project_scan")
      .get();
    const questions = database
      .query<{ count: number }, []>(
        "SELECT COUNT(*) AS count FROM project_question WHERE answer_json IS NULL"
      )
      .get();

    expect(projects?.count).toBe(1);
    expect(sources?.count).toBe(1);
    expect(scans?.count).toBe(2);
    expect(questions?.count).toBe(5);
    expect(second.scan.languages).toEqual(["Python", "TypeScript"]);

    const storedLanguages = database
      .query<{ value_json: string }, []>(
        `SELECT value_json
         FROM project_profile_entry
         WHERE category = 'stack' AND key = 'languages' AND origin = 'detected'`
      )
      .all();
    expect(storedLanguages).toEqual([
      { value_json: JSON.stringify(["Python", "TypeScript"]) }
    ]);

    const scanRows = database
      .query<{ status: string; started_at: string; summary_json: string }, []>(
        "SELECT status, started_at, summary_json FROM project_scan ORDER BY rowid"
      )
      .all();
    expect(scanRows.every((row) => row.status === "completed")).toBe(true);
    expect(scanRows.every((row) => row.started_at.length > 0)).toBe(true);
    expect(scanRows.map((row) => JSON.parse(row.summary_json))).toEqual([
      first.scan,
      second.scan
    ]);

    database.close();
  });

  test("canonicalizes a path containing parent-directory segments", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-office-workspace-"));
    const repositoryRoot = join(workspaceRoot, "repositories", "demo");
    const databaseRoot = mkdtempSync(join(tmpdir(), "ai-office-database-"));
    temporaryDirectories.push(workspaceRoot, databaseRoot);
    mkdirSync(repositoryRoot, { recursive: true });
    writeFileSync(join(repositoryRoot, "index.ts"), "export const value = 1;");

    const database = openDatabase(join(databaseRoot, "project.sqlite"));
    migrate(database, join(process.cwd(), "migrations", "project"));
    const command = new ImportProject(
      new SqliteProjectRepository(database),
      new SqliteProjectProfileRepository(database),
      new LocalProjectScanner(),
      new CryptoIdGenerator(),
      new SystemClock(),
      new SqliteTransactionRunner(database)
    );

    const direct = await command.execute({ rootPath: repositoryRoot });
    const withParentSegment = await command.execute({
      rootPath: join(repositoryRoot, "..", "demo")
    });

    expect(withParentSegment.projectId).toBe(direct.projectId);
    expect(withParentSegment.scan.rootPath).toBe(direct.scan.rootPath);
    expect(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project").get()?.count
    ).toBe(1);
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project_source")
        .get()?.count
    ).toBe(1);
    database.close();
  });

  test("rolls back every import write when persistence fails", async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "ai-office-repository-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "ai-office-database-"));
    temporaryDirectories.push(repositoryRoot, databaseRoot);
    writeFileSync(join(repositoryRoot, "index.ts"), "export const value = 1;");

    const database = openDatabase(join(databaseRoot, "project.sqlite"));
    migrate(database, join(process.cwd(), "migrations", "project"));

    class FailingProfiles extends SqliteProjectProfileRepository {
      override async saveScan(_scan: ProjectScan): Promise<void> {
        throw new Error("simulated scan persistence failure");
      }
    }

    const command = new ImportProject(
      new SqliteProjectRepository(database),
      new FailingProfiles(database),
      new LocalProjectScanner(),
      new CryptoIdGenerator(),
      new SystemClock(),
      new SqliteTransactionRunner(database)
    );

    await expect(command.execute({ rootPath: repositoryRoot })).rejects.toThrow(
      "simulated scan persistence failure"
    );

    for (const table of [
      "project",
      "project_source",
      "project_scan",
      "project_profile_entry",
      "project_question"
    ]) {
      expect(
        database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()
          ?.count
      ).toBe(0);
    }
    database.close();
  });

  test("reuses the oldest legacy import without deleting duplicate projects", async () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "ai-office-legacy-repository-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "ai-office-legacy-database-"));
    temporaryDirectories.push(repositoryRoot, databaseRoot);
    writeFileSync(join(repositoryRoot, "index.ts"), "export const value = 1;");

    const database = openDatabase(join(databaseRoot, "project.sqlite"));
    migrate(database, join(process.cwd(), "migrations", "project"));
    const canonicalPath = await new LocalProjectScanner().scan(repositoryRoot);
    const insert = database.prepare(
      `INSERT INTO project(id, name, description, created_at, updated_at)
       VALUES (?, 'Legacy', ?, ?, ?)`
    );
    insert.run(
      "legacy-oldest",
      `Imported from ${canonicalPath.rootPath}`,
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:00:00.000Z"
    );
    insert.run(
      "legacy-newest",
      `Imported from ${canonicalPath.rootPath}`,
      "2026-02-01T00:00:00.000Z",
      "2026-02-01T00:00:00.000Z"
    );

    const imported = await new ImportProject(
      new SqliteProjectRepository(database),
      new SqliteProjectProfileRepository(database),
      new LocalProjectScanner(),
      new CryptoIdGenerator(),
      new SystemClock(),
      new SqliteTransactionRunner(database)
    ).execute({ rootPath: repositoryRoot });

    expect(imported.projectId).toBe("legacy-oldest");
    expect(
      database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM project").get()?.count
    ).toBe(2);
    expect(
      database
        .query<{ project_id: string }, []>("SELECT project_id FROM project_source")
        .get()?.project_id
    ).toBe("legacy-oldest");
    database.close();
  });
});
