/**
 * `launchd` per-user LaunchAgent adapter.
 *
 * Everything launchd-specific lives here: plist rendering, the modern
 * `bootstrap`/`bootout`/`print` operations on the caller's own `gui/<uid>`
 * domain, and the mapping from `launchctl print` evidence to the normalized
 * application vocabulary. LaunchAgents are per-user files under the user's own
 * Library; `/Library/LaunchDaemons`, `sudo`, and the deprecated
 * `load`/`unload` workflow are all deliberately unused.
 *
 * launchd has no equivalent of `Requires=`/`After=`. The install bootstraps
 * the Runtime before the dashboard, but nothing depends on that order: the
 * dashboard tolerates a Runtime socket that appears shortly afterwards.
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

export const launchdLabels: Readonly<Record<OfficeServiceName, string>> = {
  runtime: "com.ai-office.runtime",
  dashboard: "com.ai-office.dashboard",
};

export interface LaunchdUserServiceManagerOptions {
  plan: OfficeServicePlan;
  /** Defaults to `~/Library/LaunchAgents`. */
  agentDirectory?: string;
  runner?: ServiceCommandRunner;
  store?: ServiceDefinitionStore;
  /** The caller's own uid; the only launchd domain this adapter ever touches. */
  userId?: number;
  /** Re-checks after a bootout, which launchd may complete asynchronously. */
  settleAttempts?: number;
  settleDelayMilliseconds?: number;
}

