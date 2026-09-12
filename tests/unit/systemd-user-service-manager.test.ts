import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  renderSystemdUnit,
  systemdUnitNames,
  SystemdUserServiceManager,
  defaultSystemdUnitDirectory,
} from "@ai-office/service-management/systemd-user-service-manager.ts";
import { OfficeServicePreconditionError } from "@ai-office/application/ports/office-service-manager.port.ts";
import type { OfficeServiceName } from "@ai-office/application/ports/office-service-manager.port.ts";
import {
  cleanTemporaryDirectories,
  FakeServiceCommandRunner,
  healthySystemdRunner,
  servicePlan,
  systemctlShowOutput,
  temporaryDefinitionDirectory,
} from "../helpers/service-management.ts";

const directories: string[] = [];
afterEach(() => cleanTemporaryDirectories(directories));

function manager(
  runner: FakeServiceCommandRunner = healthySystemdRunner(),
  planOverrides = servicePlan(),
): {
  manager: SystemdUserServiceManager;
  runner: FakeServiceCommandRunner;
  unitDirectory: string;
} {
  const unitDirectory = temporaryDefinitionDirectory(
    directories,
    "ai-office-systemd-",
  );
  return {
    runner,
    unitDirectory,
    manager: new SystemdUserServiceManager({
      plan: planOverrides,
      unitDirectory,
      runner,
      userName: "operator",
    }),
  };
}

function unitPath(unitDirectory: string, service: OfficeServiceName): string {
  return join(unitDirectory, systemdUnitNames[service]);
}

describe("systemd unit rendering", () => {
  const plan = servicePlan();

  test("the runtime unit is deterministic and carries the ownership marker", () => {
    const unit = renderSystemdUnit(plan, "runtime");
    expect(unit).toBe(renderSystemdUnit(plan, "runtime"));
    expect(unit.startsWith("# Managed by AI Office\n")).toBe(true);
    expect(unit).toContain("# Definition: ai-office/service/v1 runtime");
    expect(unit).toContain("Description=AI Office Runtime");
    expect(unit).toContain("After=network.target");
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=3");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("the runtime unit starts the Runtime through an absolute executable", () => {
    const unit = renderSystemdUnit(plan, "runtime");
    expect(unit).toContain(
      'ExecStart="/opt/bun/bin/bun" "/opt/ai-office/bin/ai-office.ts" "runtime" "start"',
    );
    // Nothing in the unit resolves a bare program name through PATH.
    expect(unit).not.toMatch(/^ExecStart=ai-office/mu);
  });

  test("the unit carries the resolved AI_OFFICE_HOME", () => {
    expect(renderSystemdUnit(plan, "runtime")).toContain(
      'Environment="AI_OFFICE_HOME=/home/operator/.ai-office"',
    );
  });

  test("the source runtime opt-in is generated only when the program needs it", () => {
    expect(renderSystemdUnit(plan, "runtime")).not.toContain(
      "AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE",
    );
    const sourcePlan = servicePlan({
      program: {
        launcher: ["/opt/bun/bin/bun", "/src/ai-office/bin/ai-office.ts"],
        runtimeHome: "/home/operator/.ai-office",
        requiresSourceRuntimeOptIn: true,
      },
    });
    expect(renderSystemdUnit(sourcePlan, "runtime")).toContain(
      'Environment="AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1"',
    );
    expect(renderSystemdUnit(sourcePlan, "dashboard")).toContain(
      'Environment="AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1"',
    );
  });

  test("the dashboard unit binds loopback and never opens a browser", () => {
    const unit = renderSystemdUnit(plan, "dashboard");
    expect(unit).toContain(
      'ExecStart="/opt/bun/bin/bun" "/opt/ai-office/bin/ai-office.ts" "dashboard" "--host" "127.0.0.1" "--port" "4278" "--no-open" "--await-runtime" "60"',
    );
    expect(unit).not.toContain("0.0.0.0");
  });

  test("the dashboard unit orders after the runtime unit", () => {
    const unit = renderSystemdUnit(plan, "dashboard");
    expect(unit).toContain(`Requires=${systemdUnitNames.runtime}`);
    expect(unit).toContain(`After=${systemdUnitNames.runtime}`);
  });

  test("a path containing a space is quoted rather than split", () => {
    const unit = renderSystemdUnit(
      servicePlan({
        program: {
          launcher: ["/opt/bun/bin/bun", "/opt/ai office/bin/ai-office.ts"],
          runtimeHome: "/home/operator/.ai office",
          requiresSourceRuntimeOptIn: false,
        },
      }),
      "runtime",
    );
    expect(unit).toContain('"/opt/ai office/bin/ai-office.ts"');
    expect(unit).toContain(
      'Environment="AI_OFFICE_HOME=/home/operator/.ai office"',
    );
  });

  test("the default unit directory follows XDG_CONFIG_HOME", () => {
    expect(
      defaultSystemdUnitDirectory({ XDG_CONFIG_HOME: "/x/config" }, "/home/o"),
    ).toBe("/x/config/systemd/user");
    expect(defaultSystemdUnitDirectory({}, "/home/o")).toBe(
      "/home/o/.config/systemd/user",
    );
  });
});

