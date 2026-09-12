import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  renderSystemdUnit,
  systemdOwnershipLines,
  systemdUnitNames,
  SystemdUserServiceManager,
  defaultSystemdUnitDirectory,
} from "@ai-office/service-management/systemd-user-service-manager.ts";
import { OfficeServicePreconditionError } from "@ai-office/application/ports/office-service-manager.port.ts";
import type { OfficeServiceName } from "@ai-office/application/ports/office-service-manager.port.ts";
import { officeServicesHealthy } from "@ai-office/application/service-management/manage-office-services.ts";
import {
  cleanTemporaryDirectories,
  FakeSystemd,
  servicePlan,
  temporaryDefinitionDirectory,
} from "../helpers/service-management.ts";

const directories: string[] = [];
afterEach(() => cleanTemporaryDirectories(directories));

interface Context {
  manager: SystemdUserServiceManager;
  runner: FakeSystemd;
  unitDirectory: string;
}

function manager(
  plan = servicePlan(),
  arrange: (runner: FakeSystemd, unitDirectory: string) => void = () => {},
): Context {
  const unitDirectory = temporaryDefinitionDirectory(
    directories,
    "ai-office-systemd-",
  );
  const runner = new FakeSystemd(unitDirectory);
  arrange(runner, unitDirectory);
  return {
    runner,
    unitDirectory,
    manager: new SystemdUserServiceManager({
      plan,
      unitDirectory,
      runner,
      userName: "operator",
    }),
  };
}

function unitPath(unitDirectory: string, service: OfficeServiceName): string {
  return join(unitDirectory, systemdUnitNames[service]);
}

function writeForeignUnit(unitDirectory: string, service: OfficeServiceName) {
  mkdirSync(unitDirectory, { recursive: true });
  const foreign = "[Unit]\nDescription=Somebody else's unit\n";
  writeFileSync(unitPath(unitDirectory, service), foreign, "utf8");
  return foreign;
}

