import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { resolveCallerLocalPaths } from "@ai-office/command-support/caller-local-paths.ts";
import {
  isLocalHelpInvocation,
  runtimeCommandHelp as cliHelp,
} from "@ai-office/command-support/help.ts";
import type { CommandIo as CliIo } from "@ai-office/command-support/arguments.ts";
import {
  IpcRuntimeClient,
  InvalidDaemonResponseError,
  RuntimeUnavailableError,
} from "./daemon-client.ts";
import type { RuntimeClient } from "@ai-office/application/runtime/runtime-client.port.ts";
import type { RuntimePurgeAdapter } from "@ai-office/application/ports/runtime-purge-adapter.port.ts";
import { runRuntimePurgeCli } from "./runtime-purge-cli.ts";
import { runDashboardCli } from "./dashboard-cli.ts";
import {
  CliUsageError,
  parseArguments,
} from "@ai-office/command-support/arguments.ts";
import type { ProjectBindingReader } from "@ai-office/application/ports/project-binding-adapter.port.ts";
import type { AgentClientCatalog } from "@ai-office/application/ports/agent-client-adapter.port.ts";
import { LocalProjectBindingReader } from "@ai-office/project-binding/local-project-binding-reader.ts";
import { getOfflineProjectStatus } from "./offline-project-status.ts";
import {
  printProjectLifecycleStatus,
  projectStatusExitCode,
} from "@ai-office/command-support/lifecycle-view.ts";
import { renderHandoverReport } from "@ai-office/command-support/handover-view.ts";
import { degradedProjectHandoverReport } from "@ai-office/application/project-lifecycle/assess-project-handover.ts";
import { ProjectBindingError } from "@ai-office/application/project-lifecycle/project-binding.ts";
import {
  resolveRuntimePaths,
  RuntimePathError,
  type RuntimePaths,
} from "@ai-office/runtime-paths/runtime-paths.ts";

export interface RuntimeCliOptions {
  projectRoot?: string;
  runtimePaths?: RuntimePaths;
  socketPath?: string;
  io?: CliIo;
  runtimePurgeAdapter?: RuntimePurgeAdapter;
  workingDirectory?: string;
  projectBindings?: ProjectBindingReader;
  agentClients?: AgentClientCatalog;
  /** Stops the foreground `dashboard` host; supplied by tests. */
  dashboardSignal?: AbortSignal;
  openBrowser?: (url: string) => Promise<void>;
  runtimeClient?: RuntimeClient;
}

/** @deprecated Use RuntimeCliOptions. */
export type DaemonCliOptions = RuntimeCliOptions;

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
  "handover:confirm",
  "project:answer",
  "project:profile",
  "project:export",
  "project:backup",
  "office:context",
  "office:apply",
  "office:show",
  "office:pipeline",
  "pipeline:start",
  "pipeline:status",
  "pipeline:assign",
  "pipeline:transition",
  "pipeline:override",
  "task:create",
  "task:list",
  "task:transitions",
  "task:start",
  "task:submit-review",
  "task:complete",
  "task:block",
  "task:unblock",
  "task:fail",
  "task:cancel",
  "task:record-completion",
  "task:link-requirement",
  "task:unlink-requirement",
  "task:reconcile",
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

async function resolvedArguments(
  args: string[],
  workingDirectory: string,
  bindings: ProjectBindingReader,
): Promise<{ args: string[]; discoveredRoot?: string }> {
  const resolved = resolveCallerLocalPaths(args, workingDirectory);
  const command = resolved[0];
  if (
    command === undefined ||
    !projectScopedCommands.has(command) ||
    resolved.includes("--project")
  )
    return { args: resolved };
  const inspection = await bindings.inspect(workingDirectory, {
    ancestors: true,
  });
  if (inspection.status === "invalid")
    throw new ProjectBindingError(
      inspection.issue ?? "Project binding is invalid",
    );
  if (inspection.status !== "valid" || inspection.binding === undefined)
    return { args: resolved };
  return {
    args: resolved,
    discoveredRoot: inspection.rootPath,
  };
}

async function resolveDiscoveredProject(
  client: RuntimeClient,
  rootPath: string,
): Promise<string> {
  const response = await client.execute(["status", rootPath, "--json"]);
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
    project?: {
      id?: unknown;
      repositoryIdentity?: { state?: unknown };
      runtimeAssociation?: { state?: unknown };
    };
    runtime?: { authoritativeState?: unknown };
  };
  if (
    (status.schemaVersion !== 2 &&
      status.schemaVersion !== 3 &&
      status.schemaVersion !== 4) ||
    typeof status.project?.id !== "string" ||
    (status.project.repositoryIdentity?.state !== "valid" &&
      status.project.repositoryIdentity?.state !== "legacy") ||
    status.project.runtimeAssociation?.state !== "valid" ||
    status.runtime?.authoritativeState !== "available"
  )
    throw new ProjectBindingError(
      "The discovered project binding is not valid in the current runtime. Run ai-office status for recovery details.",
    );
  return status.project.id;
}

