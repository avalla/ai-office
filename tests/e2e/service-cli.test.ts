import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CommandIo } from "@ai-office/command-support/arguments.ts";
import type { RuntimePaths } from "@ai-office/runtime-paths/runtime-paths.ts";
import type { OfficeServicePlan } from "@ai-office/service-management/service-plan.ts";
import {
  SystemdUserServiceManager,
  systemdUnitNames,
} from "@ai-office/service-management/systemd-user-service-manager.ts";
import {
  cleanTemporaryDirectories,
  FakeSystemd,
  temporaryDefinitionDirectory,
} from "../helpers/service-management.ts";

const directories: string[] = [];
afterEach(() => cleanTemporaryDirectories(directories));

function captureIo(): { io: CommandIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      prompt: async () => "",
    },
    stdout,
    stderr,
  };
}

/**
 * A runtime home holding the state an uninstall must never touch.
 *
 * These are the real artifact names the Runtime owns, so a future change that
 * broadened removal to the runtime home would fail here.
 */
function runtimeHomeWithState(): {
  runtimePaths: RuntimePaths;
  files: string[];
} {
  const runtimeHome = temporaryDefinitionDirectory(
    directories,
    "ai-office-home-",
  );
  mkdirSync(join(runtimeHome, "generated"), { recursive: true });
  mkdirSync(join(runtimeHome, "drafts"), { recursive: true });
  const files = [
    join(runtimeHome, "project.sqlite"),
    join(runtimeHome, "global.sqlite"),
    join(runtimeHome, "generated", "office.md"),
    join(runtimeHome, "drafts", "note.md"),
  ];
  for (const file of files) writeFileSync(file, `state:${file}`, "utf8");
  return {
    files,
    runtimePaths: Object.freeze({
      runtimeHome,
      projectDatabasePath: files[0]!,
      socketPath: join(runtimeHome, "daemon.sock"),
      globalDatabasePath: files[1]!,
      draftsDirectory: join(runtimeHome, "drafts"),
      generatedDirectory: join(runtimeHome, "generated"),
    }),
  };
}

interface Harness {
  run: (args: string[]) => Promise<number>;
  plans: OfficeServicePlan[];
  unitDirectory: string;
  runner: FakeSystemd;
  io: ReturnType<typeof captureIo>;
  runtimePaths: RuntimePaths;
  stateFiles: string[];
}

function harness(
  arrange: (runner: FakeSystemd, unitDirectory: string) => void = () => {},
): Harness {
  const unitDirectory = temporaryDefinitionDirectory(
    directories,
    "ai-office-service-cli-",
  );
  const runner = new FakeSystemd(unitDirectory);
  arrange(runner, unitDirectory);
  const { runtimePaths, files } = runtimeHomeWithState();
  const io = captureIo();
  const plans: OfficeServicePlan[] = [];
  return {
    plans,
    unitDirectory,
    runner,
    io,
    runtimePaths,
    stateFiles: files,
    run: (args) =>
      runRuntimeCli(args, {
        runtimePaths,
        workingDirectory: runtimePaths.runtimeHome,
        io: io.io,
        serviceProgram: {
          launcher: ["/opt/bun/bin/bun", "/opt/ai-office/bin/ai-office.ts"],
          requiresSourceRuntimeOptIn: true,
        },
        selectServiceManager: (plan) => {
          plans.push(plan);
          return new SystemdUserServiceManager({
            plan,
            unitDirectory,
            runner,
            userName: "operator",
          });
        },
      }),
  };
}

describe("ai-office service help", () => {
  test("the service command is discoverable in CLI help", async () => {
    const io = captureIo();
    expect(await runRuntimeCli(["--help"], { io: io.io })).toBe(0);
    const help = io.stdout.join("\n");
    expect(help).toContain("service install|status|uninstall");
    expect(help).toContain("ai-office service --help");
  });

  test.each([
    ["service"],
    ["service", "--help"],
    ["service", "install", "--help"],
    ["service", "status", "--help"],
    ["service", "uninstall", "--help"],
  ])("%s prints the service help", async (...args) => {
    const context = harness();
    expect(await context.run([...args])).toBe(0);
    const help = context.io.stdout.join("\n");
    expect(help).toContain("AI Office service management");
    expect(help).toContain("systemd --user");
    expect(help).toContain("launchd LaunchAgents");
    expect(help).toContain("Windows services are not currently supported");
  });

  test("an unknown service command is a usage error", async () => {
    const context = harness();
    expect(await context.run(["service", "restart"])).toBe(1);
    expect(context.io.stderr.join("\n")).toContain("Unknown service command");
  });
});

