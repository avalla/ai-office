import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  launchdLabels,
  launchdOwnershipLines,
  LaunchdUserServiceManager,
  defaultLaunchAgentDirectory,
  parseLaunchdPrint,
  renderLaunchdPlist,
} from "@ai-office/service-management/launchd-user-service-manager.ts";
import { OfficeServicePreconditionError } from "@ai-office/application/ports/office-service-manager.port.ts";
import type { OfficeServiceName } from "@ai-office/application/ports/office-service-manager.port.ts";
import { officeServicesHealthy } from "@ai-office/application/service-management/manage-office-services.ts";
import type {
  ServiceCommandResult,
  ServiceCommandRunner,
} from "@ai-office/service-management/service-command-runner.ts";
import {
  cleanTemporaryDirectories,
  launchdPrintOutput,
  parseMinimalPlist,
  servicePlan,
  temporaryDefinitionDirectory,
} from "../helpers/service-management.ts";

const userId = 501;
const domain = `gui/${userId}`;
const directories: string[] = [];
afterEach(() => cleanTemporaryDirectories(directories));

interface LaunchdJob {
  state: string;
  pid?: number;
  lastExitCode?: number;
}

/**
 * A launchd domain that behaves like the real one for the operations this
 * adapter uses, so registration, convergence, and repeated uninstall can be
 * exercised without a macOS host.
 */
class FakeLaunchd implements ServiceCommandRunner {
  readonly calls: string[][] = [];
  readonly jobs = new Map<string, LaunchdJob>();

  domainAvailable = true;
  launchctlMissing = false;
  /** Labels whose next bootstrap must fail. */
  readonly bootstrapFailures = new Set<string>();
  /** Labels whose bootout reports failure and does not unload the job. */
  readonly bootoutFailures = new Set<string>();
  /** Labels whose bootout reports success but leaves the job loaded. */
  readonly bootoutNoOps = new Set<string>();
  /** State a label takes on once bootstrapped. */
  readonly startedState = new Map<string, LaunchdJob>();
  /** Records the plist path each bootstrap was given. */
  readonly bootstrapped: string[] = [];

  async run(command: readonly string[]): Promise<ServiceCommandResult> {
    this.calls.push([...command]);
    if (this.launchctlMissing)
      return { exitCode: 127, stdout: "", stderr: "", unavailable: true };
    const [, operation, target, argument] = command;
    if (operation === "print" && target === domain)
      return this.domainAvailable
        ? this.ok(`${domain} = {\n}\n`)
        : this.fail(3, "Could not find domain");
    if (operation === "print") {
      const label = target!.slice(domain.length + 1);
      const job = this.jobs.get(label);
      return job === undefined
        ? this.fail(113, "Could not find service")
        : this.ok(
            launchdPrintOutput({
              state: job.state,
              ...(job.pid === undefined ? {} : { pid: job.pid }),
              ...(job.lastExitCode === undefined
                ? {}
                : { lastExitCode: job.lastExitCode }),
            }),
          );
    }
    if (operation === "bootstrap") {
      const label = basename(argument!, ".plist");
      this.bootstrapped.push(argument!);
      if (this.bootstrapFailures.has(label))
        return this.fail(5, "Input/output error");
      this.jobs.set(
        label,
        this.startedState.get(label) ?? { state: "running", pid: 4242 },
      );
      return this.ok("");
    }
    if (operation === "bootout") {
      const label = target!.slice(domain.length + 1);
      if (this.bootoutFailures.has(label))
        return this.fail(36, "Operation now in progress");
      if (this.bootoutNoOps.has(label)) return this.ok("");
      if (!this.jobs.delete(label))
        return this.fail(3, "No such process while removing service");
      return this.ok("");
    }
    return this.ok("");
  }

  private ok(stdout: string): ServiceCommandResult {
    return { exitCode: 0, stdout, stderr: "", unavailable: false };
  }

  private fail(exitCode: number, stderr: string): ServiceCommandResult {
    return { exitCode, stdout: "", stderr: `${stderr}\n`, unavailable: false };
  }

