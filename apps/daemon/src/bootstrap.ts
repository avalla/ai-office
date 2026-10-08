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
  type OpenProjectStorageOptions,
  type ProjectStorageConfig,
  type ProjectStorageHandle,
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
import type { InstalledDomainPackCatalog } from "@ai-office/application/ports/installed-domain-pack-catalog.port.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import {
  KnowledgeStoreError,
  type RuntimeAgentKnowledge,
} from "@ai-office/application/ports/agent-knowledge-store.port.ts";
import {
  daemonProtocolVersion,
  type DaemonHealthResponse,
  type RuntimeStatus,
} from "@ai-office/application/protocol/daemon-protocol.ts";
import { productVersion } from "@ai-office/command-support/version.ts";
import { readSourceRevision } from "./source-revision.ts";
import {
  agentKnowledgeEnvironment,
  isAgentKnowledgeTenantId,
  loadAgentKnowledgeConfiguration,
  type AgentKnowledgeConfiguration,
} from "@ai-office/storage-surrealdb/agent-knowledge-configuration.ts";
import type { connectSurrealAgentKnowledgeStore } from "@ai-office/storage-surrealdb/connect-agent-knowledge-store.ts";
import type { ModelRoutingState } from "@ai-office/application/model-routing/model-routing.ts";
import type { ModelProviderCatalog } from "@ai-office/application/ports/model-provider-catalog.port.ts";
import {
  CredentialModelProviderCatalog,
  loadModelRoutingState,
  resolveModelRoutingFilePath,
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
import { loadRuntimeHomeCredentialValue } from "@ai-office/llm-gateway/runtime-home-credential-store.ts";
import {
  ensureRuntimeHome,
  resolveRuntimePaths,
  withRuntimePathOverrides,
  type RuntimePaths,
} from "@ai-office/runtime-paths/runtime-paths.ts";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
type AgentKnowledgeConnector = typeof connectSurrealAgentKnowledgeStore;
type AgentKnowledgeHandle = Awaited<ReturnType<AgentKnowledgeConnector>>;
const knowledgeConnectTimeoutMs = 5_000;
const knowledgeProbeTimeoutMs = 1_500;
/**
 * Synthetic repository scope for the live status probe. The read matches no
 * caller data by construction; it only proves the connected store answers.
 */
const knowledgeProbeRepositoryId = "runtime-status-probe";

async function connectKnowledgeWithDeadline(
  connector: AgentKnowledgeConnector,
  configuration: Extract<AgentKnowledgeConfiguration, { kind: "surrealdb" }>,
  deadlineMs: number,
): Promise<AgentKnowledgeHandle> {
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const pending = Promise.resolve().then(() =>
    connector(configuration.connection, controller.signal),
  );
  void pending.then(
    (handle) => {
      if (timedOut)
        void Promise.resolve()
          .then(() => handle.close())
          .catch(() => {});
    },
    () => {},
  );
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error("Agent knowledge connection timed out"));
    }, deadlineMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

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
  installedPacks?: InstalledDomainPackCatalog;
  defaultOfficeManifest?: OfficeManifest;
  /** Host-only secondary knowledge configuration. */
  agentKnowledgeConfiguration?: AgentKnowledgeConfiguration;
  /** Internal seam for deterministic connection and cleanup tests. */
  connectAgentKnowledge?: AgentKnowledgeConnector;
  /** Internal seam for a bounded connection test. */
  agentKnowledgeConnectTimeoutMs?: number;
  /** Internal seam for a bounded live status probe test. */
  agentKnowledgeProbeTimeoutMs?: number;
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
  /** Internal bootstrap seam for deterministic acquisition-failure tests. */
  projectStorageBootstrap?: ProjectStorageBootstrapLike;
  /** Internal bootstrap seam for deterministic global-database failure tests. */
  openGlobalDatabase?: typeof openDatabase;
  /** Internal bootstrap seam for deterministic source-revision capture tests. */
  readSourceRevision?: (directory: string) => string | null;
}

