/**
 * `ai-office service install|status|uninstall`.
 *
 * This module is presentation only. It parses three fixed subcommands, hands
 * the work to the application service, and renders the normalized result. It
 * contains no platform branch, no unit or plist text, and no process
 * execution: which per-user service manager applies is decided by
 * `selectOfficeServiceManager`, and what a platform reported is decided by the
 * adapter behind it.
 *
 * Installation is always an explicit operator action. Nothing in `install`,
 * `status`, or onboarding calls it implicitly.
 */

import {
  ManageOfficeServices,
  officeServicesHealthy,
  type OfficeServiceInstallResult,
  type OfficeServiceUninstallResult,
} from "@ai-office/application/service-management/manage-office-services.ts";
import type {
  OfficeServiceManager,
  OfficeServiceName,
  OfficeServicesStatus,
} from "@ai-office/application/ports/office-service-manager.port.ts";
import {
  OfficeServicePreconditionError,
  UnsupportedServicePlatformError,
} from "@ai-office/application/ports/office-service-manager.port.ts";
import { selectOfficeServiceManager } from "@ai-office/service-management/select-service-manager.ts";
import type {
  OfficeServicePlan,
  OfficeServiceProgram,
} from "@ai-office/service-management/service-plan.ts";
import {
  CliUsageError,
  parseArguments,
  type CommandIo,
} from "@ai-office/command-support/arguments.ts";
import { dashboardDefaultPort } from "./dashboard-cli.ts";

/**
 * How long the supervised dashboard waits for the Runtime socket.
 *
 * The dashboard must not depend on the Runtime being ready when its own
 * process starts; this bound is what makes a temporarily missing socket a wait
 * instead of an exit, on both platforms.
 */
export const managedDashboardRuntimeWaitSeconds = 60;

export interface ServiceCliOptions {
  /** Absolute launcher and source-guard requirement of the running program. */
  program: OfficeServiceProgram;
  io: CommandIo;
  /**
   * Supplied by tests so the plan this command builds is observable and the
   * generated definitions land in a temporary directory. Production selects by
   * platform.
   */
  selectManager?: (plan: OfficeServicePlan) => OfficeServiceManager;
  platform?: string;
  userName?: string;
}

export const serviceCommandHelp = `AI Office service management

Installs the AI Office Runtime host and the read-only dashboard as per-user
operating-system services. Never run as root, never system-wide, and never
part of ordinary installation or onboarding.

Commands:
  ai-office service install [--json]
    renders the service definitions, starts the Runtime and then the dashboard,
    and reports the authoritative post-install state
  ai-office service status [--json]
    reports normalized state for both services
  ai-office service uninstall [--json]
    stops and removes only the generated service definitions

Platforms:
  Linux   systemd --user units in ~/.config/systemd/user
            ai-office-runtime.service, ai-office-dashboard.service
  macOS   launchd LaunchAgents in ~/Library/LaunchAgents
            com.ai-office.runtime.plist, com.ai-office.dashboard.plist
  Windows services are not currently supported.

Guarantees:
  no sudo and no privilege escalation
  the dashboard stays bound to 127.0.0.1 and the Runtime opens no TCP port
  a definition AI Office does not own is never overwritten and never deleted
  uninstall removes service definitions only; AI_OFFICE_HOME, SQLite databases
  and project state are left untouched

States: not_installed, installed_inactive, running, failed, unknown`;

const serviceLabels: Readonly<Record<OfficeServiceName, string>> = {
  runtime: "Runtime",
  dashboard: "Dashboard",
};

const platformLabels = {
  "systemd-user": "systemd --user",
  "launchd-user": "launchd LaunchAgents",
} as const;

function yesNo(value: boolean | null): string {
  return value === null ? "unknown" : value ? "yes" : "no";
}

function padded(service: OfficeServiceName): string {
  return `${serviceLabels[service]}:`.padEnd(11);
}

function printStatus(status: OfficeServicesStatus, io: CommandIo): void {
  io.stdout("AI Office services");
  io.stdout("");
  io.stdout(`Platform: ${platformLabels[status.platform]}`);
  io.stdout(`Runtime home: ${status.runtimeHome}`);
  if (!status.serviceManagerAvailable)
    io.stdout("Service manager: unavailable");
  for (const entry of status.services) {
    io.stdout("");
    io.stdout(`${serviceLabels[entry.service]}:`);
    io.stdout(`  installed: ${yesNo(entry.installed)}`);
    io.stdout(`  registered: ${yesNo(entry.registered)}`);
    io.stdout(`  enabled: ${yesNo(entry.enabled)}`);
    io.stdout(`  state: ${entry.state}`);
    if (entry.detail !== undefined) io.stdout(`  detail: ${entry.detail}`);
    io.stdout(`  definition: ${entry.definition}`);
    io.stdout(`  path: ${entry.definitionPath}`);
    if (entry.service === "dashboard")
      io.stdout(`  endpoint: ${status.dashboardEndpoint}`);
  }
  printIssues(status.issues, io);
}

function printIssues(issues: readonly string[], io: CommandIo): void {
  if (issues.length === 0) return;
  io.stdout("");
  io.stdout("Issues");
  for (const issue of issues) io.stdout(`  ${issue}`);
}