  indexOf(fragment: readonly string[]): number {
    return this.calls.findIndex((command) =>
      fragment.every((part) => command.includes(part)),
    );
  }
}

function manager(
  runner: FakeLaunchd = new FakeLaunchd(),
  plan = servicePlan(),
): {
  manager: LaunchdUserServiceManager;
  runner: FakeLaunchd;
  agentDirectory: string;
} {
  const agentDirectory = temporaryDefinitionDirectory(
    directories,
    "ai-office-launchd-",
  );
  return {
    runner,
    agentDirectory,
    manager: new LaunchdUserServiceManager({
      plan,
      agentDirectory,
      runner,
      userId,
      // Bounded re-checks without real delays; the fake settles immediately.
      settleAttempts: 3,
      settleDelayMilliseconds: 0,
    }),
  };
}

function plistPath(directory: string, service: OfficeServiceName): string {
  return join(directory, `${launchdLabels[service]}.plist`);
}

function writeForeignPlist(directory: string, service: OfficeServiceName) {
  mkdirSync(directory, { recursive: true });
  const foreign = '<?xml version="1.0"?><plist><dict/></plist>\n';
  writeFileSync(plistPath(directory, service), foreign, "utf8");
  return foreign;
}

describe("launchd plist rendering", () => {
  const plan = servicePlan();

  test("the runtime plist is deterministic and structurally valid", () => {
    const plist = renderLaunchdPlist(plan, "runtime");
    expect(plist).toBe(renderLaunchdPlist(plan, "runtime"));
    expect(plist.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')).toBe(
      true,
    );
    expect(plist).toContain("<!DOCTYPE plist PUBLIC");
    const parsed = parseMinimalPlist(plist);
    expect(Object.keys(parsed)).toEqual([
      "Label",
      "ProgramArguments",
      "EnvironmentVariables",
      "RunAtLoad",
      "KeepAlive",
      "ProcessType",
      "ThrottleInterval",
      "ServiceDescription",
    ]);
  });

  test("carries the ownership header in valid plist syntax", () => {
    const plist = renderLaunchdPlist(plan, "runtime");
    expect(plist).toContain("<!-- Managed by AI Office -->");
    expect(plist).toContain(
      "<!-- Definition: ai-office/service/v1 runtime -->",
    );
    expect(plist).not.toContain(
      "<!-- Definition: ai-office/service/v1 dashboard -->",
    );
    // The marker is a comment, so it never becomes a key launchd must know.
    expect(() => parseMinimalPlist(plist)).not.toThrow();
  });

  test("each service renders its own ownership identity", () => {
    for (const service of ["runtime", "dashboard"] as const)
      for (const line of launchdOwnershipLines(service))
        expect(renderLaunchdPlist(plan, service)).toContain(`${line}\n`);
  });

  test("uses the stable labels", () => {
    expect(parseMinimalPlist(renderLaunchdPlist(plan, "runtime")).Label).toBe(
      "com.ai-office.runtime",
    );
    expect(parseMinimalPlist(renderLaunchdPlist(plan, "dashboard")).Label).toBe(
      "com.ai-office.dashboard",
    );
  });

  test("launches the runtime through an absolute executable", () => {
    expect(
      parseMinimalPlist(renderLaunchdPlist(plan, "runtime")).ProgramArguments,
    ).toEqual([
      "/opt/bun/bin/bun",
      "/opt/ai-office/bin/ai-office.ts",
      "runtime",
      "start",
    ]);
  });

  test("carries the resolved AI_OFFICE_HOME and only the needed opt-in", () => {
    expect(
      parseMinimalPlist(renderLaunchdPlist(plan, "runtime"))
        .EnvironmentVariables,
    ).toEqual({ AI_OFFICE_HOME: "/home/operator/.ai-office" });
    const sourcePlan = servicePlan({
      program: {
        launcher: ["/opt/bun/bin/bun", "/src/ai-office/bin/ai-office.ts"],
        runtimeHome: "/home/operator/.ai-office",
        requiresSourceRuntimeOptIn: true,
      },
    });
    expect(
      parseMinimalPlist(renderLaunchdPlist(sourcePlan, "dashboard"))
        .EnvironmentVariables,
    ).toEqual({
      AI_OFFICE_HOME: "/home/operator/.ai-office",
      AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE: "1",
    });
  });

  test("a percent in a path needs no escaping in a plist", () => {
    // launchd has no specifier expansion; the systemd `%%` rule must not leak
    // into plist rendering.
    expect(
      parseMinimalPlist(
        renderLaunchdPlist(
          servicePlan({
            program: {
              launcher: ["/opt/100%/bun"],
              runtimeHome: "/home/operator/100%/.ai-office",
              requiresSourceRuntimeOptIn: false,
            },
          }),
          "runtime",
        ),
      ).EnvironmentVariables,
    ).toEqual({ AI_OFFICE_HOME: "/home/operator/100%/.ai-office" });
  });

  test("the dashboard agent binds loopback and never opens a browser", () => {
    const parsed = parseMinimalPlist(renderLaunchdPlist(plan, "dashboard"));
    expect(parsed.ProgramArguments).toEqual([
      "/opt/bun/bin/bun",
      "/opt/ai-office/bin/ai-office.ts",
      "dashboard",
      "--host",
      "127.0.0.1",
      "--port",
      "4278",
      "--no-open",
      "--await-runtime",
      "60",
    ]);
    expect(renderLaunchdPlist(plan, "dashboard")).not.toContain("0.0.0.0");
  });

  test("sets RunAtLoad and KeepAlive", () => {
    for (const service of ["runtime", "dashboard"] as const) {
      const parsed = parseMinimalPlist(renderLaunchdPlist(plan, service));
      expect(parsed.RunAtLoad).toBe(true);
      expect(parsed.KeepAlive).toBe(true);
    }
  });

  test("escapes XML metacharacters in rendered paths", () => {
    const parsed = parseMinimalPlist(
      renderLaunchdPlist(
        servicePlan({
          program: {
            launcher: ["/opt/bun/bin/bun", "/opt/a&b<c>/ai-office.ts"],
            runtimeHome: "/home/operator/.ai-office",
            requiresSourceRuntimeOptIn: false,
          },
        }),
        "runtime",
      ),
    );
    expect((parsed.ProgramArguments as string[])[1]).toBe(
      "/opt/a&amp;b&lt;c&gt;/ai-office.ts",
    );
  });

  test("the default LaunchAgents directory is per user", () => {
    expect(defaultLaunchAgentDirectory("/Users/operator")).toBe(
      "/Users/operator/Library/LaunchAgents",
    );
  });
});

