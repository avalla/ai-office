import { describe, expect, test } from "vitest";
import {
  assertAbsoluteCallerLocalPaths,
  callerLocalPathSpecs,
  resolveCallerLocalPaths,
} from "@ai-office/runtime-host/caller-local-paths.ts";
import { CliUsageError } from "@ai-office/runtime-host/commands/shared.ts";

const caller = "/caller/repository";

describe("caller-local path resolution at the client boundary", () => {
  test.each([
    [
      ["install", "."],
      ["install", caller],
    ],
    [
      ["status", "sub"],
      ["status", `${caller}/sub`],
    ],
    [
      ["next", "--json"],
      ["next", caller, "--json"],
    ],
    [
      ["uninstall", "--approve", "hash"],
      ["uninstall", caller, "--approve", "hash"],
    ],
    [
      ["project:import", ".", "--name", "Demo"],
      ["project:import", caller, "--name", "Demo"],
    ],
    [
      ["project:import", "--json"],
      ["project:import", caller, "--json"],
    ],
    [
      ["project:backup", "--project", "p1", "--output", "out.aioffice"],
      [
        "project:backup",
        "--project",
        "p1",
        "--output",
        `${caller}/out.aioffice`,
      ],
    ],
    [
      ["project:restore", "snapshot.aioffice"],
      ["project:restore", `${caller}/snapshot.aioffice`, "--root", caller],
    ],
    [
      ["agent:sync", "--project", "p1"],
      ["agent:sync", "--project", "p1", "--directory", `${caller}/agents`],
    ],
    [
      ["agent:sync", "--project", "p1", "--directory", "defs"],
      ["agent:sync", "--project", "p1", "--directory", `${caller}/defs`],
    ],
    [
      ["client:inspect", "--client", "claude", "--root", "."],
      ["client:inspect", "--client", "claude", "--root", caller],
    ],
    [
      ["office:apply", "--project", "p1", "--file", "draft.json"],
      ["office:apply", "--project", "p1", "--file", `${caller}/draft.json`],
    ],
  ])("resolves %j against the client working directory", (args, expected) => {
    expect(resolveCallerLocalPaths(args, caller)).toEqual(expected);
  });

  test("leaves an already absolute caller path untouched", () => {
    expect(
      resolveCallerLocalPaths(["project:import", "/elsewhere/repo"], caller),
    ).toEqual(["project:import", "/elsewhere/repo"]);
  });

  test("does not rewrite arguments that merely look like paths", () => {
    const args = [
      "task:create",
      "--project",
      "p1",
      "--title",
      "fix ./src/main.ts",
      "--description",
      "a/b/c",
    ];

    expect(resolveCallerLocalPaths(args, caller)).toEqual(args);
  });

  test("keeps a contract path relative to the caller-resolved root", () => {
    // --contract is interpreted inside --root, which is already absolute after
    // client resolution, so it must not be rewritten against the working
    // directory as if it were a second caller-local path.
    expect(
      resolveCallerLocalPaths(
        [
          "client:plan",
          "--client",
          "claude",
          "--root",
          "repo",
          "--contract",
          "contract.json",
        ],
        caller,
      ),
    ).toEqual([
      "client:plan",
      "--client",
      "claude",
      "--root",
      `${caller}/repo`,
      "--contract",
      "contract.json",
    ]);
  });

  test("rejects a contained option that escapes the client working directory", () => {
    expect(() =>
      resolveCallerLocalPaths(
        ["office:apply", "--project", "p1", "--file", "../outside.json"],
        caller,
      ),
    ).toThrow(CliUsageError);
  });

  test("does not treat an option value as the path positional", () => {
    expect(
      resolveCallerLocalPaths(["uninstall", "--approve", "plan-hash"], caller),
    ).toEqual(["uninstall", caller, "--approve", "plan-hash"]);
  });
});

describe("caller-local path enforcement inside the Runtime", () => {
  test.each([
    [["project:import", "."], "project:import path"],
    [["status", "sub"], "status path"],
    [["project:restore", "snapshot.aioffice"], "project:restore path"],
    [
      ["project:backup", "--project", "p1", "--output", "out.aioffice"],
      "Option --output",
    ],
    [
      ["agent:sync", "--project", "p1", "--directory", "defs"],
      "Option --directory",
    ],
    [["client:apply", "--client", "claude", "--root", "repo"], "Option --root"],
    [["office:validate", "--file", "draft.json"], "Option --file"],
  ])("refuses the relative caller-local path in %j", (args, description) => {
    expect(() => assertAbsoluteCallerLocalPaths(args)).toThrow(CliUsageError);
    expect(() => assertAbsoluteCallerLocalPaths(args)).toThrow(description);
  });

  test.each([
    [["project:import", "/repo", "--json"]],
    [["status", "/repo", "--json"]],
    [["agent:sync", "--project", "p1", "--directory", "/repo/agents"]],
    [["office:apply", "--project", "p1", "--file", "/repo/office.json"]],
    [
      [
        "client:plan",
        "--client",
        "claude",
        "--root",
        "/repo",
        "--contract",
        "contract.json",
      ],
    ],
    [["task:create", "--project", "p1", "--title", "relative/looking"]],
    [["project:import"]],
  ])("accepts %j", (args) => {
    expect(() => assertAbsoluteCallerLocalPaths(args)).not.toThrow();
  });

  test("client resolution always satisfies the Runtime guard", () => {
    for (const command of Object.keys(callerLocalPathSpecs)) {
      const spec = callerLocalPathSpecs[command]!;
      const args = [command, ...(spec.pathPositional === true ? ["."] : [])];
      for (const option of spec.pathOptions) args.push(`--${option}`, "value");

      expect(() =>
        assertAbsoluteCallerLocalPaths(resolveCallerLocalPaths(args, caller)),
      ).not.toThrow();
    }
  });
});
