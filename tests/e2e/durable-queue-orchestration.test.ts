import { describe, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap } from "../../apps/daemon/src/bootstrap.ts";
import { createTestUnixSocket } from "../helpers/unix-socket.ts";
import { DaemonClient } from "../../apps/cli/src/daemon-client.ts";
import type { AgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import { BullMqJobQueue } from "../../packages/bullmq-job-queue/src/bullmq-job-queue.ts";

const hasRedis = Bun.which("redis-server") !== null;

async function eventually(check: () => Promise<boolean>): Promise<void> {
  await expect.poll(check, { timeout: 25_000, interval: 100 }).toBe(true);
}

describe("durable queue-driven pipeline orchestration", () => {
  test.runIf(hasRedis)(
    "progresses the real bundled delivery pipeline through approval",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "ai-office-queue-e2e-"));
      const socket = createTestUnixSocket();
      const port = 20_000 + Math.floor(Math.random() * 10_000);
      let redis = Bun.spawn(
        [
          "redis-server",
          "--bind",
          "127.0.0.1",
          "--port",
          String(port),
          "--save",
          "",
          "--appendonly",
          "no",
        ],
        { stdout: "ignore", stderr: "ignore" },
      );
      const guidance: Array<{ runId: string; text: string }> = [];
      let releaseExecution!: () => void;
      const executionGate = new Promise<void>((resolve) => {
        releaseExecution = resolve;
      });
      let holdFirstExecution = true;
      const executor: AgentExecutor = {
        prepare: async (run) => {
          const value = run.snapshot();
          guidance.push({
            runId: value.id,
            text: value.roleGuidance?.text ?? "",
          });
          return {
            provenance: {
              kind: "worker",
              adapterId: "e2e-worker",
              adapterVersion: "1",
              inputHash: "0".repeat(64),
            },
            usesWorktree: false,
            execute: async () => {
              if (holdFirstExecution) {
                await executionGate;
                holdFirstExecution = false;
              }
              return {
                summary: "Queue E2E result",
                artifacts: [],
              };
            },
            accept: async () => undefined,
          };
        },
        async execute() {
          throw new Error("prepare is required");
        },
      };
      vi.stubEnv("AI_OFFICE_QUEUE_PROVIDER", "bullmq");
      vi.stubEnv("AI_OFFICE_REDIS_URL", `redis://127.0.0.1:${port}`);
      const daemon = await bootstrap({
        projectRoot: root,
        socketPath: socket.socketPath,
        agentExecutor: executor,
      });
      const controller = new AbortController();
      const running = daemon.start(controller.signal);
      const client = new DaemonClient(socket.socketPath);
      const command = async (args: string[]) => client.execute(args);
      try {
        await eventually(async () => {
          try {
            await client.health();
            return true;
          } catch {
            return false;
          }
        });
        const project = await command(["project:create", "Queue E2E"]);
        expect(project.exitCode, project.stderr.join("\\n")).toBe(0);
        const projectId = project.stdout[0]!.replace("Project created: ", "");
        const manifest = readFileSync(
          join(
            process.cwd(),
            ".agents/skills/ai-office/assets/default-office-manifest.json",
          ),
          "utf8",
        );
        await command([
          "office:apply",
          "--project",
          projectId,
          "--manifest",
          manifest,
        ]);
        const synced = await command([
          "agent:sync",
          "--project",
          projectId,
          "--directory",
          join(process.cwd(), "agents"),
        ]);
        expect(synced.exitCode, synced.stderr.join("\\n")).toBe(0);
        const task = await command([
          "task:create",
          "--project",
          projectId,
          "--title",
          "Queue-driven feature",
        ]);
        const taskId = task.stdout[0]!.replace("Task created: ", "");
        const started = await command([
          "pipeline:start",
          "--project",
          projectId,
          "--task",
          taskId,
          "--pipeline",
          "delivery",
        ]);
        expect(started.exitCode, started.stderr.join("\\n")).toBe(0);
        const pipelineRunId = JSON.parse(started.stdout[0]!).id as string;

        await eventually(async () => {
          const status = await command([
            "pipeline:status",
            "--project",
            projectId,
            "--run",
            pipelineRunId,
          ]);
          if (status.exitCode !== 0) return false;
          return (
            JSON.parse(status.stdout[0]!).stages[0].status === "active" &&
            guidance.length === 1
          );
        });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
        expect(guidance).toHaveLength(1);

        redis.kill();
        await eventually(async () => {
          const health = await client.health();
          return health.queue?.redis === "unreachable";
        });
        releaseExecution();
        redis = Bun.spawn(
          [
            "redis-server",
            "--bind",
            "127.0.0.1",
            "--port",
            String(port),
            "--save",
            "",
            "--appendonly",
            "no",
          ],
          { stdout: "ignore", stderr: "ignore" },
        );
        await eventually(async () => {
          const health = await client.health();
          return health.queue?.redis === "reachable";
        });

        await eventually(async () => {
          const status = await command([
            "pipeline:status",
            "--project",
            projectId,
            "--run",
            pipelineRunId,
          ]);
          if (status.exitCode !== 0) return false;
          return (
            JSON.parse(status.stdout[0]!).stages[2].status ===
            "awaiting_approval"
          );
        });
        const beforeApproval = await command([
          "pipeline:status",
          "--project",
          projectId,
          "--run",
          pipelineRunId,
        ]);
        const beforeHealth = await client.health();
        const beforeRuns = await command(["run:list", "--project", projectId]);
        expect(
          JSON.parse(beforeApproval.stdout[0]!)
            .stages.slice(0, 3)
            .map((stage: { status: string }) => stage.status),
          JSON.stringify({
            status: beforeApproval.stdout,
            health: beforeHealth.queue,
            runs: beforeRuns.stdout,
            guidance,
          }),
        ).toEqual(["completed", "completed", "awaiting_approval"]);
        const blocked = await command([
          "pipeline:status",
          "--project",
          projectId,
          "--run",
          pipelineRunId,
        ]);
        expect(JSON.parse(blocked.stdout[0]!).stages[3].status).toBe("pending");
        expect(guidance.map((value) => value.text)).toHaveLength(3);
        expect(guidance[0]!.text).not.toBe(guidance[1]!.text);
        expect(guidance[1]!.text).not.toBe(guidance[2]!.text);

        await command([
          "pipeline:transition",
          "--project",
          projectId,
          "--run",
          pipelineRunId,
          "--event",
          "approve",
          "--rationale",
          "Operator approved the review",
        ]);
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        const completedStatus = await command([
          "pipeline:status",
          "--project",
          projectId,
          "--run",
          pipelineRunId,
        ]);
        expect(
          completedStatus.exitCode,
          completedStatus.stderr.join("\\n"),
        ).toBe(0);
        expect(JSON.parse(completedStatus.stdout[0]!)).toMatchObject({
          status: "completed",
        });
        const tasks = await command(["task:list", "--project", projectId]);
        expect(
          tasks.stdout.some((line) => line.startsWith(`${taskId}  completed`)),
        ).toBe(true);
        expect(guidance).toHaveLength(4);
        expect(new Set(guidance.map((value) => value.text)).size).toBe(4);
        const health = await client.health();
        expect(health.queue?.provider).toBe("configured");
        expect(health.queue?.outboxPending).toBe(0);

        // Replay a completed run and forge a run identifier. Both are delivery
        // events only; SQLite validation must prevent a new authoritative run.
        const replay = new BullMqJobQueue(`redis://127.0.0.1:${port}`);
        try {
          const reviewerRunId = guidance[2]!.runId;
          await replay.enqueue({
            type: "execute_agent_run",
            jobId: `agent-run-${reviewerRunId}`,
            payload: { projectId, runId: reviewerRunId },
          });
          await replay.enqueue({
            type: "execute_agent_run",
            jobId: `forged-run-${pipelineRunId}`,
            payload: { projectId, runId: `forged-${pipelineRunId}` },
          });
          await replay.enqueue({
            type: "orchestrate_pipeline",
            jobId: `stale-stage-${pipelineRunId}`,
            payload: {
              projectId,
              pipelineRunId,
              pipelineStageRunId: JSON.parse(completedStatus.stdout[0]!)
                .stages[0].id,
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 500));
        } finally {
          await replay.close();
        }
        const afterReplay = await command(["run:list", "--project", projectId]);
        expect(afterReplay.stdout).toHaveLength(5); // header + four authoritative runs
      } finally {
        controller.abort();
        await running;
        socket.cleanup();
        await redis.kill();
        vi.unstubAllEnvs();
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