function printInstall(result: OfficeServiceInstallResult, io: CommandIo): void {
  const complete = result.outcome === "installed";
  const output = complete ? io.stdout : io.stderr;
  output(
    complete
      ? "AI Office services installed"
      : "AI Office service installation incomplete",
  );
  output("");
  for (const entry of result.status.services)
    output(`${padded(entry.service)}${entry.state}`);
  output("");
  output("Definitions");
  for (const definition of result.definitions)
    output(`  ${definition.path} (${definition.action})`);
  if (complete) {
    io.stdout("");
    io.stdout("Dashboard");
    io.stdout(`  ${result.status.dashboardEndpoint}`);
    if (result.hints.length > 0) {
      io.stdout("");
      io.stdout("Notes");
      for (const hint of result.hints) io.stdout(`  ${hint}`);
    }
    return;
  }
  output("");
  output("Reasons");
  const reasons =
    result.issues.length > 0
      ? result.issues
      : result.status.services
          .filter((entry) => entry.state !== "running")
          .map(
            (entry) =>
              `${serviceLabels[entry.service]} is ${entry.state}${entry.detail === undefined ? "" : `: ${entry.detail}`}`,
          );
  for (const reason of reasons) output(`  ${reason}`);
  output("");
  output(
    "Inspect the services with: ai-office service status. Nothing was started that is not listed above.",
  );
}

function printUninstall(
  result: OfficeServiceUninstallResult,
  io: CommandIo,
): void {
  const clean = result.outcome === "uninstalled";
  const output = clean ? io.stdout : io.stderr;
  output(
    clean
      ? "AI Office services uninstalled"
      : "AI Office service uninstall incomplete",
  );
  output("");
  output("Removed");
  if (result.removed.length === 0)
    output("  nothing; no managed definition was present");
  for (const definition of result.removed) output(`  ${definition.path}`);
  if (result.preserved.length > 0) {
    output("");
    output("Preserved");
    for (const definition of result.preserved)
      output(`  ${definition.path} (${definition.reason})`);
  }
  output("");
  output("Left untouched");
  for (const path of result.preservedData) output(`  ${path}`);
  output("  AI Office project state, SQLite databases and runtime state");
  if (!clean) printIssuesTo(result.issues, output);
}

function printIssuesTo(
  issues: readonly string[],
  output: (message: string) => void,
): void {
  if (issues.length === 0) return;
  output("");
  output("Issues");
  for (const issue of issues) output(`  ${issue}`);
}

function statusExitCode(status: OfficeServicesStatus): number {
  return officeServicesHealthy(status) && status.issues.length === 0 ? 0 : 1;
}

export async function runServiceCli(
  args: string[],
  options: ServiceCliOptions,
): Promise<number> {
  const subcommand = args[0];
  if (
    subcommand === undefined ||
    ["help", "--help", "-h"].includes(subcommand) ||
    args.slice(1).some((argument) => ["--help", "-h"].includes(argument))
  ) {
    options.io.stdout(serviceCommandHelp);
    return 0;
  }

  let json = false;
  try {
    if (!["install", "status", "uninstall"].includes(subcommand))
      throw new CliUsageError(
        `Unknown service command ${subcommand}; expected install, status or uninstall`,
      );
    const parsed = parseArguments(args.slice(1), new Set(), new Set(["json"]));
    if (parsed.positionals.length > 0)
      throw new CliUsageError(
        `service ${subcommand} only accepts named options`,
      );
    json = parsed.flags.has("json");

    const plan: OfficeServicePlan = {
      program: options.program,
      dashboard: {
        host: "127.0.0.1",
        port: dashboardDefaultPort,
        awaitRuntimeSeconds: managedDashboardRuntimeWaitSeconds,
      },
    };
    const manager =
      options.selectManager === undefined
        ? selectOfficeServiceManager({
            plan,
            ...(options.platform === undefined
              ? {}
              : { platform: options.platform }),
            ...(options.userName === undefined
              ? {}
              : { userName: options.userName }),
          })
        : options.selectManager(plan);
    const services = new ManageOfficeServices(manager);

    if (subcommand === "status") {
      const status = await services.status();
      if (json) options.io.stdout(JSON.stringify(status));
      else printStatus(status, options.io);
      return statusExitCode(status);
    }

    if (subcommand === "install") {
      const result = await services.install();
      if (json) options.io.stdout(JSON.stringify(result));
      else printInstall(result, options.io);
      return result.outcome === "installed" ? 0 : 1;
    }

    const result = await services.uninstall();
    if (json) options.io.stdout(JSON.stringify(result));
    else printUninstall(result, options.io);
    return result.outcome === "uninstalled" ? 0 : 1;
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof UnsupportedServicePlatformError ||
      error instanceof OfficeServicePreconditionError
    ) {
      if (json)
        options.io.stdout(
          JSON.stringify({
            contractVersion: 1,
            outcome: "failed",
            error: {
              code:
                error instanceof CliUsageError
                  ? "invalid_arguments"
                  : error instanceof UnsupportedServicePlatformError
                    ? "unsupported_platform"
                    : "precondition_failed",
              message: error.message,
            },
          }),
        );
      else options.io.stderr(error.message);
      return 1;
    }
    throw error;
  }
}
