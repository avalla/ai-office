import { afterEach, expect, test } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createSocketServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  probeDistributionRuntime,
  DistributionRuntimePreflightError,
} from "../../apps/cli/src/local-distribution-runtime-preflight.ts";
import { RuntimeUnavailableError } from "../../apps/cli/src/daemon-client.ts";

const roots: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ao-up-")));
  roots.push(root);
  const distribution = join(root, "d");
  const user = join(root, "u");
  const development = join(distribution, ".ai-office");
  const cwd = join(root, "project");
  for (const path of [distribution, user, development, cwd])
    mkdirSync(path, { recursive: true });
  for (const path of ["bin", "apps"])
    cpSync(resolve(path), join(distribution, path), { recursive: true });
  for (const path of ["packages", "node_modules"])
    symlinkSync(resolve(path), join(distribution, path), "dir");
  cpSync(resolve("tsconfig.json"), join(distribution, "tsconfig.json"));
  for (const home of [user, development])
    for (const name of ["project.sqlite", "global.sqlite"])
      writeFileSync(join(home, name), `sentinel ${name}`);
  const preload = join(root, "guard.ts");
  writeFileSync(
    preload,
    `
    import { mock } from "bun:test";
    const forbidden = () => { console.error("FORBIDDEN_AUTHORITY_OR_GIT"); process.exit(97); };
    mock.module("bun:sqlite", () => ({ Database: class { constructor() { forbidden(); } } }));
    mock.module(${JSON.stringify(join(distribution, "apps/cli/src/local-distribution-update-adapter.ts"))}, () => ({
      LocalDistributionUpdateError: class extends Error {},
      LocalDistributionUpdateAdapter: class {
        async plan(root) {
          console.error("PLANNED:" + root);
          return {contractVersion:1, distributionRoot:root, packageName:"ai-office", branch:"main", remote:"origin", remoteIdentity:"sha256:"+"1".repeat(64), upstreamRef:"refs/heads/main", trackingRef:"refs/remotes/origin/main", currentRevision:"a".repeat(40), targetRevision:"b".repeat(40), steps:["fetch","fast_forward","install_dependencies","register_link"]};
        }
        async apply(draft) {
          return {contractVersion:1, status:"updated", distributionRoot:draft.distributionRoot, fromRevision:draft.currentRevision, toRevision:draft.targetRevision, completedSteps:draft.steps, message:"updated"};
        }
      }
    }));
    const { IpcRuntimeClient } = await import(${JSON.stringify(join(distribution, "apps/cli/src/daemon-client.ts"))});
    IpcRuntimeClient.prototype.execute = forbidden;
    IpcRuntimeClient.prototype.health = forbidden;
    Bun.spawn = forbidden;
    Bun.spawnSync = forbidden;
  `,
  );
  const invoke = async (
    args: string[],
    allow = "",
    entry = "bin/ai-office.ts",
    home = user,
  ) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        preload,
        join(distribution, entry),
        ...args,
      ],
      {
        cwd,
        env: {
          ...process.env,
          HOME: root,
          AI_OFFICE_HOME: home,
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
  return { root, distribution, user, development, invoke };
}

async function host(home: string, status = 200) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(status).end("host present");
  });
  servers.push(server);
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(join(home, "daemon.sock"), done);
  });
  return requests;
}

for (const mode of ["user", "development"] as const) {
  test(`active ${mode} Runtime blocks plan and apply before planning without operational opt-in`, async () => {
    const f = fixture();
    const requests = await host(f[mode]);
    for (const args of [
      ["update", "--json"],
      ["update", "--approve", "old", "--json"],
    ]) {
      const result = await f.invoke(args);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "failed",
        error: { code: "runtime_running" },
      });
      expect(result.stderr).toBe("");
    }
    expect(requests).toEqual(["GET /health", "GET /health"]);
  });
}

test("both stopped allow planning and apply from executable root with no SQLite or operational Runtime access", async () => {
  const f = fixture();
  const planned = await f.invoke(["update", "--json"]);
  expect(planned.code).toBe(0);
  const plan = JSON.parse(planned.stdout) as {
    planHash: string;
    distributionRoot: string;
  };
  expect(plan.distributionRoot).toBe(f.distribution);
  expect(planned.stderr).toBe(`PLANNED:${f.distribution}\n`);
  const applied = await f.invoke([
    "update",
    "--approve",
    plan.planHash,
    "--json",
  ]);
  expect(applied.code).toBe(0);
  expect(JSON.parse(applied.stdout)).toMatchObject({
    status: "updated",
    distributionRoot: f.distribution,
  });
  for (const home of [f.user, f.development])
    for (const name of ["project.sqlite", "global.sqlite"])
      expect(readFileSync(join(home, name), "utf8")).toBe(`sentinel ${name}`);
  // Maintenance never enables the next process to issue Runtime commands.
  const denied = await f.invoke(["project:create", "Forbidden"]);
  expect(denied.code).toBe(1);
  expect(denied.stderr).toContain("AI_OFFICE_ALLOW_USER_RUNTIME_FROM_SOURCE=1");
  const optedIn = await f.invoke(["project:create", "Allowed"], "1");
  expect(optedIn.code).toBe(97); // positive control: execute instrumentation works
});

test("a host started after planning blocks approval before replanning", async () => {
  const f = fixture();
  const plan = JSON.parse((await f.invoke(["update", "--json"])).stdout) as {
    planHash: string;
  };
  await host(f.development);
  const result = await f.invoke([
    "update",
    "--approve",
    plan.planHash,
    "--json",
  ]);
  expect(JSON.parse(result.stdout)).toMatchObject({
    error: { code: "runtime_running" },
  });
  expect(result.stderr).toBe("");
});

test("incompatible or unhealthy HTTP listeners are present, never reported stopped", async () => {
  const f = fixture();
  await host(f.user, 503);
  expect(
    JSON.parse((await f.invoke(["update", "--json"])).stdout),
  ).toMatchObject({ error: { code: "runtime_running" } });
});

test("missing socket is absent but a nonresponding listener fails closed", async () => {
  const f = fixture();
  const path = join(f.user, "daemon.sock");
  await expect(probeDistributionRuntime(path)).rejects.toBeInstanceOf(
    RuntimeUnavailableError,
  );
  const connections = new Set<import("node:net").Socket>();
  const server = createSocketServer((socket) => {
    connections.add(socket);
    socket.on("close", () => connections.delete(socket));
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(path, done);
  });
  try {
    await expect(probeDistributionRuntime(path)).rejects.toBeInstanceOf(
      DistributionRuntimePreflightError,
    );
  } finally {
    for (const socket of connections) socket.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test("all help aliases on source and development launchers avoid planning and invalid runtime resolution", async () => {
  const f = fixture();
  for (const entry of ["bin/ai-office.ts", "apps/cli/src/main.ts"]) {
    for (const arg of ["--help", "help", "-h"]) {
      const result = await f.invoke(
        [arg],
        "",
        entry,
        "relative-invalid-runtime",
      );
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(
        "update [--approve <plan-hash>] [--json]",
      );
      expect(result.stderr).toBe("");
    }
  }
  expect(existsSync(join(f.root, "project", "relative-invalid-runtime"))).toBe(
    false,
  );
});
