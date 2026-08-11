import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { createDefaultConnectorRegistry } from "@ai-office/filesystem-connector/default-connector-registry.ts";
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

export { CliPromptRequiredError } from "./commands/shared.ts";
export type CliIo = CommandIo;

export const cliHelp = `AI Office CLI

Commands:
  daemon:health
  project:create <name> [--description <description>]
  project:import [path] [--name <name>]
  project:onboard --project <id>
  project:answer --project <id> --question <id> --answer <value>
  project:profile --project <id>
  project:export --project <id>
  task:create --project <id> --title <title> [--description <description>] [--priority <integer>]
  task:list --project <id>
  agent:sync --project <id> [--directory <path>]
  agent:list --project <id>
  run:schedule --project <id> --task <id> --agent <id>
  run:tick --project <id> [--capacity <integer>]
  run:list --project <id>
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
  resource:create --project <id> --type <type> --provider <fake|filesystem> --name <name> [--external-ref <absolute-root>] [--configuration <json>]
  resource:list --project <id>
  resource:disable --project <id> --resource <id>
  capability:grant --project <id> --principal-type <type> --principal <id> --resource <id> --actions <csv> --granted-by <id> --reason <text> [--constraints <json>] [--valid-from <iso>] [--expires-at <iso>]
  capability:list --project <id>
  capability:revoke --project <id> --grant <id> --revoked-by <id>
  action:request --project <id> --agent <id> --resource <id> --operation <name> [--arguments <json>]
  action:invoke --project <id> (--action <id> | --agent <id> --resource <id> --operation <name> [--arguments <json>])
  action:list --project <id>
  action:show --project <id> --action <id>`;

const commands = [
  "project:create",
  "project:import",
  "project:onboard",
  "project:answer",
  "project:profile",
  "project:export",
  "task:create",
  "task:list",
  "agent:sync",
  "agent:list",
  "run:schedule",
  "run:tick",
  "run:list",
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
  "resource:create",
  "resource:list",
  "resource:disable",
  "capability:grant",
  "capability:list",
  "capability:revoke",
  "action:request",
  "action:invoke",
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
  migrationDirectory?: string;
  io?: CliIo;
  propagatePromptRequired?: boolean;
}

const handlers = [
  handleProjectCommand,
  handleTaskCommand,
  handleAgentCommand,
  handleRunCommand,
  handleCostCommand,
  handleGovernanceCommand,
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
    error instanceof FilesystemConnectorError
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

  const database = openDatabase(
    join(options.projectRoot, ".ai-office", "project.sqlite"),
  );
  try {
    migrate(
      database,
      options.migrationDirectory ??
        join(sourceDirectory, "..", "..", "..", "migrations", "project"),
    );
    const ids = new CryptoIdGenerator();
    const clock = new SystemClock();
    const capabilities = new SqliteCapabilityPolicyRepository(database);
    const context: CommandContext = {
      projectRoot: options.projectRoot,
      io,
      projects: new SqliteProjectRepository(database),
      profiles: new SqliteProjectProfileRepository(database),
      tasks: new SqliteTaskRepository(database),
      runtime: new SqliteAgentRuntimeRepository(database),
      costs: new SqliteCostRepository(database),
      governance: new SqliteGovernanceRepository(database),
      capabilities,
      audit: new RecordAuditEvent(
        new SqliteAuditEventRepository(database),
        ids,
        clock,
      ),
      ids,
      clock,
      transactions: new SqliteTransactionRunner(database),
      connectors: createDefaultConnectorRegistry(),
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
    database.close();
  }
}
