import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ProjectStorage } from "@ai-office/application/ports/project-storage.port.ts";
import type { JobOutboxRepository } from "@ai-office/application/ports/job-outbox-repository.port.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteJobOutboxRepository } from "@ai-office/storage-sqlite/repositories/sqlite-job-outbox.repository.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("project storage composition", () => {
  test("authoritative storage includes a durable job outbox", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-project-storage-"));
    roots.push(root);
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, join(process.cwd(), "migrations", "project"));

    const storage: ProjectStorage = createSqliteProjectStorage(database);
    const completeAuthority: ProjectStorage & {
      jobOutbox: JobOutboxRepository;
    } = storage;

    expect(completeAuthority.jobOutbox).toBeInstanceOf(
      SqliteJobOutboxRepository,
    );
    database.close();
  });
});
