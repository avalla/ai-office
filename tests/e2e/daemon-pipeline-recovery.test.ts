import { afterEach, describe, expect, test } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";
import type { CliIo } from "@ai-office/runtime-host/runtime-command.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";

const roots: string[] = [];

function output(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (value) => stdout.push(value),
      stderr: (value) => stderr.push(value),
    },
    stdout,
    stderr,
  };
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

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Recover suspended pipelines",
    goals: ["Resume once the last prerequisite completes"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Recovery office",
    roles: [
      {
        id: "developer",
        title: "Developer",
        purpose: "Build",
        responsibilities: ["Build"],
      },
    ],
  },
  pipelines: [
    {
      id: "delivery",
      name: "Delivery",
      description: "Single stage",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "build",
          name: "Build",
          roleId: "developer",
          objective: "Build",
          checks: [],
          requiresApproval: false,
          capabilities: [],
        },
      ],
    },
  ],
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("daemon pipeline recovery", () => {
  test("resumes a pipeline suspended on a review-only prerequisite when task:complete lands, exactly once", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-daemon-recovery-"));
    roots.push(root);
    const agentDirectory = join(root, "agents", "developer");
    mkdirSync(agentDirectory, { recursive: true });
    writeFileSync(
      join(agentDirectory, "agent.yaml"),
      `id: developer
role_key: developer
role: Developer
version: 1
capabilities: [code]
tools: [shell]
model_policy: mock
limits:
  max_iterations: 1
  max_cost_micros: "1000"
  timeout_seconds: 60
`,
    );
    writeFileSync(
      join(agentDirectory, "system.md"),
      "You are the developer agent.\n",
    );
    const socket = createTestUnixSocket();
    roots.push(socket.root);
    const socketPath = socket.socketPath;
    const daemon = await bootstrap({ projectRoot: root, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const command = async (args: string[]) => {
      const capture = output();
      const exitCode = await runDaemonCli(args, {
        projectRoot: root,
        socketPath,
        workingDirectory: root,
        io: capture.io,
      });
      return { exitCode, ...capture };
    };
    const databasePath = join(root, ".ai-office", "project.sqlite");
    const taskStatus = (taskId: string) => {
      const database = openDatabase(databasePath);
      try {
        return database
          .query<{ status: string }, [string]>(
            "SELECT status FROM task WHERE id = ?",
          )
          .get(taskId)?.status;
      } finally {
        database.close();
      }
    };
    const resumedEvents = () => {
      const database = openDatabase(databasePath);
      try {
        return database
          .query<{ payload_json: string }, []>(
            "SELECT payload_json FROM audit_event WHERE event_type = 'pipeline.resumed'",
          )
          .all()
          .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
      } finally {
        database.close();
      }
    };

    try {
      await waitForDaemon(socketPath);
      const created = await command([
        "project:create",
        "Recovery project",
        "--json",
      ]);
      expect(created.exitCode).toBe(0);
      const projectId = (
        JSON.parse(created.stdout[0]!) as { projectId: string }
      ).projectId;
      expect(
        (
          await command([
            "office:apply",
            "--project",
            projectId,
            "--manifest",
            JSON.stringify(manifest),
          ])
        ).exitCode,
      ).toBe(0);
      expect(
        (await command(["agent:sync", "--project", projectId])).exitCode,
      ).toBe(0);
      const agents = await command(["agent:list", "--project", projectId]);
      const agentId = agents.stdout[1]!.split("\t")[0]!;

      const prerequisiteTask = await command([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Prerequisite",
      ]);
      const prerequisiteTaskId = prerequisiteTask
        .stdout[0]!.slice("Task created: ".length);
      const dependentTask = await command([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Dependent",
      ]);
      const dependentTaskId = dependentTask
        .stdout[0]!.slice("Task created: ".length);
      expect(
        (
          await command([
            "task:dependency:add",
            "--project",
            projectId,
            "--task",
            dependentTaskId,
            "--depends-on",
            prerequisiteTaskId,
          ])
        ).exitCode,
      ).toBe(0);

      // Review-ready satisfies admission ("start") but not completion.
      expect(
        (
          await command([
            "task:start",
            "--project",
            projectId,
            "--task",
            prerequisiteTaskId,
          ])
        ).exitCode,
      ).toBe(0);
      expect(
        (
          await command([
            "task:submit-review",
            "--project",
            projectId,
            "--task",
            prerequisiteTaskId,
          ])
        ).exitCode,
      ).toBe(0);

      const started = await command([
        "pipeline:start",
        "--project",
        projectId,
        "--task",
        dependentTaskId,
        "--pipeline",
        "delivery",
        "--actor",
        "operator",
      ]);
      expect(started.exitCode).toBe(0);
      const pipelineRunId = (JSON.parse(started.stdout[0]!) as { id: string })
        .id;
      expect(
        (
          await command([
            "pipeline:assign",
            "--project",
            projectId,
            "--run",
            pipelineRunId,
            "--agent",
            agentId,
            "--actor",
            "operator",
          ])
        ).exitCode,
      ).toBe(0);
      const scheduled = await command([
        "run:schedule",
        "--project",
        projectId,
        "--task",
        dependentTaskId,
        "--agent",
        agentId,
      ]);
      expect(scheduled.exitCode).toBe(0);
      const agentRunId = scheduled
        .stdout[0]!.slice("Agent run scheduled: ".length);

      // The run completes, but the final stage cannot close while the
      // prerequisite is only waiting_review: the refusal rolls back and the
      // pipeline is left suspended.
      const suspendedTick = await command([
        "run:tick",
        "--project",
        projectId,
        "--simulate",
        "--json",
      ]);
      expect(suspendedTick.exitCode).toBe(1);
      const suspendedReport = JSON.parse(suspendedTick.stdout[0]!) as {
        results: {
          runId: string;
          status: string;
          error?: { code: string };
        }[];
        pipelineRecoveries: { pipelineRunId: string; outcome: string }[];
      };
      expect(suspendedReport.results).toEqual([
        expect.objectContaining({
          runId: agentRunId,
          status: "completed",
          error: expect.objectContaining({
            code: "STAGE_AWAITING_PREREQUISITES",
          }),
        }),
      ]);
      expect(suspendedReport.pipelineRecoveries).toEqual([
        expect.objectContaining({
          pipelineRunId,
          outcome: "awaiting_prerequisites",
        }),
      ]);

      const suspendedStatus = await command([
        "pipeline:status",
        "--project",
        projectId,
        "--run",
        pipelineRunId,
      ]);
      const suspendedRun = JSON.parse(suspendedStatus.stdout[0]!) as {
        status: string;
        stages: { status: string }[];
      };
      expect(suspendedRun.status).toBe("active");
      expect(suspendedRun.stages.map((stage) => stage.status)).toEqual([
        "active",
      ]);
      expect(taskStatus(dependentTaskId)).toBe("running");
      expect(resumedEvents()).toEqual([]);

      // Completing the prerequisite runs the post-commit recovery sweep.
      const completed = await command([
        "task:complete",
        "--project",
        projectId,
        "--task",
        prerequisiteTaskId,
      ]);
      expect(completed.exitCode).toBe(0);
      expect(completed.stdout).toContain(
        `Task ${prerequisiteTaskId} is now completed`,
      );
      expect(completed.stdout).toContain(
        `Suspended pipeline ${pipelineRunId} resumed for task ${dependentTaskId}`,
      );

      const resumedStatus = await command([
        "pipeline:status",
        "--project",
        projectId,
        "--run",
        pipelineRunId,
      ]);
      expect(
        JSON.parse(resumedStatus.stdout[0]!) as { status: string },
      ).toMatchObject({ status: "completed" });
      expect(taskStatus(dependentTaskId)).toBe("completed");

      const events = resumedEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        stageId: "build",
        agentRunId,
        trigger: "task_completion",
        triggerTaskId: prerequisiteTaskId,
        prerequisiteTaskIds: [prerequisiteTaskId],
      });

      // A later tick finds no candidate: nothing is resumed twice.
      const idleTick = await command([
        "run:tick",
        "--project",
        projectId,
        "--simulate",
        "--json",
      ]);
      expect(idleTick.exitCode).toBe(0);
      const idleReport = JSON.parse(idleTick.stdout[0]!) as {
        results: unknown[];
        pipelineRecoveries: unknown[];
      };
      expect(idleReport.results).toEqual([]);
      expect(idleReport.pipelineRecoveries).toEqual([]);
      expect(resumedEvents()).toHaveLength(1);
    } finally {
      controller.abort();
      await running;
    }
  });
});
