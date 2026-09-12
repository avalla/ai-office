import { describe, expect, test } from "vitest";
import {
  ManageOfficeServices,
  officeServicesHealthy,
} from "@ai-office/application/service-management/manage-office-services.ts";
import {
  classifyManagedDefinition,
  officeServiceOwnershipMarker,
  assertRenderableValue,
} from "@ai-office/application/service-management/managed-definition.ts";
import type {
  OfficeServiceInstallReport,
  OfficeServiceManager,
  OfficeServiceName,
  OfficeServiceState,
  OfficeServiceUninstallReport,
  OfficeServicesStatus,
} from "@ai-office/application/ports/office-service-manager.port.ts";
import {
  OfficeServicePreconditionError,
  UnsupportedServicePlatformError,
} from "@ai-office/application/ports/office-service-manager.port.ts";
import { selectOfficeServiceManager } from "@ai-office/service-management/select-service-manager.ts";
import { SystemdUserServiceManager } from "@ai-office/service-management/systemd-user-service-manager.ts";
import { LaunchdUserServiceManager } from "@ai-office/service-management/launchd-user-service-manager.ts";
import { validateOfficeServicePlan } from "@ai-office/service-management/service-plan.ts";
import { servicePlan } from "../helpers/service-management.ts";

function statusWith(
  states: Readonly<Record<OfficeServiceName, OfficeServiceState>>,
  overrides: Partial<OfficeServicesStatus> = {},
): OfficeServicesStatus {
  return {
    contractVersion: 1,
    platform: "systemd-user",
    serviceManagerAvailable: true,
    runtimeHome: "/home/operator/.ai-office",
    dashboardEndpoint: "http://127.0.0.1:4278",
    services: (["runtime", "dashboard"] as const).map((service) => ({
      service,
      definitionPath: `/units/${service}`,
      definition:
        states[service] === "not_installed" ? "missing" : "managed_current",
      installed: states[service] !== "not_installed",
      registered: states[service] !== "not_installed",
      enabled: states[service] !== "not_installed",
      state: states[service],
    })),
    issues: [],
    ...overrides,
  };
}

class StubServiceManager implements OfficeServiceManager {
  readonly platform = "systemd-user" as const;

  constructor(
    private readonly reports: {
      install?: OfficeServiceInstallReport;
      status?: OfficeServicesStatus;
      uninstall?: OfficeServiceUninstallReport;
    },
  ) {}

  async install(): Promise<OfficeServiceInstallReport> {
    if (this.reports.install === undefined) throw new Error("no install stub");
    return this.reports.install;
  }

  async status(): Promise<OfficeServicesStatus> {
    if (this.reports.status === undefined) throw new Error("no status stub");
    return this.reports.status;
  }

  async uninstall(): Promise<OfficeServiceUninstallReport> {
    if (this.reports.uninstall === undefined)
      throw new Error("no uninstall stub");
    return this.reports.uninstall;
  }
}

describe("managed definition ownership", () => {
  const desired = `# ${officeServiceOwnershipMarker}\n[Service]\n`;

  test("a missing path is missing", () => {
    expect(classifyManagedDefinition(null, desired)).toBe("missing");
  });

  test("an identical managed file is current", () => {
    expect(classifyManagedDefinition(desired, desired)).toBe("managed_current");
  });

  test("a marked file that differs is outdated", () => {
    expect(
      classifyManagedDefinition(`${desired}Restart=always\n`, desired),
    ).toBe("managed_outdated");
  });

  test("a file without the marker is an unmanaged collision", () => {
    expect(classifyManagedDefinition("[Service]\n", desired)).toBe(
      "unmanaged_collision",
    );
  });

  test("a value carrying a control character is refused before rendering", () => {
    expect(() => assertRenderableValue("/home/a\nb", "AI_OFFICE_HOME")).toThrow(
      /control character/u,
    );
    expect(assertRenderableValue("/home/a b", "AI_OFFICE_HOME")).toBe(
      "/home/a b",
    );
  });
});

describe("normalized service health", () => {
  test("both services running is healthy", () => {
    expect(
      officeServicesHealthy(
        statusWith({ runtime: "running", dashboard: "running" }),
      ),
    ).toBe(true);
  });

  test("partial health is never healthy", () => {
    for (const dashboard of [
      "installed_inactive",
      "failed",
      "unknown",
      "not_installed",
    ] as const)
      expect(
        officeServicesHealthy(statusWith({ runtime: "running", dashboard })),
      ).toBe(false);
  });

  test("an unreachable service manager is never healthy", () => {
    expect(
      officeServicesHealthy(
        statusWith(
          { runtime: "running", dashboard: "running" },
          { serviceManagerAvailable: false },
        ),
      ),
    ).toBe(false);
  });
});

