/**
 * `systemd --user` adapter.
 *
 * Everything systemd-specific lives here: unit rendering, `systemctl`
 * invocation, and the mapping from systemd properties to the normalized
 * application vocabulary. No sudo, no system units, no `/etc` path — the units
 * are per-user files under the user's own configuration directory, and a user
 * manager supervises processes rather than separating principals.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type {
  OfficeServiceDefinitionOutcome,
  OfficeServiceInstallReport,
  OfficeServiceManager,
  OfficeServiceName,
  OfficeServicePreservedDefinition,
  OfficeServiceState,
  OfficeServiceStatus,
  OfficeServiceUninstallReport,
  OfficeServicesStatus,
} from "@ai-office/application/ports/office-service-manager.port.ts";
import {
  officeServiceNames,
  OfficeServicePreconditionError,
} from "@ai-office/application/ports/office-service-manager.port.ts";
import {
  assertRenderableValue,
  classifyManagedDefinition,
  officeServiceOwnershipMarker,
} from "@ai-office/application/service-management/managed-definition.ts";
import {
  dashboardEndpoint,
  dashboardServiceArguments,
  dashboardServiceDescription,
  officeServiceEnvironment,
  runtimeServiceArguments,
  runtimeServiceDescription,
  validateOfficeServicePlan,
  type OfficeServicePlan,
} from "./service-plan.ts";
import {
  BunServiceCommandRunner,
  type ServiceCommandResult,
  type ServiceCommandRunner,
} from "./service-command-runner.ts";
import {
  LocalServiceDefinitionStore,
  type ServiceDefinitionStore,
} from "./service-definition-store.ts";

export const systemdUnitNames: Readonly<Record<OfficeServiceName, string>> = {
  runtime: "ai-office-runtime.service",
  dashboard: "ai-office-dashboard.service",
};

export interface SystemdUserServiceManagerOptions {
  plan: OfficeServicePlan;
  /** Defaults to `$XDG_CONFIG_HOME/systemd/user`, else `~/.config/systemd/user`. */
  unitDirectory?: string;
  runner?: ServiceCommandRunner;
  store?: ServiceDefinitionStore;
  /** The invoking user, used only for the headless-server linger hint. */
  userName?: string;
}

export function defaultSystemdUnitDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  userHome: string = homedir(),
): string {
  const configHome = environment.XDG_CONFIG_HOME;
  const base =
    configHome !== undefined && configHome.length > 0
      ? configHome
      : join(userHome, ".config");
  return join(base, "systemd", "user");
}

/**
 * Quotes one argv element for a systemd `ExecStart=` or `Environment=` value.
 *
 * systemd applies its own word splitting and C-style unescaping inside double
 * quotes, so a path containing a space or a quote must be quoted and escaped
 * rather than pasted in. Control characters are refused before this point.
 */
function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function renderUnit(lines: readonly string[]): string {
  return `${lines.join("\n")}\n`;
}

export function renderSystemdUnit(
  plan: OfficeServicePlan,
  service: OfficeServiceName,
): string {
  const environment = officeServiceEnvironment(plan.program).map(
    ([name, value]) =>
      `Environment=${systemdQuote(`${name}=${assertRenderableValue(value, name)}`)}`,
  );
  const execStart = (
    service === "runtime"
      ? runtimeServiceArguments(plan.program)
      : dashboardServiceArguments(plan)
  )
    .map(systemdQuote)
    .join(" ");
  const header = [
    `# ${officeServiceOwnershipMarker}`,
    `# Definition: ai-office/service/v1 ${service}`,
    "# Generated file. Edit the AI Office plan and reinstall instead.",
    "",
  ];
  const unitSection =
    service === "runtime"
      ? [
          "[Unit]",
          `Description=${runtimeServiceDescription}`,
          "After=network.target",
        ]
      : [
          "[Unit]",
          `Description=${dashboardServiceDescription}`,
          // Ordering is a convenience: the dashboard tolerates a Runtime socket
          // that is not ready yet, because `After=` orders starts and never
          // proves readiness.
          `Requires=${systemdUnitNames.runtime}`,
          `After=${systemdUnitNames.runtime}`,
        ];
  return renderUnit([
    ...header,
    ...unitSection,
    "",
    "[Service]",
    "Type=simple",
    ...environment,
    `ExecStart=${execStart}`,
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=default.target",
  ]);
}

/** `systemctl show` emits `Key=Value` lines; unknown keys are simply absent. */
function parseShowProperties(stdout: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    properties.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  return properties;
}

function stateFromActiveState(
  activeState: string | undefined,
): OfficeServiceState {
  switch (activeState) {
    case "active":
      return "running";
    case "failed":
      return "failed";
    case "inactive":
      return "installed_inactive";
    default:
      // `activating`, `deactivating`, `reloading`, or an unrecognized value:
      // real but not resolved, and never reported as healthy.
      return "unknown";
  }
}

