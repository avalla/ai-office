import { afterEach, describe, expect, test } from "vitest";
import {
  BullMqJobQueue,
  sanitizedRedisDiagnostic,
} from "@ai-office/bullmq-job-queue/bullmq-job-queue.ts";
import type { QueueJobHandler } from "@ai-office/application/ports/job-worker.port.ts";

const hasRedis = Bun.which("redis-server") !== null;
const processes: Bun.Subprocess[] = [];
const queues: BullMqJobQueue[] = [];

function port(): number {
  return 24_000 + Math.floor(Math.random() * 5_000);
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  await expect.poll(check, { timeout: 10_000, interval: 50 }).toBe(true);
}

async function startQueue(): Promise<{ queue: BullMqJobQueue; url: string }> {
  const value = port();
  const url = `redis://127.0.0.1:${value}`;
  const redis = Bun.spawn(
    [
      "redis-server",
      "--bind",
      "127.0.0.1",
      "--port",
      String(value),
      "--save",
      "",
      "--appendonly",
      "no",
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  processes.push(redis);
  const queue = new BullMqJobQueue(url);
  queues.push(queue);
  await eventually(async () => (await queue.health()) === "reachable");
  return { queue, url };
}

afterEach(async () => {
  await Promise.all(
    queues
      .splice(0)
      .map((queue) =>
        Promise.race([
          queue.close().catch(() => undefined),
          new Promise<void>((resolve) => setTimeout(resolve, 500)),
        ]),
      ),
  );
  for (const process of processes.splice(0)) process.kill();
});

describe("BullMQ job queue adapter", () => {
  test("sanitizes arbitrary Redis errors without exposing connection details", () => {
    expect(
      sanitizedRedisDiagnostic(new Error("redis://:password@host:6379")),
    ).toBe("Redis queue unavailable");
    expect(sanitizedRedisDiagnostic("redis://:password@host:6379")).toBe(
      "Redis queue unavailable",
    );
  });

  test.runIf(hasRedis)(
    "handles completed, terminal, and explicit retryable dispositions",
    async () => {
      const { queue } = await startQueue();
      let finalRetryableMode: "retryable" | "completed" = "retryable";
      const dispositions: QueueJobHandler["process"][] = [
        async () => "completed",
        async () => "terminal",
        (() => {
          let attempts = 0;
          return async () => {
            attempts += 1;
            return attempts < 3 ? "retryable" : "completed";
          };
        })(),
        async () => finalRetryableMode,
      ];
      const counts = [0, 0, 0, 0];
      await queue.start({
        process: async (job) => {
          const index = Number(job.payload.case);
          counts[index] = (counts[index] ?? 0) + 1;
          return dispositions[index]!(job);
        },
      });
      for (const [index] of counts.entries())
        await queue.enqueue({
          type: "orchestrate_pipeline",
          jobId: `disposition-${index}`,
          payload: {
            projectId: "project",
            pipelineRunId: "run",
            pipelineStageRunId: "stage",
            case: index,
          },
        });
      await eventually(async () => counts.every((count) => count >= 1));
      await eventually(async () => counts[2] === 3);
      await eventually(async () => counts[3]! >= 3);
      finalRetryableMode = "completed";
      await eventually(async () => {
        await queue.enqueue({
          type: "orchestrate_pipeline",
          jobId: "disposition-3",
          payload: {
            projectId: "project",
            pipelineRunId: "run",
            pipelineStageRunId: "stage",
            case: 3,
          },
        });
        return counts[3] === 4;
      });
      expect(counts).toEqual([1, 1, 3, 4]);
    },
    20_000,
  );

  test.runIf(hasRedis)(
    "keeps health observable when Redis disappears after worker startup",
    async () => {
      const { queue, url } = await startQueue();
      const logs: string[] = [];
      const originalError = console.error;
      console.error = (...args: unknown[]) => logs.push(args.join(" "));
      try {
        await queue.start({ process: async () => "terminal" });
        const redis = processes[processes.length - 1]!;
        redis.kill();
        await eventually(async () => (await queue.health()) === "unreachable");
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(await queue.health()).toBe("unreachable");
        expect(logs.join("\n")).not.toContain(url);
        expect(logs.join("\n")).not.toContain("password");
      } finally {
        console.error = originalError;
      }
    },
    20_000,
  );
});
