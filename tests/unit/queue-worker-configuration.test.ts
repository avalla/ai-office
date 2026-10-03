import { expect, test } from "vitest";
import { readQueueConfiguration } from "@ai-office/bullmq-job-queue/config.ts";
import type { JobOutboxRepository } from "@ai-office/application/ports/job-outbox-repository.port.ts";
import type { JobQueue } from "@ai-office/application/ports/job-queue.port.ts";
import type {
  JobQueueConsumer,
  QueueJobHandler,
} from "@ai-office/application/ports/job-worker.port.ts";
import { QueueRuntime } from "../../apps/daemon/src/queue-runtime.ts";

const configured = {
  AI_OFFICE_QUEUE_PROVIDER: "bullmq",
  AI_OFFICE_REDIS_URL: "redis://localhost:6379",
};

test("queue configuration selects the Codex worker explicitly", () => {
  expect(
    readQueueConfiguration({ ...configured, AI_OFFICE_QUEUE_WORKER: "codex" }),
  ).toMatchObject({ status: "configured", worker: "codex" });
  // Selection is explicit: the default stays Claude and is never Codex.
  expect(readQueueConfiguration(configured)).toMatchObject({
    status: "configured",
    worker: "claude",
  });
});

test("an unknown queue worker misconfigures the queue instead of falling back", () => {
  for (const worker of [
    "unknown",
    "Codex",
    "codex ",
    "",
    "codex,claude",
    "claude|codex",
    "auto",
  ])
    expect(
      readQueueConfiguration({ ...configured, AI_OFFICE_QUEUE_WORKER: worker }),
      worker,
    ).toMatchObject({ status: "misconfigured" });
});

test("queued runs reach Codex through the same run:tick command as an explicit tick", async () => {
  const commands: string[][] = [];
  let handler: QueueJobHandler | undefined;
  const queue = {
    enqueue: async () => ({ accepted: true, duplicate: false }),
    health: async () => "reachable" as const,
    start: async (registered: QueueJobHandler) => {
      handler = registered;
    },
    stop: async () => {},
    close: async () => {},
    consuming: { orchestrate_pipeline: true, execute_agent_run: true },
  } as unknown as JobQueue & JobQueueConsumer;
  const outbox = {
    pending: async () => [],
    replayable: async () => [],
  } as unknown as JobOutboxRepository;
  const runtime = new QueueRuntime(
    {
      execute: async ({ args }) => {
        commands.push(args);
        return { exitCode: 1, stdout: [], stderr: [] };
      },
    },
    outbox,
    queue,
    { now: () => new Date("2026-10-03T00:00:00.000Z") },
    "codex",
  );
  await runtime.start();
  try {
    // A failed Codex run is terminal: no other executor is tried.
    expect(
      await handler!.process({
        type: "execute_agent_run",
        jobId: "job",
        payload: { projectId: "project", runId: "run" },
      }),
    ).toBe("terminal");
    expect(commands).toEqual([
      ["run:tick", "--project", "project", "--run", "run", "--worker", "codex"],
    ]);
  } finally {
    await runtime.stop();
  }
});
