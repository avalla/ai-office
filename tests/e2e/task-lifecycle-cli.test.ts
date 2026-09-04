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
import { runCli, type CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";

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

/** The audit trail the CLI actually wrote, in order. */
function auditTrail(
  root: string,
): { event_type: string; payload_json: string }[] {
  const database = openDatabase(join(root, ".ai-office", "project.sqlite"));
  try {
    return database
      .query<{ event_type: string; payload_json: string }, []>(
        // By insertion order: audit ids are random in the real CLI, so only
        // the rowid preserves the sequence the commands wrote.
        "SELECT event_type, payload_json FROM audit_event WHERE aggregate_type = 'task' ORDER BY rowid",
      )
      .all();
  } finally {
    database.close();
  }
}

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

    // The suggestion is the explicit correction, never `task:complete`: the
    // lifecycle refuses that from `pending`, so suggesting it would send the
    // operator to a command that cannot run.
    expect(text).toContain("suggested: task:record-completion");
    expect(text).not.toContain("suggested: task:complete");
  });

  test("never suggests a command the shown state would reject", async () => {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "AUC-05");
    const requirementId = await newRequirement(root, projectId, "AUC-05-R1");
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
      "--json",
    ]);
    const parsed = JSON.parse(report.stdout[0]!) as {
      issues: { status: string; suggestedCommand: string | null }[];
    };
    expect(parsed.issues.length).toBeGreaterThan(0);
    for (const issue of parsed.issues) {
      if (issue.suggestedCommand === null) continue;
      // Every suggestion must be executable from the status shown beside it.
      const transitions = await cli(root, [
        "task:transitions",
        "--project",
        projectId,
        "--task",
        taskId,
        "--json",
      ]);
      const allowed = (
        JSON.parse(transitions.stdout[0]!) as {
          allowed: { command: string }[];
        }
      ).allowed.map((value) => value.command);
      expect(
        allowed.includes(issue.suggestedCommand) ||
          issue.suggestedCommand === "task:record-completion",
      ).toBe(true);
    }
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

/**
 * The motivating workflow, end to end.
 *
 * AUC-03 sits at `pending` with every linked requirement verified. It can now be
 * corrected — by an operator saying the work was done, never by the system
 * concluding it — and the audit trail says which of the two happened.
 */
