import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";
import type { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import type { SqliteCostRepository } from "@ai-office/storage-sqlite/repositories/sqlite-cost.repository.ts";
import type { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import type { SqliteProjectProfileRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project-profile.repository.ts";
import type { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import type { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import type { SqliteCapabilityPolicyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-capability-policy.repository.ts";
import type { SqliteControlledExecutionRepository } from "@ai-office/storage-sqlite/repositories/sqlite-controlled-execution.repository.ts";
import type { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import type { ConnectorRegistry } from "@ai-office/connector-sdk/connector-registry.ts";
import type { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import type { GlobalMemoryRepository } from "@ai-office/application/ports/global-memory-repository.port.ts";
import type { MemoryReferenceRepository } from "@ai-office/application/ports/memory-reference-repository.port.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import type { SqliteRepositoryIdentityRepository } from "@ai-office/storage-sqlite/repositories/sqlite-repository-identity.repository.ts";

export interface CommandIo {
  stdout(message: string): void;
  stderr(message: string): void;
  prompt?(message: string): Promise<string>;
}

export interface CommandContext {
  projectRoot: string;
  runtimeHome: string;
  io: CommandIo;
  projects: SqliteProjectRepository;
  profiles: SqliteProjectProfileRepository;
  officeManifests: SqliteOfficeManifestRepository;
  tasks: SqliteTaskRepository;
  runtime: SqliteAgentRuntimeRepository;
  costs: SqliteCostRepository;
  governance: SqliteGovernanceRepository;
  capabilities: SqliteCapabilityPolicyRepository;
  controlled: SqliteControlledExecutionRepository;
  audit: RecordAuditEvent;
  ids: IdGenerator;
  clock: Clock;
  transactions: TransactionRunner;
  connectors: ConnectorRegistry;
  agentClients: AgentClientCatalog;
  projectBindings: ProjectBindingAdapter;
  repositoryIdentities: SqliteRepositoryIdentityRepository;
  defaultOfficeManifest: OfficeManifest;
  memory?: GlobalMemoryRepository;
  memoryReferences: MemoryReferenceRepository;
}

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export class CliPromptRequiredError extends Error {
  constructor(readonly prompt: string) {
    super("CLI input is required");
    this.name = "CliPromptRequiredError";
  }
}

export interface ParsedArguments {
  positionals: string[];
  options: ReadonlyMap<string, string>;
  flags: ReadonlySet<string>;
}

export function parseArguments(
  args: string[],
  allowedOptions: ReadonlySet<string>,
  allowedFlags: ReadonlySet<string> = new Set(),
): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (allowedFlags.has(name)) {
      if (flags.has(name))
        throw new CliUsageError(`Flag --${name} can only be provided once`);
      flags.add(name);
      continue;
    }
    if (!allowedOptions.has(name))
      throw new CliUsageError(`Unknown option --${name}`);
    if (options.has(name))
      throw new CliUsageError(`Option --${name} can only be provided once`);
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new CliUsageError(`Option --${name} requires a value`);
    options.set(name, value);
    index += 1;
  }
  return { positionals, options, flags };
}

export function requiredOption(
  arguments_: ParsedArguments,
  name: string,
): string {
  const value = arguments_.options.get(name);
  if (value === undefined)
    throw new CliUsageError(`Missing required option --${name}`);
  return value;
}

export function jsonObject(
  value: string | undefined,
  name: string,
): Readonly<Record<string, unknown>> {
  if (value === undefined) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error();
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    throw new CliUsageError(`Option --${name} must be a JSON object`);
  }
}

export function nonNegativeBigInt(value: string, name: string): bigint {
  try {
    const parsed = BigInt(value);
    if (parsed < 0n) throw new Error();
    return parsed;
  } catch {
    throw new CliUsageError(`Option --${name} must be a non-negative integer`);
  }
}

export function currency(value: string): "USD" | "EUR" {
  if (value !== "USD" && value !== "EUR")
    throw new CliUsageError("Currency must be USD or EUR");
  return value;
}
