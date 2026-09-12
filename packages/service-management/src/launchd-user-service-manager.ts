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
 * Two launchd facts are kept apart here because launchd keeps them apart. A
 * label may be *registered* — bootstrapped into the domain right now — and it
 * separately carries a persistent *enable/disable* override that survives
 * reboots and that a disabled label cannot be loaded past. `launchctl print`
 * answers the first, `launchctl print-disabled` the second, and neither is
 * inferred from the other.
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
    // The human-readable name is a comment for the same reason. launchd.plist(5)
    // defines no description key, and a plist must carry only keys launchd
    // documents rather than undocumented presentation metadata.
    `<!-- ${escapeXml(description)} -->`,
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
    "</dict>",
    "</plist>",
  ].join("\n")}\n`;
}

/** The deterministic fields a loaded job publishes through `launchctl print`. */
interface LaunchdJobFacts {
  readonly state?: string;
  readonly pid?: number;
  readonly lastExitCode?: number;
}

/**
 * What launchd said when asked about one label.
 *
 * The three cases are deliberately not two. `absent` is a *positive* answer —
 * launchd said it does not know the label — and it is the only answer that
 * permits AI Office to delete the plist that proves it owns the job. `unknown`
 * covers everything else launchctl can do instead of answering: a missing
 * binary, a time bound, an I/O error, an unreachable domain, a response in a
 * shape this adapter does not recognize. Collapsing those into "not
 * registered" would let an uninstall destroy its own ownership evidence while
 * the job was still loaded, which is exactly the state nothing can recover
 * from.
 */
export type LaunchdRegistration =
  | ({ readonly kind: "registered" } & LaunchdJobFacts)
  | { readonly kind: "absent" }
  | { readonly kind: "unknown"; readonly reason: string };

/**
 * The launchctl responses that positively mean "this label is not loaded".
 *
 * Narrow on purpose, and matched on the message rather than the exit status:
 * launchctl's numeric codes have moved between macOS releases while these
 * phrases have not, and `LC_ALL=C` is forced by the command runner so the
 * wording is not localized. "Could not find domain" is deliberately absent —
 * that says the domain could not be inspected, not that the job is gone.
 */
const launchdAbsenceSignatures: readonly RegExp[] = [
  /could not find service/iu,
  /no such service/iu,
  /no such process/iu,
];

/**
 * True only for a `launchctl print` failure that names the label as unknown.
 *
 * Every other non-zero result — an unavailable binary, a time bound, exit 5
 * with "Input/output error", a code this adapter has never seen — is an
 * inspection failure and must not be read as absence.
 */
export function launchdPrintIndicatesAbsence(
  result: ServiceCommandResult,
): boolean {
  if (result.unavailable || result.timedOut === true) return false;
  if (result.exitCode === 0) return false;
  const message = `${result.stderr}\n${result.stdout}`;
  return launchdAbsenceSignatures.some((signature) => signature.test(message));
}

/**
 * Reads the few deterministic fields `launchctl print` publishes.
 *
 * Only anchored `key = value` lines are consulted; the surrounding
 * presentation text is deliberately not interpreted.
 */
export function parseLaunchdPrint(stdout: string): LaunchdJobFacts {
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

/**
 * The persistent disabled overrides launchd keeps for a domain.
 *
 * `launchctl enable`/`disable` write a per-user override that survives reboots
 * and is entirely separate from whether a job happens to be bootstrapped right
 * now: a disabled label cannot be loaded normally until it is enabled again.
 * A label with no entry has no override and therefore starts from the default,
 * which for an AI Office plist — none of which set `Disabled` — is enabled.
 *
 * `null` means the override database could not be read, which is reported as an
 * unknown enablement rather than guessed in either direction.
 */
export type LaunchdDisabledOverrides = ReadonlyMap<string, boolean>;

/**
 * Parses `launchctl print-disabled <domain>`.
 *
 * The listing is a brace-delimited block of `"<label>" => <value>` lines.
 * Both value spellings macOS has shipped are accepted; anything else leaves the
 * entry out, and a response that is not a disabled listing at all yields
 * `null` so the caller reports an unknown state.
 */
export function parseLaunchdDisabledServices(
  stdout: string,
): LaunchdDisabledOverrides | null {
  const overrides = new Map<string, boolean>();
  for (const match of stdout.matchAll(
    /^\s*"?([\w.\-+]+)"?\s*=>\s*(true|false|disabled|enabled)\s*$/gimu,
  )) {
    const value = match[2]!.toLowerCase();
    overrides.set(match[1]!, value === "true" || value === "disabled");
  }
  if (overrides.size > 0) return overrides;
  // An empty override database is an ordinary answer, but only when the
  // response is recognizably the listing rather than something unexpected.
  return /disabled services\s*=\s*\{/iu.test(stdout) ? overrides : null;
}

/**
 * The normalized `enabled` fact for one label.
 *
 * Registration is never consulted: whether launchd currently knows a job and
 * whether it is permitted to start it are two independent facts, and conflating
 * them would report a disabled service as ready to come back after a reboot.
 */
export function launchdEnablement(
  overrides: LaunchdDisabledOverrides | null,
  label: string,
): boolean | null {
  if (overrides === null) return null;
  return overrides.get(label) !== true;
}

function stateFromRegistration(
  registration: LaunchdRegistration,
  definition: OfficeServiceDefinitionState,
): OfficeServiceState {
  if (registration.kind === "unknown") return "unknown";
  if (registration.kind === "absent")
    return definition === "missing" ? "not_installed" : "installed_inactive";
  if (registration.state === "running" || registration.pid !== undefined)
    return "running";
  if (
    registration.lastExitCode !== undefined &&
    registration.lastExitCode !== 0
  )
    return "failed";
  if (registration.state !== undefined) return "installed_inactive";
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
   * A non-zero exit is only read as absence when launchctl names the label as
   * unknown. Anything else it can fail with is `unknown`, which is emphatically
   * not "the job is not loaded" and is never treated as such.
   */
  private async registration(
    service: OfficeServiceName,
  ): Promise<LaunchdRegistration> {
    const target = `${this.domain}/${launchdLabels[service]}`;
    const printed = await this.launchctl("print", target);
    if (printed.exitCode === 0 && !printed.unavailable)
      return { kind: "registered", ...parseLaunchdPrint(printed.stdout) };
    if (launchdPrintIndicatesAbsence(printed)) return { kind: "absent" };
    return {
      kind: "unknown",
      reason: `launchctl print ${target} did not report whether the job is loaded${describeCommandFailure(printed)}`,
    };
  }

  /**
   * Reads the domain's persistent enable/disable overrides once.
   *
   * One call answers for every managed label, and `null` propagates as an
   * unknown enablement rather than an assumed one.
   */
  private async disabledOverrides(): Promise<LaunchdDisabledOverrides | null> {
    const printed = await this.launchctl("print-disabled", this.domain);
    if (printed.unavailable || printed.exitCode !== 0) return null;
    return parseLaunchdDisabledServices(printed.stdout);
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
   * progress, so its exit code is never taken as proof. The last observation is
   * returned so the caller can say which of the two failures it hit: the job is
   * demonstrably still there, or launchd never said. Only `absent` is success;
   * an answer that never came is not an answer that the job left.
   */
  private async waitUntilUnregistered(
    service: OfficeServiceName,
  ): Promise<LaunchdRegistration> {
    let last: LaunchdRegistration = {
      kind: "unknown",
      reason: `launchctl was not asked about ${launchdLabels[service]}`,
    };
    for (let attempt = 0; attempt < this.settleAttempts; attempt += 1) {
      last = await this.registration(service);
      if (last.kind === "absent") return last;
      if (attempt + 1 < this.settleAttempts) await this.delay();
    }
    return last;
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
    // Services whose persistent launchd enablement could not be established.
    // An override written by a previous `launchctl disable` outlives a reboot
    // and silently prevents a bootstrap, so an explicit install lifts it
    // deliberately rather than hoping none is set.
    const enableFailures = new Set<OfficeServiceName>();
    for (const service of officeServiceNames) {
      const target = `${this.domain}/${launchdLabels[service]}`;
      const enabled = await this.launchctl("enable", target);
      if (enabled.unavailable || enabled.exitCode !== 0) {
        issues.push(
          `launchctl enable ${target} failed${describeCommandFailure(enabled)}; a persistent disabled override may still prevent this service from starting.`,
        );
        enableFailures.add(service);
      }
    }
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
      const before = await this.registration(service);
      if (before.kind === "unknown") {
        issues.push(`${before.reason}, so it was not re-bootstrapped.`);
        unconverged.add(service);
        continue;
      }
      if (before.kind === "registered") {
        const bootout = await this.launchctl(
          "bootout",
          `${this.domain}/${label}`,
        );
        if ((await this.waitUntilUnregistered(service)).kind !== "absent") {
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
      const after = await this.registration(service);
      if (after.kind !== "registered") {
        issues.push(
          `${label} was bootstrapped but launchd does not report it as loaded.`,
        );
        unconverged.add(service);
      }
    }

    const status = await this.buildStatus(unconverged, enableFailures);
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
    return this.buildStatus(new Set(), new Set());
  }

  /**
   * `unconverged` names services the caller has just proved are still running
   * a previously loaded configuration. A standalone status cannot discover
   * that — launchd exposes no link from a loaded job back to the plist bytes —
   * so it is never guessed, only carried from an install that observed it.
   *
   * `enableFailures` names services whose `launchctl enable` did not succeed.
   * Their enablement is never reported as `true`, even when the override
   * database happens to read as enabled, because the install has direct
   * evidence that it could not establish that state.
   */
  private async buildStatus(
    unconverged: ReadonlySet<OfficeServiceName>,
    enableFailures: ReadonlySet<OfficeServiceName>,
  ): Promise<OfficeServicesStatus> {
    const probe = await this.probeManager();
    const issues: string[] = [];
    const services: OfficeServiceStatus[] = [];
    const overrides = probe.available ? await this.disabledOverrides() : null;
    if (probe.available && overrides === null)
      issues.push(
        `launchctl print-disabled ${this.domain} did not report the persistent enable state, so enablement is unknown.`,
      );

    for (const service of officeServiceNames) {
      const path = this.plistPath(service);
      const { state: definition } = await this.classify(service);
      const installed =
        definition === "managed_current" || definition === "managed_outdated";

      if (definition === "unmanaged_collision")
        issues.push(
          `${path} exists and is not managed by AI Office; it is reported, never modified.`,
        );

      // The persistent override is a fact about the label, not about the loaded
      // job, so it is reported even when registration could not be read. A
      // failed `launchctl enable` withholds a `true`; a positive disabled
      // reading still survives as `false`, because that much was established.
      const reported = launchdEnablement(overrides, launchdLabels[service]);
      const enabled =
        enableFailures.has(service) && reported !== false ? null : reported;
      if (enabled === false)
        issues.push(
          `${launchdLabels[service]} has a persistent launchd disabled override, so launchd will not start it. Run ai-office service install to re-enable it.`,
        );

      // launchd is always consulted, including when no plist exists: a deleted
      // plist does not unload a job, it only destroys the proof of ownership.
      const registration: LaunchdRegistration = probe.available
        ? await this.registration(service)
        : { kind: "unknown", reason: "launchd could not be contacted" };
      if (registration.kind === "unknown") {
        services.push({
          service,
          definitionPath: path,
          definition,
          installed,
          registered: null,
          enabled,
          state: "unknown",
          detail: probe.available
            ? "launchctl did not report whether this job is loaded"
            : "launchd could not be contacted",
        });
        if (probe.available) issues.push(`${registration.reason}.`);
        continue;
      }

      const orphaned = !installed && registration.kind === "registered";
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
        stateFromRegistration(registration, definition) === "running";
      services.push({
        service,
        definitionPath: path,
        definition,
        installed,
        registered: registration.kind === "registered",
        enabled,
        // A job that could not be re-bootstrapped may be running, but not the
        // configuration on disk. That is not a running service in any sense
        // worth reporting as healthy.
        state: stale
          ? "unknown"
          : stateFromRegistration(registration, definition),
        ...(stale
          ? {
              detail:
                "launchd is still running a previously loaded configuration; the plist on disk was not applied",
            }
          : this.detailFor(definition, registration, orphaned, enabled)),
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
    registration: LaunchdRegistration,
    orphaned: boolean,
    enabled: boolean | null,
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
    if (enabled === false)
      return {
        detail:
          "a persistent launchd disabled override prevents this service from starting",
      };
    if (enabled === null)
      return {
        detail: "the persistent launchd enable state could not be read",
      };
    if (definition === "managed_outdated")
      return { detail: "the plist on disk differs from the current plan" };
    if (registration.kind !== "registered" || registration.state === undefined)
      return {};
    return {
      detail:
        registration.lastExitCode === undefined
          ? registration.state
          : `${registration.state} (last exit ${registration.lastExitCode})`,
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
        const orphan = await this.registration(service);
        if (orphan.kind === "registered")
          issues.push(
            `${label} is still registered with launchd but AI Office owns no plist for it. Remove it yourself with: launchctl bootout ${this.domain}/${label}`,
          );
        else if (orphan.kind === "unknown")
          issues.push(
            `${orphan.reason}, so AI Office cannot confirm that no orphaned job remains for ${label}.`,
          );
        continue;
      }

      const before = await this.registration(service);
      // An inspection that failed is not an inspection that found nothing. The
      // plist is the only evidence that AI Office owns this job, so deleting it
      // here would leave a job nothing can later attribute or clean up.
      if (before.kind === "unknown") {
        preserved.push({
          service,
          path,
          reason: "launchd did not report whether the job was loaded",
        });
        issues.push(`${before.reason}, so its plist was preserved.`);
        continue;
      }

      if (before.kind === "registered") {
        const bootout = await this.launchctl(
          "bootout",
          `${this.domain}/${label}`,
        );
        // The exit code alone settles nothing: bootout may report progress, an
        // already-absent label, or a real refusal. Registration is what is
        // checked, because removing the plist would destroy the evidence that
        // lets a later uninstall clean up a job that is still loaded.
        const settled = await this.waitUntilUnregistered(service);
        if (settled.kind !== "absent") {
          const unknown = settled.kind === "unknown";
          preserved.push({
            service,
            path,
            reason: unknown
              ? "launchd did not report whether the job was unloaded"
              : "the job is still registered with launchd",
          });
          issues.push(
            unknown
              ? `${settled.reason} after bootout${describeCommandFailure(bootout)}, so its plist was preserved.`
              : `${label} is still loaded after bootout${describeCommandFailure(bootout)}, so its plist was preserved.`,
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
