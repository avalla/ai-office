import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProjectStorage } from "@ai-office/application/ports/project-storage.port.ts";
import { migratePostgres } from "@ai-office/storage-postgres/database/migrate-postgres.ts";
import { PostgresClient } from "@ai-office/storage-postgres/database/postgres-client.ts";
import { PostgresTransactionRunner } from "@ai-office/storage-postgres/database/postgres-transaction-runner.ts";
import { PostgresGovernanceRepository } from "@ai-office/storage-postgres/repositories/postgres-governance.repository.ts";
import { PostgresProjectRepository } from "@ai-office/storage-postgres/repositories/postgres-project.repository.ts";
import { PostgresTaskRepository } from "@ai-office/storage-postgres/repositories/postgres-task.repository.ts";
import { PostgresTaskRequirementRepository } from "@ai-office/storage-postgres/repositories/postgres-task-requirement.repository.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { createSqliteProjectStorage } from "@ai-office/storage-sqlite/sqlite-project-storage.ts";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const defaultSqliteMigrationDirectory = join(
  sourceDirectory,
  "..",
  "..",
  "..",
  "migrations",
  "project",
);
const defaultPostgresMigrationDirectory = join(
  sourceDirectory,
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);

export type ProjectStorageProvider = "sqlite" | "postgres";

export type ProjectStorageConfig =
  | { provider: "sqlite"; databasePath: string }
  | { provider: "postgres"; connectionString: string };

export const projectStorageCapabilityNames = [
  "projects",
  "profiles",
  "officeManifests",
  "pipelines",
  "tasks",
  "taskRequirements",
  "runtime",
  "costs",
  "governance",
  "capabilities",
  "controlled",
  "auditEvents",
  "repositoryIdentities",
  "projectStates",
  "memoryReferences",
  "projectMemoryProvenance",
  "operationalReads",
  "transactions",
  "jobOutbox",
] as const satisfies readonly (keyof ProjectStorage)[];

export type ProjectStorageCapability =
  (typeof projectStorageCapabilityNames)[number];

export type ProjectStorageCapabilities = Readonly<
  Record<ProjectStorageCapability, boolean>
>;

export interface ProjectStorageHandle {
  readonly provider: ProjectStorageProvider;
  readonly capabilities: ProjectStorageCapabilities;
  /** Repository ports implemented by this provider; incomplete providers stay partial. */
  readonly repositories: Partial<ProjectStorage>;
  close(): Promise<void>;
}

export class StorageProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageProviderConfigurationError";
  }
}

export class StorageProviderIncompleteError extends Error {
  readonly provider: ProjectStorageProvider;
  readonly missingCapabilities: readonly ProjectStorageCapability[];

  constructor(
    provider: ProjectStorageProvider,
    missingCapabilities: readonly ProjectStorageCapability[],
  ) {
    super(
      `Storage provider '${provider}' cannot provide complete Runtime project authority; missing capabilities: ${missingCapabilities.join(", ")}`,
    );
    this.name = "StorageProviderIncompleteError";
    this.provider = provider;
    this.missingCapabilities = missingCapabilities;
  }
}

export interface ProjectStorageBootstrapOptions {
  sqliteDatabasePath: string;
  environment?: Readonly<Record<string, string | undefined>>;
  sqliteMigrationDirectory?: string;
  postgresMigrationDirectory?: string;
}

export interface OpenProjectStorageOptions {
  configuration?: ProjectStorageConfig;
  sqliteMigrationDirectory?: string;
  postgresMigrationDirectory?: string;
  requireComplete?: boolean;
}

export class ProjectStorageBootstrap {
  private readonly environment: Readonly<Record<string, string | undefined>>;
  private readonly sqliteDatabasePath: string;
  private readonly sqliteMigrationDirectory: string;
  private readonly postgresMigrationDirectory: string;

  constructor(options: ProjectStorageBootstrapOptions) {
    this.environment = options.environment ?? process.env;
    this.sqliteDatabasePath = options.sqliteDatabasePath;
    this.sqliteMigrationDirectory =
      options.sqliteMigrationDirectory ?? defaultSqliteMigrationDirectory;
    this.postgresMigrationDirectory =
      options.postgresMigrationDirectory ?? defaultPostgresMigrationDirectory;
  }

  resolve(configuration?: ProjectStorageConfig): ProjectStorageConfig {
    if (configuration !== undefined)
      return validateConfiguration(configuration);

    const provider = this.environment.AI_OFFICE_STORAGE_PROVIDER ?? "sqlite";
    switch (provider) {
      case "sqlite":
        return { provider, databasePath: this.sqliteDatabasePath };
      case "postgres": {
        const connectionString = this.environment.AI_OFFICE_POSTGRES_URL;
        if (connectionString === undefined || connectionString.length === 0)
          throw new StorageProviderConfigurationError(
            "AI_OFFICE_POSTGRES_URL is required when AI_OFFICE_STORAGE_PROVIDER=postgres",
          );
        return { provider, connectionString };
      }
      default:
        throw new StorageProviderConfigurationError(
          "AI_OFFICE_STORAGE_PROVIDER must be one of: sqlite, postgres",
        );
    }
  }

