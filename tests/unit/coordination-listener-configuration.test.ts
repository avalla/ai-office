import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    ["unknown top field", { version: 1, enabled: true, projects: [], all: true }, "unknown field \"all\""],
    ["wrong version", { version: 2, enabled: true, projects: [] }, "version must be 1"],
    ["enabled not boolean", { version: 1, enabled: "yes", projects: [] }, "enabled must be"],
    ["projects not array", { version: 1, enabled: true, projects: "*" }, "projects must be an array"],
    ["entry not object", { version: 1, enabled: true, projects: ["p"] }, "projects[0] must be an object"],
    ["unknown entry field", { version: 1, enabled: true, projects: [{ projectId: "p", classes: ["P"], scope: "x" }] }, "unknown field projects[0].\"scope\""],
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
      { mode: 0o600 },
    );
    expect(loadCoordinationListenerConfiguration(directory).state).toBe(
      "enabled",
    );
  });

  test("a FIFO is refused without blocking Runtime start", () => {
    const directory = home();
    const path = join(directory, "coordination-listener.json");
    expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
    // A blocking open would wait forever for a writer; run it in a child so
    // a regression fails on the deadline instead of hanging the suite.
    const child = Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const { loadCoordinationListenerConfiguration } = await import(${JSON.stringify(
          new URL(
            "../../apps/daemon/src/coordination-listener-configuration-file.ts",
            import.meta.url,
          ).pathname,
        )}); console.log(JSON.stringify(loadCoordinationListenerConfiguration(${JSON.stringify(directory)})));`,
      ],
      { timeout: 10_000 },
    );
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString().trim())).toEqual({
      state: "misconfigured",
      reason: "the configuration is not a regular file",
    });
  });

  test("a file other users can write is misconfigured", () => {
    const directory = home();
    const path = join(directory, "coordination-listener.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        enabled: true,
        projects: [{ projectId: "p", classes: ["P"] }],
      }),
    );
    for (const mode of [0o620, 0o602]) {
      chmodSync(path, mode);
      expect(loadCoordinationListenerConfiguration(directory)).toEqual({
        state: "misconfigured",
        reason: "the configuration is writable by other users; use mode 0600",
      });
    }
    chmodSync(path, 0o600);
    expect(loadCoordinationListenerConfiguration(directory).state).toBe(
      "enabled",
    );
  });

  test("an unknown key is quoted and bounded in the reason", () => {
    const result = parseCoordinationListenerConfiguration(
      JSON.stringify({
        version: 1,
        enabled: true,
        projects: [],
        [`evil\n\u001b[31m${"k".repeat(200)}`]: 1,
      }),
    );
    expect(result.state).toBe("misconfigured");
    if (result.state !== "misconfigured") return;
    expect(result.reason).not.toContain("\n");
    expect(result.reason).not.toContain("\u001b");
    expect(result.reason.length).toBeLessThan(120);
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
      { mode: 0o600 },
    );
    expect(loadCoordinationListenerConfiguration(large)).toEqual({
      state: "misconfigured",
      reason: "the configuration is too large",
    });
  });
});
