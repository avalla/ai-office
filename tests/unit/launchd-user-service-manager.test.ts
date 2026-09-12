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
  LaunchdUserServiceManager,
  defaultLaunchAgentDirectory,
  parseLaunchdPrint,
  renderLaunchdPlist,
} from "@ai-office/service-management/launchd-user-service-manager.ts";
import { OfficeServicePreconditionError } from "@ai-office/application/ports/office-service-manager.port.ts";
import type { OfficeServiceName } from "@ai-office/application/ports/office-service-manager.port.ts";
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
 * adapter uses, so registration, repeated install, and repeated uninstall can
 * be exercised without a macOS host.
 */
class FakeLaunchd implements ServiceCommandRunner {
  readonly calls: string[][] = [];
  readonly jobs = new Map<string, LaunchdJob>();

  domainAvailable = true;
  launchctlMissing = false;
  /** Labels whose next bootstrap must fail. */
  readonly bootstrapFailures = new Set<string>();
  /** State a label takes on once bootstrapped. */
  readonly startedState = new Map<string, LaunchdJob>();

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
    }),
  };
}

function plistPath(directory: string, service: OfficeServiceName): string {
  return join(directory, `${launchdLabels[service]}.plist`);
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

  test("carries the ownership marker in valid plist syntax", () => {
    const plist = renderLaunchdPlist(plan, "runtime");
    expect(plist).toContain("<!-- Managed by AI Office -->");
    expect(plist).toContain(
      "<!-- Definition: ai-office/service/v1 runtime -->",
    );
    // The marker is a comment, so it never becomes a key launchd must know.
    expect(() => parseMinimalPlist(plist)).not.toThrow();
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
    const runtimeBootstrap = context.runner.indexOf([
      "bootstrap",
      plistPath(context.agentDirectory, "runtime"),
    ]);
    const dashboardBootstrap = context.runner.indexOf([
      "bootstrap",
      plistPath(context.agentDirectory, "dashboard"),
    ]);
    expect(runtimeBootstrap).toBeGreaterThanOrEqual(0);
    expect(runtimeBootstrap).toBeLessThan(dashboardBootstrap);
    expect(context.runner.calls[runtimeBootstrap]).toEqual([
      "launchctl",
      "bootstrap",
      domain,
      plistPath(context.agentDirectory, "runtime"),
    ]);
    // The deprecated load/unload workflow is never used.
    expect(context.runner.indexOf(["load"])).toBe(-1);
    expect(context.runner.indexOf(["unload"])).toBe(-1);
  });

  test("a repeated install leaves running agents alone", async () => {
    const context = manager();
    await context.manager.install();
    const before = context.runner.calls.length;
    const second = await context.manager.install();
    expect(second.definitions.map((entry) => entry.action)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    const replayed = context.runner.calls.slice(before);
    expect(replayed.some((command) => command.includes("bootout"))).toBe(false);
    expect(replayed.some((command) => command.includes("bootstrap"))).toBe(
      false,
    );
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
    const before = context.runner.calls.length;
    const second = await context.manager.install();

    expect(
      second.definitions.find((entry) => entry.service === "dashboard")?.action,
    ).toBe("updated");
    expect(readFileSync(path, "utf8")).toBe(
      renderLaunchdPlist(servicePlan(), "dashboard"),
    );
    const replayed = context.runner.calls.slice(before);
    const bootout = replayed.findIndex((command) =>
      command.includes(`${domain}/${launchdLabels.dashboard}`),
    );
    expect(
      replayed.filter((command) => command.includes("bootstrap")),
    ).toHaveLength(1);
    expect(bootout).toBeGreaterThanOrEqual(0);
  });

  test("an unmanaged plist fails closed and nothing is written or bootstrapped", async () => {
    const context = manager();
    mkdirSync(context.agentDirectory, { recursive: true });
    const foreign = '<?xml version="1.0"?><plist><dict/></plist>\n';
    writeFileSync(
      plistPath(context.agentDirectory, "dashboard"),
      foreign,
      "utf8",
    );

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

  test("post-install verification reads launchd, not the writes just made", async () => {
    const context = manager();
    await context.manager.install();
    const lastPrint = context.runner.calls
      .map((command, index) => ({ command, index }))
      .filter(({ command }) => command.includes("print"))
      .at(-1);
    const lastBootstrap = context.runner.indexOf(["bootstrap"]);
    expect(lastPrint!.index).toBeGreaterThan(lastBootstrap);
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

  test("reports missing definitions without asking launchd about them", async () => {
    const context = manager();
    const status = await context.manager.status();
    expect(status.services.map((entry) => entry.state)).toEqual([
      "not_installed",
      "not_installed",
    ]);
    expect(
      context.runner.indexOf(["print", `${domain}/${launchdLabels.runtime}`]),
    ).toBe(-1);
  });

  test("a registered dashboard with a missing runtime definition is reported honestly", async () => {
    const context = manager();
    await context.manager.install();
    rmSync(plistPath(context.agentDirectory, "runtime"));
    const status = await context.manager.status();
    expect(
      status.services.map((entry) => [entry.service, entry.state]),
    ).toEqual([
      ["runtime", "not_installed"],
      ["dashboard", "running"],
    ]);
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
    expect(status.issues.join("\n")).toContain("launchctl is not available");
  });

  test("an unmanaged plist collision is reported and never claimed as ours", async () => {
    const context = manager();
    mkdirSync(context.agentDirectory, { recursive: true });
    writeFileSync(
      plistPath(context.agentDirectory, "runtime"),
      "<plist><dict/></plist>\n",
      "utf8",
    );
    const status = await context.manager.status();
    const runtime = status.services.find(
      (entry) => entry.service === "runtime",
    )!;
    expect(runtime.definition).toBe("unmanaged_collision");
    expect(runtime.installed).toBe(false);
    expect(runtime.state).toBe("unknown");
    expect(status.issues.join("\n")).toContain("not managed by AI Office");
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

  test("a repeated uninstall succeeds cleanly and touches nothing", async () => {
    const context = manager();
    await context.manager.install();
    await context.manager.uninstall();
    const before = context.runner.calls.length;
    const second = await context.manager.uninstall();
    expect(second.removed).toEqual([]);
    expect(second.issues).toEqual([]);
    expect(context.runner.calls.slice(before)).toEqual([]);
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
    const foreign = "<plist><dict/></plist>\n";
    writeFileSync(
      plistPath(context.agentDirectory, "runtime"),
      foreign,
      "utf8",
    );

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