describe("ai-office service install", () => {
  test("builds the plan from the authoritative runtime home and defaults", async () => {
    const context = harness();
    expect(await context.run(["service", "install"])).toBe(0);
    expect(context.plans[0]).toEqual({
      program: {
        launcher: ["/opt/bun/bin/bun", "/opt/ai-office/bin/ai-office.ts"],
        runtimeHome: context.runtimePaths.runtimeHome,
        requiresSourceRuntimeOptIn: true,
      },
      dashboard: { host: "127.0.0.1", port: 4278, awaitRuntimeSeconds: 60 },
    });
    const unit = readFileSync(
      join(context.unitDirectory, systemdUnitNames.runtime),
      "utf8",
    );
    expect(unit).toContain(
      `Environment="AI_OFFICE_HOME=${context.runtimePaths.runtimeHome}"`,
    );
    expect(unit).toContain(
      'Environment="AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1"',
    );
  });

  test("prints a success banner only after post-install verification", async () => {
    const context = harness();
    expect(await context.run(["service", "install"])).toBe(0);
    const output = context.io.stdout.join("\n");
    expect(output).toContain("AI Office services installed");
    expect(output).toContain("Runtime:   running");
    expect(output).toContain("Dashboard: running");
    expect(output).toContain("http://127.0.0.1:4278");
    expect(output).toContain("sudo loginctl enable-linger operator");
    expect(output).toContain("ssh -L 4278:127.0.0.1:4278");
    expect(context.io.stderr).toEqual([]);
  });

  test("is idempotent", async () => {
    const context = harness();
    expect(await context.run(["service", "install"])).toBe(0);
    expect(await context.run(["service", "install"])).toBe(0);
    expect(context.io.stdout.join("\n")).toContain("(unchanged)");
  });

  test("reports partial installation on stderr and exits non-zero", async () => {
    const context = harness((runner) => {
      runner.startFailures.add(systemdUnitNames.dashboard);
    });
    expect(await context.run(["service", "install"])).toBe(1);
    const errors = context.io.stderr.join("\n");
    expect(errors).toContain("AI Office service installation incomplete");
    expect(errors).toContain("Runtime:   running");
    expect(errors).toContain("Dashboard: failed");
    expect(errors).toContain("Job for ai-office-dashboard.service failed");
    expect(errors).toContain("restart ai-office-dashboard.service failed");
    expect(context.io.stdout.join("\n")).not.toContain(
      "AI Office services installed",
    );
  });

  test("an unmanaged unit fails closed with an actionable error", async () => {
    const context = harness();
    mkdirSync(context.unitDirectory, { recursive: true });
    writeFileSync(
      join(context.unitDirectory, systemdUnitNames.runtime),
      "[Unit]\nDescription=Somebody else\n",
      "utf8",
    );
    expect(await context.run(["service", "install"])).toBe(1);
    expect(context.io.stderr.join("\n")).toContain(
      "is not managed by AI Office",
    );
    expect(
      existsSync(join(context.unitDirectory, systemdUnitNames.dashboard)),
    ).toBe(false);
  });

  test("--json emits the normalized result", async () => {
    const context = harness();
    expect(await context.run(["service", "install", "--json"])).toBe(0);
    const result = JSON.parse(context.io.stdout[0]!) as {
      contractVersion: number;
      outcome: string;
      platform: string;
      status: { services: { service: string; state: string }[] };
    };
    expect(result.contractVersion).toBe(1);
    expect(result.outcome).toBe("installed");
    expect(result.platform).toBe("systemd-user");
    expect(result.status.services.map((entry) => entry.state)).toEqual([
      "running",
      "running",
    ]);
  });
});