export class SystemdUserServiceManager implements OfficeServiceManager {
  readonly platform = "systemd-user" as const;

  private readonly plan: OfficeServicePlan;
  private readonly unitDirectory: string;
  private readonly runner: ServiceCommandRunner;
  private readonly store: ServiceDefinitionStore;
  private readonly userName: string | undefined;

  constructor(options: SystemdUserServiceManagerOptions) {
    this.plan = validateOfficeServicePlan(options.plan);
    this.unitDirectory = options.unitDirectory ?? defaultSystemdUnitDirectory();
    this.runner = options.runner ?? new BunServiceCommandRunner();
    this.store = options.store ?? new LocalServiceDefinitionStore();
    this.userName = options.userName;
  }

  unitPath(service: OfficeServiceName): string {
    return join(this.unitDirectory, systemdUnitNames[service]);
  }

  private systemctl(
    ...arguments_: readonly string[]
  ): Promise<ServiceCommandResult> {
    return this.runner.run(["systemctl", "--user", ...arguments_]);
  }

  /**
   * Proves a usable per-user manager before anything is written.
   *
   * `systemctl --version` only proves the binary exists; without a user bus
   * every later call would fail after the units had already been created.
   */
  private async probeManager(): Promise<{
    available: boolean;
    reason?: string;
  }> {
    const version = await this.systemctl("--version");
    if (version.unavailable || version.exitCode !== 0)
      return {
        available: false,
        reason: "systemctl is not available on this system",
      };
    // `is-system-running` answers with a word on stdout whenever the user
    // manager responds, including for `degraded` and `starting`, which are
    // ordinary states and not failures.
    const running = await this.systemctl("is-system-running");
    if (running.unavailable || running.stdout.trim().length === 0)
      return {
        available: false,
        reason:
          "no systemd user manager is reachable; ensure XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS are set for this session",
      };
    return { available: true };
  }

  async install(): Promise<OfficeServiceInstallReport> {
    const probe = await this.probeManager();
    if (!probe.available)
      throw new OfficeServicePreconditionError(
        `AI Office service installation requires systemd --user: ${probe.reason}`,
      );

    const desired = new Map<OfficeServiceName, string>();
    for (const service of officeServiceNames)
      desired.set(service, renderSystemdUnit(this.plan, service));

    // Classify every target before writing any of them: a collision on the
    // second unit must not leave the first one installed.
    const classified = new Map<
      OfficeServiceName,
      ReturnType<typeof classifyManagedDefinition>
    >();
    for (const service of officeServiceNames) {
      const path = this.unitPath(service);
      const existing = await this.store.read(path);
      const state = classifyManagedDefinition(existing, desired.get(service)!);
      if (state === "unmanaged_collision")
        throw new OfficeServicePreconditionError(
          `${path} exists and is not managed by AI Office. Remove or rename it yourself, then run ai-office service install again.`,
        );
      classified.set(service, state);
    }

    const definitions: OfficeServiceDefinitionOutcome[] = [];
    for (const service of officeServiceNames) {
      const path = this.unitPath(service);
      const state = classified.get(service)!;
      if (state === "managed_current") {
        definitions.push({ service, path, action: "unchanged" });
        continue;
      }
      await this.store.write(path, desired.get(service)!);
      definitions.push({
        service,
        path,
        action: state === "missing" ? "created" : "updated",
      });
    }

    const issues: string[] = [];
    const reload = await this.systemctl("daemon-reload");
    if (reload.exitCode !== 0 || reload.unavailable)
      issues.push(
        `systemctl --user daemon-reload failed; the generated units were written but not loaded${describeFailure(reload)}`,
      );
    else
      // Runtime first, so the dashboard's `Requires=`/`After=` ordering has
      // something to order against on this very first start.
      for (const service of officeServiceNames) {
        const enable = await this.systemctl(
          "enable",
          "--now",
          systemdUnitNames[service],
        );
        if (enable.exitCode !== 0 || enable.unavailable)
          issues.push(
            `systemctl --user enable --now ${systemdUnitNames[service]} failed${describeFailure(enable)}`,
          );
      }

    const status = await this.status();
    return {
      definitions,
      issues: [...issues, ...status.issues],
      hints: this.hints(),
      status,
    };
  }

  private hints(): readonly string[] {
    const user = this.userName;
    return [
      "User services start with your login session. On a headless server, enable lingering so they also start before login and survive logout:",
      `  sudo loginctl enable-linger ${user ?? "<user>"}`,
      "AI Office never runs that command for you and never escalates privileges.",
      `The dashboard stays bound to loopback. Reach it remotely with SSH forwarding: ssh -L ${this.plan.dashboard.port}:${this.plan.dashboard.host}:${this.plan.dashboard.port} <user>@<server>`,
    ];
  }

