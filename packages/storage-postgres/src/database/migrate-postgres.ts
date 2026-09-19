import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PostgresClient } from "./postgres-client.ts";

interface MigrationRow extends Record<string, unknown> {
  version: string;
}

/** Small ordered runner for the SQL files also used by Supabase deployment. */
export async function migratePostgres(
  database: PostgresClient,
  migrationDirectory: string,
): Promise<string[]> {
  const migrations = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      sql: readFileSync(join(migrationDirectory, file), "utf8"),
    }));

  return database.transaction(async () => {
    // The lock must be acquired through the transaction-bound session. A
    // session-level lock on the pool could be released or observed on another
    // connection before the migration statements complete.
    await database.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('ai-office:core:schema-migration', 0))",
    );
    await database.query("CREATE SCHEMA IF NOT EXISTS core");
    await database.query(`
      CREATE TABLE IF NOT EXISTS core.schema_migration (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const applied = new Set(
      (
        await database.query<MigrationRow>(
          "SELECT version FROM core.schema_migration ORDER BY version",
        )
      ).map((row) => row.version),
    );
    const appliedNow: string[] = [];

    for (const migration of migrations) {
      if (applied.has(migration.file)) continue;
      await database.query(migration.sql);
      await database.query(
        "INSERT INTO core.schema_migration(version) VALUES ($1)",
        [migration.file],
      );
      appliedNow.push(migration.file);
    }

    return appliedNow;
  });
}
