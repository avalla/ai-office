import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe } from "vitest";
import type { GovernanceEventRecord } from "@ai-office/application/ports/governance-repository.port.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { defineGovernanceRepositoryContracts } from "../contracts/governance-repository.contract.ts";

const migrationDirectory = join(process.cwd(), "migrations", "project");

describe("SQLite governance repository contracts", () => {
  defineGovernanceRepositoryContracts(async () => {
    const root = mkdtempSync(
      join(tmpdir(), "ai-office-sqlite-governance-contract-"),
    );
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, migrationDirectory);
    const projects = new SqliteProjectRepository(database);
    const governance = new SqliteGovernanceRepository(database);

    return {
      projects,
      governance,
      async seedEvent(value: GovernanceEventRecord): Promise<void> {
        database
          .prepare(
            `INSERT INTO governance_event(
               id, project_id, event_type, aggregate_id, metadata_json, occurred_at
             ) VALUES (?, ?, ?, ?, ?, ?)`,
          )
          .run(
            value.id,
            value.projectId,
            value.eventType,
            value.aggregateId,
            JSON.stringify(value.metadata),
            value.occurredAt.toISOString(),
          );
      },
      async failEventAppend(eventId: string): Promise<void> {
        database.exec(
          `CREATE TRIGGER inject_event_failure BEFORE INSERT ON governance_event
           WHEN NEW.id = '${eventId.replaceAll("'", "''")}'
           BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`,
        );
      },
      async restoreEventAppend(): Promise<void> {
        database.exec("DROP TRIGGER IF EXISTS inject_event_failure");
      },
      async close(): Promise<void> {
        database.close();
        rmSync(root, { recursive: true, force: true });
      },
    };
  });
});