describe("systemd install", () => {
  test("a fresh install writes both units, reloads, enables and verifies", async () => {
    const context = manager();
    const report = await context.manager.install();

    expect(report.definitions).toEqual([
      {
        service: "runtime",
        path: unitPath(context.unitDirectory, "runtime"),
        action: "created",
      },
      {
        service: "dashboard",
        path: unitPath(context.unitDirectory, "dashboard"),
        action: "created",
      },
    ]);
    expect(report.issues).toEqual([]);
    expect(report.status.services.map((entry) => entry.state)).toEqual([
      "running",
      "running",
    ]);

    const reload = context.runner.indexOf(["daemon-reload"]);
    const enableRuntime = context.runner.indexOf([
      "enable",
      systemdUnitNames.runtime,
    ]);
    const enableDashboard = context.runner.indexOf([
      "enable",
      systemdUnitNames.dashboard,
    ]);
    const verify = context.runner.indexOf(["show", systemdUnitNames.runtime]);
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(reload).toBeLessThan(enableRuntime);
    expect(enableRuntime).toBeLessThan(enableDashboard);
    expect(enableDashboard).toBeLessThan(verify);
    expect(context.runner.calls[enableRuntime]).toEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      systemdUnitNames.runtime,
    ]);
  });

  test("a repeated install changes nothing and stays safe", async () => {
    const context = manager();
    await context.manager.install();
    const second = await context.manager.install();
    expect(second.definitions.map((entry) => entry.action)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    expect(second.issues).toEqual([]);
  });

  test("a managed but outdated unit is deliberately updated", async () => {
    const context = manager();
    await context.manager.install();
    const path = unitPath(context.unitDirectory, "dashboard");
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}# stale local edit\n`,
      "utf8",
    );
    const second = await context.manager.install();
    expect(
      second.definitions.find((entry) => entry.service === "dashboard")?.action,
    ).toBe("updated");
    expect(readFileSync(path, "utf8")).toBe(
      renderSystemdUnit(servicePlan(), "dashboard"),
    );
  });

  test("an unmanaged unit fails closed and nothing is written or started", async () => {
    const context = manager();
    mkdirSync(context.unitDirectory, { recursive: true });
    const foreign = "[Unit]\nDescription=Somebody else's unit\n";
    writeFileSync(
      unitPath(context.unitDirectory, "dashboard"),
      foreign,
      "utf8",
    );

    await expect(context.manager.install()).rejects.toBeInstanceOf(
      OfficeServicePreconditionError,
    );
    expect(
      readFileSync(unitPath(context.unitDirectory, "dashboard"), "utf8"),
    ).toBe(foreign);
    // The first unit is not written either: a collision stops the whole install.
    expect(existsSync(unitPath(context.unitDirectory, "runtime"))).toBe(false);
    expect(context.runner.indexOf(["daemon-reload"])).toBe(-1);
  });

  test("an unusable systemd user manager is refused before anything is written", async () => {
    const context = manager(
      healthySystemdRunner().on(["is-system-running"], {
        exitCode: 1,
        stderr: "Failed to connect to bus\n",
      }),
    );
    await expect(context.manager.install()).rejects.toThrow(/systemd --user/u);
    expect(existsSync(unitPath(context.unitDirectory, "runtime"))).toBe(false);
  });

  test("a daemon-reload failure is reported and no unit is started", async () => {
    const context = manager(
      healthySystemdRunner()
        .on(["daemon-reload"], { exitCode: 1, stderr: "reload refused\n" })
        .on(["show"], {
          stdout: systemctlShowOutput({
            LoadState: "not-found",
            ActiveState: "inactive",
            SubState: "dead",
            UnitFileState: "",
          }),
        }),
    );
    const report = await context.manager.install();
    expect(report.issues[0]).toContain("daemon-reload failed");
    expect(report.issues[0]).toContain("reload refused");
    expect(context.runner.indexOf(["enable"])).toBe(-1);
    expect(report.status.services.map((entry) => entry.state)).toEqual([
      "installed_inactive",
      "installed_inactive",
    ]);
  });

  test("a runtime start failure is reported without claiming success", async () => {
    const context = manager(
      healthySystemdRunner()
        .on(["enable", systemdUnitNames.runtime], {
          exitCode: 1,
          stderr: "Job failed\n",
        })
        .on(["show", systemdUnitNames.runtime], {
          stdout: systemctlShowOutput({
            LoadState: "loaded",
            ActiveState: "failed",
            SubState: "failed",
            UnitFileState: "enabled",
          }),
        }),
    );
    const report = await context.manager.install();
    expect(report.issues.join("\n")).toContain(
      `enable --now ${systemdUnitNames.runtime} failed`,
    );
    expect(
      report.status.services.find((entry) => entry.service === "runtime")
        ?.state,
    ).toBe("failed");
    // The dashboard is still attempted; it does not depend on the runtime
    // having started for its own process to be valid.
    expect(
      context.runner.indexOf(["enable", systemdUnitNames.dashboard]),
    ).toBeGreaterThanOrEqual(0);
  });

  test("a dashboard start failure leaves the runtime running", async () => {
    const context = manager(
      healthySystemdRunner()
        .on(["enable", systemdUnitNames.dashboard], {
          exitCode: 1,
          stderr: "Job failed\n",
        })
        .on(["show", systemdUnitNames.dashboard], {
          stdout: systemctlShowOutput({
            LoadState: "loaded",
            ActiveState: "failed",
            SubState: "failed",
            UnitFileState: "enabled",
          }),
        }),
    );
    const report = await context.manager.install();
    expect(report.status.services.map((entry) => entry.state)).toEqual([
      "running",
      "failed",
    ]);
  });
});

