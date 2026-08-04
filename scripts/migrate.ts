import { join } from "node:path";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";

const projectRoot = process.cwd();
const projectPath = join(projectRoot, ".ai-office", "project.sqlite");
const migrationsPath = join(projectRoot, "migrations", "project");
const database = openDatabase(projectPath);

try {
  const result = migrate(database, migrationsPath);
  const detail = result.applied.length === 0 ? "already up to date" : result.applied.join(", ");
  console.log(`Migrated ${projectPath} (${detail})`);
} finally {
  database.close();
}
