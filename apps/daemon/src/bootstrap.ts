import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteOperationalReadRepository } from "@ai-office/storage-sqlite/repositories/sqlite-operational-read.repository.ts";
import { OperationalEventBus } from "@ai-office/application/events/operational-event-bus.ts";
import { OperationalQueryService } from "@ai-office/application/queries/operational-query-service.ts";
import { LocalCommandHandler } from "./local-command-handler.ts";
import { ApplicationRuntime } from "./application-runtime.ts";
import { PersistentRuntimeHost } from "./office-daemon.ts";
import { QueryApi } from "./query-api.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import {
  ensureRuntimeHome,
  resolveRuntimePaths,
  withRuntimePathOverrides,
  type RuntimePaths,
} from "@ai-office/runtime-paths/runtime-paths.ts";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export interface BootstrapOptions {
  runtimePaths?: RuntimePaths;
  projectRoot?: string;
  socketPath?: string;
  migrationDirectory?: string;
  globalDatabasePath?: string;
  globalMigrationDirectory?: string;
  agentClients?: AgentClientCatalog;
  projectBindings?: ProjectBindingAdapter;
  defaultOfficeManifest?: OfficeManifest;
}

export async function bootstrap(
  options: BootstrapOptions = {},
): Promise<PersistentRuntimeHost> {
  const commandRoot = options.projectRoot ?? process.cwd();
  const runtimePaths = withRuntimePathOverrides(
    options.runtimePaths ??
      resolveRuntimePaths({
        mode: "development",
        developmentRoot: commandRoot,
      }),
    {
      ...(options.socketPath === undefined
        ? {}
        : { socketPath: options.socketPath }),
      ...(options.globalDatabasePath === undefined
        ? {}
        : { globalDatabasePath: options.globalDatabasePath }),
    },
  );
  ensureRuntimeHome(runtimePaths);
  const migrationDirectory =
    options.migrationDirectory ??
    join(sourceDirectory, "..", "..", "..", "migrations", "project");
  const database = openDatabase(runtimePaths.projectDatabasePath);
  migrate(database, migrationDirectory);
  const events = new RecordAuditEvent(
    new SqliteAuditEventRepository(database),
    new CryptoIdGenerator(),
    new SystemClock(),
  );

  // The query surface reuses the persistent host's already-migrated
  // connection. It is read-only, so it needs no transaction runner and adds no
  // write path.
  const queryEvents = new OperationalEventBus();
  const queries = new OperationalQueryService({
    reads: new SqliteOperationalReadRepository(database),
    clock: new SystemClock(),
  });

  const runtime = new ApplicationRuntime(
    runtimePaths,
    commandRoot,
    migrationDirectory,
    options.globalMigrationDirectory,
    options.agentClients,
    options.projectBindings,
    options.defaultOfficeManifest,
  );

  return new PersistentRuntimeHost({
    socketPath: runtimePaths.socketPath,
    queryApi: new QueryApi({ queries, events: queryEvents }),
    queryEvents,
    handler: new LocalCommandHandler(runtime),
    events,
    onStopped: () => database.close(),
  });
}
