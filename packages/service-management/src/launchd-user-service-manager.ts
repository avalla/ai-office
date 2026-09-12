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
    `<!-- ${officeServiceOwnershipMarker} -->`,
    `<!-- Definition: ai-office/service/v1 ${service} -->`,
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
): OfficeServiceState {
  if (!evidence.registered) return "installed_inactive";
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

  constructor(options: LaunchdUserServiceManagerOptions) {
    this.plan = validateOfficeServicePlan(options.plan);
    this.agentDirectory =
      options.agentDirectory ?? defaultLaunchAgentDirectory();
    this.runner = options.runner ?? new BunServiceCommandRunner();
    this.store = options.store ?? new LocalServiceDefinitionStore();
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

  async install(): Promise<OfficeServiceInstallReport> {
    const probe = await this.probeManager();
    if (!probe.available)
      throw new OfficeServicePreconditionError(
        `AI Office service installation requires launchd: ${probe.reason}`,
      );

    const desired = new Map<OfficeServiceName, string>();
    for (const service of officeServiceNames)
      desired.set(service, renderLaunchdPlist(this.plan, service));

    const classified = new Map<
      OfficeServiceName,
      ReturnType<typeof classifyManagedDefinition>
    >();
    for (const service of officeServiceNames) {
      const path = this.plistPath(service);
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
      const path = this.plistPath(service);
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
    // Runtime first, dashboard second. Correctness does not rely on it;
    // it just avoids a pointless first dashboard restart.
    for (const service of officeServiceNames) {
      const label = launchdLabels[service];
      const registered = (await this.evidence(service))?.registered === true;
      const action = definitions.find(
        (entry) => entry.service === service,
      )?.action;
      if (registered && action === "unchanged") continue;
      if (registered) {
        const bootout = await this.launchctl(
          "bootout",
          `${this.domain}/${label}`,
        );
        if (bootout.exitCode !== 0 || bootout.unavailable)
          issues.push(
            `launchctl bootout ${this.domain}/${label} failed${describeFailure(bootout)}`,
          );
      }
      const bootstrap = await this.launchctl(
        "bootstrap",
        this.domain,
        this.plistPath(service),
      );
      if (bootstrap.exitCode !== 0 || bootstrap.unavailable)
        issues.push(
          `launchctl bootstrap ${this.domain} ${this.plistPath(service)} failed${describeFailure(bootstrap)}`,
        );
    }

    const status = await this.status();
    return {
      definitions,
      issues: [...issues, ...status.issues],
      hints: [
        `The dashboard stays bound to loopback. Reach it remotely with SSH forwarding: ssh -L ${this.plan.dashboard.port}:${this.plan.dashboard.host}:${this.plan.dashboard.port} <user>@<host>`,
        `Inspect a service with: launchctl print ${this.domain}/${launchdLabels.runtime}`,
      ],
      status,
    };
  }

  async status(): Promise<OfficeServicesStatus> {
    const probe = await this.probeManager();
    const issues: string[] = [];
    const services: OfficeServiceStatus[] = [];

    for (const service of officeServiceNames) {
      const path = this.plistPath(service);
      const existing = await this.store.read(path);
      const definition = classifyManagedDefinition(
        existing,
        renderLaunchdPlist(this.plan, service),
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
          detail: "an unmanaged LaunchAgent occupies this path",
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
          detail: "launchd could not be contacted",
        });
        continue;
      }

      const evidence = await this.evidence(service);
      if (evidence === null) {
        services.push({
          service,
          definitionPath: path,
          definition,
          installed: true,
          registered: null,
          enabled: null,
          state: "unknown",
          detail: "launchctl did not report this service",
        });
        continue;
      }
      services.push({
        service,
        definitionPath: path,
        definition,
        installed: true,
        registered: evidence.registered,
        // launchd has no unit-file enablement separate from registration: a
        // bootstrapped agent with RunAtLoad is what "enabled" means here.
        enabled: evidence.registered,
        state: stateFromEvidence(evidence),
        ...(evidence.state === undefined
          ? {}
          : {
              detail:
                evidence.lastExitCode === undefined
                  ? evidence.state
                  : `${evidence.state} (last exit ${evidence.lastExitCode})`,
            }),
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

    for (const service of ["dashboard", "runtime"] as const) {
      const path = this.plistPath(service);
      const existing = await this.store.read(path);
      const definition = classifyManagedDefinition(
        existing,
        renderLaunchdPlist(this.plan, service),
      );
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
      if (definition === "missing") continue;

      const label = launchdLabels[service];
      const bootout = await this.launchctl(
        "bootout",
        `${this.domain}/${label}`,
      );
      // A label that is not bootstrapped is the ordinary repeated-uninstall
      // case; only an unexecutable launchctl is a real failure here.
      if (bootout.unavailable)
        issues.push(
          `launchctl bootout ${this.domain}/${label} failed${describeFailure(bootout)}`,
        );
      await this.store.remove(path);
      removed.push({ service, path, action: "removed" });
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

function describeFailure(result: ServiceCommandResult): string {
  if (result.unavailable) return " (the command could not be executed)";
  const line = result.stderr.split("\n").find((entry) => entry.trim() !== "");
  return line === undefined
    ? ` (exit ${result.exitCode})`
    : ` (exit ${result.exitCode}: ${line.trim()})`;
}
