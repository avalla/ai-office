/**
 * The task board and its lifecycle commands, end to end through the CLI.
 *
 * `task:list` is an operational board, not a list of reminders: STATUS is the
 * task's own state, requirement progress is a separate column, and a
 * contradiction between them is marked rather than resolved.
 */

import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type CliIo } from "../../apps/cli/src/cli.ts";

const temporaryDirectories: string[] = [];

function projectRootDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "ai-office-task-cli-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "README.md"), "# Board");
  return directory;
}

function captureIo(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
      prompt: async () => "",
    },
    stdout,
    stderr,
  };
}

afterEach(() => {
  while (temporaryDirectories.length > 0)
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
});

async function cli(
  projectRoot: string,
  args: string[],
): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const output = captureIo();
  const code = await runCli(args, { projectRoot, io: output.io });
  return { code, stdout: output.stdout, stderr: output.stderr };
}

async function board(): Promise<{ root: string; projectId: string }> {
  const root = projectRootDirectory();
  const created = await cli(root, ["project:create", "Board"]);
  expect(created.code).toBe(0);
  const projectId = created.stdout[0]!.replace("Project created: ", "");
  return { root, projectId };
}

async function newTask(
  root: string,
  projectId: string,
  title: string,
): Promise<string> {
  const created = await cli(root, [
    "task:create",
    "--project",
    projectId,
    "--title",
    title,
  ]);
  expect(created.code).toBe(0);
  return created.stdout[0]!.replace("Task created: ", "");
}

async function newRequirement(
  root: string,
  projectId: string,
  key: string,
): Promise<string> {
  const created = await cli(root, [
    "requirement:create",
    "--project",
    projectId,
    "--key",
    key,
    "--title",
    `Requirement ${key}`,
    "--description",
    "Must hold",
  ]);
  expect(created.code).toBe(0);
  return created.stdout[0]!.replace("Requirement created: ", "");
}

async function verify(
  root: string,
  projectId: string,
  requirementId: string,
): Promise<void> {
  for (const status of ["accepted", "implemented", "verified"])
    expect(
      (
        await cli(root, [
          "requirement:set-status",
          "--project",
          projectId,
          "--requirement",
          requirementId,
          "--status",
          status,
        ])
      ).code,
    ).toBe(0);
}

