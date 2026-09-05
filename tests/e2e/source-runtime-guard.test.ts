import { afterEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runRuntimeCli } from "../../apps/cli/src/daemon-cli.ts";
import { runtimeCommandHelp } from "@ai-office/command-support/help.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("all source help forms stay local before runtime paths, SQLite, or IPC", async () => {
  const root = mkdtempSync(join(tmpdir(), "ao-local-help-"));
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
  const invoke = async (args: string[], allow = "") => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        resolve("bin/ai-office.ts"),
        ...args,
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          AI_OFFICE_HOME: runtimeHome,
          AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE: allow,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      code: await child.exited,
      stdout: await new Response(child.stdout).text(),
      stderr: await new Response(child.stderr).text(),
    };
  };
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const result = await invoke(args);
    expect(result).toEqual({
      code: 0,
      stdout: `${runtimeCommandHelp}\n`,
      stderr: "",
    });
    expect(existsSync(runtimeHome)).toBe(false);
    const stdout: string[] = [];
    // Throwing getters prove the reusable CLI shares the same early boundary.
    expect(
      await runRuntimeCli(args, {
        io: {
          stdout: (message) => stdout.push(message),
          stderr: () => {
            throw new Error("Unexpected stderr");
          },
        },
        get runtimePaths(): never {
          throw new Error("Runtime paths accessed");
        },
        get runtimeClient(): never {
          throw new Error("IPC client accessed");
        },
      }),
    ).toBe(0);
    expect(stdout).toEqual([runtimeCommandHelp]);
  }
  const denied = await invoke(["project:create", "Forbidden"]);
  expect(denied.code).toBe(1);
  expect(denied.stderr).toContain("AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1");
  expect(denied.stderr).not.toContain("FORBIDDEN_RUNTIME_ACCESS");
  expect(existsSync(runtimeHome)).toBe(false);
  // Positive control: an opted-in operation reaches the instrumentation.
  expect((await invoke(["project:create", "Allowed"], "1")).code).toBe(97);
});

test("source bin requires deliberate user-runtime opt-in even with an explicit destination", async () => {
  const root = mkdtempSync(join(tmpdir(), "ao-source-guard-"));
  roots.push(root);
  const runtimeHome = join(root, "personal");
  const invoke = async (allow: string, args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, resolve("bin/ai-office.ts"), ...args],
      {
        cwd: root,
        env: {
          ...process.env,
          AI_OFFICE_HOME: runtimeHome,
          AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE: allow,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    return {
      exitCode: await child.exited,
      stderr: await new Response(child.stderr).text(),
      stdout: await new Response(child.stdout).text(),
    };
  };
  const refused = await invoke("", ["project:create", "Forbidden"]);
  expect(refused.exitCode).toBe(1);
  expect(refused.stderr).toContain(
    "AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1",
  );
  expect(existsSync(runtimeHome)).toBe(false);
  expect((await invoke("", ["--help"])).exitCode).toBe(0);
  const optedIn = await invoke("1", ["project:create", "No host"]);
  expect(optedIn.exitCode).toBe(1);
  expect(optedIn.stderr).not.toContain("requires AI_OFFICE_ALLOW");
  expect(existsSync(runtimeHome)).toBe(false);
});
