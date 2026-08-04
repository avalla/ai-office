import { join } from "node:path";
import { homedir } from "node:os";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";

const projectRoot = process.cwd();
const globalPath = join(homedir(), ".ai-office", "global.sqlite");
const projectPath = join(projectRoot, ".ai-office", "project.sqlite");
const indexPath = join(projectRoot, ".ai-office", "index.sqlite");

const targets = [
  [globalPath, join(projectRoot, "migrations", "global")],
  [projectPath, join(projectRoot, "migrations", "project")],
  [indexPath, join(projectRoot, "migrations", "index")]
] as const;

for (const [databasePath, migrationsPath] of targets) {
  const database = openDatabase(databasePath);
  migrate(database, migrationsPath);
  database.close();
  console.log(`Migrated ${databasePath}`);
}
