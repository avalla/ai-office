import type {
  OfficeServiceInstallReport,
  OfficeServiceManager,
  OfficeServiceName,
  OfficeServicePlatform,
  OfficeServicePreservedDefinition,
  OfficeServiceDefinitionOutcome,
  OfficeServiceStatus,
  OfficeServiceUninstallReport,
  OfficeServicesStatus,
} from "../ports/office-service-manager.port.ts";
import { officeServiceNames } from "../ports/office-service-manager.port.ts";

export type OfficeServiceInstallOutcome = "installed" | "partial" | "failed";
export type OfficeServiceUninstallOutcome =
  "uninstalled" | "partial" | "failed";

export interface OfficeServiceInstallResult {
  readonly contractVersion: 1;
  readonly outcome: OfficeServiceInstallOutcome;
  readonly platform: OfficeServicePlatform;
  readonly definitions: readonly OfficeServiceDefinitionOutcome[];
  readonly status: OfficeServicesStatus;
  readonly issues: readonly string[];
  readonly hints: readonly string[];
}

export interface OfficeServiceUninstallResult {
  readonly contractVersion: 1;
  readonly outcome: OfficeServiceUninstallOutcome;
  readonly platform: OfficeServicePlatform;
  readonly removed: readonly OfficeServiceDefinitionOutcome[];
  readonly preserved: readonly OfficeServicePreservedDefinition[];
  readonly preservedData: readonly string[];
  readonly issues: readonly string[];
}

function serviceOf(
  status: OfficeServicesStatus,
  service: OfficeServiceName,
): OfficeServiceStatus | undefined {
  return status.services.find((entry) => entry.service === service);
}

/**
 * True only when every managed service is installed and observed running.
 *
 * `unknown` never counts as healthy: a state the adapter could not read is a
 * reason to report less, not a reason to claim more.
 */
export function officeServicesHealthy(status: OfficeServicesStatus): boolean {
  if (!status.serviceManagerAvailable) return false;
  return officeServiceNames.every((name) => {
    const entry = serviceOf(status, name);
    return entry !== undefined && entry.installed && entry.state === "running";
  });
}

/**
 * Coordinates native service lifecycle through one platform adapter.
 *
 * The adapter reports what the operating system did and what it now says. The
 * decision of whether that amounts to success stays here, so no platform
 * implementation can report a success banner that its own post-install status
 * contradicts.
 */
export class ManageOfficeServices {
  constructor(private readonly manager: OfficeServiceManager) {}

  async install(): Promise<OfficeServiceInstallResult> {
    const report = await this.manager.install();
    return {
      contractVersion: 1,
      outcome: installOutcome(report),
      platform: this.manager.platform,
      definitions: report.definitions,
      status: report.status,
      issues: report.issues,
      hints: report.hints,
    };
  }

  status(): Promise<OfficeServicesStatus> {
    return this.manager.status();
  }

  async uninstall(): Promise<OfficeServiceUninstallResult> {
    const report = await this.manager.uninstall();
    return {
      contractVersion: 1,
      outcome: uninstallOutcome(report),
      platform: report.platform,
      removed: report.removed,
      preserved: report.preserved,
      preservedData: report.preservedData,
      issues: report.issues,
    };
  }
}

function installOutcome(
  report: OfficeServiceInstallReport,
): OfficeServiceInstallOutcome {
  if (officeServicesHealthy(report.status) && report.issues.length === 0)
    return "installed";
  const anyRunning = report.status.services.some(
    (entry) => entry.state === "running",
  );
  const anyDefinition = report.definitions.length > 0;
  return anyRunning || anyDefinition ? "partial" : "failed";
}

function uninstallOutcome(
  report: OfficeServiceUninstallReport,
): OfficeServiceUninstallOutcome {
  if (report.issues.length === 0 && report.preserved.length === 0)
    return "uninstalled";
  // Something of ours may still be registered, or a foreign definition still
  // occupies a name AI Office would use. Neither is a clean uninstall.
  return report.removed.length > 0 || report.preserved.length > 0
    ? "partial"
    : "failed";
}
