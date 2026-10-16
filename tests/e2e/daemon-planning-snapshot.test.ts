/**
 * `planning:snapshot`, end to end through the CLI client, the Unix-socket
 * protocol and the Runtime host: the minimized planning read model of CB-02.
 */

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

async function withRuntime(
  scenario: (runtime: {
    projectRoot: string;
    invoke(args: string[]): Promise<Invocation>;
    run(args: string[]): Promise<string[]>;
  }) => Promise<void>,
): Promise<void> {
  const projectRoot = mkdtempSync(join(tmpdir(), "ai-office-planning-"));
  temporaryDirectories.push(projectRoot);
  writeFileSync(join(projectRoot, "README.md"), "# Planning");
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

/** Audit rows after `rowid`, as "<event type> <payload command>". */
function auditSince(
  projectRoot: string,
  rowid: number,
): { rowid: number; events: string[] } {
  const database = openDatabase(
    join(projectRoot, ".ai-office", "project.sqlite"),
  );
  try {
    const rows = database
      .query<
        { rowid: number; event_type: string; payload_json: string },
        [number]
      >(
        "SELECT rowid, event_type, payload_json FROM audit_event WHERE rowid > ? ORDER BY rowid",
      )
      .all(rowid);
    return {
      rowid: rows.at(-1)?.rowid ?? rowid,
      events: rows.map((row) => {
        const payload = JSON.parse(row.payload_json) as { command?: string };
        return `${row.event_type} ${payload.command ?? ""}`;
      }),
    };
  } finally {
    database.close();
  }
}

const created = (line: string | undefined, prefix: string): string =>
  (line ?? "").replace(prefix, "");

describe("planning:snapshot through the Runtime socket", () => {
  test("returns minimized, paginated, deterministic pages and writes nothing", async () => {
    await withRuntime(async ({ projectRoot, invoke, run }) => {
      const projectId = created(
        (await run(["project:create", "Planning"]))[0],
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
        ["Second", "2"],
        ["Third", "1"],
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
      const [first, second, third] = taskIds as [string, string, string];
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

      const before = auditSince(projectRoot, 0).rowid;
      const snapshot = (...extra: string[]) =>
        run(["planning:snapshot", "--project", projectId, ...extra]);
      const pageOne = (await snapshot("--limit", "2"))[0]!;
      expect(await snapshot("--limit", "2")).toEqual([pageOne]);
      const one = JSON.parse(pageOne);
      const two = JSON.parse(
        (await snapshot("--limit", "2", "--offset", "2"))[0]!,
      );
      expect(one).toMatchObject({
        schemaVersion: 1,
        collection: "tasks",
        section: "authoritative",
        classes: ["P", "T"],
        scope: { projectId, milestoneId: null },
        page: { offset: 0, limit: 2, total: 3, truncated: true },
      });
      expect(two.snapshotId).toBe(one.snapshotId);
      expect(two.pageDigest).not.toBe(one.pageDigest);
      expect(
        [...one.items, ...two.items].map(
          (item: { taskId: string }) => item.taskId,
        ),
      ).toEqual([first, second, third]);
      expect(one.items[1]).toEqual({
        taskId: second,
        title: "Second",
        status: "pending",
        priority: 2,
        milestoneIds: [],
        requirementIds: [],
        prerequisiteIds: [first],
      });

      const scoped = JSON.parse(
        (await snapshot("--milestone", milestoneId, "--classes", "P"))[0]!,
      );
      expect(scoped.items).toEqual([
        {
          taskId: first,
          status: "pending",
          priority: 3,
          milestoneIds: [milestoneId],
          requirementIds: [requirementId],
          prerequisiteIds: [],
        },
      ]);
      const runnable = JSON.parse(
        (await snapshot("--collection", "runnable"))[0]!,
      );
      expect(runnable.section).toBe("derived");
      expect(
        runnable.items.map((item: { taskId: string }) => item.taskId),
      ).toEqual([first, third]);
      const decisions = JSON.parse(
        (await snapshot("--collection", "decisions"))[0]!,
      );
      expect(decisions.items).toEqual([
        {
          kind: "requirement_proposed",
          subjectType: "requirement",
          subjectId: requirementId,
        },
      ]);

      const everything = [
        pageOne,
        ...(await snapshot("--collection", "milestones")),
        ...(await snapshot("--collection", "requirements")),
      ].join("\n");
      expect(everything).not.toContain("SECRET");
      // The read writes no planning or domain audit: the only rows are the
      // host's per-command envelope that every Runtime command records.
      expect(new Set(auditSince(projectRoot, before).events)).toEqual(
        new Set([
          "command.received planning:snapshot",
          "command.completed planning:snapshot",
        ]),
      );

      for (const [args, message] of [
        [["--collection", "runs"], "Planning collection must be one of"],
        [["--limit", "201"], "Planning limit must be an integer from 1 to 200"],
        [["--limit", "1e3"], "--limit must be a non-negative decimal integer"],
        [["--classes", "P,D"], "Planning data classes must be P or P,T"],
        [["--milestone", "missing"], "Milestone missing not found"],
      ] as const) {
        const refused = await invoke([
          "planning:snapshot",
          "--project",
          projectId,
          ...args,
        ]);
        expect(refused.code).not.toBe(0);
        expect(refused.stderr.join("\n")).toContain(message);
      }
      const missing = await invoke([
        "planning:snapshot",
        "--project",
        "missing",
      ]);
      expect(missing.code).not.toBe(0);
      expect(missing.stderr.join("\n")).toContain("Project missing not found");
    });
  });
});
