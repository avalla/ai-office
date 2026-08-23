import { createInterface } from "node:readline/promises";
import { join, resolve } from "node:path";
import { cliHelp, type CliIo } from "./cli.ts";
import {
  DaemonClient,
  DaemonUnavailableError,
  InvalidDaemonResponseError,
} from "./daemon-client.ts";
import type { RuntimePurgeAdapter } from "@ai-office/application/ports/runtime-purge-adapter.port.ts";
import { runRuntimePurgeCli } from "./runtime-purge-cli.ts";
import type { ProjectBindingAdapter } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import { LocalProjectBindingAdapter } from "./local-project-binding-adapter.ts";
import { getOfflineProjectStatus } from "./offline-project-status.ts";
import { printProjectLifecycleStatus } from "./commands/lifecycle.ts";
import { ProjectBindingError } from "@ai-office/application/project-lifecycle/project-binding.ts";

export interface DaemonCliOptions {
  projectRoot: string;
  socketPath?: string;
  io?: CliIo;
  runtimePurgeAdapter?: RuntimePurgeAdapter;
  workingDirectory?: string;
  projectBindings?: ProjectBindingAdapter;
  agentClients?: AgentClientCatalog;
}

const defaultIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

function promptContext(lines: string[]): string[] {
  let lastSaved = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index]?.startsWith("Answer saved:") === true) {
      lastSaved = index;
      break;
    }
  }
  return lines.slice(lastSaved + 1);
}

function withoutRepeatedPrefix(lines: string[], prefix: string[]): string[] {
  const maximumOverlap = Math.min(lines.length, prefix.length);
  for (let overlap = maximumOverlap; overlap > 0; overlap -= 1) {
    const previousSuffix = prefix.slice(prefix.length - overlap);
    if (previousSuffix.every((line, index) => lines[index] === line)) {
      return lines.slice(overlap);
    }
  }
  return lines;
}

const projectScopedCommands = new Set([
  "project:onboard",
  "project:answer",
  "project:profile",
  "project:export",
  "office:context",
  "office:apply",
  "office:show",
  "office:pipeline",
  "task:create",
  "task:list",
  "agent:sync",
  "agent:list",
  "run:schedule",
  "run:tick",
  "run:list",
  "run:show",
  "budget:set",
  "cost:list",
  "milestone:create",
  "milestone:set-status",
  "requirement:create",
  "requirement:set-status",
  "adr:create",
  "adr:set-status",
  "review:create",
  "review:decide",
  "governance:profile",
  "governance:export",
  "memory:pattern:adopt",
  "memory:references",
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
]);

function lifecycleArguments(
  args: string[],
  workingDirectory: string,
): string[] {
  const command = args[0];
  if (command !== "install" && command !== "status" && command !== "uninstall")
    return args;
  const result = [...args];
  let positionalIndex = -1;
  for (let index = 1; index < result.length; index += 1) {
    const argument = result[index];
    if (argument === "--approve") {
      index += 1;
      continue;
    }
    if (argument?.startsWith("--") === true) continue;
    positionalIndex = index;
    break;
  }
  if (positionalIndex === -1) result.splice(1, 0, workingDirectory);
  else
    result[positionalIndex] = resolve(
      workingDirectory,
      result[positionalIndex]!,
    );
  return result;
}

async function resolvedArguments(
  args: string[],
  workingDirectory: string,
  bindings: ProjectBindingAdapter,
): Promise<{ args: string[]; discoveredProjectId?: string }> {
  const lifecycle = lifecycleArguments(args, workingDirectory);
  const command = lifecycle[0];
  if (
    command === undefined ||
    !projectScopedCommands.has(command) ||
    lifecycle.includes("--project")
  )
    return { args: lifecycle };
  const inspection = await bindings.inspect(workingDirectory, {
    ancestors: true,
  });
  if (inspection.status === "invalid")
    throw new ProjectBindingError(
      inspection.issue ?? "Project binding is invalid",
    );
  if (inspection.status !== "valid" || inspection.binding === undefined)
    return { args: lifecycle };
  return {
    args: [...lifecycle, "--project", inspection.binding.projectId],
    discoveredProjectId: inspection.binding.projectId,
  };
}