describe("historical completion record CLI", () => {
  async function stalePending(): Promise<{
    root: string;
    projectId: string;
    taskId: string;
  }> {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "AUC-03");
    for (const key of ["AUC-03-R1", "AUC-03-R2"]) {
      const requirementId = await newRequirement(root, projectId, key);
      expect(
        (
          await cli(root, [
            "task:link-requirement",
            "--project",
            projectId,
            "--task",
            taskId,
            "--requirement",
            requirementId,
          ])
        ).code,
      ).toBe(0);
      await verify(root, projectId, requirementId);
    }
    return { root, projectId, taskId };
  }

  test("previews the correction, then applies it against the approved plan", async () => {
    const { root, projectId, taskId } = await stalePending();

    const preflight = await cli(root, [
      "task:record-completion",
      "--project",
      projectId,
      "--task",
      taskId,
      "--reason",
      "delivered in the M4 release before the board tracked it",
    ]);
    expect(preflight.code).toBe(0);
    const preview = preflight.stdout.join("\n");
    expect(preview).toContain("status: pending");
    expect(preview).toContain("linked requirements: 2/2 verified");
    expect(preview).toContain(
      "operation: historical correction, not a lifecycle transition",
    );
    expect(preview).toContain("resulting status: completed");
    expect(preview).toContain("No task:start is emitted");

    // The preflight is a read: the board is unchanged.
    expect(
      (await cli(root, ["task:list", "--project", projectId])).stdout[1],
    ).toContain("pending !");

    const planHash = preview.match(/--approve ([0-9a-f]{64})/u)?.[1];
    expect(planHash).toBeDefined();

    const applied = await cli(root, [
      "task:record-completion",
      "--project",
      projectId,
      "--task",
      taskId,
      "--reason",
      "delivered in the M4 release before the board tracked it",
      "--approve",
      planHash!,
    ]);
    expect(applied.code).toBe(0);
    expect(applied.stdout[0]).toBe(
      `Recorded completion of task ${taskId}: pending -> completed (historical correction)`,
    );

    const listed = await cli(root, ["task:list", "--project", projectId]);
    expect(listed.stdout[1]).toContain("completed");
    expect(listed.stdout[1]).not.toContain("!");
    expect(
      (await cli(root, ["task:reconcile", "--project", projectId])).stdout.join(
        "\n",
      ),
    ).toContain("No inconsistencies found.");

    // The point of the whole command: the task is completed and the trail says
    // a person recorded that, not that the work was executed here. There is no
    // `task.status_changed` at all, so in particular no fabricated `start`.
    const trail = auditTrail(root);
    expect(trail.map((row) => row.event_type)).toEqual([
      "task.requirement_linked",
      "task.requirement_linked",
      "task.completion_recorded",
    ]);
    expect(JSON.parse(trail[2]!.payload_json)).toMatchObject({
      operation: "record-completion",
      from: "pending",
      to: "completed",
      correction: true,
      reason: "delivered in the M4 release before the board tracked it",
      evidence: { total: 2, verified: 2, terminal: 2, open: 0 },
    });
  });

  test("refuses to apply without an approved plan hash", async () => {
    const { root, projectId, taskId } = await stalePending();
    const stale = await cli(root, [
      "task:record-completion",
      "--project",
      projectId,
      "--task",
      taskId,
      "--reason",
      "already done",
      "--approve",
      "0".repeat(64),
    ]);
    expect(stale.code).toBe(1);
    expect(stale.stderr.join("\n")).toContain(
      "approval does not match the current plan",
    );
    expect(
      (await cli(root, ["task:list", "--project", projectId])).stdout[1],
    ).toContain("pending");
  });

  test("requires a rationale that says something", async () => {
    const { root, projectId, taskId } = await stalePending();
    const missing = await cli(root, [
      "task:record-completion",
      "--project",
      projectId,
      "--task",
      taskId,
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr.join("\n")).toContain("--reason");

    const blank = await cli(root, [
      "task:record-completion",
      "--project",
      projectId,
      "--task",
      taskId,
      "--reason",
      "   ",
    ]);
    expect(blank.code).toBe(1);
    expect(blank.stderr.join("\n")).toContain("cannot be empty");
  });

  test("points at task:complete when the lifecycle can already do it", async () => {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "Ship it");
    await cli(root, ["task:start", "--project", projectId, "--task", taskId]);

    const refused = await cli(root, [
      "task:record-completion",
      "--project",
      projectId,
      "--task",
      taskId,
      "--reason",
      "already done",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stdout.join("\n")).toContain("use instead: task:complete");
  });

  test("never reopens a terminal task", async () => {
    const { root, projectId } = await board();
    const taskId = await newTask(root, projectId, "Ship it");
    await cli(root, [
      "task:cancel",
      "--project",
      projectId,
      "--task",
      taskId,
      "--reason",
      "descoped",
    ]);

    const refused = await cli(root, [
      "task:record-completion",
      "--project",
      projectId,
      "--task",
      taskId,
      "--reason",
      "actually it shipped",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stdout.join("\n")).toContain("terminal");
    expect(
      (await cli(root, ["task:list", "--project", projectId])).stdout[1],
    ).toContain("cancelled");
  });

  test("emits a machine-readable plan and result", async () => {
    const { root, projectId, taskId } = await stalePending();
    const preflight = await cli(root, [
      "task:record-completion",
      "--project",
      projectId,
      "--task",
      taskId,
      "--reason",
      "already delivered",
      "--json",
    ]);
    const plan = JSON.parse(preflight.stdout[0]!) as {
      kind: string;
      available: boolean;
      planHash: string;
      evidence: { verified: number; total: number };
      rationaleRequired: boolean;
    };
    expect(plan).toMatchObject({
      kind: "historical_correction",
      available: true,
      rationaleRequired: true,
    });
    expect(plan.evidence).toMatchObject({ verified: 2, total: 2 });

    const applied = await cli(root, [
      "task:record-completion",
      "--project",
      projectId,
      "--task",
      taskId,
      "--reason",
      "already delivered",
      "--approve",
      plan.planHash,
      "--json",
    ]);
    expect(JSON.parse(applied.stdout[0]!)).toMatchObject({
      taskId,
      from: "pending",
      to: "completed",
      correction: true,
    });
  });
});
