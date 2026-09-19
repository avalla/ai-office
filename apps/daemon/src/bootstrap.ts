import { dirname, join } from "node:path";
import type { AgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import { fileURLToPath } from "node:url";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteGlobalMemoryRepository } from "@ai-office/storage-sqlite/repositories/sqlite-global-memory.repository.ts";
import {
  ProjectStorageBootstrap,
  requireCompleteProjectStorage,
  type ProjectStorageConfig,
} from "@ai-office/storage-bootstrap/project-storage-bootstrap.ts";
import { migrateGlobal } from "@ai-office/storage-sqlite/database/migrate-global.ts";
import { OperationalEventBus } from "@ai-office/application/events/operational-event-bus.ts";
import { OperationalQueryService } from "@ai-office/application/queries/operational-query-service.ts";
import { LocalCommandHandler } from "./local-command-handler.ts";
import { ApplicationRuntime } from "@ai-office/runtime-host/application-runtime.ts";
import { PersistentRuntimeHost } from "./office-daemon.ts";
import { QueryApi } from "./query-api.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import type { ProjectMemoryProvider } from "@ai-office/application/ports/project-memory-provider.port.ts";
import { createProjectMemoryProvider } from "@ai-office/cairnkeep-memory/create-project-memory-provider.ts";
import type { ModelRoutingState } from "@ai-office/application/model-routing/model-routing.ts";
import type { ModelProviderCatalog } from "@ai-office/application/ports/model-provider-catalog.port.ts";
import {
  CredentialModelProviderCatalog,
  loadModelRoutingState,
} from "@ai-office/llm-gateway/model-routing-configuration.ts";
import {
  CredentialGatewayModelProviders,
  type GatewayModelProviders,
} from "@ai-office/llm-gateway/gateway-worker-runtime.ts";
import { BullMqJobQueue } from "@ai-office/bullmq-job-queue/bullmq-job-queue.ts";
import { readQueueConfiguration } from "@ai-office/bullmq-job-queue/config.ts";
import { QueueRuntime } from "./queue-runtime.ts";
import {
  loadProviderCredentials,
  type ProviderCredentials,
} from "@ai-office/llm-gateway/provider-credentials.ts";
import {
  ensureRuntimeHome,
  resolveRuntimePaths,
  withRuntimePathOverrides,
  type RuntimePaths,
} from "@ai-office/runtime-paths/runtime-paths.ts";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

export interface BootstrapOptions {
  agentExecutor?: AgentExecutor;
  runtimePaths?: RuntimePaths;
  projectRoot?: string;
  socketPath?: string;
  migrationDirectory?: string;
  globalDatabasePath?: string;
  globalMigrationDirectory?: string;
  agentClients?: AgentClientCatalog;
  projectBindings?: ProjectBindingAdapter;
  defaultOfficeManifest?: OfficeManifest;
  /**
   * Optional project memory provider. When omitted, the host reads its own
   * environment once (`AI_OFFICE_PROJECT_MEMORY_PROVIDER`, disabled by default).
   */
  projectMemory?: ProjectMemoryProvider;
  /**
   * Optional host model routing. When omitted, the host reads it once from
   * `<AI_OFFICE_HOME>/model-routing.yaml` or, in the foreground only, from
   * `AI_OFFICE_MODEL_ROUTING_FILE` and `AI_OFFICE_LLM_MODEL`.
   */
  modelRouting?: ModelRoutingState;
  modelProviders?: ModelProviderCatalog;
  /**
   * Optional provider credentials. When omitted, the host loads them once:
   * a managed service (`AI_OFFICE_PROVIDER_CREDENTIAL_SOURCE=runtime_home`)
   * only from `<AI_OFFICE_HOME>/credentials/`, a foreground host only from its
   * own environment, never from that directory. Nothing persists them.
   */
  providerCredentials?: ProviderCredentials;
  /** Optional gateway provider access; defaults to the loaded credentials. */
  gatewayProviders?: GatewayModelProviders;
  /** Explicit project storage selection; absent means the bootstrap environment/default. */
  projectStorageConfig?: ProjectStorageConfig;
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
  const storageBootstrap = new ProjectStorageBootstrap({
    sqliteDatabasePath: runtimePaths.projectDatabasePath,
  });
  // Resolve before touching Runtime state so invalid provider configuration
  // cannot fall through to SQLite or start a partially configured host.
  const storageConfiguration = storageBootstrap.resolve(
    options.projectStorageConfig,
  );
  ensureRuntimeHome(runtimePaths);
  // Read once; a credential change takes effect on Runtime restart.
  const credentials =
    options.providerCredentials ??
    loadProviderCredentials(process.env, {
      runtimeHome: runtimePaths.runtimeHome,
    });
  const migrationDirectory =
    options.migrationDirectory ??
    join(sourceDirectory, "..", "..", "..", "migrations", "project");
  const projectStorageHandle = await storageBootstrap.open({
    configuration: storageConfiguration,
    ...(options.migrationDirectory === undefined
      ? {}
      : { sqliteMigrationDirectory: options.migrationDirectory }),
    requireComplete: true,
  });
  const projectStorage = requireCompleteProjectStorage(projectStorageHandle);
  const globalDatabase = openDatabase(runtimePaths.globalDatabasePath);
  migrateGlobal(
    globalDatabase,
    options.globalMigrationDirectory ??
      join(sourceDirectory, "..", "..", "..", "migrations", "global"),
  );
  const events = new RecordAuditEvent(
    projectStorage.auditEvents,
    new CryptoIdGenerator(),
    new SystemClock(),
  );

