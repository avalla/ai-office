/**
 * `task:update` description and priority edits, end to end through the CLI
 * client, the Unix-socket protocol and the Runtime host.
 */

import { afterEach, describe, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
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

interface WorkspaceTask {
  taskId: string;
  priority: number;
  description: string | null;
}

/**
 * The host exposes no readiness signal to an in-process caller, so this polls
 * the socket's health endpoint like the other daemon e2e suites; the short
 * sleep only paces retries and never decides an assertion.
 */
async function waitForDaemon(socketPath: string): Promise<void> {
  const client = new DaemonClient(socketPath);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await client.health();
      return;
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error("Daemon did not become healthy");
}

/** Starts an isolated Runtime host and runs `scenario` against its socket. */
async function withRuntime(
  scenario: (runtime: {
    projectRoot: string;
    invoke(args: string[]): Promise<Invocation>;
    run(args: string[]): Promise<string[]>;
  }) => Promise<void>,
): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-task-update-"));
  temporaryDirectories.push(projectRoot);
  writeFileSync(join(projectRoot, "README.md"), "# Board");
  const socket = createTestUnixSocket();
  temporaryDirectories.push(socket.root);
  const daemon = await bootstrap({
    projectRoot,
    socketPath: socket.socketPath,
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
      projectRoot,
      socketPath: socket.socketPath,
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
    await waitForDaemon(socket.socketPath);
    await scenario({ projectRoot, invoke, run });
  } finally {
    controller.abort();
    await running;
  }
}

function projectDatabase(projectRoot: string) {
  const path = join(projectRoot, ".ai-office", "project.sqlite");
  expect(existsSync(path)).toBe(true);
  return openDatabase(path);
}

/** Task-scoped audit events in insertion order. */
function taskAudit(
  projectRoot: string,
): { aggregate_id: string; event_type: string; payload_json: string }[] {
  const database = projectDatabase(projectRoot);
  try {
    return database
      .query<
        { aggregate_id: string; event_type: string; payload_json: string },
        []
      >(
        "SELECT aggregate_id, event_type, payload_json FROM audit_event WHERE aggregate_type = 'task' ORDER BY rowid",
      )
      .all();
  } finally {
    database.close();
  }
}

function storedTask(
  projectRoot: string,
  taskId: string,
): { description: string | null; priority: number; status: string } | null {
  const database = projectDatabase(projectRoot);
  try {
    return database
      .query<
        { description: string | null; priority: number; status: string },
        [string]
      >("SELECT description, priority, status FROM task WHERE id = ?")
      .get(taskId);
  } finally {
    database.close();
  }
}

async function setUp(run: (args: string[]) => Promise<string[]>): Promise<{
  projectId: string;
  low: string;
  high: string;
}> {
  const projectId = (await run(["project:create", "Board"]))[0]!.replace(
    "Project created: ",
    "",
  );
  const ids: string[] = [];
  for (const [title, priority] of [
    ["High", "5"],
    ["Low", "-1"],
  ] as const) {
    const created = await run([
      "task:create",
      "--project",
      projectId,
      "--title",
      title,
      "--priority",
      priority,
    ]);
    ids.push(created[0]!.replace("Task created: ", ""));
  }
  return { projectId, high: ids[0]!, low: ids[1]! };
}

async function workspaceTasks(
  run: (args: string[]) => Promise<string[]>,
  projectId: string,
  ...filters: string[]
): Promise<WorkspaceTask[]> {
  const output = await run([
    "office:workspace",
    "--project",
    projectId,
    "--status",
    "all",
    ...filters,
    "--json",
  ]);
  const snapshot: { project: { tasks: { items: WorkspaceTask[] } } } =
    JSON.parse(output.join("\n"));
  return snapshot.project.tasks.items;
}

describe("task:update over the Runtime socket", () => {
  test("changes priority, audits before and after, and every read model follows", async () => {
    await withRuntime(async ({ projectRoot, run }) => {
      const { projectId, low, high } = await setUp(run);
      const boardOrder = async () =>
        (await run(["task:list", "--project", projectId]))
          .slice(1)
          .map((line) => line.split(/\s+/u)[0]);
      expect(await boardOrder()).toEqual([high, low]);

      expect(
        await run([
          "task:update",
          "--project",
          projectId,
          "--task",
          low,
          "--priority",
          "10",
        ]),
      ).toEqual([`Task updated: ${low}`]);

      expect(storedTask(projectRoot, low)).toEqual({
        description: null,
        priority: 10,
        status: "pending",
      });
      expect(taskAudit(projectRoot)).toEqual([
        {
          aggregate_id: low,
          event_type: "task.priority_updated",
          payload_json: JSON.stringify({ from: -1, to: 10 }),
        },
      ]);

      // task:list reads the task repository; office:workspace reads the
      // operational read model. Both see the new priority.
      expect(await boardOrder()).toEqual([low, high]);
      expect(
        (await run(["task:list", "--project", projectId]))[1],
      ).toMatch(new RegExp(`^${low}\\s+pending\\s+\\S+\\s+10\\s+Low$`, "u"));
      expect(
        (await workspaceTasks(run, projectId)).map(({ taskId, priority }) => ({
          taskId,
          priority,
        })),
      ).toEqual(
        expect.arrayContaining([
          { taskId: low, priority: 10 },
          { taskId: high, priority: 5 },
        ]),
      );
      expect(
        (await workspaceTasks(run, projectId, "--priority", "10")).map(
          (task) => task.taskId,
        ),
      ).toEqual([low]);
      expect(
        await workspaceTasks(run, projectId, "--priority", "-1"),
      ).toEqual([]);
    });
  });

  test("applies description and priority together in one command", async () => {
    await withRuntime(async ({ projectRoot, run }) => {
      const { projectId, high } = await setUp(run);

      await run([
        "task:update",
        "--project",
        projectId,
        "--task",
        high,
        "--description",
        "Ship first",
        "--priority",
        "-3",
      ]);

      expect(storedTask(projectRoot, high)).toEqual({
        description: "Ship first",
        priority: -3,
        status: "pending",
      });
      expect(taskAudit(projectRoot)).toEqual([
        {
          aggregate_id: high,
          event_type: "task.description_updated",
          payload_json: JSON.stringify({ descriptionUpdated: true }),
        },
        {
          aggregate_id: high,
          event_type: "task.priority_updated",
          payload_json: JSON.stringify({ from: 5, to: -3 }),
        },
      ]);
      expect(
        (await workspaceTasks(run, projectId)).find(
          (task) => task.taskId === high,
        ),
      ).toMatchObject({ description: "Ship first", priority: -3 });
    });
  });

  test("keeps description-only updates unchanged", async () => {
    await withRuntime(async ({ projectRoot, run }) => {
      const { projectId, high } = await setUp(run);

      await run([
        "task:update",
        "--project",
        projectId,
        "--task",
        high,
        "--description",
        "Notes only",
      ]);

      expect(storedTask(projectRoot, high)).toEqual({
        description: "Notes only",
        priority: 5,
        status: "pending",
      });
      expect(taskAudit(projectRoot)).toEqual([
        {
          aggregate_id: high,
          event_type: "task.description_updated",
          payload_json: JSON.stringify({ descriptionUpdated: true }),
        },
      ]);
    });
  });

  test("refuses invalid or missing fields without writing", async () => {
    await withRuntime(async ({ projectRoot, invoke, run }) => {
      const { projectId, high } = await setUp(run);
      const base = ["task:update", "--project", projectId, "--task", high];

      const refusals: [string, string][] = [
        ["1.5", "Option --priority must be a plain decimal integer"],
        ["1e3", "Option --priority must be a plain decimal integer"],
        ["urgent", "Option --priority must be a plain decimal integer"],
        [
          "2147483648",
          "Task priority must be an integer between -2147483648 and 2147483647",
        ],
        [
          "-2147483649",
          "Task priority must be an integer between -2147483648 and 2147483647",
        ],
      ];
      for (const [priority, message] of refusals) {
        const refused = await invoke([
          ...base,
          "--description",
          "Never",
          "--priority",
          priority,
        ]);
        expect(refused).toMatchObject({ code: 1, stdout: [] });
        expect(refused.stderr.join("\n")).toContain(message);
      }
      const empty = await invoke(base);
      expect(empty).toMatchObject({ code: 1, stdout: [] });
      expect(empty.stderr.join("\n")).toContain(
        "task:update requires --description and/or --priority",
      );

      expect(storedTask(projectRoot, high)).toEqual({
        description: null,
        priority: 5,
        status: "pending",
      });
      expect(taskAudit(projectRoot)).toEqual([]);
    });
  });
});