export async function runRuntimeCli(
  args: string[],
  options: RuntimeCliOptions,
): Promise<number> {
  const io = options.io ?? defaultIo;
  if (isLocalHelpInvocation(args)) {
    io.stdout(cliHelp);
    return 0;
  }
  let runtimePaths: RuntimePaths;
  try {
    runtimePaths =
      options.runtimePaths ??
      resolveRuntimePaths({
        mode: "development",
        developmentRoot: options.projectRoot ?? process.cwd(),
      });
  } catch (error) {
    if (error instanceof RuntimePathError) {
      io.stderr(error.message);
      return 1;
    }
    throw error;
  }
  const socketPath = options.socketPath ?? runtimePaths.socketPath;
  const client = options.runtimeClient ?? new IpcRuntimeClient(socketPath);
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const bindings = options.projectBindings ?? new LocalProjectBindingReader();

  try {
    if (
      args[0] === "daemon:health" ||
      args[0] === "runtime:health" ||
      (args[0] === "runtime" && args[1] === "status" && args.length === 2)
    ) {
      const health = await client.health();
      io.stdout(
        `${args[0] === "daemon:health" ? "Daemon" : "Runtime"} status: ${health.status}`,
      );
      io.stdout(`Started at: ${health.startedAt}`);
      return 0;
    }

    if (args[0] === "runtime" && args[1] === "start") {
      io.stderr(
        'Start the persistent AI Office Runtime host with "ai-office runtime start" through the linkable CLI.',
      );
      return 1;
    }

    // The dashboard is a foreground local host, not a Runtime command: it is
    // handled before protocol dispatch for the same reason runtime:purge is.
    // Awaited on purpose: returning the promise from inside the try would let
    // a rejection bypass the catch below.
    if (args[0] === "dashboard")
      return await runDashboardCli(args.slice(1), {
        socketPath,
        io,
        ...(options.dashboardSignal === undefined
          ? {}
          : { signal: options.dashboardSignal }),
        ...(options.openBrowser === undefined
          ? {}
          : { openBrowser: options.openBrowser }),
      });

    if (args[0] === "runtime:purge")
      return runRuntimePurgeCli(args.slice(1), {
        runtimeRoot: runtimePaths.runtimeHome,
        daemonClient: client,
        io,
        ...(options.runtimePurgeAdapter === undefined
          ? {}
          : { adapter: options.runtimePurgeAdapter }),
      });

    if (args[0] === "status" && args.includes("--offline")) {
      // Explicit offline inspection is still `status [path] [--offline]
      // [--json]`. Validating with the shared parser before anything else
      // keeps one grammar and stops a malformed invocation from being answered
      // as if it were well formed.
      const parsed = parseArguments(
        args.slice(1),
        new Set(),
        new Set(["offline", "json"]),
      );
      if (parsed.positionals.length > 1)
        throw new CliUsageError("status accepts at most one project path");
      const status = await getOfflineProjectStatus(
        resolve(workingDirectory, parsed.positionals[0] ?? "."),
        {
          runtimeHome: runtimePaths.runtimeHome,
          // No health or command request is made on this path, so the only
          // honest thing the report can say about the host is that it was not
          // checked.
          hostEvidence: "not_checked",
          bindings,
          ...(options.agentClients === undefined
            ? {}
            : { clients: options.agentClients }),
        },
      );
      if (parsed.flags.has("json")) io.stdout(JSON.stringify(status));
      else printProjectLifecycleStatus(status, { io });
      return projectStatusExitCode(status.health);
    }

    const prepared = await resolvedArguments(args, workingDirectory, bindings);
    const commandArguments =
      prepared.discoveredRoot === undefined
        ? prepared.args
        : [
            ...prepared.args,
            "--project",
            await resolveDiscoveredProject(client, prepared.discoveredRoot),
          ];
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
        const response = await client.execute(commandArguments, answer);
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
    if (
      error instanceof RuntimeUnavailableError &&
      (args[0] === "status" || args[0] === "next")
    ) {
      const prepared = resolveCallerLocalPaths(args, workingDirectory);
      const status = await getOfflineProjectStatus(prepared[1]!, {
        runtimeHome: runtimePaths.runtimeHome,
        // A request to the host was made and failed, so "unreachable" is
        // supported by evidence here in a way it never is under --offline.
        hostEvidence: "unreachable",
        bindings,
        ...(options.agentClients === undefined
          ? {}
          : { clients: options.agentClients }),
      });
      // The authoritative runtime is unreachable, so the handover assessment
      // is degraded on purpose: it reports what the repository proves and
      // never guesses management state it cannot read.
      const handover = degradedProjectHandoverReport(status);
      if (args[0] === "next") {
        if (args.includes("--json")) io.stdout(JSON.stringify(handover));
        else renderHandoverReport(handover, { stdout: io.stdout });
        return 1;
      }
      if (args.includes("--json")) io.stdout(JSON.stringify(status));
      else printProjectLifecycleStatus(status, { io }, handover);
      return 1;
    }
    if (
      error instanceof RuntimeUnavailableError ||
      error instanceof InvalidDaemonResponseError ||
      error instanceof ProjectBindingError ||
      error instanceof RuntimePathError ||
      error instanceof CliUsageError
    ) {
      io.stderr(error.message);
      return 1;
    }
    throw error;
  }
}

/** @deprecated Use runRuntimeCli. */
export const runDaemonCli = runRuntimeCli;
