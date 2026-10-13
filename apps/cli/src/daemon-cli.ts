import { createInterface, type Interface } from "node:readline/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  codexProjectSkillPath,
  isManagedProjectSkillContent,
} from "@ai-office/agent-client-integrations/adapters.ts";
import { isLocalVersionInvocation } from "@ai-office/command-support/version.ts";
import { runVersionCli } from "./version-cli.ts";
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
import { runDistributionUpdateCli } from "./distribution-update-cli.ts";
import type { DistributionUpdateAdapter } from "@ai-office/application/ports/distribution-update-adapter.port.ts";
import { runRuntimePurgeCli } from "./runtime-purge-cli.ts";
import { runDashboardCli } from "./dashboard-cli.ts";
import { runServiceCli } from "./service-cli.ts";
import { runCredentialCli, type CredentialInput } from "./credential-cli.ts";
import type { OfficeServiceManager } from "@ai-office/application/ports/office-service-manager.port.ts";
import type { OfficeServicePlan } from "@ai-office/service-management/service-plan.ts";
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
  ensureRuntimeHome,
  resolveRuntimePaths,
  RuntimePathError,
  type RuntimePaths,
} from "@ai-office/runtime-paths/runtime-paths.ts";

export interface RuntimeCliOptions {
  projectRoot?: string;
  distributionRoot?: string;
  distributionUpdateAdapter?: DistributionUpdateAdapter;
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
  /**
   * How the generated OS service definitions invoke AI Office. Only an entry
   * point that knows its own absolute launcher can supply this, so `service`
   * is unavailable without it rather than guessing a path.
   */
  serviceProgram?: {
    launcher: readonly string[];
    requiresSourceRuntimeOptIn: boolean;
  };
  /** Test seam: observes the plan and supplies an isolated adapter. */
  selectServiceManager?: (plan: OfficeServicePlan) => OfficeServiceManager;
  servicePlatform?: string;
  /** Test seam: stdin for `credential set`. */
  credentialInput?: CredentialInput;
}

/** @deprecated Use RuntimeCliOptions. */
export type DaemonCliOptions = RuntimeCliOptions;

/**
 * Creating the `process.stdout` stream makes a pipe on fd 1 non-blocking in
 * Bun, after which `console.log` silently drops whatever the pipe cannot take
 * in one write. Default stdout therefore stays on `console.log` until an
 * interactive prompt opens that stream, and then writes through the stream,
 * which honors backpressure and drains before the process exits naturally.
 */
let promptStdout: typeof process.stdout | undefined;

function openPromptReader(): Interface {
  promptStdout = process.stdout;
  return createInterface({ input: process.stdin, output: promptStdout });
}

