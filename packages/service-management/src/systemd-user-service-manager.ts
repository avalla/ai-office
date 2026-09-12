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
  OfficeServiceDefinitionState,
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
  officeServiceDefinitionIdentity,
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
  describeCommandFailure,
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
 * Two independent systemd rules apply, and both must be honoured or the unit
 * means something other than the plan:
 *
 * - word splitting and C-style unescaping inside double quotes, so a path with
 *   a space, a quote, or a backslash must be quoted and escaped;
 * - specifier expansion, where `%` introduces a substitution. A literal `%` in
 *   a path — `/home/operator/100%/ai-office` is a perfectly ordinary directory
 *   — must be written `%%` or systemd silently resolves or drops it.
 *
 * Neither of these is shell escaping; a shell is never involved.
 */
function systemdValue(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("%", "%%");
}

function systemdQuote(value: string): string {
  return `"${systemdValue(value)}"`;
}

/** The exact header lines that prove AI Office owns a unit at a given path. */
export function systemdOwnershipLines(
  service: OfficeServiceName,
): readonly string[] {
  return [
    `# ${officeServiceOwnershipMarker}`,
    `# ${officeServiceDefinitionIdentity(service)}`,
  ];
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
    ...systemdOwnershipLines(service),
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
  return `${[
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
  ].join("\n")}\n`;
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

/** What `systemctl show` said about one unit, or `null` when it said nothing. */
interface SystemdUnitEvidence {
  readonly loadState: string | undefined;
  readonly activeState: string | undefined;
  readonly subState: string | undefined;
  readonly unitFileState: string | undefined;
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

/** Positive proof that nothing is running for this unit. */
function provablyNotRunning(evidence: SystemdUnitEvidence): boolean {
  if (evidence.loadState === "not-found") return true;
  return (
    evidence.activeState === "inactive" || evidence.activeState === "failed"
  );
}

function isEnabled(unitFileState: string | undefined): boolean {
  return unitFileState === "enabled" || unitFileState === "enabled-runtime";
}

function isRegistered(evidence: SystemdUnitEvidence): boolean {
  return evidence.loadState === "loaded";
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

  /**
   * Reads the manager's own view of a unit.
   *
   * `show` answers for any unit name, including one with no unit file, so this
   * is also how an orphaned registration is discovered: the filesystem cannot
   * prove a service is not loaded.
   */
  private async inspect(
    service: OfficeServiceName,
  ): Promise<SystemdUnitEvidence | null> {
    const shown = await this.systemctl(
      "show",
      systemdUnitNames[service],
      "--property=LoadState",
      "--property=ActiveState",
      "--property=SubState",
      "--property=UnitFileState",
    );
    if (shown.unavailable || shown.exitCode !== 0) return null;
    const properties = parseShowProperties(shown.stdout);
    return {
      loadState: properties.get("LoadState"),
      activeState: properties.get("ActiveState"),
      subState: properties.get("SubState"),
      unitFileState: properties.get("UnitFileState"),
    };
  }

  private async classify(
    service: OfficeServiceName,
  ): Promise<{ state: OfficeServiceDefinitionState; desired: string }> {
    const desired = renderSystemdUnit(this.plan, service);
    const existing = await this.store.read(this.unitPath(service));
    return {
      desired,
      state: classifyManagedDefinition(
        existing,
        desired,
        systemdOwnershipLines(service),
      ),
    };
  }

  async install(): Promise<OfficeServiceInstallReport> {
    const probe = await this.probeManager();
    if (!probe.available)
      throw new OfficeServicePreconditionError(
        `AI Office service installation requires systemd --user: ${probe.reason}`,
      );

    // Classify every target before writing any of them: a collision on the
    // second unit must not leave the first one installed.
    const classified = new Map<
      OfficeServiceName,
      { state: OfficeServiceDefinitionState; desired: string }
    >();
    for (const service of officeServiceNames) {
      const classification = await this.classify(service);
      if (classification.state === "unmanaged_collision")
        throw new OfficeServicePreconditionError(
          `${this.unitPath(service)} exists and is not managed by AI Office. Remove or rename it yourself, then run ai-office service install again.`,
        );
      classified.set(service, classification);
    }

    const definitions: OfficeServiceDefinitionOutcome[] = [];
    for (const service of officeServiceNames) {
      const path = this.unitPath(service);
      const { state, desired } = classified.get(service)!;
      if (state === "managed_current") {
        definitions.push({ service, path, action: "unchanged" });
        continue;
      }
      await this.store.write(path, desired);
      definitions.push({
        service,
        path,
        action: state === "missing" ? "created" : "updated",
      });
    }

    const issues: string[] = [];
    // Services whose running process could not be brought to the unit on disk.
    // systemd publishes no link from a running process back to the bytes of
    // the unit it was started from, so a failed restart is the only moment at
    // which the mismatch is knowable, and the install's own status carries it.
    const unconverged = new Set<OfficeServiceName>();
    const reload = await this.systemctl("daemon-reload");
    if (reload.exitCode !== 0 || reload.unavailable) {
      issues.push(
        `systemctl --user daemon-reload failed; the generated units were written but not loaded${describeCommandFailure(reload)}`,
      );
      for (const service of officeServiceNames) unconverged.add(service);
    } else {
      for (const service of officeServiceNames) {
        const enable = await this.systemctl(
          "enable",
          systemdUnitNames[service],
        );
        if (enable.exitCode !== 0 || enable.unavailable)
          issues.push(
            `systemctl --user enable ${systemdUnitNames[service]} failed${describeCommandFailure(enable)}`,
          );
      }
      // `restart` rather than `enable --now`, and runtime before dashboard.
      //
      // `enable --now` starts a stopped unit and does nothing at all to a
      // running one, so an install that rewrote a unit would leave the old
      // process running against the old launcher and environment while
      // reporting the new definition as installed. An explicit install is a
      // converge operation: it brings the *running process* to the definition
      // on disk, which means restarting services that are already up.
      for (const service of officeServiceNames) {
        const restart = await this.systemctl(
          "restart",
          systemdUnitNames[service],
        );
        if (restart.exitCode !== 0 || restart.unavailable) {
          issues.push(
            `systemctl --user restart ${systemdUnitNames[service]} failed${describeCommandFailure(restart)}`,
          );
          unconverged.add(service);
        }
      }
    }

    const status = await this.buildStatus(unconverged);
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
      "Installing converges the running processes to the definitions on disk, so an explicit install restarts services that were already running.",
      "User services start with your login session. On a headless server, enable lingering so they also start before login and survive logout:",
      `  sudo loginctl enable-linger ${user ?? "<user>"}`,
      "AI Office never runs that command for you and never escalates privileges.",
      `The dashboard stays bound to loopback. Reach it remotely with SSH forwarding: ssh -L ${this.plan.dashboard.port}:${this.plan.dashboard.host}:${this.plan.dashboard.port} <user>@<server>`,
    ];
  }

  status(): Promise<OfficeServicesStatus> {
    return this.buildStatus(new Set());
  }

  /**
   * `unconverged` names services the caller has just proved are still running
   * a previously loaded configuration. A standalone status cannot discover
   * that — systemd exposes no link from a running process back to the unit
   * bytes — so it is never guessed, only carried from an install that observed
   * it.
   */
  private async buildStatus(
    unconverged: ReadonlySet<OfficeServiceName>,
  ): Promise<OfficeServicesStatus> {
    const probe = await this.probeManager();
    const issues: string[] = [];
    const services: OfficeServiceStatus[] = [];

    for (const service of officeServiceNames) {
      const path = this.unitPath(service);
      const { state: definition } = await this.classify(service);
      const installed =
        definition === "managed_current" || definition === "managed_outdated";

      if (definition === "unmanaged_collision")
        issues.push(
          `${path} exists and is not managed by AI Office; it is reported, never modified.`,
        );

      // The manager is always consulted, including when no definition exists.
      // A missing file proves AI Office owns nothing at that path; it proves
      // nothing whatsoever about whether a unit of that name is loaded.
      const evidence = probe.available ? await this.inspect(service) : null;
      if (evidence === null) {
        services.push({
          service,
          definitionPath: path,
          definition,
          installed,
          registered: null,
          enabled: null,
          state: "unknown",
          detail: probe.available
            ? "systemctl did not report this unit's properties"
            : "the systemd user manager could not be contacted",
        });
        continue;
      }

      const registered = isRegistered(evidence);
      const enabled = isEnabled(evidence.unitFileState);
      const normalized: OfficeServiceState =
        evidence.loadState === "not-found"
          ? definition === "missing"
            ? "not_installed"
            : "installed_inactive"
          : stateFromActiveState(evidence.activeState);

      const orphaned = !installed && registered;
      if (orphaned) {
        issues.push(
          `${systemdUnitNames[service]} is still registered with systemd but AI Office cannot prove it owns ${path}. Inspect it, then remove it yourself with: systemctl --user disable --now ${systemdUnitNames[service]}`,
        );
      }

      // The downgrade bites only where it matters. A service the manager
      // reports as stopped is already described truthfully and unhealthily; it
      // is a service that still looks `running` after a failed convergence
      // that would otherwise read as healthy while executing the old
      // configuration.
      const stale = unconverged.has(service) && normalized === "running";
      services.push({
        service,
        definitionPath: path,
        definition,
        installed,
        registered,
        enabled,
        // A unit that could not be restarted may still be up, but not on the
        // definition now on disk. That is never reported as healthy.
        state: stale ? "unknown" : normalized,
        ...(stale
          ? {
              detail:
                "the unit on disk was not applied to the running process; systemd may still be running the previous configuration",
            }
          : this.detailFor(definition, evidence, orphaned)),
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

  private detailFor(
    definition: OfficeServiceDefinitionState,
    evidence: SystemdUnitEvidence,
    orphaned: boolean,
  ): { detail?: string } {
    if (orphaned)
      return {
        detail:
          definition === "unmanaged_collision"
            ? "an unmanaged unit occupies this path and a unit of this name is registered"
            : "the unit remains registered but AI Office cannot prove ownership",
      };
    if (definition === "unmanaged_collision")
      return { detail: "an unmanaged unit occupies this path" };
    if (definition === "managed_outdated")
      return { detail: "the unit on disk differs from the current plan" };
    if (evidence.subState === undefined || evidence.subState.length === 0)
      return {};
    return {
      detail: `${evidence.activeState ?? "unknown"} (${evidence.subState})`,
    };
  }

  async uninstall(): Promise<OfficeServiceUninstallReport> {
    const removed: OfficeServiceDefinitionOutcome[] = [];
    const preserved: OfficeServicePreservedDefinition[] = [];
    const issues: string[] = [];

    const probe = await this.probeManager();
    if (!probe.available) {
      // Without a manager there is no way to establish that anything stopped,
      // and deleting a definition would destroy the only proof that AI Office
      // owns whatever is still registered.
      issues.push(
        `AI Office cannot verify that its services are stopped: ${probe.reason}. No service definition was removed.`,
      );
      for (const service of ["dashboard", "runtime"] as const) {
        const { state } = await this.classify(service);
        if (state === "missing") continue;
        preserved.push({
          service,
          path: this.unitPath(service),
          reason: "the systemd user manager could not be contacted",
        });
      }
      return this.uninstallReport(removed, preserved, issues);
    }

    // Dashboard first: the dependent service stops before the thing it
    // depends on, so the Runtime never disappears from under a live proxy.
    for (const service of ["dashboard", "runtime"] as const) {
      const path = this.unitPath(service);
      const { state: definition } = await this.classify(service);

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

      if (definition === "missing") {
        // Nothing AI Office owns is at this path, so there is nothing it may
        // disable — but a unit of this name may still be loaded, and that is
        // worth reporting rather than reading as a clean uninstall.
        const orphan = await this.inspect(service);
        if (
          orphan !== null &&
          (isRegistered(orphan) || isEnabled(orphan.unitFileState))
        )
          issues.push(
            `${systemdUnitNames[service]} is still known to systemd but AI Office owns no definition for it. Remove it yourself with: systemctl --user disable --now ${systemdUnitNames[service]}`,
          );
        continue;
      }

      const disable = await this.systemctl(
        "disable",
        "--now",
        systemdUnitNames[service],
      );
      if (disable.exitCode !== 0 || disable.unavailable)
        issues.push(
          `systemctl --user disable --now ${systemdUnitNames[service]} failed${describeCommandFailure(disable)}`,
        );

      // The command's exit code is evidence, not the decision. Removal is
      // gated on the manager's own post-operation answer, because deleting the
      // unit file destroys the ownership evidence that would let a later
      // uninstall clean up whatever is still running.
      const after = await this.inspect(service);
      if (after === null) {
        preserved.push({
          service,
          path,
          reason: "systemd did not confirm the unit had stopped",
        });
        issues.push(
          `${systemdUnitNames[service]} could not be verified as stopped, so its unit file was preserved.`,
        );
        continue;
      }
      if (!provablyNotRunning(after) || isEnabled(after.unitFileState)) {
        preserved.push({
          service,
          path,
          reason: provablyNotRunning(after)
            ? "the unit is still enabled"
            : "the unit is still running",
        });
        issues.push(
          `${systemdUnitNames[service]} is still ${provablyNotRunning(after) ? "enabled" : `${after.activeState ?? "active"}`} after disable --now, so its unit file was preserved.`,
        );
        continue;
      }

      await this.store.remove(path);
      removed.push({ service, path, action: "removed" });
    }

    if (removed.length > 0) {
      const reload = await this.systemctl("daemon-reload");
      if (reload.exitCode !== 0 || reload.unavailable)
        issues.push(
          `systemctl --user daemon-reload failed after removing the units${describeCommandFailure(reload)}`,
        );
    }

    return this.uninstallReport(removed, preserved, issues);
  }

  private uninstallReport(
    removed: readonly OfficeServiceDefinitionOutcome[],
    preserved: readonly OfficeServicePreservedDefinition[],
    issues: readonly string[],
  ): OfficeServiceUninstallReport {
    return {
      platform: this.platform,
      removed,
      preserved,
      issues,
      preservedData: [this.plan.program.runtimeHome],
    };
  }
}