  async status(): Promise<OfficeServicesStatus> {
    const probe = await this.probeManager();
    const issues: string[] = [];
    const services: OfficeServiceStatus[] = [];

    for (const service of officeServiceNames) {
      const path = this.unitPath(service);
      const existing = await this.store.read(path);
      const definition = classifyManagedDefinition(
        existing,
        renderSystemdUnit(this.plan, service),
      );

      if (definition === "unmanaged_collision") {
        issues.push(
          `${path} exists and is not managed by AI Office; it is reported, never modified.`,
        );
        services.push({
          service,
          definitionPath: path,
          definition,
          installed: false,
          registered: null,
          enabled: null,
          state: "unknown",
          detail: "an unmanaged unit occupies this path",
        });
        continue;
      }

      if (definition === "missing") {
        services.push({
          service,
          definitionPath: path,
          definition,
          installed: false,
          registered: false,
          enabled: false,
          state: "not_installed",
        });
        continue;
      }

      if (!probe.available) {
        services.push({
          service,
          definitionPath: path,
          definition,
          installed: true,
          registered: null,
          enabled: null,
          state: "unknown",
          detail: "the systemd user manager could not be contacted",
        });
        continue;
      }

      const shown = await this.systemctl(
        "show",
        systemdUnitNames[service],
        "--property=LoadState",
        "--property=ActiveState",
        "--property=SubState",
        "--property=UnitFileState",
      );
      if (shown.unavailable || shown.exitCode !== 0) {
        services.push({
          service,
          definitionPath: path,
          definition,
          installed: true,
          registered: null,
          enabled: null,
          state: "unknown",
          detail: "systemctl did not report this unit's properties",
        });
        continue;
      }
      const properties = parseShowProperties(shown.stdout);
      const loadState = properties.get("LoadState");
      const unitFileState = properties.get("UnitFileState");
      const activeState = properties.get("ActiveState");
      const subState = properties.get("SubState");
      services.push({
        service,
        definitionPath: path,
        definition,
        installed: true,
        registered: loadState === "loaded",
        enabled:
          unitFileState === "enabled" || unitFileState === "enabled-runtime",
        state:
          loadState === "not-found"
            ? "installed_inactive"
            : stateFromActiveState(activeState),
        ...(subState === undefined || subState.length === 0
          ? {}
          : { detail: `${activeState ?? "unknown"} (${subState})` }),
      });
    }

    if (!probe.available && probe.reason !== undefined)
      issues.push(probe.reason);

    return {
      contractVersion: 1,
      platform: this.platform,
      serviceManagerAvailable: probe.available,
      runtimeHome: this.plan.program.runtimeHome,
      dashboardEndpoint: dashboardEndpoint(this.plan),
      services,
      issues,
    };
  }

  async uninstall(): Promise<OfficeServiceUninstallReport> {
    const removed: OfficeServiceDefinitionOutcome[] = [];
    const preserved: OfficeServicePreservedDefinition[] = [];
    const issues: string[] = [];

    // Dashboard first: the dependent service stops before the thing it
    // depends on, so the Runtime never disappears from under a live proxy.
    for (const service of ["dashboard", "runtime"] as const) {
      const path = this.unitPath(service);
      const existing = await this.store.read(path);
      const definition = classifyManagedDefinition(
        existing,
        renderSystemdUnit(this.plan, service),
      );
      if (definition === "unmanaged_collision") {
        preserved.push({
          service,
          path,
          reason: "the unit is not managed by AI Office",
        });
        issues.push(
          `${path} is not managed by AI Office; it was left running and on disk.`,
        );
        continue;
      }
      // Nothing AI Office owns is at this path, so there is nothing it may
      // disable: a unit of the same name elsewhere in the search path belongs
      // to somebody else.
      if (definition === "missing") continue;

      const disable = await this.systemctl(
        "disable",
        "--now",
        systemdUnitNames[service],
      );
      if (disable.exitCode !== 0 || disable.unavailable)
        issues.push(
          `systemctl --user disable --now ${systemdUnitNames[service]} failed${describeFailure(disable)}`,
        );
      await this.store.remove(path);
      removed.push({ service, path, action: "removed" });
    }

    if (removed.length > 0) {
      const reload = await this.systemctl("daemon-reload");
      if (reload.exitCode !== 0 || reload.unavailable)
        issues.push(
          `systemctl --user daemon-reload failed after removing the units${describeFailure(reload)}`,
        );
    }

    return {
      platform: this.platform,
      removed,
      preserved,
      issues,
      preservedData: [this.plan.program.runtimeHome],
    };
  }
}

/** One short, non-localized cause; never the full command output. */
function describeFailure(result: ServiceCommandResult): string {
  if (result.unavailable) return " (the command could not be executed)";
  const line = result.stderr.split("\n").find((entry) => entry.trim() !== "");
  return line === undefined
    ? ` (exit ${result.exitCode})`
    : ` (exit ${result.exitCode}: ${line.trim()})`;
}