const defaultIo: CliIo = {
  stdout: (message) => {
    if (promptStdout === undefined) console.log(message);
    else promptStdout.write(`${message}\n`);
  },
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
  "project:pack:show",
  "project:pack:preview",
  "project:pack:apply",
  "project:pack:upgrade",
  "project:definition:show",
  "project:definition:preview",
  "project:definition:apply",
  "project:configuration:show",
  "project:configuration:legacy",
  "office:context",
  "office:workspace",
  "office:apply",
  "office:show",
  "office:pipeline",
  "pipeline:start",
  "pipeline:status",
  "pipeline:assign",
  "pipeline:transition",
  "pipeline:override",
  "task:create",
  "task:update",
  "task:list",
  "task:transitions",
  "task:dependency:add",
  "task:dependency:remove",
  "task:readiness",
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
  "agent:models",
  "model:check",
  "model:override",
  "run:schedule",
  "run:tick",
  "run:list",
  "run:show",
  "budget:set",
  "cost:list",
  "milestone:create",
  "milestone:update",
  "milestone:set-status",
  "requirement:create",
  "requirement:list",
  "requirement:validate",
  "requirement:update",
  "requirement:assign-milestone",
  "requirement:set-status",
  "adr:create",
  "adr:set-status",
  "review:create",
  "review:decide",
  "governance:profile",
  "governance:export",
  "memory:pattern:adopt",
  "memory:references",
  "knowledge:search",
  "knowledge:task",
  "knowledge:plan",
  "knowledge:admit",
  "knowledge:trace",
  "delivery:setup:show",
  "delivery:setup:set",
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
  const modelOverrideScope =
    command === "model:override"
      ? resolved[resolved.indexOf("--scope") + 1]
      : undefined;
  if (
    command === undefined ||
    !projectScopedCommands.has(command) ||
    resolved.includes("--project") ||
    (command === "model:override" && modelOverrideScope === "host")
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

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * ADR-0033: `office:apply` only persists a manifest revision. When the caller
 * runs inside the repository bound to the applied project, the client then
 * reconciles the generated guidance through the existing `install` flow. The
 * revision is already committed, so a failed refresh is reported on stderr and
 * never changes the apply exit code.
 */
async function refreshGeneratedGuidance(input: {
  client: RuntimeClient;
  bindings: ProjectBindingReader;
  workingDirectory: string;
  appliedProjectId: string | undefined;
  io: CliIo;
  /** Explicit non-interactive approval (`--refresh-guidance`). */
  approved: boolean;
  /** True when a person can answer: a test prompt or a terminal. */
  interactive: boolean;
  prompt: (message: string) => Promise<string>;
}): Promise<void> {
  const recovery =
    "Run ai-office install . from the repository to refresh the generated guidance.";
  try {
    const inspection = await input.bindings.inspect(input.workingDirectory, {
      ancestors: true,
    });
    if (inspection.status !== "valid" || inspection.binding === undefined)
      return;
    let boundProjectId: string;
    try {
      boundProjectId = await resolveDiscoveredProject(
        input.client,
        inspection.rootPath,
      );
    } catch (error) {
      // A binding this Runtime does not know is not this project's repository.
      if (error instanceof ProjectBindingError) return;
      throw error;
    }
    if (boundProjectId !== input.appliedProjectId) return;
    // ADR-0033: the refresh rewrites repository files, so it needs approval:
    // the explicit flag, or an interactive answer. Without either the
    // revision stays committed and the files stay untouched.
    let approved = input.approved;
    if (!approved && input.interactive)
      approved = /^y(es)?$/iu.test(
        (
          await input.prompt(
            "Refresh the generated project guidance in this repository now (runs ai-office install .)? [y/N] ",
          )
        ).trim(),
      );
    if (!approved) {
      input.io.stderr(
        `The manifest revision was applied; the generated guidance was not refreshed. ${recovery} Or rerun office:apply with --refresh-guidance.`,
      );
      return;
    }
    const response = await input.client.execute([
      "install",
      inspection.rootPath,
      "--json",
    ]);
    const exitCode = response.exitCode ?? 1;
    if (exitCode !== 0 && exitCode !== 2) {
      input.io.stderr(
        `The manifest revision was applied, but refreshing the generated guidance failed. ${recovery}`,
      );
      return;
    }
    const installed = JSON.parse(response.stdout[0] ?? "{}") as {
      changes?: unknown[];
    };
    // Exit 0 does not prove a user-owned skill was refreshed (`clientIssues`
    // hides unmanaged configurations of undetected clients), and a client
    // reported as unmanaged may still own a managed skill. Inspect the skill
    // files themselves: a skill without the managed marker was preserved.
    const skillFile = join(inspection.rootPath, codexProjectSkillPath);
    let preserved = false;
    try {
      preserved =
        existsSync(skillFile) &&
        !isManagedProjectSkillContent(readFileSync(skillFile, "utf8"));
    } catch {
      preserved = false;
    }
    if (exitCode === 2 || preserved)
      input.io.stderr(
        `The manifest revision was applied, but the generated guidance refresh finished with warnings${preserved ? ": a user-owned AI Office file was preserved and may still list the previous task kinds" : ""}. Run ai-office status . for details.`,
      );
    else
      input.io.stderr(
        `Generated project guidance reconciled (${installed.changes?.length ?? 0} file(s) updated).`,
      );
  } catch {
    input.io.stderr(
      `The manifest revision was applied, but refreshing the generated guidance failed. ${recovery}`,
    );
  }
}

export async function runRuntimeCli(
  args: string[],
  options: RuntimeCliOptions,
): Promise<number> {
  const io = options.io ?? defaultIo;
  if (isLocalVersionInvocation(args)) {
    // Only the program distribution root is source-identity provenance;
    // projectRoot may be any user project and is never inspected for it.
    return runVersionCli(args, {
      io,
      ...(options.distributionRoot === undefined
        ? {}
        : { distributionRoot: options.distributionRoot }),
    });
  }
  if (isLocalHelpInvocation(args)) {
    io.stdout(cliHelp);
    return 0;
  }
  if (args[0] === "update") {
    if (options.distributionRoot === undefined) {
      io.stderr(
        "AI Office program update is available only through the linkable ai-office entry point",
      );
      return 1;
    }
    return runDistributionUpdateCli(args.slice(1), {
      distributionRoot: options.distributionRoot,
      io,
      ...(options.distributionUpdateAdapter === undefined
        ? {}
        : { adapter: options.distributionUpdateAdapter }),
    });
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
        ...(options.runtimeClient === undefined
          ? {}
          : { runtimeClient: options.runtimeClient }),
      });

    // Service management is a local operator command like `dashboard` and
    // `runtime:purge`: it manages the host that serves Runtime commands and so
    // cannot be dispatched through it.
    if (args[0] === "service") {
      if (
        options.serviceProgram === undefined &&
        options.selectServiceManager === undefined
      ) {
        io.stderr(
          "AI Office service management is available only through the linkable ai-office entry point",
        );
        return 1;
      }
      return await runServiceCli(args.slice(1), {
        program: {
          launcher: options.serviceProgram?.launcher ?? [],
          runtimeHome: runtimePaths.runtimeHome,
          requiresSourceRuntimeOptIn:
            options.serviceProgram?.requiresSourceRuntimeOptIn ?? false,
        },
        io,
        ...(options.selectServiceManager === undefined
          ? {}
          : { selectManager: options.selectServiceManager }),
        ...(options.servicePlatform === undefined
          ? {}
          : { platform: options.servicePlatform }),
        ...(process.env.USER === undefined
          ? {}
          : { userName: process.env.USER }),
      });
    }

    // Provider credentials are local Runtime host configuration written to
    // owner-only files; no value crosses the Runtime protocol.
    if (args[0] === "credential")
      return await runCredentialCli(args.slice(1), {
        runtimeHome: runtimePaths.runtimeHome,
        io,
        ensureRuntimeHome: () => ensureRuntimeHome(runtimePaths),
        ...(options.credentialInput === undefined
          ? {}
          : { input: options.credentialInput }),
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

    // `--refresh-guidance` is a client-only approval (ADR-0033); the Runtime
    // never sees it.
    const refreshApproved =
      args[0] === "office:apply" && args.includes("--refresh-guidance");
    const prepared = await resolvedArguments(
      refreshApproved
        ? args.filter((argument) => argument !== "--refresh-guidance")
        : args,
      workingDirectory,
      bindings,
    );
    const commandArguments =
      prepared.discoveredRoot === undefined
        ? prepared.args
        : [
            ...prepared.args,
            "--project",
            await resolveDiscoveredProject(client, prepared.discoveredRoot),
          ];
    // Opened only when the Runtime asks a question; see `promptStdout`.
    let reader: Interface | undefined;
    const prompt =
      io.prompt ??
      ((message: string) => (reader ??= openPromptReader()).question(message));
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

        if (response.prompt === undefined) {
          const exitCode = response.exitCode ?? 1;
          if (exitCode === 0 && commandArguments[0] === "office:apply")
            await refreshGeneratedGuidance({
              client,
              bindings,
              workingDirectory,
              appliedProjectId: optionValue(commandArguments, "--project"),
              io,
              approved: refreshApproved,
              interactive:
                io.prompt !== undefined ||
                (process.stdin.isTTY === true && process.stdout.isTTY === true),
              prompt,
            });
          return exitCode;
        }
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
