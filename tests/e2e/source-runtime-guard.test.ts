import { afterEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
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
