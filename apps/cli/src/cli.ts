import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  resolveRuntimePaths,
  withRuntimePathOverrides,
  type RuntimePaths,
} from "@ai-office/runtime-paths/runtime-paths.ts";
import { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";
import { InvalidAgentDefinitionError } from "@ai-office/agent-runtime/agent-definition.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { AgentDefinitionDirectoryError } from "@ai-office/agent-runtime/yaml-agent-definition-loader.ts";
import {
  AgentNotFoundError,
  TaskLockActiveError,
  TaskLockExpiredError,
  TaskNotFoundError,
} from "@ai-office/application/commands/schedule-agent-run.ts";
import {
  BudgetExceededError,
  BudgetNotFoundError,
  DuplicateProviderUsageError,
  MonetaryOverflowError,
  PricingCurrencyMismatchError,
  PricingNotFoundError,
  PricingOverlapError,
  ReservationExpiredError,
} from "@ai-office/application/cost-errors.ts";
import {
  InvalidProjectAnswerError,
  InvalidOfficeManifestError,
  OfficeManifestNotFoundError,
  OfficePipelineNotFoundError,
  ProjectNotFoundError,
  ProjectQuestionAlreadyAnsweredError,
  ProjectQuestionNotFoundError,
} from "@ai-office/application/errors.ts";
import {
  DuplicateRequirementKeyError,
  GovernanceCrossProjectReferenceError,
  GovernanceSubjectNotFoundError,
  ReviewAlreadyFinalizedError,
  ReviewNotFoundError,
} from "@ai-office/application/governance-errors.ts";
import {
  ActionRequestNotFoundError,
  CapabilityGrantNotFoundError,
  CapabilityGrantRevokedError,
  CapabilityPrincipalNotFoundError,
  CapabilityProjectMismatchError,
  ConcurrentActionTransitionError,
  ActionSimulationConflictError,
  ActionApprovalNotFoundError,
  ActionApprovalConflictError,
  InvalidActionApprovalStateError,
  ActionExecutionConflictError,
  ActionExecutionNotFoundError,
  InvalidActionExecutionStateError,
  StaleActionSimulationError,
  InvalidConnectorInvocationStateError,
  StaleActionAuthorizationError,
  ResourceDisabledError,
  ResourceNotFoundError,
} from "@ai-office/application/capability-errors.ts";
import {
  CapabilityValidationError,
  CanonicalSerializationError,
  InvalidActionTransitionError,
  InvalidActionTimestampError,
} from "@ai-office/domain/capability/errors.ts";
import { SystemClock } from "@ai-office/application/ports/clock.port.ts";
import { TransactionAlreadyActiveError } from "@ai-office/application/ports/transaction-runner.port.ts";
import { CryptoIdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { migrateGlobal } from "@ai-office/storage-sqlite/database/migrate-global.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteCostRepository } from "@ai-office/storage-sqlite/repositories/sqlite-cost.repository.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteCapabilityPolicyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-capability-policy.repository.ts";
import { SqliteControlledExecutionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-controlled-execution.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqliteGlobalMemoryRepository } from "@ai-office/storage-sqlite/repositories/sqlite-global-memory.repository.ts";
import { SqliteMemoryReferenceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-memory-reference.repository.ts";
import { createDefaultConnectorRegistry } from "@ai-office/filesystem-connector/default-connector-registry.ts";
import { LlmProviderError } from "@ai-office/llm-gateway/provider.ts";
import {
  ConnectorRegistryError,
  UnsupportedConnectorError,
  UnsupportedConnectorOperationError,
  ConnectorExecutionUnavailableError,
} from "@ai-office/connector-sdk/errors.ts";
import { FilesystemConnectorError } from "@ai-office/filesystem-connector/errors.ts";
import { handleAgentCommand } from "./commands/agent.ts";
import { handleCostCommand } from "./commands/cost.ts";
import { handleGovernanceCommand } from "./commands/governance.ts";
import { handleProjectCommand } from "./commands/project.ts";
import { handleRunCommand } from "./commands/run.ts";
import {
  CliPromptRequiredError,
  CliUsageError,
  type CommandContext,
  type CommandIo,
} from "./commands/shared.ts";
import { handleTaskCommand } from "./commands/task.ts";
import { handleCapabilityCommand } from "./commands/capability.ts";
import { handleOfficeCommand } from "./commands/office.ts";
import { handleClientCommand } from "./commands/client.ts";
import { handleMemoryCommand } from "./commands/memory.ts";
import { handleLifecycleCommand } from "./commands/lifecycle.ts";
import { DefaultAgentClientCatalog } from "@ai-office/agent-client-integrations/registry.ts";
import { AgentClientIntegrationError } from "@ai-office/application/agent-client/errors.ts";
import { InvalidProjectInstructionContractError } from "@ai-office/domain/agent/project-instruction-contract.ts";
import {
  GlobalMemoryDeprecatedError,
  GlobalMemoryNotFoundError,
  GlobalMemorySourceMismatchError,
  GlobalMemoryVersionConflictError,
} from "@ai-office/application/memory-errors.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { parseOfficeManifestJson } from "@ai-office/application/office/office-manifest-schema.ts";
import { LocalProjectBindingAdapter } from "./local-project-binding-adapter.ts";
import { ProjectLifecycleError } from "@ai-office/application/project-lifecycle/manage-project-lifecycle.ts";
import { ProjectBindingError } from "@ai-office/application/project-lifecycle/project-binding.ts";
import { ProjectSourceAssociationError } from "@ai-office/application/commands/import-project.ts";

export { CliPromptRequiredError } from "./commands/shared.ts";
export type CliIo = CommandIo;

export const cliHelp = `AI Office CLI

Commands:
  install [path] [--rebind] [--json]
    exit 0: installed; exit 2: installed with warnings; exit 1: failed/partial
  status [path] [--json]
  uninstall [path] [--approve <plan-hash>] [--json]
  daemon  # available through the linkable ai-office entry point
  daemon:health
  project:create <name> [--description <description>] [--json]
  project:import [path] [--name <name>] [--json]
  project:answer --project <id> --question <id> --answer <value>  # legacy stored questions only
  project:profile --project <id>
  project:export --project <id>
  office:context --project <id>
  office:validate (--file <path> | --manifest <json>)
  office:apply --project <id> (--file <path> | --manifest <json>)
  office:show --project <id>
  office:pipeline --project <id> --task-kind <feature|bugfix|maintenance|research|release>
  client:detect [--client <codex|claude>]
  client:inspect --client <codex|claude> --root <path>
  client:plan --client <codex|claude> --root <path> --contract <file>
  client:apply --client <codex|claude> --root <path> --contract <file> --approve <plan-hash>
  client:validate --client <codex|claude> --root <path>
  client:uninstall --client <codex|claude> --root <path> [--approve <plan-hash>]
  runtime:purge [--approve <plan-hash>]  # local; daemon must be stopped
  task:create --project <id> --title <title> [--description <description>] [--priority <integer>]
  task:list --project <id>
  agent:sync --project <id> [--directory <path>]
  agent:list --project <id>
  run:schedule --project <id> --task <id> --agent <id> [--resource <id> --operation <name> [--arguments <json>]]
  run:tick --project <id> [--capacity <integer>]
  run:list --project <id>
  run:show --project <id> --run <id>
  pricing:set --provider <id> --model <id> --currency <USD|EUR> --input <micros> --cached-input <micros> --output <micros> --reasoning <micros>
  budget:set --project <id> --limit <micros> [--currency <USD|EUR>]
  cost:list --project <id> [--group-by <project|task|agent|agent_run>]
  milestone:create --project <id> --title <title> [--description <description>]
  milestone:set-status --project <id> --milestone <id> --status <status>
  requirement:create --project <id> --key <key> --title <title> --description <description> [--milestone <id>]
  requirement:set-status --project <id> --requirement <id> --status <status>
  adr:create --project <id> --title <title> --context <text> --decision <text> --consequences <text>
  adr:set-status --project <id> --adr <id> --status <status>
  review:create --project <id> --subject-type <type> --subject <id> --reviewer <name>
  review:decide --project <id> --review <id> --actor <name> --decision <approved|rejected> [--rationale <text>]
  governance:profile --project <id>
  governance:export --project <id>
  memory:role:create --name <name> --key <key> --version <n> --model-policy <policy> --max-iterations <n> --max-cost <micros> --timeout <seconds> [--description <text>] [--responsibilities <csv>] [--capabilities <csv>] [--tools <csv>]
  memory:pattern:create --name <name> --version <n> --problem <text> --context <text> --solution <text> [--id <id>] [--source-project <id>] [--applicability <csv>] [--constraints <csv>] [--risks <csv>]
  memory:lesson:create --title <title> --content <text> --confidence <0..1> [--source-project <id> --source-task <id>]
  memory:search --query <text> [--limit <1..100>] [--json]
  memory:pattern:adopt --project <id> --pattern <id> --version <n> [--query <text>]
  memory:references --project <id> [--json]
  memory:deprecate --type <role|pattern|lesson> --id <id> [--version <n>]  # version required for roles and patterns
  resource:create --project <id> --type <type> --provider <fake|filesystem> --name <name> [--external-ref <absolute-root>] [--configuration <json>]
  resource:list --project <id>
  resource:disable --project <id> --resource <id>
  capability:grant --project <id> --principal-type <type> --principal <id> --resource <id> --actions <csv> --granted-by <id> --reason <text> [--constraints <json>] [--valid-from <iso>] [--expires-at <iso>]
  capability:list --project <id>
  capability:revoke --project <id> --grant <id> --revoked-by <id>
  action:request --project <id> --agent <id> --resource <id> --operation <name> [--arguments <json>]
  action:invoke --project <id> (--action <id> | --agent <id> --resource <id> --operation <name> [--arguments <json>])
  action:approve --project <id> --action <id> --actor <audit-identity>
  action:reject --project <id> --action <id> --actor <audit-identity>
  action:execute --project <id> --action <id>
  action:list --project <id>
  action:show --project <id> --action <id>

Environment (linkable ai-office entry point):
  AI_OFFICE_HOME  runtime data home; defaults to ~/.ai-office`;

// runtime:purge is intentionally absent: the daemon client handles that
// destructive offline lifecycle boundary before protocol dispatch.
const commands = [
  "install",
  "status",
  "uninstall",
  "project:create",
  "project:import",
  "project:answer",
  "project:profile",
  "project:export",
  "office:context",
  "office:validate",
  "office:apply",
  "office:show",
  "office:pipeline",
  "client:detect",
  "client:inspect",
  "client:plan",
  "client:apply",
  "client:validate",
  "client:uninstall",
  "task:create",
  "task:list",
  "agent:sync",
  "agent:list",
  "run:schedule",
  "run:tick",
  "run:list",
  "run:show",
  "pricing:set",
  "budget:set",
  "cost:list",
  "milestone:create",
  "requirement:create",
  "adr:create",
  "milestone:set-status",
  "requirement:set-status",
  "adr:set-status",
  "review:create",
  "review:decide",
  "governance:profile",
  "governance:export",
  "memory:role:create",
  "memory:pattern:create",
  "memory:lesson:create",
  "memory:search",
  "memory:pattern:adopt",
  "memory:references",
  "memory:deprecate",
  "resource:create",
  "resource:list",
  "resource:disable",
  "capability:grant",
  "capability:list",
  "capability:revoke",
  "action:request",
  "action:invoke",
  "action:approve",
  "action:reject",
  "action:execute",
  "action:list",
  "action:show",
] as const;

type Command = (typeof commands)[number];
const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export interface CliOptions {
  projectRoot: string;
  runtimePaths?: RuntimePaths;
  migrationDirectory?: string;
  globalDatabasePath?: string;
  globalMigrationDirectory?: string;
  io?: CliIo;
  propagatePromptRequired?: boolean;
  agentClients?: AgentClientCatalog;
  projectBindings?: ProjectBindingAdapter;
  defaultOfficeManifest?: OfficeManifest;
}

function defaultOfficeManifest(): OfficeManifest {
  const manifest = parseOfficeManifestJson(
    readFileSync(
      join(
        sourceDirectory,
        "..",
        "..",
        "..",
        ".agents",
        "skills",
        "ai-office",
        "assets",
        "default-office-manifest.json",
      ),
      "utf8",
    ),
  );
  return {
    ...manifest,
    provenance: { ...manifest.provenance, host: "cli" },
  };
}

const handlers = [
  handleLifecycleCommand,
  handleProjectCommand,
  handleOfficeCommand,
  handleClientCommand,
  handleTaskCommand,
  handleAgentCommand,
  handleRunCommand,
  handleCostCommand,
  handleGovernanceCommand,
  handleMemoryCommand,
  handleCapabilityCommand,
] as const;

function isCommand(value: string): value is Command {
  return commands.some((command) => command === value);
}

function formatKnownError(error: unknown): string | null {
  if (
    error instanceof CliUsageError ||
    error instanceof DomainValidationError ||
    error instanceof ProjectNotFoundError ||
    error instanceof ProjectQuestionNotFoundError ||
    error instanceof ProjectQuestionAlreadyAnsweredError ||
    error instanceof InvalidProjectAnswerError ||
    error instanceof InvalidOfficeManifestError ||
    error instanceof OfficeManifestNotFoundError ||
    error instanceof OfficePipelineNotFoundError ||
    error instanceof AgentNotFoundError ||
    error instanceof TaskNotFoundError ||
    error instanceof TaskLockActiveError ||
    error instanceof TaskLockExpiredError ||
    error instanceof InvalidAgentDefinitionError ||
    error instanceof AgentDefinitionDirectoryError ||
    error instanceof PricingNotFoundError ||
    error instanceof PricingOverlapError ||
    error instanceof PricingCurrencyMismatchError ||
    error instanceof BudgetNotFoundError ||
    error instanceof BudgetExceededError ||
    error instanceof ReservationExpiredError ||
    error instanceof DuplicateProviderUsageError ||
    error instanceof MonetaryOverflowError ||
    error instanceof GovernanceCrossProjectReferenceError ||
    error instanceof GovernanceSubjectNotFoundError ||
    error instanceof ReviewNotFoundError ||
    error instanceof ReviewAlreadyFinalizedError ||
    error instanceof DuplicateRequirementKeyError ||
    error instanceof ResourceNotFoundError ||
    error instanceof ResourceDisabledError ||
    error instanceof CapabilityGrantNotFoundError ||
    error instanceof CapabilityGrantRevokedError ||
    error instanceof CapabilityPrincipalNotFoundError ||
    error instanceof CapabilityProjectMismatchError ||
    error instanceof ActionRequestNotFoundError ||
    error instanceof ConcurrentActionTransitionError ||
    error instanceof ActionSimulationConflictError ||
    error instanceof ActionApprovalNotFoundError ||
    error instanceof ActionApprovalConflictError ||
    error instanceof InvalidActionApprovalStateError ||
    error instanceof ActionExecutionConflictError ||
    error instanceof ActionExecutionNotFoundError ||
    error instanceof InvalidActionExecutionStateError ||
    error instanceof StaleActionSimulationError ||
    error instanceof InvalidConnectorInvocationStateError ||
    error instanceof StaleActionAuthorizationError ||
    error instanceof CapabilityValidationError ||
    error instanceof CanonicalSerializationError ||
    error instanceof InvalidActionTransitionError ||
    error instanceof InvalidActionTimestampError ||
    error instanceof TransactionAlreadyActiveError ||
    error instanceof ConnectorRegistryError ||
    error instanceof UnsupportedConnectorError ||
    error instanceof UnsupportedConnectorOperationError ||
    error instanceof ConnectorExecutionUnavailableError ||
    error instanceof FilesystemConnectorError ||
    error instanceof LlmProviderError ||
    error instanceof AgentClientIntegrationError ||
    error instanceof InvalidProjectInstructionContractError ||
    error instanceof GlobalMemoryDeprecatedError ||
    error instanceof GlobalMemoryNotFoundError ||
    error instanceof GlobalMemorySourceMismatchError ||
    error instanceof GlobalMemoryVersionConflictError ||
    error instanceof ProjectLifecycleError ||
    error instanceof ProjectSourceAssociationError ||
    error instanceof ProjectBindingError
  )
    return error.message;
  return null;
}

export async function runCli(
  args: string[],
  options: CliOptions,
): Promise<number> {
  const io = options.io ?? defaultIo;
  const [command, ...commandArguments] = args;
  if (
    command === undefined ||
    command === "help" ||
    command === "--help" ||
    command === "-h"
  ) {
    io.stdout(cliHelp);
    return 0;
  }
  if (!isCommand(command)) {
    io.stderr(`Unknown command: ${command}\n\n${cliHelp}`);
    return 1;
  }

  const runtimePaths = withRuntimePathOverrides(
    options.runtimePaths ??
      resolveRuntimePaths({
        mode: "development",
        developmentRoot: options.projectRoot,
      }),
    options.globalDatabasePath === undefined
      ? {}
      : { globalDatabasePath: options.globalDatabasePath },
  );
  const database = openDatabase(runtimePaths.projectDatabasePath);
  let globalDatabase: ReturnType<typeof openDatabase> | null = null;
  try {
    migrate(
      database,
      options.migrationDirectory ??
        join(sourceDirectory, "..", "..", "..", "migrations", "project"),
    );
    if (command.startsWith("memory:")) {
      globalDatabase = openDatabase(runtimePaths.globalDatabasePath);
      migrateGlobal(
        globalDatabase,
        options.globalMigrationDirectory ??
          join(sourceDirectory, "..", "..", "..", "migrations", "global"),
      );
    }
    const ids = new CryptoIdGenerator();
    const clock = new SystemClock();
    const capabilities = new SqliteCapabilityPolicyRepository(database);
    const controlled = new SqliteControlledExecutionRepository(database);
    const costs = new SqliteCostRepository(database);
    const context: CommandContext = {
      projectRoot: options.projectRoot,
      runtimeHome: runtimePaths.runtimeHome,
      io,
      projects: new SqliteProjectRepository(database),
      profiles: new SqliteProjectProfileRepository(database),
      officeManifests: new SqliteOfficeManifestRepository(database),
      tasks: new SqliteTaskRepository(database),
      runtime: new SqliteAgentRuntimeRepository(database),
      costs,
      governance: new SqliteGovernanceRepository(database),
      capabilities,
      controlled,
      audit: new RecordAuditEvent(
        new SqliteAuditEventRepository(database),
        ids,
        clock,
      ),
      ids,
      clock,
      transactions: new SqliteTransactionRunner(database),
      connectors: createDefaultConnectorRegistry(),
      agentClients: options.agentClients ?? new DefaultAgentClientCatalog(),
      projectBindings:
        options.projectBindings ?? new LocalProjectBindingAdapter(),
      repositoryIdentities: new SqliteRepositoryIdentityRepository(database),
      defaultOfficeManifest:
        options.defaultOfficeManifest ?? defaultOfficeManifest(),
      memoryReferences: new SqliteMemoryReferenceRepository(database),
      ...(globalDatabase === null
        ? {}
        : { memory: new SqliteGlobalMemoryRepository(globalDatabase) }),
    };
    for (const handler of handlers) {
      const result = await handler(command, commandArguments, context);
      if (result !== null) return result;
    }
    throw new CliUsageError(`No handler is registered for ${command}`);
  } catch (error) {
    if (
      error instanceof CliPromptRequiredError &&
      options.propagatePromptRequired === true
    )
      throw error;
    const message = formatKnownError(error);
    if (message !== null) {
      io.stderr(message);
      return 1;
    }
    io.stderr("AI Office failed because of an unexpected error.");
    return 1;
  } finally {
    globalDatabase?.close();
    database.close();
  }
}
