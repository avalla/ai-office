import { afterEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import {
  isLocalVersionInvocation,
  productVersion,
} from "@ai-office/command-support/version.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("product version stays local in both launchers and the reusable client", async () => {
  const root = mkdtempSync(join(tmpdir(), "ao-version-"));
  roots.push(root);
  const runtimeHome = join(root, "personal");
  const preload = join(root, "forbid-runtime.ts");
  writeFileSync(
    preload,
    `
    import { mock } from "bun:test";
    const forbidden = () => { console.error("FORBIDDEN_RUNTIME_ACCESS"); process.exit(97); };
    mock.module(${JSON.stringify(resolve("packages/runtime-paths/src/runtime-paths.ts"))}, () => ({
      RuntimePathError: class RuntimePathError extends Error {},
      resolveRuntimePaths: forbidden,
      legacyCheckoutDatabasePath: forbidden,
      withRuntimePathOverrides: forbidden,
    }));
    mock.module("bun:sqlite", () => ({ Database: class Database { constructor() { forbidden(); } } }));
    globalThis.fetch = forbidden;
    Bun.connect = forbidden;
  `,
  );
  for (const flag of ["--version", "-V"]) {
    for (const entry of ["bin/ai-office.ts", "apps/cli/src/main.ts"]) {
      const child = Bun.spawn(
        [process.execPath, "--preload", preload, resolve(entry), flag],
        {
          cwd: root,
          env: {
            ...process.env,
            AI_OFFICE_HOME: runtimeHome,
            AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE: "",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await child.exited).toBe(0);
      expect(await new Response(child.stdout).text()).toBe(
        `${productVersion}\n`,
      );
      expect(await new Response(child.stderr).text()).toBe("");
      expect(existsSync(runtimeHome)).toBe(false);
    }
    const output: string[] = [];
    expect(
      await runRuntimeCli([flag], {
        io: {
          stdout: (line) => output.push(line),
          stderr: () => {
            throw new Error("Unexpected stderr");
          },
        },
        get runtimePaths(): never {
          throw new Error("Runtime paths accessed");
        },
        get runtimeClient(): never {
          throw new Error("Runtime client accessed");
        },
      }),
    ).toBe(0);
    expect(output).toEqual([productVersion]);
  }
});

test("product version flags do not swallow versioned role commands or extra arguments", () => {
  for (const args of [
    [],
    ["memory:role:create", "--version", "1"],
    ["memory:deprecate", "--type", "role", "--version", "2"],
    ["--version", "project:create", "Example"],
    ["-V", "unexpected"],
  ])
    expect(isLocalVersionInvocation(args)).toBe(false);
});