async function verifyDiscoveredProject(
  client: DaemonClient,
  workingDirectory: string,
  projectId: string,
): Promise<void> {
  const response = await client.execute(["status", workingDirectory, "--json"]);
  const firstLine = response.stdout[0];
  let value: unknown;
  try {
    value = firstLine === undefined ? undefined : JSON.parse(firstLine);
  } catch {
    throw new InvalidDaemonResponseError(
      "Daemon returned invalid project binding status",
    );
  }
  if (typeof value !== "object" || value === null)
    throw new InvalidDaemonResponseError(
      "Daemon returned invalid project binding status",
    );
  const status = value as {
    schemaVersion?: unknown;
    project?: { id?: unknown; binding?: { state?: unknown } };
    runtime?: { authoritativeState?: unknown };
  };
  if (
    status.schemaVersion !== 1 ||
    status.project?.id !== projectId ||
    status.project.binding?.state !== "valid" ||
    status.runtime?.authoritativeState !== "available"
  )
    throw new ProjectBindingError(
      "The discovered project binding is not valid in the current runtime. Run ai-office status for recovery details.",
    );
}

export async function runDaemonCli(
  args: string[],
  options: DaemonCliOptions,
): Promise<number> {
  const io = options.io ?? defaultIo;
  const socketPath =
    options.socketPath ??
    join(options.projectRoot, ".ai-office", "daemon.sock");
  const client = new DaemonClient(socketPath);
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const bindings = options.projectBindings ?? new LocalProjectBindingAdapter();

  try {
    if (
      args.length === 0 ||
      args[0] === "help" ||
      args[0] === "--help" ||
      args[0] === "-h"
    ) {
      io.stdout(cliHelp);
      return 0;
    }

    if (args[0] === "daemon:health") {
      const health = await client.health();
      io.stdout(`Daemon status: ${health.status}`);
      io.stdout(`Started at: ${health.startedAt}`);
      return 0;
    }

    if (args[0] === "runtime:purge")
      return runRuntimePurgeCli(args.slice(1), {
        runtimeRoot: options.projectRoot,
        daemonClient: client,
        io,
        ...(options.runtimePurgeAdapter === undefined
          ? {}
          : { adapter: options.runtimePurgeAdapter }),
      });

    const prepared = await resolvedArguments(args, workingDirectory, bindings);
    if (prepared.discoveredProjectId !== undefined)
      await verifyDiscoveredProject(
        client,
        workingDirectory,
        prepared.discoveredProjectId,
      );
    const reader =
      io.prompt === undefined
        ? createInterface({ input: process.stdin, output: process.stdout })
        : undefined;
    const prompt =
      io.prompt ?? ((message: string) => reader!.question(message));
    let answer: string | undefined;
    let previousPromptContext: string[] = [];

    try {
      while (true) {
        const response = await client.execute(prepared.args, answer);
        const stdout = withoutRepeatedPrefix(
          response.stdout,
          previousPromptContext,
        );
        for (const line of stdout) io.stdout(line);
        for (const line of response.stderr) io.stderr(line);

        if (response.prompt === undefined) return response.exitCode ?? 1;
        previousPromptContext = promptContext(response.stdout);
        answer = await prompt(response.prompt.message);
      }
    } finally {
      reader?.close();
    }
  } catch (error) {
    if (error instanceof DaemonUnavailableError && args[0] === "status") {
      const prepared = lifecycleArguments(args, workingDirectory);
      const status = await getOfflineProjectStatus(prepared[1]!, {
        bindings,
        ...(options.agentClients === undefined
          ? {}
          : { clients: options.agentClients }),
      });
      if (args.includes("--json")) io.stdout(JSON.stringify(status));
      else printProjectLifecycleStatus(status, { io });
      return 1;
    }
    if (
      error instanceof DaemonUnavailableError ||
      error instanceof InvalidDaemonResponseError ||
      error instanceof ProjectBindingError
    ) {
      io.stderr(error.message);
      return 1;
    }
    throw error;
  }
}