describe("ai-office service status", () => {
  test("reports normalized state for both services", async () => {
    const context = harness();
    await context.run(["service", "install"]);
    context.io.stdout.length = 0;
    expect(await context.run(["service", "status"])).toBe(0);
    const output = context.io.stdout.join("\n");
    expect(output).toContain("AI Office services");
    expect(output).toContain("Platform: systemd --user");
    expect(output).toContain(
      `Runtime home: ${context.runtimePaths.runtimeHome}`,
    );
    expect(output).toContain("  installed: yes");
    expect(output).toContain("  enabled: yes");
    expect(output).toContain("  state: running");
    expect(output).toContain("  endpoint: http://127.0.0.1:4278");
  });

  test("not installed is reported and exits non-zero", async () => {
    const context = harness();
    expect(await context.run(["service", "status"])).toBe(1);
    const output = context.io.stdout.join("\n");
    expect(output).toContain("  state: not_installed");
    expect(output).toContain("  installed: no");
  });

  test("partial health never exits zero", async () => {
    const context = harness();
    await context.run(["service", "install"]);
    const dashboard = context.runner.units.get(systemdUnitNames.dashboard)!;
    dashboard.activeState = "inactive";
    dashboard.subState = "dead";
    context.io.stdout.length = 0;
    expect(await context.run(["service", "status"])).toBe(1);
    expect(context.io.stdout.join("\n")).toContain("state: installed_inactive");
  });

  test("--json emits the normalized status", async () => {
    const context = harness();
    await context.run(["service", "install"]);
    context.io.stdout.length = 0;
    await context.run(["service", "status", "--json"]);
    const status = JSON.parse(context.io.stdout[0]!) as {
      contractVersion: number;
      serviceManagerAvailable: boolean;
      dashboardEndpoint: string;
    };
    expect(status.contractVersion).toBe(1);
    expect(status.serviceManagerAvailable).toBe(true);
    expect(status.dashboardEndpoint).toBe("http://127.0.0.1:4278");
  });
});

describe("ai-office service uninstall", () => {
  test("removes the definitions and preserves all AI Office data", async () => {
    const context = harness();
    await context.run(["service", "install"]);
    context.io.stdout.length = 0;

    expect(await context.run(["service", "uninstall"])).toBe(0);
    const output = context.io.stdout.join("\n");
    expect(output).toContain("AI Office services uninstalled");
    expect(output).toContain(context.runtimePaths.runtimeHome);
    expect(output).toContain(
      "AI Office project state, SQLite databases and runtime state",
    );

    expect(
      existsSync(join(context.unitDirectory, systemdUnitNames.runtime)),
    ).toBe(false);
    expect(
      existsSync(join(context.unitDirectory, systemdUnitNames.dashboard)),
    ).toBe(false);

    // Nothing under the runtime home may be removed or rewritten.
    expect(existsSync(context.runtimePaths.runtimeHome)).toBe(true);
    for (const file of context.stateFiles) {
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(`state:${file}`);
    }
    expect(existsSync(context.runtimePaths.projectDatabasePath)).toBe(true);
    expect(existsSync(context.runtimePaths.globalDatabasePath)).toBe(true);
    expect(existsSync(context.runtimePaths.generatedDirectory)).toBe(true);
  });

  test("is idempotent", async () => {
    const context = harness();
    await context.run(["service", "install"]);
    expect(await context.run(["service", "uninstall"])).toBe(0);
    context.io.stdout.length = 0;
    expect(await context.run(["service", "uninstall"])).toBe(0);
    expect(context.io.stdout.join("\n")).toContain(
      "nothing; no managed definition",
    );
    for (const file of context.stateFiles) expect(existsSync(file)).toBe(true);
  });

  test("an unmanaged definition is preserved and the collision is reported", async () => {
    const context = harness();
    await context.run(["service", "install"]);
    const foreign = "[Unit]\nDescription=Somebody else\n";
    const path = join(context.unitDirectory, systemdUnitNames.runtime);
    writeFileSync(path, foreign, "utf8");

    expect(await context.run(["service", "uninstall"])).toBe(1);
    expect(context.io.stderr.join("\n")).toContain(
      "AI Office service uninstall incomplete",
    );
    expect(context.io.stderr.join("\n")).toContain("not managed by AI Office");
    expect(readFileSync(path, "utf8")).toBe(foreign);
  });
});

