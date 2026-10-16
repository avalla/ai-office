import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseCoordinationListenerConfiguration } from "@ai-office/application/coordination/coordination-listener-configuration.ts";
import { loadCoordinationListenerConfiguration } from "../../apps/daemon/src/coordination-listener-configuration-file.ts";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const parse = (value: unknown) =>
  parseCoordinationListenerConfiguration(JSON.stringify(value));

describe("coordination listener configuration", () => {
  test("no file is disabled", () => {
    expect(parseCoordinationListenerConfiguration(undefined)).toEqual({
      state: "disabled",
    });
  });

  test("an enabled file lists projects with sorted classes", () => {
    const result = parse({
      version: 1,
      enabled: true,
      projects: [
        { projectId: "p1", classes: ["T", "P"] },
        { projectId: "p2", classes: ["P"] },
      ],
    });
    expect(result.state).toBe("enabled");
    if (result.state !== "enabled") return;
    expect([...result.projects]).toEqual([
      ["p1", ["P", "T"]],
      ["p2", ["P"]],
    ]);
  });

  test("enabled false is disabled even with projects", () => {
    expect(
      parse({
        version: 1,
        enabled: false,
        projects: [{ projectId: "p1", classes: ["P"] }],
      }),
    ).toEqual({ state: "disabled" });
  });

  test.each([
    ["not json", "{", "not valid JSON"],
    ["not an object", [], "one object"],
    ["unknown top field", { version: 1, enabled: true, projects: [], all: true }, "unknown field all"],
    ["wrong version", { version: 2, enabled: true, projects: [] }, "version must be 1"],
    ["enabled not boolean", { version: 1, enabled: "yes", projects: [] }, "enabled must be"],
    ["projects not array", { version: 1, enabled: true, projects: "*" }, "projects must be an array"],
    ["entry not object", { version: 1, enabled: true, projects: ["p"] }, "projects[0] must be an object"],
    ["unknown entry field", { version: 1, enabled: true, projects: [{ projectId: "p", classes: ["P"], scope: "x" }] }, "unknown field projects[0].scope"],
    ["bad project id", { version: 1, enabled: true, projects: [{ projectId: "a/b", classes: ["P"] }] }, "projectId must be"],
    ["duplicate project", { version: 1, enabled: true, projects: [{ projectId: "p", classes: ["P"] }, { projectId: "p", classes: ["P"] }] }, "listed twice"],
    ["class D", { version: 1, enabled: true, projects: [{ projectId: "p", classes: ["P", "D"] }] }, "classes must be"],
    ["T without P", { version: 1, enabled: true, projects: [{ projectId: "p", classes: ["T"] }] }, "classes must be"],
    ["repeated class", { version: 1, enabled: true, projects: [{ projectId: "p", classes: ["P", "P"] }] }, "classes must be"],
    ["enabled without projects", { version: 1, enabled: true, projects: [] }, "at least one project"],
  ])("%s is misconfigured", (_name, value, reason) => {
    const result =
      typeof value === "string"
        ? parseCoordinationListenerConfiguration(value)
        : parse(value);
    expect(result.state).toBe("misconfigured");
    if (result.state === "misconfigured") expect(result.reason).toContain(reason);
  });

  test("an invalid later entry discards the whole file", () => {
    expect(
      parse({
        version: 1,
        enabled: true,
        projects: [
          { projectId: "p1", classes: ["P", "T"] },
          { projectId: "p2", classes: ["A"] },
        ],
      }).state,
    ).toBe("misconfigured");
  });
});

describe("coordination listener configuration file", () => {
  function home(): string {
    const directory = mkdtempSync(join(tmpdir(), "ai-office-coord-config-"));
    directories.push(directory);
    return directory;
  }

  test("a missing file is disabled", () => {
    expect(loadCoordinationListenerConfiguration(home())).toEqual({
      state: "disabled",
    });
  });

  test("a regular file is parsed", () => {
    const directory = home();
    writeFileSync(
      join(directory, "coordination-listener.json"),
      JSON.stringify({
        version: 1,
        enabled: true,
        projects: [{ projectId: "p", classes: ["P"] }],
      }),
    );
    expect(loadCoordinationListenerConfiguration(directory).state).toBe(
      "enabled",
    );
  });

  test("a symbolic link, a directory or an oversized file is misconfigured", () => {
    const linked = home();
    const target = join(linked, "elsewhere.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(linked, "coordination-listener.json"));
    expect(loadCoordinationListenerConfiguration(linked).state).toBe(
      "misconfigured",
    );

    const directory = home();
    mkdirSync(join(directory, "coordination-listener.json"));
    expect(loadCoordinationListenerConfiguration(directory).state).toBe(
      "misconfigured",
    );

    const large = home();
    writeFileSync(
      join(large, "coordination-listener.json"),
      " ".repeat(64 * 1024 + 1),
    );
    expect(loadCoordinationListenerConfiguration(large)).toEqual({
      state: "misconfigured",
      reason: "the configuration is too large",
    });
  });
});
