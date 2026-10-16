/**
 * The read-only coordination listener and `coordination:read`, end to end
 * through the Runtime host (CB-10, ADR-0036 Decision 5): disabled by default,
 * GET-only coordination routes on a second Unix socket, no command or
 * dashboard route there, no audit row on a read, and the same data through
 * every adapter.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqlitePlanningReadRepository } from "@ai-office/storage-sqlite/repositories/sqlite-planning-read.repository.ts";
import { GetPlanningSnapshot } from "@ai-office/application/coordination/get-planning-snapshot.ts";
import {
  CoordinationReadService,
  coordinationReadOperations,
} from "@ai-office/application/coordination/coordination-read-service.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

interface Invocation {
  code: number;
  stdout: string[];
  stderr: string[];
}

interface Runtime {
  mainSocket: string;
  coordinationSocket: string;
  invoke(args: string[]): Promise<Invocation>;
  run(args: string[]): Promise<string[]>;
}

interface Home {
  projectRoot: string;
  mainSocket: string;
  coordinationSocket: string;
  databasePath: string;
  configurationPath: string;
}

function home(): Home {
  const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-coord-"));
  temporaryDirectories.push(projectRoot);
  writeFileSync(join(projectRoot, "README.md"), "# Coordination");
  mkdirSync(join(projectRoot, ".ai-office"), { recursive: true, mode: 0o700 });
  const socket = createTestUnixSocket();
  temporaryDirectories.push(socket.root);
  return {
    projectRoot,
    mainSocket: socket.socketPath,
    coordinationSocket: join(socket.root, "c.sock"),
    databasePath: join(projectRoot, ".ai-office", "project.sqlite"),
    configurationPath: join(
      projectRoot,
      ".ai-office",
      "coordination-listener.json",
    ),
  };
}

async function waitForDaemon(socketPath: string): Promise<void> {
  const client = new DaemonClient(socketPath);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error("Daemon did not become healthy");
}

async function withRuntime(
  where: Home,
  scenario: (runtime: Runtime) => Promise<void>,
): Promise<void> {
  const daemon = await bootstrap({
    projectRoot: where.projectRoot,
    socketPath: where.mainSocket,
    coordinationSocketPath: where.coordinationSocket,
  });
  const controller = new AbortController();
  const running = daemon.start(controller.signal);

  async function invoke(args: string[]): Promise<Invocation> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      prompt: async () => "",
    };
    const code = await runDaemonCli(args, {
      projectRoot: where.projectRoot,
      socketPath: where.mainSocket,
      io,
    });
    return { code, stdout, stderr };
  }
  async function run(args: string[]): Promise<string[]> {
    const result = await invoke(args);
    expect({ args, code: result.code, stderr: result.stderr }).toMatchObject({
      args,
      code: 0,
    });
    return result.stdout;
  }
  try {
    await waitForDaemon(where.mainSocket);
    await scenario({
      mainSocket: where.mainSocket,
      coordinationSocket: where.coordinationSocket,
      invoke,
      run,
    });
  } finally {
    controller.abort();
    await running;
  }
}

async function request(
  socketPath: string,
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<{ status: number; text: string; body: Record<string, unknown> }> {
  const response = await fetch(`http://localhost${path}`, {
    ...init,
    unix: socketPath,
  } as RequestInit);
  const text = await response.text();
  return {
    status: response.status,
    text,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

function scalar(databasePath: string, sql: string): number {
  const database = openDatabase(databasePath);
  try {
    return database.query<{ n: number }, []>(sql).get()!.n;
  } finally {
    database.close();
  }
}

const created = (line: string | undefined, prefix: string): string =>
  (line ?? "").replace(prefix, "");

const token = `ghp_${"z".repeat(36)}`;

async function seed(run: Runtime["run"]) {
  const projectId = created(
    (await run(["project:create", "Coordination"]))[0],
    "Project created: ",
  );
  const otherId = created(
    (await run(["project:create", "Other"]))[0],
    "Project created: ",
  );
  const milestoneId = created(
    (
      await run([
        "milestone:create",
        "--project",
        projectId,
        "--title",
        "M1",
        "--description",
        "SECRET-MILESTONE",
      ])
    )[0],
    "Milestone created: ",
  );
  const requirementId = created(
    (
      await run([
        "requirement:create",
        "--project",
        projectId,
        "--key",
        "R-1",
        "--title",
        "Req",
        "--description",
        "SECRET-REQUIREMENT",
        "--milestone",
        milestoneId,
      ])
    )[0],
    "Requirement created: ",
  );
  const taskIds: string[] = [];
  for (const [title, priority] of [
    ["First", "3"],
    [`Second ${token}`, "2"],
    ["L".repeat(300), "1"],
  ] as const)
    taskIds.push(
      created(
        (
          await run([
            "task:create",
            "--project",
            projectId,
            "--title",
            title,
            "--description",
            "SECRET-TASK",
            "--priority",
            priority,
          ])
        )[0],
        "Task created: ",
      ),
    );
  const [first, second] = taskIds as [string, string, string];
  await run([
    "task:link-requirement",
    "--project",
    projectId,
    "--task",
    first,
    "--requirement",
    requirementId,
  ]);
  await run([
    "task:dependency:add",
    "--project",
    projectId,
    "--task",
    second,
    "--depends-on",
    first,
  ]);
  return { projectId, otherId, milestoneId, taskIds };
}

function enable(where: Home, projects: { projectId: string; classes: string[] }[]) {
  writeFileSync(
    where.configurationPath,
    JSON.stringify({ version: 1, enabled: true, projects }),
  );
}

describe("coordination listener", () => {
  test("is disabled by default and when misconfigured, with the Runtime up", async () => {
    const where = home();
    await withRuntime(where, async ({ run }) => {
      await run(["project:create", "Disabled"]);
      expect(existsSync(where.coordinationSocket)).toBe(false);
    });
    writeFileSync(
      where.configurationPath,
      JSON.stringify({ version: 1, enabled: true, projects: "all" }),
    );
    await withRuntime(where, async ({ run }) => {
      await run(["project:create", "Misconfigured"]);
      expect(existsSync(where.coordinationSocket)).toBe(false);
    });
  });

  test("serves the coordination profile only, read-only, with CLI parity", async () => {
    const where = home();
    let seeded!: Awaited<ReturnType<typeof seed>>;
    await withRuntime(where, async ({ run }) => {
      seeded = await seed(run);
    });
    const { projectId, otherId, milestoneId } = seeded;
    enable(where, [{ projectId, classes: ["P", "T"] }]);

    await withRuntime(where, async ({ mainSocket, coordinationSocket, run, invoke }) => {
      expect(statSync(coordinationSocket).isSocket()).toBe(true);
      expect(statSync(coordinationSocket).mode & 0o777).toBe(0o600);

      const health = await request(
        coordinationSocket,
        "/api/coordination/v1/health",
      );
      expect(health.status).toBe(200);
      expect(Object.keys(health.body).sort()).toEqual([
        "coordinationApiVersion",
        "startedAt",
        "status",
      ]);
      expect(health.body).toMatchObject({
        coordinationApiVersion: 1,
        status: "ok",
      });

      const auditBefore = scalar(
        where.databasePath,
        "SELECT count(*) AS n FROM audit_event",
      );
      const service = new CoordinationReadService(
        new GetPlanningSnapshot(
          new SqlitePlanningReadRepository(openDatabase(where.databasePath)),
        ),
      );
      const listenerBodies: string[] = [];
      for (const operation of coordinationReadOperations) {
        for (const query of [
          {},
          { milestone: milestoneId },
          ...(operation === "status" ? [] : [{ limit: "1", offset: "1" }]),
          { classes: "P" },
        ] as Record<string, string>[]) {
          const search = new URLSearchParams(query).toString();
          const listener = await request(
            coordinationSocket,
            `/api/coordination/v1/projects/${projectId}/${operation}${search === "" ? "" : `?${search}`}`,
          );
          expect({ operation, query, status: listener.status }).toEqual({
            operation,
            query,
            status: 200,
          });
          const cli = await run([
            "coordination:read",
            "--project",
            projectId,
            "--operation",
            operation,
            ...Object.entries(query).flatMap(([name, value]) => [
              `--${name}`,
              value,
            ]),
          ]);
          const direct = await service.execute({
            projectId,
            operation,
            milestoneId: query.milestone ?? null,
            ...(query.limit === undefined ? {} : { limit: Number(query.limit) }),
            ...(query.offset === undefined
              ? {}
              : { offset: Number(query.offset) }),
            ...(query.classes === undefined
              ? {}
              : { classes: query.classes.split(",") }),
          });
          // Byte-identical across the listener, the CLI and the service.
          expect(cli).toEqual([listener.text]);
          expect(listener.text).toBe(JSON.stringify(direct));
          listenerBodies.push(listener.text);
        }
      }
      const everything = listenerBodies.join("\n");
      expect(everything).not.toContain("SECRET");
      expect(everything).not.toContain(token);
      expect(everything).toContain(`Second [redacted]`);
      expect(everything).toContain(`"truncatedFields":["title"]`);

      // Nothing a command or the dashboard uses is reachable here.
      const projectsBefore = scalar(
        where.databasePath,
        "SELECT count(*) AS n FROM project",
      );
      const command = JSON.stringify({
        protocolVersion: 1,
        requestId: "r1",
        args: ["project:create", "Injected"],
        cwd: where.projectRoot,
      });
      for (const path of [
        "/commands",
        "/api/coordination/v1/commands",
        `/api/coordination/v1/projects/${projectId}/tasks`,
      ])
        for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
          const refused = await request(coordinationSocket, path, {
            method,
            body: command,
          });
          expect({ path, method, status: refused.status }).toEqual({
            path,
            method,
            status: 405,
          });
        }
      for (const path of [
        "/commands",
        "/health",
        "/api",
        "/api/status",
        "/api/projects",
        `/api/projects/${projectId}`,
        `/api/projects/${projectId}/tasks`,
        "/api/events",
        "/api/memory",
        "/api/activity",
        "/api/runs/x",
        "/api/coordination/v1/",
        `/api/coordination/v1/projects/${projectId}/active`,
        `/api/coordination/v1/projects/${projectId}/decisions`,
        "/anything",
      ]) {
        const refused = await request(coordinationSocket, path);
        expect({ path, status: refused.status, code: (refused.body.error as { code: string }).code }).toEqual({
          path,
          status: 404,
          code: "NOT_FOUND",
        });
      }
      expect(
        scalar(where.databasePath, "SELECT count(*) AS n FROM project"),
      ).toBe(projectsBefore);

      // A project that exists but is not enabled answers like a missing one.
      for (const id of [otherId, "missing"]) {
        const hidden = await request(
          coordinationSocket,
          `/api/coordination/v1/projects/${id}/tasks`,
        );
        expect(hidden.status).toBe(404);
        expect(hidden.body.error).toEqual({
          code: "NOT_FOUND",
          message: "Project not found",
        });
      }
      for (const [search, status, code] of [
        ["?limit=201", 400, "INVALID_REQUEST"],
        ["?limit=1&limit=2", 400, "INVALID_REQUEST"],
        ["?unknown=1", 400, "INVALID_REQUEST"],
        ["?classes=P,D", 400, "INVALID_REQUEST"],
        ["?milestone=missing", 404, "NOT_FOUND"],
        [`?milestone=${"m".repeat(128)}&x=${"y".repeat(4096)}`, 414, "PAYLOAD_TOO_LARGE"],
      ] as const) {
        const refused = await request(
          coordinationSocket,
          `/api/coordination/v1/projects/${projectId}/tasks${search}`,
        );
        expect({ search, status: refused.status, code: (refused.body.error as { code: string }).code }).toEqual({
          search,
          status,
          code,
        });
      }

      // Listener reads append no audit row; the CLI reads above recorded only
      // the host's per-command envelope.
      const events = (() => {
        const database = openDatabase(where.databasePath);
        try {
          return database
            .query<{ event_type: string; payload_json: string }, [number]>(
              "SELECT event_type, payload_json FROM audit_event WHERE rowid > ? ORDER BY rowid",
            )
            .all(auditBefore)
            .map(
              (row) =>
                `${row.event_type} ${(JSON.parse(row.payload_json) as { command?: string }).command ?? ""}`,
            );
        } finally {
          database.close();
        }
      })();
      expect(new Set(events)).toEqual(
        new Set([
          "command.received coordination:read",
          "command.completed coordination:read",
        ]),
      );

      // The coordination routes are not mounted on the main socket.
      const main = await request(
        mainSocket,
        `/api/coordination/v1/projects/${projectId}/tasks`,
      );
      expect(main.status).toBe(404);

      const refusedCli = await invoke([
        "coordination:read",
        "--project",
        projectId,
        "--operation",
        "runs",
      ]);
      expect(refusedCli.code).not.toBe(0);
      expect(refusedCli.stderr.join("\n")).toContain(
        "Coordination operation must be one of",
      );
    });
    expect(existsSync(where.coordinationSocket)).toBe(false);
  });

  test("serves only the classes the owner enabled for a project", async () => {
    const where = home();
    let projectId = "";
    await withRuntime(where, async ({ run }) => {
      projectId = (await seed(run)).projectId;
    });
    enable(where, [{ projectId, classes: ["P"] }]);
    await withRuntime(where, async ({ coordinationSocket }) => {
      const page = await request(
        coordinationSocket,
        `/api/coordination/v1/projects/${projectId}/tasks`,
      );
      expect(page.status).toBe(200);
      expect(page.body.classes).toEqual(["P"]);
      expect(page.text).not.toContain('"title"');
      const refused = await request(
        coordinationSocket,
        `/api/coordination/v1/projects/${projectId}/tasks?classes=P,T`,
      );
      expect(refused.status).toBe(400);
      expect(refused.body.error).toEqual({
        code: "INVALID_REQUEST",
        message: "The requested data classes are not enabled for this project",
      });
    });
  });

  test("replaces a stale socket but never another file at the socket path", async () => {
    const where = home();
    let projectId = "";
    await withRuntime(where, async ({ run }) => {
      projectId = (await seed(run)).projectId;
    });
    enable(where, [{ projectId, classes: ["P"] }]);

    writeFileSync(where.coordinationSocket, "not a socket");
    await withRuntime(where, async ({ run }) => {
      await run(["task:list", "--project", projectId]);
      expect(readFileSync(where.coordinationSocket, "utf8")).toBe(
        "not a socket",
      );
    });
    rmSync(where.coordinationSocket);

    // A socket left by a crashed host is stale and replaced. A clean stop
    // would unlink it, so the holder is killed instead.
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `Bun.serve({ unix: ${JSON.stringify(where.coordinationSocket)}, fetch: () => new Response("") }); console.log("ready"); setInterval(() => {}, 1000);`,
      ],
      { stdout: "pipe" },
    );
    const reader = holder.stdout.getReader();
    await reader.read();
    holder.kill("SIGKILL");
    await holder.exited;
    expect(statSync(where.coordinationSocket).isSocket()).toBe(true);
    await withRuntime(where, async ({ coordinationSocket }) => {
      const health = await request(
        coordinationSocket,
        "/api/coordination/v1/health",
      );
      expect(health.status).toBe(200);
    });
  });
});