interface ProjectStorageBootstrapLike {
  resolve(configuration?: ProjectStorageConfig): ProjectStorageConfig;
  open(options?: OpenProjectStorageOptions): Promise<ProjectStorageHandle>;
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
  const storageBootstrap =
    options.projectStorageBootstrap ??
    new ProjectStorageBootstrap({
      sqliteDatabasePath: runtimePaths.projectDatabasePath,
    });
  // Resolve before touching Runtime state so invalid provider configuration
  // cannot fall through to SQLite or start a partially configured host.
  const storageConfiguration = storageBootstrap.resolve(
    options.projectStorageConfig,
  );
  const resolvedKnowledgeConfiguration =
    options.agentKnowledgeConfiguration ??
    loadAgentKnowledgeConfiguration(process.env, {
      runtimeHome: runtimePaths.runtimeHome,
      ...(storageConfiguration.provider === "postgres"
        ? { authoritativeTenantId: storageConfiguration.tenantId }
        : {}),
      loadCredential: (name) => {
        if (
          name !== agentKnowledgeEnvironment.username &&
          name !== agentKnowledgeEnvironment.password
        )
          return undefined;
        const credential = loadRuntimeHomeCredentialValue(
          runtimePaths.runtimeHome,
          name,
        );
        return credential.state === "present" ? credential.value : undefined;
      },
    });
  // The test/composition seam must not override PostgreSQL's authoritative tenant.
  const knowledgeConfiguration =
    storageConfiguration.provider === "postgres" &&
    resolvedKnowledgeConfiguration.kind === "surrealdb"
      ? {
          ...resolvedKnowledgeConfiguration,
          tenantId: storageConfiguration.tenantId,
        }
      : resolvedKnowledgeConfiguration;
  const validatedKnowledgeConfiguration =
    knowledgeConfiguration.kind === "surrealdb" &&
    !isAgentKnowledgeTenantId(knowledgeConfiguration.tenantId)
      ? { kind: "misconfigured" as const, provider: "surrealdb" as const }
      : knowledgeConfiguration;
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
  let projectStorageHandle: ProjectStorageHandle | undefined;
  let globalDatabase: ReturnType<typeof openDatabase> | undefined;
  let agentKnowledgeHandle: AgentKnowledgeHandle | undefined;
  let ownershipTransferred = false;
  try {
    projectStorageHandle = await storageBootstrap.open({
      configuration: storageConfiguration,
      ...(options.migrationDirectory === undefined
        ? {}
        : { sqliteMigrationDirectory: options.migrationDirectory }),
      requireComplete: true,
    });
    const projectStorage = requireCompleteProjectStorage(projectStorageHandle);
    globalDatabase = (options.openGlobalDatabase ?? openDatabase)(
      runtimePaths.globalDatabasePath,
    );
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

    const routingEnvironment = { ...process.env };
    const loadRouting = (readFile?: (path: string) => string) =>
      loadModelRoutingState(routingEnvironment, {
        runtimeHome: runtimePaths.runtimeHome,
        ...(readFile === undefined ? {} : { readFile }),
      });
    const modelRoutingFile = resolveModelRoutingFilePath(
      routingEnvironment,
      runtimePaths.runtimeHome,
    );
    const initialRouting = options.modelRouting ?? loadRouting();
    const routing = {
      state: initialRouting,
      load: loadRouting,
      reload: () => {
        const next = loadRouting();
        routing.state = next;
        return next;
      },
      restore: (state: ModelRoutingState) => {
        routing.state = state;
      },
      ...(modelRoutingFile === undefined ? {} : { file: modelRoutingFile }),
      providers:
        options.modelProviders ??
        new CredentialModelProviderCatalog(credentials),
      gateway:
        options.gatewayProviders ??
        new CredentialGatewayModelProviders(credentials, {
          debug: process.env.AI_OFFICE_DEBUG_LLM === "1",
        }),
    };
    let agentKnowledge: RuntimeAgentKnowledge =
      validatedKnowledgeConfiguration.kind === "disabled"
        ? { state: "disabled" }
        : validatedKnowledgeConfiguration.kind === "misconfigured"
          ? {
              state: "misconfigured",
              error: new KnowledgeStoreError("KNOWLEDGE_MISCONFIGURED"),
            }
          : {
              state: "unavailable",
              error: new KnowledgeStoreError("KNOWLEDGE_UNAVAILABLE"),
            };
    let knowledgeStatus: NonNullable<DaemonHealthResponse["knowledge"]> =
      validatedKnowledgeConfiguration.kind === "disabled"
        ? { provider: "none", startup: "disabled" }
        : validatedKnowledgeConfiguration.kind === "misconfigured"
          ? {
              provider: validatedKnowledgeConfiguration.provider,
              startup: "misconfigured",
            }
          : { provider: "surrealdb", startup: "unavailable" };
    if (validatedKnowledgeConfiguration.kind === "surrealdb") {
      try {
        agentKnowledgeHandle = await connectKnowledgeWithDeadline(
          options.connectAgentKnowledge ??
            (
              await import("@ai-office/storage-surrealdb/connect-agent-knowledge-store.ts")
            ).connectSurrealAgentKnowledgeStore,
          validatedKnowledgeConfiguration,
          options.agentKnowledgeConnectTimeoutMs ?? knowledgeConnectTimeoutMs,
        );
        agentKnowledge = {
          state: "connected",
          tenantId: validatedKnowledgeConfiguration.tenantId,
          store: agentKnowledgeHandle.store,
        };
        knowledgeStatus = { provider: "surrealdb", startup: "connected" };
      } catch {
        // Knowledge is advisory. Keep the authoritative Runtime available.
      }
    }
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
      routing,
      projectStorage,
      agentKnowledge,
      options.installedPacks,
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

    // The provider reads the host through a holder, assigned just below; it
    // only runs at request time, once the host has recorded its start instant.
    // The source revision is resolved once, here: re-reading mutable git
    // metadata per request could report a checkout that moved after this
    // process loaded its code, misrepresenting the running distribution.
    const statusHost: { current?: PersistentRuntimeHost } = {};
    const sourceRevision = (options.readSourceRevision ?? readSourceRevision)(
      sourceDirectory,
    );
    // Live request-time connectivity probe, separate from the startup-observed
    // `knowledgeStatus`: a bounded read-only query through the connected store.
    // It never runs inside a transaction and cannot write; a slow or dead
    // store only delays this one status request by the probe deadline.
    const knowledgeLiveStatus = async (): Promise<
      "connected" | "unavailable" | "not_checked"
    > => {
      if (agentKnowledge.state !== "connected") return "not_checked";
      try {
        await Promise.race([
          agentKnowledge.store.findKnowledge(
            {
              tenantId: agentKnowledge.tenantId,
              repositoryId: knowledgeProbeRepositoryId,
            },
            { text: "probe", limit: 1 },
          ),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error("knowledge probe deadline exceeded")),
              options.agentKnowledgeProbeTimeoutMs ?? knowledgeProbeTimeoutMs,
            ),
          ),
        ]);
        return "connected";
      } catch {
        return "unavailable";
      }
    };
    const runtimeStatus = async (): Promise<RuntimeStatus> => {
      const startedAt = statusHost.current?.startedAtInstant ?? new Date();
      return {
        protocolVersion: daemonProtocolVersion,
        status: "ok",
        productVersion,
        sourceRevision,
        startedAt: startedAt.toISOString(),
        uptimeSeconds: Math.max(
          0,
          Math.floor((Date.now() - startedAt.getTime()) / 1000),
        ),
        knowledge: {
          ...knowledgeStatus,
          live: await knowledgeLiveStatus(),
        },
        queue: await queueStatus(),
        // Reaching this composition means the authoritative project store
        // opened; a daemon that failed to open it never answers.
        storage: { project: "available" },
      };
    };

    const host = new PersistentRuntimeHost({
      socketPath: runtimePaths.socketPath,
      queryApi: new QueryApi({
        queries,
        events: queryEvents,
        status: runtimeStatus,
      }),
      queryEvents,
      handler: new LocalCommandHandler(runtime),
      events,
      onStarting: () => queueRuntime?.start() ?? Promise.resolve(),
      queueStatus,
      knowledgeStatus,
      onStopped: async () => {
        try {
          await agentKnowledgeHandle?.close();
        } catch {
          // Secondary storage cannot change the authoritative shutdown result.
        } finally {
          try {
            await projectStorageHandle?.close();
          } finally {
            globalDatabase?.close();
          }
        }
      },
      onStopping: async () => {
        await queueRuntime?.stop();
        await runtime.stop();
      },
    });
    statusHost.current = host;
    ownershipTransferred = true;
    return host;
  } finally {
    if (!ownershipTransferred) {
      try {
        await agentKnowledgeHandle?.close();
      } catch {
        // Preserve the original bootstrap failure.
      } finally {
        try {
          await projectStorageHandle?.close();
        } finally {
          globalDatabase?.close();
        }
      }
    }
  }
}