describe("systemd status", () => {
  async function statusWithShow(
    show: (unit: string) => string,
    install = true,
  ) {
    const context = manager(
      healthySystemdRunner().on(["show"], (command) => ({
        stdout: show(command[3] ?? ""),
      })),
    );
    if (install) await context.manager.install();
    return context.manager.status();
  }

  test("reports both services running", async () => {
    const status = await statusWithShow(() =>
      systemctlShowOutput({
        LoadState: "loaded",
        ActiveState: "active",
        SubState: "running",
        UnitFileState: "enabled",
      }),
    );
    expect(status.serviceManagerAvailable).toBe(true);
    expect(status.dashboardEndpoint).toBe("http://127.0.0.1:4278");
    expect(
      status.services.map((entry) => [
        entry.state,
        entry.enabled,
        entry.registered,
      ]),
    ).toEqual([
      ["running", true, true],
      ["running", true, true],
    ]);
  });

  test("reports runtime running and dashboard stopped", async () => {
    const status = await statusWithShow((unit) =>
      systemctlShowOutput(
        unit === systemdUnitNames.runtime
          ? {
              LoadState: "loaded",
              ActiveState: "active",
              SubState: "running",
              UnitFileState: "enabled",
            }
          : {
              LoadState: "loaded",
              ActiveState: "inactive",
              SubState: "dead",
              UnitFileState: "disabled",
            },
      ),
    );
    expect(status.services.map((entry) => entry.state)).toEqual([
      "running",
      "installed_inactive",
    ]);
    expect(
      status.services.find((entry) => entry.service === "dashboard")?.enabled,
    ).toBe(false);
  });

  test("reports a dashboard registered while the runtime unit is missing", async () => {
    const context = manager();
    await context.manager.install();
    // Only the runtime definition is removed, leaving a dashboard that would
    // start without the Runtime it proxies.
    const { rmSync } = await import("node:fs");
    rmSync(unitPath(context.unitDirectory, "runtime"));
    const status = await context.manager.status();
    expect(
      status.services.map((entry) => [
        entry.service,
        entry.state,
        entry.installed,
      ]),
    ).toEqual([
      ["runtime", "not_installed", false],
      ["dashboard", "running", true],
    ]);
  });

  test("reports a failed unit as failed", async () => {
    const status = await statusWithShow(() =>
      systemctlShowOutput({
        LoadState: "loaded",
        ActiveState: "failed",
        SubState: "failed",
        UnitFileState: "enabled",
      }),
    );
    expect(status.services.map((entry) => entry.state)).toEqual([
      "failed",
      "failed",
    ]);
  });

  test("an unresolved active state is unknown, never healthy", async () => {
    const status = await statusWithShow(() =>
      systemctlShowOutput({
        LoadState: "loaded",
        ActiveState: "activating",
        SubState: "start",
        UnitFileState: "enabled",
      }),
    );
    expect(status.services.map((entry) => entry.state)).toEqual([
      "unknown",
      "unknown",
    ]);
  });

  test("reports missing definitions without contacting the manager about them", async () => {
    const context = manager();
    const status = await context.manager.status();
    expect(status.services.map((entry) => entry.state)).toEqual([
      "not_installed",
      "not_installed",
    ]);
    expect(context.runner.indexOf(["show"])).toBe(-1);
  });

  test("definitions present with an unavailable manager are unknown, not inactive", async () => {
    const context = manager();
    await context.manager.install();
    const offline = new SystemdUserServiceManager({
      plan: servicePlan(),
      unitDirectory: context.unitDirectory,
      runner: new FakeServiceCommandRunner({
        exitCode: 127,
        stdout: "",
        stderr: "",
        unavailable: true,
      }),
    });
    const status = await offline.status();
    expect(status.serviceManagerAvailable).toBe(false);
    expect(status.services.map((entry) => entry.state)).toEqual([
      "unknown",
      "unknown",
    ]);
    expect(status.services.every((entry) => entry.installed)).toBe(true);
    expect(status.issues.join("\n")).toContain("systemctl is not available");
  });

  test("an unmanaged collision is reported and never claimed as ours", async () => {
    const context = manager();
    mkdirSync(context.unitDirectory, { recursive: true });
    writeFileSync(
      unitPath(context.unitDirectory, "runtime"),
      "[Unit]\nDescription=Foreign\n",
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

describe("systemd uninstall", () => {
  test("stops the dashboard before the runtime and removes only the units", async () => {
    const context = manager();
    await context.manager.install();
    const report = await context.manager.uninstall();

    expect(report.removed.map((entry) => entry.service)).toEqual([
      "dashboard",
      "runtime",
    ]);
    const disableDashboard = context.runner.indexOf([
      "disable",
      systemdUnitNames.dashboard,
    ]);
    const disableRuntime = context.runner.indexOf([
      "disable",
      systemdUnitNames.runtime,
    ]);
    expect(disableDashboard).toBeLessThan(disableRuntime);
    expect(existsSync(unitPath(context.unitDirectory, "runtime"))).toBe(false);
    expect(existsSync(unitPath(context.unitDirectory, "dashboard"))).toBe(
      false,
    );
    expect(report.issues).toEqual([]);
    expect(report.preservedData).toEqual(["/home/operator/.ai-office"]);
  });

  test("reloads the manager only after something was removed", async () => {
    const context = manager();
    await context.manager.install();
    const beforeUninstall = context.runner.calls.length;
    await context.manager.uninstall();
    const reloads = context.runner.calls
      .slice(beforeUninstall)
      .filter((command) => command.includes("daemon-reload"));
    expect(reloads).toHaveLength(1);
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

  test("an unmanaged unit is preserved, reported, and never disabled", async () => {
    const context = manager();
    await context.manager.install();
    const foreign = "[Unit]\nDescription=Foreign\n";
    writeFileSync(unitPath(context.unitDirectory, "runtime"), foreign, "utf8");

    const report = await context.manager.uninstall();
    expect(report.preserved).toEqual([
      {
        service: "runtime",
        path: unitPath(context.unitDirectory, "runtime"),
        reason: "the unit is not managed by AI Office",
      },
    ]);
    expect(
      readFileSync(unitPath(context.unitDirectory, "runtime"), "utf8"),
    ).toBe(foreign);
    expect(context.runner.indexOf(["disable", systemdUnitNames.runtime])).toBe(
      -1,
    );
    expect(report.removed.map((entry) => entry.service)).toEqual(["dashboard"]);
  });

  test("a failed disable is reported rather than silently ignored", async () => {
    const context = manager(
      healthySystemdRunner().on(["disable"], {
        exitCode: 1,
        stderr: "Failed to disable unit\n",
      }),
    );
    await context.manager.install();
    const report = await context.manager.uninstall();
    expect(report.issues).toHaveLength(2);
    expect(report.issues[0]).toContain("disable --now");
  });
});
