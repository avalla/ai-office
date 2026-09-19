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
  const files = readdirSync(migrationDirectory)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationDirectory, file), "utf8");
    await database.transaction(async () => {
      await database.query(sql);
      await database.query(
        "INSERT INTO core.schema_migration(version) VALUES ($1)",
        [file],
      );
    });
    appliedNow.push(file);
  }

  return appliedNow;
}