describe("launchctl print parsing", () => {
  test("reads the deterministic fields only", () => {
    expect(
      parseLaunchdPrint(
        launchdPrintOutput({ state: "running", pid: 77, lastExitCode: 0 }),
      ),
    ).toEqual({ state: "running", pid: 77, lastExitCode: 0 });
  });

  test("absent fields are absent rather than guessed", () => {
    expect(parseLaunchdPrint("com.ai-office.runtime = {\n}\n")).toEqual({});
  });
});

describe("launchd install", () => {
  test("a fresh install writes both agents and bootstraps runtime first", async () => {
    const context = manager();
    const report = await context.manager.install();

    expect(report.definitions.map((entry) => entry.action)).toEqual([
      "created",
      "created",
    ]);
    expect(report.issues).toEqual([]);
    expect(report.status.services.map((entry) => entry.state)).toEqual([
      "running",
      "running",
    ]);
    expect(officeServicesHealthy(report.status)).toBe(true);
    expect(context.runner.bootstrapped).toEqual([
      plistPath(context.agentDirectory, "runtime"),
      plistPath(context.agentDirectory, "dashboard"),
    ]);
    // The deprecated load/unload workflow is never used.
    expect(context.runner.indexOf(["load"])).toBe(-1);
    expect(context.runner.indexOf(["unload"])).toBe(-1);
  });

  test("an explicit install re-bootstraps even an unchanged plist", async () => {
    // Byte equality proves what is on disk, never what launchd has loaded.
    const context = manager();
    await context.manager.install();
    const before = context.runner.bootstrapped.length;
    const second = await context.manager.install();

    expect(second.definitions.map((entry) => entry.action)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    expect(second.issues).toEqual([]);
    expect(context.runner.bootstrapped.length).toBe(before + 2);
    expect(officeServicesHealthy(second.status)).toBe(true);
  });

  test("install converges a loaded job left stale by a failed re-bootstrap", async () => {
    const context = manager();
    await context.manager.install();

    // A second install whose bootout refuses: the plist is rewritten but the
    // old job stays loaded, and the install honestly reports failure.
    const nextPlan = servicePlan({
      program: {
        launcher: ["/opt/bun/bin/bun", "/opt/ai-office-next/bin/ai-office.ts"],
        runtimeHome: "/home/operator/.ai-office",
        requiresSourceRuntimeOptIn: false,
      },
    });
    const failing = new LaunchdUserServiceManager({
      plan: nextPlan,
      agentDirectory: context.agentDirectory,
      runner: context.runner,
      userId,
      settleAttempts: 2,
      settleDelayMilliseconds: 0,
    });
    context.runner.bootoutFailures.add(launchdLabels.runtime);
    const partial = await failing.install();
    expect(partial.issues.join("\n")).toContain("still active");
    expect(officeServicesHealthy(partial.status)).toBe(false);
    // The plist on disk is already the new one, so a byte-equality view would
    // now call this installed and leave the stale job running.
    expect(
      partial.status.services.find((entry) => entry.service === "runtime")
        ?.definition,
    ).toBe("managed_current");

    // The next install must actually recover, not merely report success.
    context.runner.bootoutFailures.clear();
    const bootstrapsBefore = context.runner.bootstrapped.length;
    const recovered = await failing.install();

    expect(recovered.issues).toEqual([]);
    expect(officeServicesHealthy(recovered.status)).toBe(true);
    expect(context.runner.bootstrapped.slice(bootstrapsBefore)).toContain(
      plistPath(context.agentDirectory, "runtime"),
    );
  });

  test("a bootout that reports success but does not unload is not trusted", async () => {
    const context = manager();
    await context.manager.install();
    context.runner.bootoutNoOps.add(launchdLabels.dashboard);
    const report = await context.manager.install();

    expect(report.issues.join("\n")).toContain("did not unload the job");
    expect(
      context.runner.bootstrapped.filter(
        (path) => path === plistPath(context.agentDirectory, "dashboard"),
      ),
    ).toHaveLength(1);
  });

  test("a managed but outdated plist is rewritten and re-bootstrapped", async () => {
    const context = manager();
    await context.manager.install();
    const path = plistPath(context.agentDirectory, "dashboard");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("4278", "4279"),
      "utf8",
    );
    const second = await context.manager.install();

    expect(
      second.definitions.find((entry) => entry.service === "dashboard")?.action,
    ).toBe("updated");
    expect(readFileSync(path, "utf8")).toBe(
      renderLaunchdPlist(servicePlan(), "dashboard"),
    );
  });

  test("an unmanaged plist fails closed and nothing is written or bootstrapped", async () => {
    const context = manager();
    const foreign = writeForeignPlist(context.agentDirectory, "dashboard");

    await expect(context.manager.install()).rejects.toBeInstanceOf(
      OfficeServicePreconditionError,
    );
    expect(
      readFileSync(plistPath(context.agentDirectory, "dashboard"), "utf8"),
    ).toBe(foreign);
    expect(existsSync(plistPath(context.agentDirectory, "runtime"))).toBe(
      false,
    );
    expect(context.runner.indexOf(["bootstrap"])).toBe(-1);
  });

  test("a plist carrying the other service's ownership identity fails closed", async () => {
    const context = manager();
    mkdirSync(context.agentDirectory, { recursive: true });
    writeFileSync(
      plistPath(context.agentDirectory, "dashboard"),
      renderLaunchdPlist(servicePlan(), "runtime"),
      "utf8",
    );
    await expect(context.manager.install()).rejects.toBeInstanceOf(
      OfficeServicePreconditionError,
    );
  });

  test("an unreachable launchd domain is refused before anything is written", async () => {
    const runner = new FakeLaunchd();
    runner.domainAvailable = false;
    const context = manager(runner);
    await expect(context.manager.install()).rejects.toThrow(/launchd/u);
    expect(existsSync(plistPath(context.agentDirectory, "runtime"))).toBe(
      false,
    );
  });

  test("a runtime bootstrap failure is reported without claiming success", async () => {
    const runner = new FakeLaunchd();
    runner.bootstrapFailures.add(launchdLabels.runtime);
    const context = manager(runner);
    const report = await context.manager.install();
    expect(report.issues.join("\n")).toContain("bootstrap");
    expect(report.status.services.map((entry) => entry.state)).toEqual([
      "installed_inactive",
      "running",
    ]);
    expect(officeServicesHealthy(report.status)).toBe(false);
  });

  test("a dashboard bootstrap failure leaves the runtime running", async () => {
    const runner = new FakeLaunchd();
    runner.bootstrapFailures.add(launchdLabels.dashboard);
    const context = manager(runner);
    const report = await context.manager.install();
    expect(report.status.services.map((entry) => entry.state)).toEqual([
      "running",
      "installed_inactive",
    ]);
    expect(report.issues.join("\n")).toContain(launchdLabels.dashboard);
  });

  test("post-install verification reads launchd after the last bootstrap", async () => {
    const context = manager();
    await context.manager.install();
    const lastPrint = context.runner.calls
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => command.includes("print"))
      .at(-1);
    const lastBootstrap = context.runner.calls
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => command.includes("bootstrap"))
      .at(-1);
    expect(lastPrint!.index).toBeGreaterThan(lastBootstrap!.index);
  });
});