describe("ai-office service status orphan reporting", () => {
  test("a unit left registered after its definition was deleted is exposed", async () => {
    const context = harness();
    await context.run(["service", "install"]);
    rmSync(join(context.unitDirectory, systemdUnitNames.runtime));
    context.io.stdout.length = 0;

    expect(await context.run(["service", "status"])).toBe(1);
    const output = context.io.stdout.join("\n");
    expect(output).toContain("  installed: no");
    expect(output).toContain("  registered: yes");
    expect(output).toContain("  state: running");
    expect(output).toContain("cannot prove ownership");
    // Cleanup is the operator's call: ownership can no longer be proven.
    expect(output).toContain(
      `systemctl --user disable --now ${systemdUnitNames.runtime}`,
    );
  });

  test("an orphan is never reported as a healthy installation", async () => {
    const context = harness();
    await context.run(["service", "install"]);
    rmSync(join(context.unitDirectory, systemdUnitNames.dashboard));
    context.io.stdout.length = 0;

    await context.run(["service", "status", "--json"]);
    const status = JSON.parse(context.io.stdout[0]!) as {
      services: { service: string; installed: boolean; registered: boolean }[];
      issues: string[];
    };
    expect(
      status.services.find((entry) => entry.service === "dashboard"),
    ).toMatchObject({ installed: false, registered: true });
    expect(status.issues.length).toBeGreaterThan(0);
  });

  test("a running but disabled service exits non-zero", async () => {
    const context = harness();
    await context.run(["service", "install"]);
    context.runner.units.get(systemdUnitNames.runtime)!.unitFileState =
      "disabled";
    context.io.stdout.length = 0;

    expect(await context.run(["service", "status"])).toBe(1);
    expect(context.io.stdout.join("\n")).toContain("  enabled: no");
  });
});

describe("ai-office service uninstall fails closed", () => {
  test("a service that will not stop keeps its definition and reports partial", async () => {
    const context = harness((runner) => {
      runner.refuseStop.add(systemdUnitNames.runtime);
    });
    await context.run(["service", "install"]);
    context.io.stdout.length = 0;

    expect(await context.run(["service", "uninstall"])).toBe(1);
    const errors = context.io.stderr.join("\n");
    expect(errors).toContain("AI Office service uninstall incomplete");
    expect(errors).toContain("Preserved");
    // The ownership evidence survives, so a later uninstall can still clean up.
    expect(
      existsSync(join(context.unitDirectory, systemdUnitNames.runtime)),
    ).toBe(true);
    for (const file of context.stateFiles) expect(existsSync(file)).toBe(true);
  });

  test("an unreachable service manager removes nothing", async () => {
    const context = harness();
    await context.run(["service", "install"]);
    context.runner.systemctlMissing = true;
    context.io.stdout.length = 0;

    expect(await context.run(["service", "uninstall"])).toBe(1);
    expect(context.io.stderr.join("\n")).toContain(
      "No service definition was removed",
    );
    for (const service of ["runtime", "dashboard"] as const)
      expect(
        existsSync(join(context.unitDirectory, systemdUnitNames[service])),
      ).toBe(true);
  });
});

describe("service command availability", () => {
  test("an unsupported platform fails explicitly", async () => {
    const io = captureIo();
    const runtimeHome = temporaryDefinitionDirectory(
      directories,
      "ai-office-unsupported-",
    );
    mkdirSync(runtimeHome, { recursive: true });
    const code = await runRuntimeCli(["service", "status"], {
      projectRoot: runtimeHome,
      io: io.io,
      servicePlatform: "win32",
      serviceProgram: {
        launcher: ["/opt/bun/bin/bun", "/opt/ai-office/bin/ai-office.ts"],
        requiresSourceRuntimeOptIn: false,
      },
    });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain(
      "does not currently support Windows services",
    );
  });

  test("is unavailable without a resolved program launcher", async () => {
    const io = captureIo();
    const runtimeHome = temporaryDefinitionDirectory(
      directories,
      "ai-office-nolauncher-",
    );
    mkdirSync(runtimeHome, { recursive: true });
    const code = await runRuntimeCli(["service", "status"], {
      projectRoot: runtimeHome,
      io: io.io,
    });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain(
      "available only through the linkable ai-office entry point",
    );
  });
});
