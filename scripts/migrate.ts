import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import {
  ensureRuntimeHome,
  resolveRuntimePaths,
} from "@ai-office/runtime-paths/runtime-paths.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePaths = resolveRuntimePaths({
  mode: "development",
  developmentRoot: projectRoot,
});
ensureRuntimeHome(runtimePaths);
const projectPath = runtimePaths.projectDatabasePath;
const migrationsPath = join(projectRoot, "migrations", "project");
const database = openDatabase(projectPath);

try {
  const result = migrate(database, migrationsPath);
  const detail =
    result.applied.length === 0
      ? "already up to date"
      : result.applied.join(", ");
  console.log(`Migrated ${projectPath} (${detail})`);
} finally {
  database.close();
}
