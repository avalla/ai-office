import type { OfficeServiceManager } from "@ai-office/application/ports/office-service-manager.port.ts";
import { UnsupportedServicePlatformError } from "@ai-office/application/ports/office-service-manager.port.ts";
import type { OfficeServicePlan } from "./service-plan.ts";
import { SystemdUserServiceManager } from "./systemd-user-service-manager.ts";
import { LaunchdUserServiceManager } from "./launchd-user-service-manager.ts";
import type { ServiceCommandRunner } from "./service-command-runner.ts";
import type { ServiceDefinitionStore } from "./service-definition-store.ts";

export interface SelectOfficeServiceManagerOptions {
  plan: OfficeServicePlan;
  /** Defaults to the running platform. */
  platform?: string;
  runner?: ServiceCommandRunner;
  store?: ServiceDefinitionStore;
  /** systemd only: overrides `~/.config/systemd/user`. */
  unitDirectory?: string;
  /** launchd only: overrides `~/Library/LaunchAgents`. */
  agentDirectory?: string;
  userName?: string;
  userId?: number;
}

/**
 * Chooses the per-user service adapter for the running operating system.
 *
 * Platform selection lives here rather than in the CLI so presentation never
 * grows a platform branch, and so an unsupported platform fails with one
 * actionable error instead of a partially implemented install.
 */
export function selectOfficeServiceManager(
  options: SelectOfficeServiceManagerOptions,
): OfficeServiceManager {
  const platform = options.platform ?? process.platform;
  switch (platform) {
    case "linux":
      return new SystemdUserServiceManager({
        plan: options.plan,
        ...(options.unitDirectory === undefined
          ? {}
          : { unitDirectory: options.unitDirectory }),
        ...(options.runner === undefined ? {} : { runner: options.runner }),
        ...(options.store === undefined ? {} : { store: options.store }),
        ...(options.userName === undefined
          ? {}
          : { userName: options.userName }),
      });
    case "darwin":
      return new LaunchdUserServiceManager({
        plan: options.plan,
        ...(options.agentDirectory === undefined
          ? {}
          : { agentDirectory: options.agentDirectory }),
        ...(options.runner === undefined ? {} : { runner: options.runner }),
        ...(options.store === undefined ? {} : { store: options.store }),
        ...(options.userId === undefined ? {} : { userId: options.userId }),
      });
    case "win32":
      throw new UnsupportedServicePlatformError(
        platform,
        'AI Office does not currently support Windows services. Run the Runtime and the dashboard in the foreground with "ai-office runtime start" and "ai-office dashboard".',
      );
    default:
      throw new UnsupportedServicePlatformError(
        platform,
        `AI Office service management supports Linux (systemd --user) and macOS (launchd LaunchAgents); ${platform} is not supported. Run "ai-office runtime start" and "ai-office dashboard" in the foreground instead.`,
      );
  }
}