describe("ManageOfficeServices", () => {
  test("normalizes a complete installation", async () => {
    const services = new ManageOfficeServices(
      new StubServiceManager({
        install: {
          definitions: [
            { service: "runtime", path: "/units/runtime", action: "created" },
            {
              service: "dashboard",
              path: "/units/dashboard",
              action: "created",
            },
          ],
          issues: [],
          hints: ["linger"],
          status: statusWith({ runtime: "running", dashboard: "running" }),
        },
      }),
    );
    const result = await services.install();
    expect(result).toMatchObject({
      contractVersion: 1,
      outcome: "installed",
      platform: "systemd-user",
      hints: ["linger"],
    });
    expect(result.definitions).toHaveLength(2);
  });

  test("refuses to call a partly started installation a success", async () => {
    const services = new ManageOfficeServices(
      new StubServiceManager({
        install: {
          definitions: [
            { service: "runtime", path: "/units/runtime", action: "created" },
            {
              service: "dashboard",
              path: "/units/dashboard",
              action: "created",
            },
          ],
          issues: [],
          hints: [],
          status: statusWith({ runtime: "running", dashboard: "failed" }),
        },
      }),
    );
    expect((await services.install()).outcome).toBe("partial");
  });

  test("an adapter cannot report success while raising an issue", async () => {
    const services = new ManageOfficeServices(
      new StubServiceManager({
        install: {
          definitions: [
            { service: "runtime", path: "/units/runtime", action: "unchanged" },
            {
              service: "dashboard",
              path: "/units/dashboard",
              action: "unchanged",
            },
          ],
          issues: ["daemon-reload failed"],
          hints: [],
          status: statusWith({ runtime: "running", dashboard: "running" }),
        },
      }),
    );
    expect((await services.install()).outcome).toBe("partial");
  });

  test("nothing written and nothing started is a failure", async () => {
    const services = new ManageOfficeServices(
      new StubServiceManager({
        install: {
          definitions: [],
          issues: ["systemctl --user daemon-reload failed"],
          hints: [],
          status: statusWith({
            runtime: "not_installed",
            dashboard: "not_installed",
          }),
        },
      }),
    );
    expect((await services.install()).outcome).toBe("failed");
  });

  test("normalizes a clean uninstall", async () => {
    const services = new ManageOfficeServices(
      new StubServiceManager({
        uninstall: {
          platform: "systemd-user",
          removed: [
            {
              service: "dashboard",
              path: "/units/dashboard",
              action: "removed",
            },
            { service: "runtime", path: "/units/runtime", action: "removed" },
          ],
          preserved: [],
          issues: [],
          preservedData: ["/home/operator/.ai-office"],
        },
      }),
    );
    const result = await services.uninstall();
    expect(result.outcome).toBe("uninstalled");
    expect(result.preservedData).toEqual(["/home/operator/.ai-office"]);
  });

  test("a preserved unmanaged definition makes uninstall partial", async () => {
    const services = new ManageOfficeServices(
      new StubServiceManager({
        uninstall: {
          platform: "systemd-user",
          removed: [],
          preserved: [
            {
              service: "runtime",
              path: "/units/runtime",
              reason: "the unit is not managed by AI Office",
            },
          ],
          issues: ["/units/runtime is not managed by AI Office"],
          preservedData: ["/home/operator/.ai-office"],
        },
      }),
    );
    expect((await services.uninstall()).outcome).toBe("partial");
  });

  test("a repeated uninstall with nothing to remove is still clean", async () => {
    const services = new ManageOfficeServices(
      new StubServiceManager({
        uninstall: {
          platform: "systemd-user",
          removed: [],
          preserved: [],
          issues: [],
          preservedData: ["/home/operator/.ai-office"],
        },
      }),
    );
    expect((await services.uninstall()).outcome).toBe("uninstalled");
  });
});

describe("platform selection", () => {
  test("linux selects the systemd user adapter", () => {
    const manager = selectOfficeServiceManager({
      plan: servicePlan(),
      platform: "linux",
      unitDirectory: "/tmp/units",
    });
    expect(manager).toBeInstanceOf(SystemdUserServiceManager);
    expect(manager.platform).toBe("systemd-user");
  });

  test("darwin selects the launchd user adapter", () => {
    const manager = selectOfficeServiceManager({
      plan: servicePlan(),
      platform: "darwin",
      agentDirectory: "/tmp/agents",
      userId: 501,
    });
    expect(manager).toBeInstanceOf(LaunchdUserServiceManager);
    expect(manager.platform).toBe("launchd-user");
  });

  test("windows fails explicitly and says so", () => {
    expect(() =>
      selectOfficeServiceManager({ plan: servicePlan(), platform: "win32" }),
    ).toThrow(UnsupportedServicePlatformError);
    expect(() =>
      selectOfficeServiceManager({ plan: servicePlan(), platform: "win32" }),
    ).toThrow(/Windows services/u);
  });

  test("any other platform fails with an actionable error", () => {
    expect(() =>
      selectOfficeServiceManager({ plan: servicePlan(), platform: "freebsd" }),
    ).toThrow(/freebsd is not supported/u);
  });
});

describe("service plan validation", () => {
  test("requires an absolute executable", () => {
    expect(() =>
      validateOfficeServicePlan(
        servicePlan({
          program: {
            launcher: ["bun", "/opt/ai-office/bin/ai-office.ts"],
            runtimeHome: "/home/operator/.ai-office",
            requiresSourceRuntimeOptIn: false,
          },
        }),
      ),
    ).toThrow(OfficeServicePreconditionError);
  });

  test("requires an absolute AI_OFFICE_HOME", () => {
    expect(() =>
      validateOfficeServicePlan(
        servicePlan({
          program: {
            launcher: ["/opt/bun/bin/bun"],
            runtimeHome: ".ai-office",
            requiresSourceRuntimeOptIn: false,
          },
        }),
      ),
    ).toThrow(/absolute AI_OFFICE_HOME/u);
  });

  test("refuses a non-loopback dashboard address", () => {
    expect(() =>
      validateOfficeServicePlan(
        servicePlan({
          dashboard: { host: "0.0.0.0", port: 4278, awaitRuntimeSeconds: 60 },
        }),
      ),
    ).toThrow(/loopback/u);
  });
});
