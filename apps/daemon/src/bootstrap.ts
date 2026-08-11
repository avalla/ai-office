import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { LocalCommandHandler } from "./local-command-handler.ts";
import { OfficeDaemon } from "./office-daemon.ts";
import type { OnboardingQuestionGenerator } from "@ai-office/application/ports/onboarding-question-generator.port.ts";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export interface BootstrapOptions {
  projectRoot?: string;
  socketPath?: string;
  migrationDirectory?: string;
  onboardingGenerator?: OnboardingQuestionGenerator;
}

export async function bootstrap(
  options: BootstrapOptions = {},
): Promise<OfficeDaemon> {
  const projectRoot = options.projectRoot ?? process.cwd();
  const migrationDirectory =
    options.migrationDirectory ??
    join(sourceDirectory, "..", "..", "..", "migrations", "project");
  const database = openDatabase(
    join(projectRoot, ".ai-office", "project.sqlite"),
  );
  migrate(database, migrationDirectory);
  const events = new RecordAuditEvent(
    new SqliteAuditEventRepository(database),
    new CryptoIdGenerator(),
    new SystemClock(),
  );

  return new OfficeDaemon({
    socketPath:
      options.socketPath ?? join(projectRoot, ".ai-office", "daemon.sock"),
    handler: new LocalCommandHandler(
      projectRoot,
      migrationDirectory,
      options.onboardingGenerator,
    ),
    events,
    onStopped: () => database.close(),
  });
}