  async open(
    options: OpenProjectStorageOptions = {},
  ): Promise<ProjectStorageHandle> {
    const configuration = this.resolve(options.configuration);
    let handle: ProjectStorageHandle;
    switch (configuration.provider) {
      case "sqlite":
        handle = this.openSqlite(
          configuration,
          options.sqliteMigrationDirectory,
        );
        break;
      case "postgres":
        handle = await this.openPostgres(
          configuration,
          options.postgresMigrationDirectory,
        );
        break;
      default:
        return unreachable(configuration);
    }

    if (options.requireComplete === true) {
      try {
        requireCompleteProjectStorage(handle);
      } catch (error) {
        await handle.close();
        throw error;
      }
    }
    return handle;
  }

  private openSqlite(
    configuration: Extract<ProjectStorageConfig, { provider: "sqlite" }>,
    migrationDirectory: string | undefined,
  ): ProjectStorageHandle {
    const database = openDatabase(configuration.databasePath);
    try {
      migrate(database, migrationDirectory ?? this.sqliteMigrationDirectory);
      return {
        provider: "sqlite",
        capabilities: completeCapabilities(),
        repositories: createSqliteProjectStorage(database),
        close: onceClose(() => database.close()),
      };
    } catch (error) {
      database.close();
      throw error;
    }
  }

  private async openPostgres(
    configuration: Extract<ProjectStorageConfig, { provider: "postgres" }>,
    migrationDirectory: string | undefined,
  ): Promise<ProjectStorageHandle> {
    const database = new PostgresClient(configuration.connectionString);
    try {
      await migratePostgres(
        database,
        migrationDirectory ?? this.postgresMigrationDirectory,
      );
      const repositories = {
        projects: new PostgresProjectRepository(database),
        tasks: new PostgresTaskRepository(database),
        taskRequirements: new PostgresTaskRequirementRepository(database),
        governance: new PostgresGovernanceRepository(database),
        transactions: new PostgresTransactionRunner(database),
      } satisfies Pick<
        ProjectStorage,
        | "projects"
        | "tasks"
        | "taskRequirements"
        | "governance"
        | "transactions"
      >;
      return {
        provider: "postgres",
        capabilities: postgresCapabilities(),
        repositories,
        close: onceClose(() => database.close()),
      };
    } catch (error) {
      await database.close();
      throw error;
    }
  }
}

export function requireCompleteProjectStorage(
  handle: ProjectStorageHandle,
): ProjectStorage {
  const missingCapabilities = projectStorageCapabilityNames.filter(
    (capability) => !handle.capabilities[capability],
  );
  if (missingCapabilities.length > 0)
    throw new StorageProviderIncompleteError(
      handle.provider,
      missingCapabilities,
    );
  return handle.repositories as ProjectStorage;
}

function validateConfiguration(
  configuration: ProjectStorageConfig,
): ProjectStorageConfig {
  switch (configuration.provider) {
    case "sqlite":
      if (configuration.databasePath.length === 0)
        throw new StorageProviderConfigurationError(
          "SQLite project storage requires a database path",
        );
      return configuration;
    case "postgres":
      if (configuration.connectionString.length === 0)
        throw new StorageProviderConfigurationError(
          "PostgreSQL project storage requires a connection string",
        );
      return configuration;
    default:
      throw new StorageProviderConfigurationError(
        "Project storage provider must be one of: sqlite, postgres",
      );
  }
}

function completeCapabilities(): ProjectStorageCapabilities {
  return capabilities(projectStorageCapabilityNames);
}

function postgresCapabilities(): ProjectStorageCapabilities {
  return capabilities([
    "projects",
    "tasks",
    "taskRequirements",
    "governance",
    "transactions",
  ]);
}

function capabilities(
  implemented: readonly ProjectStorageCapability[],
): ProjectStorageCapabilities {
  return Object.freeze(
    Object.fromEntries(
      projectStorageCapabilityNames.map((name) => [
        name,
        implemented.includes(name),
      ]),
    ),
  ) as ProjectStorageCapabilities;
}

function onceClose(close: () => void | Promise<void>): () => Promise<void> {
  let closed = false;
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= Promise.resolve().then(() => {
      if (closed) return;
      closed = true;
      return close();
    });
    return closing;
  };
}

function unreachable(value: never): never {
  throw new StorageProviderConfigurationError(
    `Unsupported project storage provider: ${String(value)}`,
  );
}
