/**
 * Application port for native per-user service management.
 *
 * AI Office runs two long-lived local processes — the authoritative Runtime
 * host and the loopback dashboard — and an operator may want the operating
 * system to keep them running. The mechanics of that are entirely
 * platform-specific (systemd user units, launchd LaunchAgents), so only the
 * normalized vocabulary lives here: the CLI and the application service never
 * see a unit file, a plist, or a service-manager invocation.
 *
 * Nothing on this port implies a privilege or security boundary. The managed
 * services are per-user, non-root, localhost-only, and installed by explicit
 * operator action; a service manager supervises processes, it does not separate
 * same-UID principals.
 */

/** The two supervised AI Office processes. */
export type OfficeServiceName = "runtime" | "dashboard";

export const officeServiceNames: readonly OfficeServiceName[] = [
  "runtime",
  "dashboard",
];

/** Which per-user OS service manager a report came from. */
export type OfficeServicePlatform = "systemd-user" | "launchd-user";

/**
 * Normalized service state, identical on every platform.
 *
 * `unknown` is deliberate: a state the adapter could not establish is never
 * reported as healthy, and it is never collapsed into `installed_inactive`.
 */
export type OfficeServiceState =
  "not_installed" | "installed_inactive" | "running" | "failed" | "unknown";

/**
 * Ownership classification of a generated service definition.
 *
 * `unmanaged_collision` means a file occupies the target path and does not
 * carry the AI Office ownership marker. It is never written over and never
 * deleted.
 */
export type OfficeServiceDefinitionState =
  "missing" | "managed_current" | "managed_outdated" | "unmanaged_collision";

export interface OfficeServiceStatus {
  readonly service: OfficeServiceName;
  /** Absolute path of the unit or plist this service would be defined by. */
  readonly definitionPath: string;
  readonly definition: OfficeServiceDefinitionState;
  /** True only for a definition AI Office provably owns. */
  readonly installed: boolean;
  /** Registered with the service manager; `null` when it could not be read. */
  readonly registered: boolean | null;
  /** Starts without an operator; `null` when it could not be read. */
  readonly enabled: boolean | null;
  readonly state: OfficeServiceState;
  /** Short, non-localized platform evidence; never raw command output. */
  readonly detail?: string;
}

export interface OfficeServicesStatus {
  readonly contractVersion: 1;
  readonly platform: OfficeServicePlatform;
  /** False when the per-user service manager could not be contacted. */
  readonly serviceManagerAvailable: boolean;
  readonly runtimeHome: string;
  readonly dashboardEndpoint: string;
  readonly services: readonly OfficeServiceStatus[];
  readonly issues: readonly string[];
}

export type OfficeServiceDefinitionAction =
  "created" | "updated" | "unchanged" | "removed";

export interface OfficeServiceDefinitionOutcome {
  readonly service: OfficeServiceName;
  readonly path: string;
  readonly action: OfficeServiceDefinitionAction;
}

/**
 * What an adapter observed while installing. It reports facts only; the
 * application decides whether the installation succeeded.
 */
export interface OfficeServiceInstallReport {
  readonly definitions: readonly OfficeServiceDefinitionOutcome[];
  readonly issues: readonly string[];
  readonly hints: readonly string[];
  /** Authoritative post-install state, queried after the start attempts. */
  readonly status: OfficeServicesStatus;
}

export interface OfficeServicePreservedDefinition {
  readonly service: OfficeServiceName;
  readonly path: string;
  readonly reason: string;
}

export interface OfficeServiceUninstallReport {
  readonly platform: OfficeServicePlatform;
  readonly removed: readonly OfficeServiceDefinitionOutcome[];
  readonly preserved: readonly OfficeServicePreservedDefinition[];
  readonly issues: readonly string[];
  /** Data paths the uninstall deliberately left untouched. */
  readonly preservedData: readonly string[];
}

export interface OfficeServiceManager {
  readonly platform: OfficeServicePlatform;
  install(): Promise<OfficeServiceInstallReport>;
  status(): Promise<OfficeServicesStatus>;
  uninstall(): Promise<OfficeServiceUninstallReport>;
}

/** Raised when no per-user service adapter exists for the running platform. */
export class UnsupportedServicePlatformError extends Error {
  constructor(
    readonly platform: string,
    message: string,
  ) {
    super(message);
    this.name = "UnsupportedServicePlatformError";
  }
}

/**
 * Raised when installation cannot proceed safely: a collision with a file AI
 * Office does not own, an unusable service manager, or an unrenderable
 * definition. Installation stops instead of guessing.
 */
export class OfficeServicePreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfficeServicePreconditionError";
  }
}