describe("systemd unit rendering", () => {
  const plan = servicePlan();

  test("the runtime unit is deterministic and carries the ownership header", () => {
    const unit = renderSystemdUnit(plan, "runtime");
    expect(unit).toBe(renderSystemdUnit(plan, "runtime"));
    expect(unit.startsWith("# Managed by AI Office\n")).toBe(true);
    expect(unit).toContain("# Definition: ai-office/service/v1 runtime");
    expect(unit).not.toContain("# Definition: ai-office/service/v1 dashboard");
    expect(unit).toContain("Description=AI Office Runtime");
    expect(unit).toContain("After=network.target");
    expect(unit).toContain("Type=simple");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("RestartSec=3");
    expect(unit).toContain("WantedBy=default.target");
  });

  test("each service renders its own ownership identity", () => {
    for (const service of ["runtime", "dashboard"] as const)
      for (const line of systemdOwnershipLines(service))
        expect(renderSystemdUnit(plan, service)).toContain(`${line}\n`);
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

  describe("systemd specifier escaping", () => {
    // `%` introduces a systemd specifier. A directory literally named `100%`
    // is ordinary, and systemd must receive the literal character, so every
    // rendered `%` is doubled. This is unit syntax, not shell escaping.
    const percentPlan = servicePlan({
      program: {
        launcher: ["/opt/100%/bun", "/srv/ai-office%20build/bin/ai-office.ts"],
        runtimeHome: "/home/operator/100%/.ai-office",
        requiresSourceRuntimeOptIn: true,
      },
    });

    test("a percent in the executable path is escaped", () => {
      expect(renderSystemdUnit(percentPlan, "runtime")).toContain(
        '"/opt/100%%/bun"',
      );
    });

    test("a percent in the entry-module path is escaped", () => {
      expect(renderSystemdUnit(percentPlan, "dashboard")).toContain(
        '"/srv/ai-office%%20build/bin/ai-office.ts"',
      );
    });

    test("a percent in AI_OFFICE_HOME is escaped", () => {
      expect(renderSystemdUnit(percentPlan, "runtime")).toContain(
        'Environment="AI_OFFICE_HOME=/home/operator/100%%/.ai-office"',
      );
    });

    test("no single unescaped percent survives in a directive", () => {
      for (const service of ["runtime", "dashboard"] as const)
        for (const line of renderSystemdUnit(percentPlan, service).split("\n"))
          if (line.startsWith("ExecStart=") || line.startsWith("Environment="))
            // Every `%` must be part of a `%%` pair.
            expect(line.replaceAll("%%", "")).not.toContain("%");
    });

    test("escaping survives alongside quote and backslash escaping", () => {
      const unit = renderSystemdUnit(
        servicePlan({
          program: {
            launcher: ['/opt/we"ird\\100%/bun'],
            runtimeHome: "/home/operator/.ai-office",
            requiresSourceRuntimeOptIn: false,
          },
        }),
        "runtime",
      );
      expect(unit).toContain('ExecStart="/opt/we\\"ird\\\\100%%/bun"');
    });
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
  test("a fresh install writes both units, reloads, enables, starts and verifies", async () => {
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
    expect(officeServicesHealthy(report.status)).toBe(true);

    const reload = context.runner.indexOf(["daemon-reload"]);
    const enableRuntime = context.runner.indexOf([
      "enable",
      systemdUnitNames.runtime,
    ]);
    const restartRuntime = context.runner.indexOf([
      "restart",
      systemdUnitNames.runtime,
    ]);
    const restartDashboard = context.runner.indexOf([
      "restart",
      systemdUnitNames.dashboard,
    ]);
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(reload).toBeLessThan(enableRuntime);
    expect(enableRuntime).toBeLessThan(restartRuntime);
    expect(restartRuntime).toBeLessThan(restartDashboard);
  });

  test("install converges a running service to a changed definition", async () => {
    const context = manager();
    await context.manager.install();

    // A different plan at the same paths: the units are rewritten, and the
    // processes must be brought to them. `enable --now` would not have.
    const converged = new SystemdUserServiceManager({
      plan: servicePlan({
        program: {
          launcher: [
            "/opt/bun/bin/bun",
            "/opt/ai-office-next/bin/ai-office.ts",
          ],
          runtimeHome: "/home/operator/.ai-office",
          requiresSourceRuntimeOptIn: false,
        },
      }),
      unitDirectory: context.unitDirectory,
      runner: context.runner,
      userName: "operator",
    });
    const before = context.runner.calls.length;
    const report = await converged.install();

    expect(report.definitions.map((entry) => entry.action)).toEqual([
      "updated",
      "updated",
    ]);
    const replayed = context.runner.calls.slice(before);
    for (const service of ["runtime", "dashboard"] as const)
      expect(
        replayed.some(
          (command) =>
            command.includes("restart") &&
            command.includes(systemdUnitNames[service]),
        ),
      ).toBe(true);
    expect(report.issues).toEqual([]);
    expect(officeServicesHealthy(report.status)).toBe(true);
    expect(
      readFileSync(unitPath(context.unitDirectory, "runtime"), "utf8"),
    ).toContain("/opt/ai-office-next/bin/ai-office.ts");
  });

  test("a repeated install converges rather than skipping, and stays safe", async () => {
    const context = manager();
    await context.manager.install();
    const before = context.runner.calls.length;
    const second = await context.manager.install();

    expect(second.definitions.map((entry) => entry.action)).toEqual([
      "unchanged",
      "unchanged",
    ]);
    expect(second.issues).toEqual([]);
    expect(officeServicesHealthy(second.status)).toBe(true);
    // Byte equality of the unit proves nothing about the running process, so
    // an explicit install restarts anyway.
    expect(
      context.runner.calls
        .slice(before)
        .filter((command) => command.includes("restart")),
    ).toHaveLength(2);
  });

  test("install recovers a service left stopped by an earlier partial apply", async () => {
    const context = manager();
    await context.manager.install();
    // Simulate the earlier failure: the unit file is current, the process is
    // not running. A definition-only view would call this installed.
    context.runner.units.get(systemdUnitNames.dashboard)!.activeState =
      "inactive";
    const report = await context.manager.install();
    expect(report.status.services.map((entry) => entry.state)).toEqual([
      "running",
      "running",
    ]);
    expect(officeServicesHealthy(report.status)).toBe(true);
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
    const foreign = writeForeignUnit(context.unitDirectory, "dashboard");

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

  test("a unit carrying the other service's ownership identity fails closed", async () => {
    const context = manager();
    mkdirSync(context.unitDirectory, { recursive: true });
    writeFileSync(
      unitPath(context.unitDirectory, "dashboard"),
      renderSystemdUnit(servicePlan(), "runtime"),
      "utf8",
    );
    await expect(context.manager.install()).rejects.toBeInstanceOf(
      OfficeServicePreconditionError,
    );
  });

  test("an unusable systemd user manager is refused before anything is written", async () => {
    const context = manager(servicePlan(), (runner) => {
      runner.userManagerAvailable = false;
    });
    await expect(context.manager.install()).rejects.toThrow(/systemd --user/u);
    expect(existsSync(unitPath(context.unitDirectory, "runtime"))).toBe(false);
  });

  test("a daemon-reload failure is reported and no unit is started", async () => {
    const context = manager(servicePlan(), (runner) => {
      runner.on(["daemon-reload"], {
        exitCode: 1,
        stderr: "reload refused\n",
      });
    });
    const report = await context.manager.install();
    expect(report.issues[0]).toContain("daemon-reload failed");
    expect(report.issues[0]).toContain("reload refused");
    expect(context.runner.indexOf(["enable"])).toBe(-1);
    expect(context.runner.indexOf(["restart"])).toBe(-1);
    expect(officeServicesHealthy(report.status)).toBe(false);
  });

  test("a runtime start failure is reported without claiming success", async () => {
    const context = manager(servicePlan(), (runner) => {
      runner.on(["restart", systemdUnitNames.runtime], {
        exitCode: 1,
        stderr: "Job for ai-office-runtime.service failed\n",
      });
    });
    const report = await context.manager.install();
    expect(report.issues.join("\n")).toContain(
      `restart ${systemdUnitNames.runtime} failed`,
    );
    expect(
      report.status.services.find((entry) => entry.service === "runtime")
        ?.state,
    ).toBe("installed_inactive");
    expect(officeServicesHealthy(report.status)).toBe(false);
    // The dashboard is still attempted; it does not depend on the runtime
    // having started for its own process to be valid.
    expect(
      context.runner.indexOf(["restart", systemdUnitNames.dashboard]),
    ).toBeGreaterThanOrEqual(0);
  });

  test("a dashboard start failure leaves the runtime running", async () => {
    const context = manager(servicePlan(), (runner) => {
      runner.refuseStart.add(systemdUnitNames.dashboard);
    });
    const report = await context.manager.install();
    expect(report.status.services.map((entry) => entry.state)).toEqual([
      "running",
      "installed_inactive",
    ]);
    expect(officeServicesHealthy(report.status)).toBe(false);
  });
});

describe("systemd status", () => {
  test("reports both services running, registered and enabled", async () => {
    const context = manager();
    await context.manager.install();
    const status = await context.manager.status();
    expect(status.serviceManagerAvailable).toBe(true);
    expect(status.dashboardEndpoint).toBe("http://127.0.0.1:4278");
    expect(
      status.services.map((entry) => [
        entry.state,
        entry.enabled,
        entry.registered,
        entry.definition,
      ]),
    ).toEqual([
      ["running", true, true, "managed_current"],
      ["running", true, true, "managed_current"],
    ]);
    expect(officeServicesHealthy(status)).toBe(true);
  });

  test("reports runtime running and dashboard stopped", async () => {
    const context = manager();
    await context.manager.install();
    const dashboard = context.runner.units.get(systemdUnitNames.dashboard)!;
    dashboard.activeState = "inactive";
    dashboard.subState = "dead";
    dashboard.unitFileState = "disabled";
    const status = await context.manager.status();
    expect(status.services.map((entry) => entry.state)).toEqual([
      "running",
      "installed_inactive",
    ]);
    expect(
      status.services.find((entry) => entry.service === "dashboard")?.enabled,
    ).toBe(false);
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("a running but disabled unit is reported and is not healthy", async () => {
    const context = manager();
    await context.manager.install();
    context.runner.units.get(systemdUnitNames.dashboard)!.unitFileState =
      "disabled";
    const status = await context.manager.status();
    expect(
      status.services.find((entry) => entry.service === "dashboard"),
    ).toMatchObject({ state: "running", enabled: false });
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("an outdated managed unit is reported and is not healthy", async () => {
    const context = manager();
    await context.manager.install();
    const path = unitPath(context.unitDirectory, "runtime");
    writeFileSync(path, `${readFileSync(path, "utf8")}# drift\n`, "utf8");
    const status = await context.manager.status();
    expect(
      status.services.find((entry) => entry.service === "runtime"),
    ).toMatchObject({
      definition: "managed_outdated",
      installed: true,
      state: "running",
    });
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("reports a failed unit as failed", async () => {
    const context = manager();
    await context.manager.install();
    for (const unit of context.runner.units.values()) {
      unit.activeState = "failed";
      unit.subState = "failed";
    }
    const status = await context.manager.status();
    expect(status.services.map((entry) => entry.state)).toEqual([
      "failed",
      "failed",
    ]);
  });

  test("an unresolved active state is unknown, never healthy", async () => {
    const context = manager();
    await context.manager.install();
    for (const unit of context.runner.units.values()) {
      unit.activeState = "activating";
      unit.subState = "start";
    }
    const status = await context.manager.status();
    expect(status.services.map((entry) => entry.state)).toEqual([
      "unknown",
      "unknown",
    ]);
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("reports nothing installed when no definition and no unit exist", async () => {
    const context = manager();
    const status = await context.manager.status();
    expect(
      status.services.map((entry) => [
        entry.state,
        entry.installed,
        entry.registered,
      ]),
    ).toEqual([
      ["not_installed", false, false],
      ["not_installed", false, false],
    ]);
    expect(status.issues).toEqual([]);
  });

  test("a missing definition does not stop status from asking systemd", async () => {
    // The old behaviour short-circuited on a missing file and reported
    // `registered: false` without evidence.
    const context = manager();
    await context.manager.status();
    expect(
      context.runner.indexOf(["show", systemdUnitNames.runtime]),
    ).toBeGreaterThanOrEqual(0);
  });

  test("exposes an orphan whose unit file was deleted by hand", async () => {
    const context = manager();
    await context.manager.install();
    // The file is gone; systemd still has the unit loaded and running.
    rmSync(unitPath(context.unitDirectory, "runtime"));

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
      `systemctl --user disable --now ${systemdUnitNames.runtime}`,
    );
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("definitions present with an unavailable manager are unknown, not inactive", async () => {
    const context = manager();
    await context.manager.install();
    context.runner.systemctlMissing = true;

    const status = await context.manager.status();
    expect(status.serviceManagerAvailable).toBe(false);
    expect(status.services.map((entry) => entry.state)).toEqual([
      "unknown",
      "unknown",
    ]);
    expect(status.services.every((entry) => entry.installed)).toBe(true);
    expect(
      status.services.every(
        (entry) => entry.registered === null && entry.enabled === null,
      ),
    ).toBe(true);
    expect(status.issues.join("\n")).toContain("systemctl is not available");
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("an unmanaged collision is reported and never claimed as ours", async () => {
    const context = manager();
    writeForeignUnit(context.unitDirectory, "runtime");
    const status = await context.manager.status();
    const runtime = status.services.find(
      (entry) => entry.service === "runtime",
    )!;
    expect(runtime.definition).toBe("unmanaged_collision");
    expect(runtime.installed).toBe(false);
    expect(status.issues.join("\n")).toContain("not managed by AI Office");
    expect(officeServicesHealthy(status)).toBe(false);
  });

  test("an unmanaged collision whose unit is loaded is reported as an orphan too", async () => {
    const context = manager();
    writeForeignUnit(context.unitDirectory, "runtime");
    context.runner.register(systemdUnitNames.runtime);
    const status = await context.manager.status();
    const runtime = status.services.find(
      (entry) => entry.service === "runtime",
    )!;
    expect(runtime.registered).toBe(true);
    expect(runtime.state).toBe("running");
    expect(runtime.installed).toBe(false);
    expect(status.issues.join("\n")).toContain("still registered with systemd");
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

  test("verifies the unit is stopped before deleting its file", async () => {
    const context = manager();
    await context.manager.install();
    const before = context.runner.calls.length;
    await context.manager.uninstall();

    const replayed = context.runner.calls.slice(before);
    const disable = replayed.findIndex(
      (command) =>
        command.includes("disable") &&
        command.includes(systemdUnitNames.dashboard),
    );
    const verify = replayed.findIndex(
      (command) =>
        command.includes("show") &&
        command.includes(systemdUnitNames.dashboard),
    );
    expect(disable).toBeGreaterThanOrEqual(0);
    expect(verify).toBeGreaterThan(disable);
  });

  test("preserves the unit when the service manager cannot be contacted", async () => {
    const context = manager();
    await context.manager.install();
    context.runner.systemctlMissing = true;

    const report = await context.manager.uninstall();
    expect(report.removed).toEqual([]);
    expect(report.preserved.map((entry) => entry.service)).toEqual([
      "dashboard",
      "runtime",
    ]);
    expect(report.issues.join("\n")).toContain(
      "No service definition was removed",
    );
    expect(existsSync(unitPath(context.unitDirectory, "runtime"))).toBe(true);
    expect(existsSync(unitPath(context.unitDirectory, "dashboard"))).toBe(true);
  });

  test("preserves the unit when disable fails and the service is still running", async () => {
    // The failing override answers without changing state, so the unit is
    // still up when verification runs. A failed disable must never be followed
    // blindly by removal.
    const context = manager(servicePlan(), (runner) => {
      runner.on(["disable", systemdUnitNames.runtime], {
        exitCode: 1,
        stderr: "Failed to disable unit\n",
      });
    });
    await context.manager.install();
    const report = await context.manager.uninstall();

    expect(report.removed.map((entry) => entry.service)).toEqual(["dashboard"]);
    expect(report.preserved.map((entry) => entry.service)).toEqual(["runtime"]);
    expect(existsSync(unitPath(context.unitDirectory, "runtime"))).toBe(true);
    expect(report.issues.join("\n")).toContain("disable --now");
    expect(report.issues.join("\n")).toContain("was preserved");
  });

  test("preserves the unit when post-stop verification still reports running", async () => {
    // `disable --now` exits 0, but the unit did not actually stop. Removing
    // the file here would destroy the only proof AI Office owns what is still
    // running.
    const context = manager(servicePlan(), (runner) => {
      runner.refuseStop.add(systemdUnitNames.runtime);
    });
    await context.manager.install();
    const report = await context.manager.uninstall();

    expect(report.removed.map((entry) => entry.service)).toEqual(["dashboard"]);
    expect(report.preserved).toEqual([
      {
        service: "runtime",
        path: unitPath(context.unitDirectory, "runtime"),
        reason: "the unit is still running",
      },
    ]);
    expect(existsSync(unitPath(context.unitDirectory, "runtime"))).toBe(true);
    expect(report.issues.join("\n")).toContain("still active");
  });

  test("preserves the unit when it stops but remains enabled", async () => {
    // Stopped is not the whole goal state: a unit still wanted by
    // default.target comes back at the next login, and deleting its file would
    // leave that residue with no owner.
    const context = manager();
    await context.manager.install();
    const dashboard = context.runner.units.get(systemdUnitNames.dashboard)!;
    dashboard.activeState = "inactive";
    dashboard.subState = "dead";
    context.runner.on(["disable", systemdUnitNames.dashboard], {
      exitCode: 0,
    });
    const report = await context.manager.uninstall();

    expect(report.preserved.map((entry) => entry.service)).toEqual([
      "dashboard",
    ]);
    expect(existsSync(unitPath(context.unitDirectory, "dashboard"))).toBe(true);
    expect(report.issues.join("\n")).toContain("still enabled");
  });

  test("preserves the unit when systemd cannot confirm it stopped", async () => {
    const context = manager();
    await context.manager.install();
    context.runner.on(["show"], { exitCode: 1, stderr: "bus error\n" });

    const report = await context.manager.uninstall();
    expect(report.removed).toEqual([]);
    expect(report.preserved).toHaveLength(2);
    expect(report.issues.join("\n")).toContain(
      "could not be verified as stopped",
    );
    expect(existsSync(unitPath(context.unitDirectory, "runtime"))).toBe(true);
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

  test("a repeated uninstall of a genuinely absent service is clean and idempotent", async () => {
    const context = manager();
    await context.manager.install();
    await context.manager.uninstall();
    const second = await context.manager.uninstall();

    expect(second.removed).toEqual([]);
    expect(second.preserved).toEqual([]);
    expect(second.issues).toEqual([]);
  });

  test("a repeated uninstall reports a unit that is still registered", async () => {
    const context = manager();
    await context.manager.install();
    await context.manager.uninstall();
    // Something re-registered the unit name after AI Office let go of it.
    context.runner.register(systemdUnitNames.runtime);

    const second = await context.manager.uninstall();
    expect(second.removed).toEqual([]);
    expect(second.issues.join("\n")).toContain(
      "AI Office owns no definition for it",
    );
  });

  test("an unmanaged unit is preserved, reported, and never disabled", async () => {
    const context = manager();
    await context.manager.install();
    const foreign = writeForeignUnit(context.unitDirectory, "runtime");
    const before = context.runner.calls.length;

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
    expect(
      context.runner.calls
        .slice(before)
        .some(
          (command) =>
            command.includes("disable") &&
            command.includes(systemdUnitNames.runtime),
        ),
    ).toBe(false);
    expect(report.removed.map((entry) => entry.service)).toEqual(["dashboard"]);
  });
});