export function defaultLaunchAgentDirectory(
  userHome: string = homedir(),
): string {
  return join(userHome, "Library", "LaunchAgents");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** The exact header lines that prove AI Office owns a plist at a given path. */
export function launchdOwnershipLines(
  service: OfficeServiceName,
): readonly string[] {
  return [
    `<!-- ${officeServiceOwnershipMarker} -->`,
    `<!-- ${officeServiceDefinitionIdentity(service)} -->`,
  ];
}

export function renderLaunchdPlist(
  plan: OfficeServicePlan,
  service: OfficeServiceName,
): string {
  const label = launchdLabels[service];
  const description =
    service === "runtime"
      ? runtimeServiceDescription
      : dashboardServiceDescription;
  const programArguments =
    service === "runtime"
      ? runtimeServiceArguments(plan.program)
      : dashboardServiceArguments(plan);
  const argumentLines = programArguments.map(
    (argument) =>
      `    <string>${escapeXml(assertRenderableValue(argument, argument))}</string>`,
  );
  const environmentLines = officeServiceEnvironment(plan.program).flatMap(
    ([name, value]) => [
      `    <key>${escapeXml(name)}</key>`,
      `    <string>${escapeXml(assertRenderableValue(value, name))}</string>`,
    ],
  );
  return `${[
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    // The ownership marker is an XML comment so the file stays a valid plist
    // and launchd is never handed a key it does not define.
    ...launchdOwnershipLines(service),
    "<!-- Generated file. Edit the AI Office plan and reinstall instead. -->",
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${escapeXml(label)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    ...argumentLines,
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...environmentLines,
    "  </dict>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "  <key>ThrottleInterval</key>",
    "  <integer>3</integer>",
    "  <key>ServiceDescription</key>",
    `  <string>${escapeXml(description)}</string>`,
    "</dict>",
    "</plist>",
  ].join("\n")}\n`;
}

interface LaunchdServiceEvidence {
  readonly registered: boolean;
  readonly state?: string;
  readonly pid?: number;
  readonly lastExitCode?: number;
}

/**
 * Reads the few deterministic fields `launchctl print` publishes.
 *
 * Only anchored `key = value` lines are consulted; the surrounding
 * presentation text is deliberately not interpreted.
 */
export function parseLaunchdPrint(
  stdout: string,
): Omit<LaunchdServiceEvidence, "registered"> {
  const state = /^\s*state\s*=\s*(\S+)/mu.exec(stdout)?.[1];
  const pid = /^\s*pid\s*=\s*(\d+)/mu.exec(stdout)?.[1];
  const lastExit = /^\s*last exit (?:code|status)\s*=\s*(-?\d+)/mu.exec(
    stdout,
  )?.[1];
  return {
    ...(state === undefined ? {} : { state }),
    ...(pid === undefined ? {} : { pid: Number(pid) }),
    ...(lastExit === undefined ? {} : { lastExitCode: Number(lastExit) }),
  };
}

function stateFromEvidence(
  evidence: LaunchdServiceEvidence,
  definition: OfficeServiceDefinitionState,
): OfficeServiceState {
  if (!evidence.registered)
    return definition === "missing" ? "not_installed" : "installed_inactive";
  if (evidence.state === "running" || evidence.pid !== undefined)
    return "running";
  if (evidence.lastExitCode !== undefined && evidence.lastExitCode !== 0)
    return "failed";
  if (evidence.state !== undefined) return "installed_inactive";
  return "unknown";
}

export class LaunchdUserServiceManager implements OfficeServiceManager {
  readonly platform = "launchd-user" as const;

  private readonly plan: OfficeServicePlan;
  private readonly agentDirectory: string;
  private readonly runner: ServiceCommandRunner;
  private readonly store: ServiceDefinitionStore;
  private readonly domain: string;
  private readonly settleAttempts: number;
  private readonly settleDelayMilliseconds: number;

  constructor(options: LaunchdUserServiceManagerOptions) {
    this.plan = validateOfficeServicePlan(options.plan);
    this.agentDirectory =
      options.agentDirectory ?? defaultLaunchAgentDirectory();
    this.runner = options.runner ?? new BunServiceCommandRunner();
    this.store = options.store ?? new LocalServiceDefinitionStore();
    this.settleAttempts = options.settleAttempts ?? 10;
    this.settleDelayMilliseconds = options.settleDelayMilliseconds ?? 200;
    const userId = options.userId ?? process.getuid?.();
    if (userId === undefined)
      throw new OfficeServicePreconditionError(
        "AI Office service installation could not determine the current user id",
      );
    this.domain = `gui/${userId}`;
  }

  plistPath(service: OfficeServiceName): string {
    return join(this.agentDirectory, `${launchdLabels[service]}.plist`);
  }

  private launchctl(
    ...arguments_: readonly string[]
  ): Promise<ServiceCommandResult> {
    return this.runner.run(["launchctl", ...arguments_]);
  }

  private async probeManager(): Promise<{
    available: boolean;
    reason?: string;
  }> {
    const domain = await this.launchctl("print", this.domain);
    if (domain.unavailable)
      return {
        available: false,
        reason: "launchctl is not available on this system",
      };
    if (domain.exitCode !== 0)
      return {
        available: false,
        reason: `the launchd ${this.domain} domain is not reachable from this session`,
      };
    return { available: true };
  }

  /**
   * Asks launchd about one label.
   *
   * `null` means launchctl itself could not answer — which is emphatically not
   * the same as "the job is not loaded", and is never treated as such.
   */
  private async evidence(
    service: OfficeServiceName,
  ): Promise<LaunchdServiceEvidence | null> {
    const printed = await this.launchctl(
      "print",
      `${this.domain}/${launchdLabels[service]}`,
    );
    if (printed.unavailable) return null;
    // A non-zero exit here is the ordinary "no such service" answer for a
    // label that is simply not bootstrapped, not an execution failure.
    if (printed.exitCode !== 0) return { registered: false };
    return { registered: true, ...parseLaunchdPrint(printed.stdout) };
  }

  private delay(): Promise<void> {
    if (this.settleDelayMilliseconds <= 0) return Promise.resolve();
    return new Promise((resolve) =>
      setTimeout(resolve, this.settleDelayMilliseconds),
    );
  }

  /**
   * Waits for a booted-out label to actually leave the domain.
   *
   * `launchctl bootout` is allowed to return while removal is still in
   * progress, so its exit code is never taken as proof. Returns `true` only on
   * a positive "no such service" answer.
   */
  private async waitUntilUnregistered(
    service: OfficeServiceName,
  ): Promise<boolean> {
    for (let attempt = 0; attempt < this.settleAttempts; attempt += 1) {
      const evidence = await this.evidence(service);
      if (evidence !== null && !evidence.registered) return true;
      if (attempt + 1 < this.settleAttempts) await this.delay();
    }
    return false;
  }

  private async classify(
    service: OfficeServiceName,
  ): Promise<{ state: OfficeServiceDefinitionState; desired: string }> {
    const desired = renderLaunchdPlist(this.plan, service);
    const existing = await this.store.read(this.plistPath(service));
    return {
      desired,
      state: classifyManagedDefinition(
        existing,
        desired,
        launchdOwnershipLines(service),
      ),
    };
  }

  async install(): Promise<OfficeServiceInstallReport> {
    const probe = await this.probeManager();
    if (!probe.available)
      throw new OfficeServicePreconditionError(
        `AI Office service installation requires launchd: ${probe.reason}`,
      );

    const classified = new Map<
      OfficeServiceName,
      { state: OfficeServiceDefinitionState; desired: string }
    >();
    for (const service of officeServiceNames) {
      const classification = await this.classify(service);
      if (classification.state === "unmanaged_collision")
        throw new OfficeServicePreconditionError(
          `${this.plistPath(service)} exists and is not managed by AI Office. Remove or rename it yourself, then run ai-office service install again.`,
        );
      classified.set(service, classification);
    }

    const definitions: OfficeServiceDefinitionOutcome[] = [];
    for (const service of officeServiceNames) {
      const path = this.plistPath(service);
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
    // Services whose loaded job could not be brought to the plist on disk.
    // launchd publishes nothing that ties a running job to the bytes of the
    // file it came from, so this is the only moment at which the mismatch is
    // knowable, and the install's own status must carry it.
    const unconverged = new Set<OfficeServiceName>();
    // Runtime first, dashboard second. Correctness does not rely on it; it
    // just avoids a pointless first dashboard restart.
    //
    // Every managed job is deliberately re-bootstrapped, whether or not the
    // plist changed. A plist that is byte-identical to the plan proves only
    // what is on disk: a previous install whose bootout or bootstrap failed
    // leaves a stale job loaded behind an already-current file, and skipping
    // convergence there would report success for the old configuration. An
    // explicit install therefore restarts services that were already running.
    for (const service of officeServiceNames) {
      const label = launchdLabels[service];
      const before = await this.evidence(service);
      if (before === null) {
        issues.push(
          `launchctl could not report ${this.domain}/${label}, so it was not re-bootstrapped.`,
        );
        continue;
      }
      if (before.registered) {
        const bootout = await this.launchctl(
          "bootout",
          `${this.domain}/${label}`,
        );
        if (!(await this.waitUntilUnregistered(service))) {
          issues.push(
            `launchctl bootout ${this.domain}/${label} did not unload the job${describeCommandFailure(bootout)}; the previously loaded configuration is still active.`,
          );
          unconverged.add(service);
          continue;
        }
      }
      const bootstrap = await this.launchctl(
        "bootstrap",
        this.domain,
        this.plistPath(service),
      );
      if (bootstrap.exitCode !== 0 || bootstrap.unavailable) {
        issues.push(
          `launchctl bootstrap ${this.domain} ${this.plistPath(service)} failed${describeCommandFailure(bootstrap)}`,
        );
        unconverged.add(service);
        continue;
      }
      const after = await this.evidence(service);
      if (after === null || !after.registered) {
        issues.push(
          `${label} was bootstrapped but launchd does not report it as loaded.`,
        );
        unconverged.add(service);
      }
    }

    const status = await this.buildStatus(unconverged);
    return {
      definitions,
      issues: [...issues, ...status.issues],
      hints: [
        "Installing converges the loaded launchd jobs to the plists on disk, so an explicit install restarts services that were already running.",
        `The dashboard stays bound to loopback. Reach it remotely with SSH forwarding: ssh -L ${this.plan.dashboard.port}:${this.plan.dashboard.host}:${this.plan.dashboard.port} <user>@<host>`,
        `Inspect a service with: launchctl print ${this.domain}/${launchdLabels.runtime}`,
      ],
      status,
    };
  }

  status(): Promise<OfficeServicesStatus> {
    return this.buildStatus(new Set());
  }

  /**
   * `unconverged` names services the caller has just proved are still running
   * a previously loaded configuration. A standalone status cannot discover
   * that — launchd exposes no link from a loaded job back to the plist bytes —
   * so it is never guessed, only carried from an install that observed it.
   */
  private async buildStatus(
    unconverged: ReadonlySet<OfficeServiceName>,
  ): Promise<OfficeServicesStatus> {
    const probe = await this.probeManager();
    const issues: string[] = [];
    const services: OfficeServiceStatus[] = [];

    for (const service of officeServiceNames) {
      const path = this.plistPath(service);
      const { state: definition } = await this.classify(service);
      const installed =
        definition === "managed_current" || definition === "managed_outdated";

      if (definition === "unmanaged_collision")
        issues.push(
          `${path} exists and is not managed by AI Office; it is reported, never modified.`,
        );

      // launchd is always consulted, including when no plist exists: a deleted
      // plist does not unload a job, it only destroys the proof of ownership.
      const evidence = probe.available ? await this.evidence(service) : null;
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
            ? "launchctl did not report this service"
            : "launchd could not be contacted",
        });
        continue;
      }

      const orphaned = !installed && evidence.registered;
      if (orphaned)
        issues.push(
          `${launchdLabels[service]} is still registered with launchd but AI Office cannot prove it owns ${path}. Inspect it, then remove it yourself with: launchctl bootout ${this.domain}/${launchdLabels[service]}`,
        );

      // The downgrade bites only where it matters: a job launchd reports as
      // unloaded is already described truthfully, while one that still looks
      // `running` after a failed re-bootstrap would otherwise read as healthy
      // while executing the old configuration.
      const stale =
        unconverged.has(service) &&
        stateFromEvidence(evidence, definition) === "running";
      services.push({
        service,
        definitionPath: path,
        definition,
        installed,
        registered: evidence.registered,
        // launchd has no unit-file enablement separate from registration: a
        // bootstrapped agent with RunAtLoad is what "enabled" means here.
        enabled: evidence.registered,
        // A job that could not be re-bootstrapped may be running, but not the
        // configuration on disk. That is not a running service in any sense
        // worth reporting as healthy.
        state: stale ? "unknown" : stateFromEvidence(evidence, definition),
        ...(stale
          ? {
              detail:
                "launchd is still running a previously loaded configuration; the plist on disk was not applied",
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
    evidence: LaunchdServiceEvidence,
    orphaned: boolean,
  ): { detail?: string } {
    if (orphaned)
      return {
        detail:
          definition === "unmanaged_collision"
            ? "an unmanaged LaunchAgent occupies this path and this label is registered"
            : "the job remains registered but AI Office cannot prove ownership",
      };
    if (definition === "unmanaged_collision")
      return { detail: "an unmanaged LaunchAgent occupies this path" };
    if (definition === "managed_outdated")
      return { detail: "the plist on disk differs from the current plan" };
    if (evidence.state === undefined) return {};
    return {
      detail:
        evidence.lastExitCode === undefined
          ? evidence.state
          : `${evidence.state} (last exit ${evidence.lastExitCode})`,
    };
  }

  async uninstall(): Promise<OfficeServiceUninstallReport> {
    const removed: OfficeServiceDefinitionOutcome[] = [];
    const preserved: OfficeServicePreservedDefinition[] = [];
    const issues: string[] = [];

    const probe = await this.probeManager();
    if (!probe.available) {
      issues.push(
        `AI Office cannot verify that its services are unloaded: ${probe.reason}. No service definition was removed.`,
      );
      for (const service of ["dashboard", "runtime"] as const) {
        const { state } = await this.classify(service);
        if (state === "missing") continue;
        preserved.push({
          service,
          path: this.plistPath(service),
          reason: "launchd could not be contacted",
        });
      }
      return this.uninstallReport(removed, preserved, issues);
    }

    for (const service of ["dashboard", "runtime"] as const) {
      const path = this.plistPath(service);
      const label = launchdLabels[service];
      const { state: definition } = await this.classify(service);

      if (definition === "unmanaged_collision") {
        preserved.push({
          service,
          path,
          reason: "the LaunchAgent is not managed by AI Office",
        });
        issues.push(
          `${path} is not managed by AI Office; it was left loaded and on disk.`,
        );
        continue;
      }

      if (definition === "missing") {
        const orphan = await this.evidence(service);
        if (orphan !== null && orphan.registered)
          issues.push(
            `${label} is still registered with launchd but AI Office owns no plist for it. Remove it yourself with: launchctl bootout ${this.domain}/${label}`,
          );
        continue;
      }

      const before = await this.evidence(service);
      if (before === null) {
        preserved.push({
          service,
          path,
          reason: "launchd did not report whether the job was loaded",
        });
        issues.push(
          `${label} could not be inspected, so its plist was preserved.`,
        );
        continue;
      }

      if (before.registered) {
        const bootout = await this.launchctl(
          "bootout",
          `${this.domain}/${label}`,
        );
        // The exit code alone settles nothing: bootout may report progress, an
        // already-absent label, or a real refusal. Registration is what is
        // checked, because removing the plist would destroy the evidence that
        // lets a later uninstall clean up a job that is still loaded.
        if (!(await this.waitUntilUnregistered(service))) {
          preserved.push({
            service,
            path,
            reason: "the job is still registered with launchd",
          });
          issues.push(
            `${label} is still loaded after bootout${describeCommandFailure(bootout)}, so its plist was preserved.`,
          );
          continue;
        }
      }

      await this.store.remove(path);
      removed.push({ service, path, action: "removed" });
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
