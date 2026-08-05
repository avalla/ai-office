import { afterEach, describe, expect, test } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDaemonCli } from "../../apps/cli/src/daemon-cli.ts";
import type { CliIo } from "../../apps/cli/src/cli.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";

const roots: string[] = [];

const captured = (): { io: CliIo; stdout: string[]; stderr: string[] } => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: (message) => stdout.push(message),
      stderr: (message) => stderr.push(message),
    },
    stdout,
    stderr,
  };
};

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

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("M3-M5 CLI through the daemon", () => {
  test("executes the complete command surface and reports known errors", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-daemon-m3-m5-"));
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
    const socketPath = join(root, ".ai-office", "daemon.sock");
    const daemon = await bootstrap({ projectRoot: root, socketPath });
    const controller = new AbortController();
    const running = daemon.start(controller.signal);
    const run = async (args: string[]) => {
      const output = captured();
      const exitCode = await runDaemonCli(args, {
        projectRoot: root,
        socketPath,
        io: output.io,
      });
      return { ...output, exitCode };
    };

    try {
      await waitForDaemon(socketPath);
      const project = await run(["project:create", "Demo"]);
      const projectId = project.stdout[0]!.replace("Project created: ", "");
      const task = await run([
        "task:create",
        "--project",
        projectId,
        "--title",
        "Implement",
      ]);
      const taskId = task.stdout[0]!.replace("Task created: ", "");

      expect((await run(["agent:sync", "--project", projectId])).exitCode).toBe(
        0,
      );
      const agents = await run(["agent:list", "--project", projectId]);
      expect(agents.stdout.join("\n")).toContain("developer");
      const agentId = agents.stdout[1]!.split("\t")[0]!;
      expect(
        (
          await run([
            "run:schedule",
            "--project",
            projectId,
            "--task",
            taskId,
            "--agent",
            agentId,
          ])
        ).exitCode,
      ).toBe(0);
      expect((await run(["run:tick", "--project", projectId])).stdout[0]).toBe(
        "Agent runs executed: 1",
      );
      expect(
        (await run(["run:list", "--project", projectId])).stdout.join("\n"),
      ).toContain("completed");

      expect(
        (
          await run([
            "pricing:set",
            "--provider",
            "mock",
            "--model",
            "model",
            "--currency",
            "USD",
            "--input",
            "1",
            "--cached-input",
            "0",
            "--output",
            "1",
            "--reasoning",
            "0",
          ])
        ).exitCode,
      ).toBe(0);
      expect(
        (await run(["budget:set", "--project", projectId, "--limit", "1000"]))
          .exitCode,
      ).toBe(0);
      expect((await run(["cost:list", "--project", projectId])).stdout[0]).toBe(
        "No cost events found.",
      );

      const milestone = await run([
        "milestone:create",
        "--project",
        projectId,
        "--title",
        "M1",
      ]);
      const milestoneId = milestone.stdout[0]!.replace(
        "Milestone created: ",
        "",
      );
      const requirementArgs = [
        "requirement:create",
        "--project",
        projectId,
        "--key",
        "REQ-1",
        "--title",
        "Requirement",
        "--description",
        "Description",
        "--milestone",
        milestoneId,
      ];
      const requirement = await run(requirementArgs);
      const requirementId = requirement.stdout[0]!.replace(
        "Requirement created: ",
        "",
      );
      expect(
        (
          await run([
            "adr:create",
            "--project",
            projectId,
            "--title",
            "ADR",
            "--context",
            "Context",
            "--decision",
            "Decision",
            "--consequences",
            "Consequences",
          ])
        ).exitCode,
      ).toBe(0);
      const review = await run([
        "review:create",
        "--project",
        projectId,
        "--subject-type",
        "requirement",
        "--subject",
        requirementId,
        "--reviewer",
        "reviewer",
      ]);
      const reviewId = review.stdout[0]!.replace("Review created: ", "");
      expect(
        (
          await run([
            "review:decide",
            "--project",
            projectId,
            "--review",
            reviewId,
            "--actor",
            "owner",
            "--decision",
            "approved",
          ])
        ).exitCode,
      ).toBe(0);
      expect(
        (await run(["governance:profile", "--project", projectId])).stdout.join(
          "\n",
        ),
      ).toContain("REQ-1");
      expect(
        (await run(["governance:export", "--project", projectId])).exitCode,
      ).toBe(0);
      expect(
        existsSync(join(root, ".ai-office", "generated", "governance.md")),
      ).toBe(true);

      const duplicate = await run(requirementArgs);
      expect(duplicate.exitCode).toBe(1);
      expect(duplicate.stderr[0]).toContain("already exists");
    } finally {
      controller.abort();
      await running;
    }
    expect(existsSync(socketPath)).toBe(false);
  });
});
