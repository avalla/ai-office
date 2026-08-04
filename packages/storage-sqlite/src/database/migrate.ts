import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function migrate(database: Database, directory: string): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = database
    .query<{ version: string }, []>("SELECT version FROM schema_migration")
    .all()
    .map((row) => row.version);

  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".sql"))
    .sort();

  const insertMigration = database.prepare(
    "INSERT INTO schema_migration(version, applied_at) VALUES (?, ?)"
  );

  for (const file of files) {
    if (applied.includes(file)) continue;

    const sql = readFileSync(join(directory, file), "utf8");

    database.transaction(() => {
      database.exec(sql);
      insertMigration.run(file, new Date().toISOString());
    })();
  }
}
