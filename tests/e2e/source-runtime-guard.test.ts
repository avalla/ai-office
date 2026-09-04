import { afterEach, expect, test } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("development entry points share isolated project and global state from a descendant worktree layout", async () => {
  const root = mkdtempSync(join(tmpdir(), "ao-l-"));
  roots.push(root);
  const source = join(root, "d"),
    personal = join(root, "personal"),
    descendant = join(source, "nested");
  mkdirSync(descendant, { recursive: true });
  mkdirSync(personal);
  writeFileSync(join(personal, "global.sqlite"), "personal sentinel");
  writeFileSync(
    join(source, ".git"),
    "gitdir: /nonexistent/worktree-metadata\n",
  );
  cpSync(resolve("apps"), join(source, "apps"), { recursive: true });
  cpSync(resolve("migrations"), join(source, "migrations"), {
    recursive: true,
  });
  for (const directory of ["node_modules", "packages", ".agents"])
    symlinkSync(resolve(directory), join(source, directory), "dir");
  cpSync(resolve("tsconfig.json"), join(source, "tsconfig.json"));
  const env = {
    ...process.env,
    AI_OFFICE_HOME: personal,
    AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE: "",
  };
  const child = Bun.spawn(
    [process.execPath, join(source, "apps/daemon/src/main.ts")],
    {
      cwd: descendant,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    const client = new DaemonClient(join(source, ".ai-office", "daemon.sock"));
    let healthy = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        await client.health();
        healthy = true;
        break;
      } catch {
        await Bun.sleep(5);
      }
    }
    expect(healthy).toBe(true);
    for (const args of [
      ["project:create", "Isolated"],
      ["memory:search", "--query", "empty", "--json"],
    ]) {
      const cli = Bun.spawn(
        [process.execPath, join(source, "apps/cli/src/main.ts"), ...args],
        {
          cwd: descendant,
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(await cli.exited).toBe(0);
      expect(await new Response(cli.stderr).text()).toContain(
        join(source, ".ai-office"),
      );
      const stdout = await new Response(cli.stdout).text();
      if (args[0] === "memory:search")
        expect(JSON.parse(stdout)).toEqual({ results: [] });
    }
    expect(existsSync(join(source, ".ai-office", "project.sqlite"))).toBe(true);
    expect(existsSync(join(source, ".ai-office", "global.sqlite"))).toBe(true);
    expect(existsSync(join(descendant, ".ai-office"))).toBe(false);
    expect(existsSync(join(personal, "project.sqlite"))).toBe(false);
    expect(readFileSync(join(personal, "global.sqlite"), "utf8")).toBe(
      "personal sentinel",
    );
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
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
