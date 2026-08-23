import type { Database } from "bun:sqlite";
import { migrate, type MigrationResult } from "./migrate.ts";

export function migrateGlobal(
  database: Database,
  migrationDirectory: string,
): MigrationResult {
  return migrate(database, migrationDirectory);
}
