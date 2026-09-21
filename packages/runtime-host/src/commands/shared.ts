import type { CommandIo } from "@ai-office/command-support/arguments.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { RunExecutionControl } from "@ai-office/application/runtime/run-execution-control.ts";
import type { AgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type { ProjectStorage } from "@ai-office/application/ports/project-storage.port.ts";
import type { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import type { ConnectorRegistry } from "@ai-office/connector-sdk/connector-registry.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import type { GlobalMemoryRepository } from "@ai-office/application/ports/global-memory-repository.port.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import type { OperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import type { ProjectArchiveAdapter } from "@ai-office/application/ports/project-archive-adapter.port.ts";
import type { ProjectMemoryProvider } from "@ai-office/application/ports/project-memory-provider.port.ts";
import type { ModelRoutingState } from "@ai-office/application/model-routing/model-routing.ts";
import type { ModelProviderCatalog } from "@ai-office/application/ports/model-provider-catalog.port.ts";
import type { GatewayModelProviders } from "@ai-office/llm-gateway/gateway-worker-runtime.ts";

export interface CommandContext extends ProjectStorage {
  onRunChanged?: () => void;
  executionControl: RunExecutionControl;
  agentExecutor?: AgentExecutor;
  runtimeHome: string;
  io: CommandIo;
  principal: OperatorPrincipal;
  audit: RecordAuditEvent;
  ids: IdGenerator;
  clock: Clock;
  connectors: ConnectorRegistry;
  agentClients: AgentClientCatalog;
  projectBindings: ProjectBindingAdapter;
  projectArchives: ProjectArchiveAdapter;
  defaultOfficeManifest: OfficeManifest;
  memory?: GlobalMemoryRepository;
  /** Optional, non-authoritative project memory; disabled unless configured. */
  projectMemory: ProjectMemoryProvider;
  /** Host model routing snapshot used by this command. */
  modelRouting: ModelRoutingState;
  /** Operator-only host reload; absent for non-daemon direct composition. */
  reloadModelRouting?: () => ModelRoutingState;
  /** Selected host-local routing file; never emitted in audit/read models. */
  modelRoutingFile?: string;
  modelProviders: ModelProviderCatalog;
  /** Host provider access for gateway-executed routed runs; credentials never leave it. */
  gatewayProviders: GatewayModelProviders;
}

export * from "@ai-office/command-support/arguments.ts";
