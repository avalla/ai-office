import { isAbsolute } from "node:path";
import { OfficeServicePreconditionError } from "@ai-office/application/ports/office-service-manager.port.ts";
import { assertRenderableValue } from "@ai-office/application/service-management/managed-definition.ts";

/**
 * How the managed services invoke AI Office.
 *
 * The launcher is an absolute argv prefix, never a bare program name: a
 * per-user service inherits a minimal environment, so anything resolved
 * through an interactive shell `PATH` would work at install time and fail at
 * boot. The composition root supplies it because only the entry point knows
 * whether it is a script run by an interpreter or a standalone executable.
 */
export interface OfficeServiceProgram {
  readonly launcher: readonly string[];
  /** The authoritative AI_OFFICE_HOME, resolved by the caller's own rules. */
  readonly runtimeHome: string;
  /**
   * True when the resolved executable is the source distribution, which
   * refuses operational Runtime access without an explicit opt-in. The guard
   * is satisfied deliberately for the generated services and is never relaxed
   * anywhere else.
   */
  readonly requiresSourceRuntimeOptIn: boolean;
}

export interface OfficeServiceDashboardPlan {
  /** Loopback only; a non-loopback address is refused before rendering. */
  readonly host: string;
  readonly port: number;
  /**
   * How long the supervised dashboard waits for the Runtime socket before
   * giving up and letting the service manager restart it. Start ordering is a
   * convenience, never a correctness assumption.
   */
  readonly awaitRuntimeSeconds: number;
}

export interface OfficeServicePlan {
  readonly program: OfficeServiceProgram;
  readonly dashboard: OfficeServiceDashboardPlan;
}

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);

export const runtimeServiceDescription = "AI Office Runtime";
export const dashboardServiceDescription = "AI Office Dashboard";

/** Validates a plan once, before any platform renders or writes anything. */
export function validateOfficeServicePlan(
  plan: OfficeServicePlan,
): OfficeServicePlan {
  if (plan.program.launcher.length === 0)
    throw new OfficeServicePreconditionError(
      "AI Office service installation requires a resolved program launcher",
    );
  for (const part of plan.program.launcher) assertRenderableValue(part, part);
  const executable = plan.program.launcher[0]!;
  if (!isAbsolute(executable))
    throw new OfficeServicePreconditionError(
      `AI Office service installation requires an absolute executable path, not ${executable}`,
    );
  if (!isAbsolute(plan.program.runtimeHome))
    throw new OfficeServicePreconditionError(
      `AI Office service installation requires an absolute AI_OFFICE_HOME, not ${plan.program.runtimeHome}`,
    );
  assertRenderableValue(plan.program.runtimeHome, "AI_OFFICE_HOME");
  if (!loopbackHosts.has(plan.dashboard.host))
    throw new OfficeServicePreconditionError(
      `The managed dashboard only binds loopback addresses; refusing ${plan.dashboard.host}`,
    );
  if (
    !Number.isSafeInteger(plan.dashboard.port) ||
    plan.dashboard.port < 1 ||
    plan.dashboard.port > 65535
  )
    throw new OfficeServicePreconditionError(
      "The managed dashboard port must be an integer between 1 and 65535",
    );
  if (
    !Number.isSafeInteger(plan.dashboard.awaitRuntimeSeconds) ||
    plan.dashboard.awaitRuntimeSeconds < 0
  )
    throw new OfficeServicePreconditionError(
      "The managed dashboard Runtime wait must be a non-negative integer",
    );
  return plan;
}

/**
 * Environment shared by both services, in a fixed order so rendering stays
 * byte-for-byte deterministic.
 */
export function officeServiceEnvironment(
  program: OfficeServiceProgram,
): ReadonlyArray<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [
    ["AI_OFFICE_HOME", program.runtimeHome],
  ];
  if (program.requiresSourceRuntimeOptIn)
    entries.push(["AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE", "1"]);
  return entries;
}

export function runtimeServiceArguments(
  program: OfficeServiceProgram,
): readonly string[] {
  return [...program.launcher, "runtime", "start"];
}

export function dashboardServiceArguments(
  plan: OfficeServicePlan,
): readonly string[] {
  return [
    ...plan.program.launcher,
    "dashboard",
    "--host",
    plan.dashboard.host,
    "--port",
    String(plan.dashboard.port),
    "--no-open",
    "--await-runtime",
    String(plan.dashboard.awaitRuntimeSeconds),
  ];
}

export function dashboardEndpoint(plan: OfficeServicePlan): string {
  const authority =
    plan.dashboard.host === "::1" ? "[::1]" : plan.dashboard.host;
  return `http://${authority}:${plan.dashboard.port}`;
}