describe("task lifecycle CLI", () => {
  test("moves a task through its lifecycle", async () => {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "Ship it");

    for (const [command, expected] of [
      ["task:start", "running"],
      ["task:submit-review", "waiting_review"],
      ["task:complete", "completed"],
    ] as const) {
      const result = await cli(root, [
        command,
        "--project",
        projectId,
        "--task",
        taskId,
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout[0]).toBe(`Task ${taskId} is now ${expected}`);
    }
  });

  test("refuses an impossible transition and names what is allowed", async () => {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "Ship it");

    const result = await cli(root, [
      "task:complete",
      "--project",
      projectId,
      "--task",
      taskId,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain(
      "Allowed from pending: running, blocked, cancelled",
    );
  });

  test("requires a reason for block and fail", async () => {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "Ship it");

    const missing = await cli(root, [
      "task:block",
      "--project",
      projectId,
      "--task",
      taskId,
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr.join("\n")).toContain("requires --reason");

    expect(
      (
        await cli(root, [
          "task:block",
          "--project",
          projectId,
          "--task",
          taskId,
          "--reason",
          "waiting on vendor",
        ])
      ).code,
    ).toBe(0);
  });

  test("reports allowed transitions without mutating the task", async () => {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "Ship it");

    const preflight = await cli(root, [
      "task:transitions",
      "--project",
      projectId,
      "--task",
      taskId,
    ]);
    expect(preflight.code).toBe(0);
    expect(preflight.stdout[0]).toBe("Current state: pending");
    expect(preflight.stdout.join("\n")).toContain("running\ttask:start");
    expect(preflight.stdout.join("\n")).toContain("Terminal:");

    const listed = await cli(root, ["task:list", "--project", projectId]);
    expect(listed.stdout[1]).toContain("pending");
  });

  test("has no generic status escape hatch", async () => {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "Ship it");

    // The danger identified while probing `requirement:set-status` is not
    // reproduced here: there is no way to assign a terminal status directly.
    const result = await cli(root, [
      "task:set-status",
      "--project",
      projectId,
      "--task",
      taskId,
      "--status",
      "completed",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toMatch(/Unknown command/u);
  });
});

describe("task board", () => {
  test("shows requirement progress beside status and flags the contradiction", async () => {
    const { root, projectId } = await board();
    const stale = await newTask(root, projectId, "AUC-03");
    const healthy = await newTask(root, projectId, "AUC-04");
    const first = await newRequirement(root, projectId, "AUC-03-R1");
    const second = await newRequirement(root, projectId, "AUC-03-R2");
    const open = await newRequirement(root, projectId, "AUC-04-R1");

    for (const requirementId of [first, second])
      expect(
        (
          await cli(root, [
            "task:link-requirement",
            "--project",
            projectId,
            "--task",
            stale,
            "--requirement",
            requirementId,
          ])
        ).code,
      ).toBe(0);
    expect(
      (
        await cli(root, [
          "task:link-requirement",
          "--project",
          projectId,
          "--task",
          healthy,
          "--requirement",
          open,
        ])
      ).code,
    ).toBe(0);
    await verify(root, projectId, first);
    await verify(root, projectId, second);

    const listed = await cli(root, ["task:list", "--project", projectId]);
    expect(listed.stdout[0]).toBe(
      "ID\tSTATUS\tREQUIREMENTS\tPRIORITY\tTITLE",
    );
    const rows = listed.stdout.slice(1);
    const staleRow = rows.find((row) => row.startsWith(stale))!;
    const healthyRow = rows.find((row) => row.startsWith(healthy))!;

    // STATUS stays the task's real state; the marker says the two disagree.
    expect(staleRow).toContain("pending !");
    expect(staleRow).toContain("2/2 verified");
    // A task whose requirements are still open is not a contradiction.
    expect(healthyRow).toContain("pending\t0/1 verified");
    expect(healthyRow).not.toContain("!");

    expect(listed.stderr.join("\n")).toContain(
      `warning: task ${stale} is pending while all linked requirements are terminal`,
    );
    expect(listed.stderr.join("\n")).toContain("task:reconcile");
  });

  test("refuses to link a requirement from another project", async () => {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "Ship it");
    const other = await cli(root, ["project:create", "Other"]);
    const otherProject = other.stdout[0]!.replace("Project created: ", "");
    const foreign = await newRequirement(root, otherProject, "OTHER-R1");

    const result = await cli(root, [
      "task:link-requirement",
      "--project",
      projectId,
      "--task",
      taskId,
      "--requirement",
      foreign,
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain(`Requirement ${foreign} not found`);
  });
});

describe("task reconciliation CLI", () => {
  test("is read-only, refuses the stale-task repair, and explains why", async () => {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "AUC-03");
    const requirementId = await newRequirement(root, projectId, "AUC-03-R1");
    await cli(root, [
      "task:link-requirement",
      "--project",
      projectId,
      "--task",
      taskId,
      "--requirement",
      requirementId,
    ]);
    await verify(root, projectId, requirementId);

    const report = await cli(root, [
      "task:reconcile",
      "--project",
      projectId,
    ]);
    expect(report.code).toBe(0);
    const text = report.stdout.join("\n");
    expect(text).toContain("stale_pending_task");
    expect(text).toContain("Automatic repair REFUSED");
    expect(text).toContain(
      "requirement completion alone is insufficient evidence",
    );
    expect(text).toContain("No automatic repair is available");

    // Detection changed nothing.
    const listed = await cli(root, ["task:list", "--project", projectId]);
    expect(listed.stdout[1]).toContain("pending !");

    // And the operator can still correct it explicitly, which is the point.
    expect(
      (
        await cli(root, [
          "task:start",
          "--project",
          projectId,
          "--task",
          taskId,
        ])
      ).code,
    ).toBe(0);
    expect(
      (
        await cli(root, [
          "task:complete",
          "--project",
          projectId,
          "--task",
          taskId,
        ])
      ).code,
    ).toBe(0);
    const after = await cli(root, ["task:reconcile", "--project", projectId]);
    expect(after.stdout.join("\n")).toContain("No inconsistencies found.");
  });

  test("requires an approved plan before repairing anything", async () => {
    const { root, projectId } = await board();
    const result = await cli(root, [
      "task:reconcile",
      "--project",
      projectId,
      "--fix",
    ]);
    expect(result.code).toBe(1);
    expect(result.stderr.join("\n")).toContain("requires --approve");
  });

  test("emits a machine-readable report", async () => {
    const { root, projectId } = await board();
    await newTask(root, projectId, "Ship it");
    const result = await cli(root, [
      "task:reconcile",
      "--project",
      projectId,
      "--json",
    ]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.stdout[0]!) as {
      tasksInspected: number;
      issues: unknown[];
      planHash: string | null;
    };
    expect(report.tasksInspected).toBe(1);
    expect(report.issues).toEqual([]);
    expect(report.planHash).toBeNull();
  });
});