describe("launchd status", () => {
  test("reports registered and running agents", async () => {
    const context = manager();
    await context.manager.install();
    const status = await context.manager.status();
    expect(status.platform).toBe("launchd-user");
    expect(status.dashboardEndpoint).toBe("http://127.0.0.1:4278");
    expect(
      status.services.map((entry) => [
        entry.state,
        entry.registered,
        entry.enabled,
      ]),
    ).toEqual([
      ["running", true, true],
      ["running", true, true],
    ]);
    expect(officeServicesHealthy(status)).toBe(true);
  });

  test("reports a registered but not running agent as inactive", async () => {
    const runner = new FakeLaunchd();
    runner.startedState.set(launchdLabels.dashboard, {
      state: "waiting",
      lastExitCode: 0,
    });
    const context = manager(runner);
    await context.manager.install();
    const status = await context.manager.status();
    expect(status.services.map((entry) => entry.state)).toEqual([
      "running",
      "installed_inactive",
    ]);
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("reports a repeatedly crashing agent as failed", async () => {
    const runner = new FakeLaunchd();
    runner.startedState.set(launchdLabels.runtime, {
      state: "not running",
      lastExitCode: 1,
    });
    const context = manager(runner);
    await context.manager.install();
    const status = await context.manager.status();
    expect(
      status.services.find((entry) => entry.service === "runtime"),
    ).toMatchObject({ state: "failed", registered: true });
  });

  test("an outdated managed plist is reported and is not healthy", async () => {
    const context = manager();
    await context.manager.install();
    const path = plistPath(context.agentDirectory, "runtime");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace("Background", "Standard"),
      "utf8",
    );
    const status = await context.manager.status();
    expect(
      status.services.find((entry) => entry.service === "runtime"),
    ).toMatchObject({ definition: "managed_outdated", state: "running" });
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("reports nothing installed when no plist and no job exist", async () => {
    const context = manager();
    const status = await context.manager.status();
    expect(
      status.services.map((entry) => [entry.state, entry.registered]),
    ).toEqual([
      ["not_installed", false],
      ["not_installed", false],
    ]);
    expect(status.issues).toEqual([]);
  });

  test("a missing plist does not stop status from asking launchd", async () => {
    const context = manager();
    await context.manager.status();
    expect(
      context.runner.indexOf(["print", `${domain}/${launchdLabels.runtime}`]),
    ).toBeGreaterThanOrEqual(0);
  });

  test("exposes an orphan whose plist was deleted by hand", async () => {
    const context = manager();
    await context.manager.install();
    rmSync(plistPath(context.agentDirectory, "runtime"));

    const status = await context.manager.status();
    const runtime = status.services.find(
      (entry) => entry.service === "runtime",
    )!;
    expect(runtime.definition).toBe("missing");
    expect(runtime.installed).toBe(false);
    expect(runtime.registered).toBe(true);
    expect(runtime.state).toBe("running");
    expect(runtime.detail).toContain("cannot prove ownership");
    expect(status.issues.join("\n")).toContain(
      `launchctl bootout ${domain}/${launchdLabels.runtime}`,
    );
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("definitions present with an unusable launchctl are unknown", async () => {
    const context = manager();
    await context.manager.install();
    context.runner.launchctlMissing = true;
    const status = await context.manager.status();
    expect(status.serviceManagerAvailable).toBe(false);
    expect(status.services.map((entry) => entry.state)).toEqual([
      "unknown",
      "unknown",
    ]);
    expect(
      status.services.every(
        (entry) => entry.registered === null && entry.enabled === null,
      ),
    ).toBe(true);
    expect(status.issues.join("\n")).toContain("launchctl is not available");
  });

  test("an unmanaged plist collision is reported and never claimed as ours", async () => {
    const context = manager();
    writeForeignPlist(context.agentDirectory, "runtime");
    const status = await context.manager.status();
    const runtime = status.services.find(
      (entry) => entry.service === "runtime",
    )!;
    expect(runtime.definition).toBe("unmanaged_collision");
    expect(runtime.installed).toBe(false);
    expect(status.issues.join("\n")).toContain("not managed by AI Office");
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("an unmanaged plist whose label is loaded is reported as an orphan too", async () => {
    const context = manager();
    writeForeignPlist(context.agentDirectory, "runtime");
    context.runner.jobs.set(launchdLabels.runtime, {
      state: "running",
      pid: 99,
    });
    const status = await context.manager.status();
    const runtime = status.services.find(
      (entry) => entry.service === "runtime",
    )!;
    expect(runtime.registered).toBe(true);
    expect(runtime.state).toBe("running");
    expect(status.issues.join("\n")).toContain("still registered with launchd");
  });
});

describe("launchd uninstall", () => {
  test("boots out the dashboard before the runtime and removes only the plists", async () => {
    const context = manager();
    await context.manager.install();
    const before = context.runner.calls.length;
    const report = await context.manager.uninstall();

    expect(report.removed.map((entry) => entry.service)).toEqual([
      "dashboard",
      "runtime",
    ]);
    const replayed = context.runner.calls.slice(before).map((c) => c.join(" "));
    const dashboardBootout = replayed.findIndex(
      (command) =>
        command.includes("bootout") &&
        command.includes(launchdLabels.dashboard),
    );
    const runtimeBootout = replayed.findIndex(
      (command) =>
        command.includes("bootout") && command.includes(launchdLabels.runtime),
    );
    expect(dashboardBootout).toBeGreaterThanOrEqual(0);
    expect(dashboardBootout).toBeLessThan(runtimeBootout);
    expect(context.runner.jobs.size).toBe(0);
    expect(existsSync(plistPath(context.agentDirectory, "runtime"))).toBe(
      false,
    );
    expect(report.issues).toEqual([]);
  });

  test("verifies the job is unloaded before deleting its plist", async () => {
    const context = manager();
    await context.manager.install();
    const before = context.runner.calls.length;
    await context.manager.uninstall();

    const replayed = context.runner.calls.slice(before);
    const bootout = replayed.findIndex(
      (command) =>
        command.includes("bootout") &&
        command.includes(`${domain}/${launchdLabels.dashboard}`),
    );
    const verify = replayed.findIndex(
      (command, index) =>
        index > bootout &&
        command.includes("print") &&
        command.includes(`${domain}/${launchdLabels.dashboard}`),
    );
    expect(bootout).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(bootout);
  });

  test("preserves the plist when launchctl cannot be contacted", async () => {
    const context = manager();
    await context.manager.install();
    context.runner.launchctlMissing = true;

    const report = await context.manager.uninstall();
    expect(report.removed).toEqual([]);
    expect(report.preserved.map((entry) => entry.service)).toEqual([
      "dashboard",
      "runtime",
    ]);
    expect(report.issues.join("\n")).toContain(
      "No service definition was removed",
    );
    expect(existsSync(plistPath(context.agentDirectory, "runtime"))).toBe(true);
  });

  test("preserves the plist when bootout fails", async () => {
    const context = manager();
    await context.manager.install();
    context.runner.bootoutFailures.add(launchdLabels.runtime);

    const report = await context.manager.uninstall();
    expect(report.removed.map((entry) => entry.service)).toEqual(["dashboard"]);
    expect(report.preserved).toEqual([
      {
        service: "runtime",
        path: plistPath(context.agentDirectory, "runtime"),
        reason: "the job is still registered with launchd",
      },
    ]);
    expect(existsSync(plistPath(context.agentDirectory, "runtime"))).toBe(true);
    expect(report.issues.join("\n")).toContain("still loaded after bootout");
  });

  test("preserves the plist when bootout exits zero but the job stays loaded", async () => {
    // A non-zero exit is not the only way bootout can fail to unload, so
    // registration, not the exit code, is what gates removal.
    const context = manager();
    await context.manager.install();
    context.runner.bootoutNoOps.add(launchdLabels.runtime);

    const report = await context.manager.uninstall();
    expect(report.removed.map((entry) => entry.service)).toEqual(["dashboard"]);
    expect(report.preserved.map((entry) => entry.service)).toEqual(["runtime"]);
    expect(existsSync(plistPath(context.agentDirectory, "runtime"))).toBe(true);
  });

  test("a repeated uninstall of a genuinely absent service is clean and idempotent", async () => {
    const context = manager();
    await context.manager.install();
    await context.manager.uninstall();
    const before = context.runner.calls.length;
    const second = await context.manager.uninstall();

    expect(second.removed).toEqual([]);
    expect(second.preserved).toEqual([]);
    expect(second.issues).toEqual([]);
    // Only the read-only domain and label probes; nothing is booted out again.
    expect(
      context.runner.calls
        .slice(before)
        .every((command) => command.includes("print")),
    ).toBe(true);
  });

  test("a repeated uninstall reports a label that is still registered", async () => {
    const context = manager();
    await context.manager.install();
    await context.manager.uninstall();
    context.runner.jobs.set(launchdLabels.runtime, {
      state: "running",
      pid: 7,
    });

    const second = await context.manager.uninstall();
    expect(second.removed).toEqual([]);
    expect(second.issues.join("\n")).toContain(
      "AI Office owns no plist for it",
    );
  });

  test("a label that is no longer bootstrapped is an ordinary uninstall case", async () => {
    const context = manager();
    await context.manager.install();
    context.runner.jobs.clear();
    const report = await context.manager.uninstall();
    expect(report.issues).toEqual([]);
    expect(report.removed).toHaveLength(2);
  });

  test("an unmanaged plist is preserved, reported, and never booted out", async () => {
    const context = manager();
    await context.manager.install();
    const foreign = writeForeignPlist(context.agentDirectory, "runtime");
    const before = context.runner.calls.length;

    const report = await context.manager.uninstall();
    expect(report.preserved).toEqual([
      {
        service: "runtime",
        path: plistPath(context.agentDirectory, "runtime"),
        reason: "the LaunchAgent is not managed by AI Office",
      },
    ]);
    expect(
      readFileSync(plistPath(context.agentDirectory, "runtime"), "utf8"),
    ).toBe(foreign);
    expect(
      context.runner.calls
        .slice(before)
        .some(
          (command) =>
            command.includes("bootout") &&
            command.includes(`${domain}/${launchdLabels.runtime}`),
        ),
    ).toBe(false);
  });
});