  // The query surface reuses the persistent host's already-migrated
  // connection. It is read-only, so it needs no transaction runner and adds no
  // write path.
  const queryEvents = new OperationalEventBus();
  const queries = new OperationalQueryService({
    reads: projectStorage.operationalReads,
    clock: new SystemClock(),
    memory: new SqliteGlobalMemoryRepository(globalDatabase),
  });

  const runtime = new ApplicationRuntime(
    runtimePaths,
    commandRoot,
    migrationDirectory,
    options.globalMigrationDirectory,
    options.agentClients,
    options.projectBindings,
    options.defaultOfficeManifest,
    options.agentExecutor,
    () => queryEvents.publish(["run.updated", "task.updated"]),
    options.projectMemory ?? createProjectMemoryProvider(process.env),
    {
      state:
        options.modelRouting ??
        loadModelRoutingState(process.env, {
          runtimeHome: runtimePaths.runtimeHome,
        }),
      providers:
        options.modelProviders ??
        new CredentialModelProviderCatalog(credentials),
      gateway:
        options.gatewayProviders ??
        new CredentialGatewayModelProviders(credentials, {
          debug: process.env.AI_OFFICE_DEBUG_LLM === "1",
        }),
    },
    projectStorage,
  );

  const queueConfiguration = readQueueConfiguration(process.env);
  if (queueConfiguration.status === "misconfigured")
    console.error(
      "Queue configuration is invalid; queue-backed orchestration is disabled.",
    );
  const outbox = projectStorage.jobOutbox;
  const queue =
    queueConfiguration.status === "configured" &&
    queueConfiguration.redisUrl !== undefined
      ? new BullMqJobQueue(queueConfiguration.redisUrl)
      : undefined;
  const queueRuntime =
    queue === undefined
      ? undefined
      : new QueueRuntime(
          runtime,
          outbox,
          queue,
          new SystemClock(),
          options.agentExecutor === undefined
            ? queueConfiguration.worker
            : undefined,
        );
  const queueStatus = async () => ({
    provider:
      queueConfiguration.status === "disabled"
        ? ("disabled" as const)
        : queueConfiguration.status === "misconfigured"
          ? ("misconfigured" as const)
          : ("configured" as const),
    redis:
      queue === undefined ? ("not_checked" as const) : await queue.health(),
    outboxPending: await outbox.pendingCount(),
    orchestrationWorker: queue?.consuming.orchestrate_pipeline ?? false,
    agentRunWorker: queue?.consuming.execute_agent_run ?? false,
  });

  return new PersistentRuntimeHost({
    socketPath: runtimePaths.socketPath,
    queryApi: new QueryApi({ queries, events: queryEvents }),
    queryEvents,
    handler: new LocalCommandHandler(runtime),
    events,
    onStarting: () => queueRuntime?.start() ?? Promise.resolve(),
    queueStatus,
    onStopped: async () => {
      await projectStorageHandle.close();
      globalDatabase.close();
    },
    onStopping: async () => {
      await queueRuntime?.stop();
      await runtime.stop();
    },
  });
}
