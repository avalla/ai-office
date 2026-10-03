import { expect, test } from "vitest";
import { readQueueConfiguration } from "@ai-office/bullmq-job-queue/config.ts";

test("queue configuration selects the Codex worker explicitly", () => {
  expect(
    readQueueConfiguration({
      AI_OFFICE_QUEUE_PROVIDER: "bullmq",
      AI_OFFICE_QUEUE_WORKER: "codex",
      AI_OFFICE_REDIS_URL: "redis://localhost:6379",
    }),
  ).toMatchObject({ status: "configured", worker: "codex" });
  expect(
    readQueueConfiguration({
      AI_OFFICE_QUEUE_PROVIDER: "bullmq",
      AI_OFFICE_QUEUE_WORKER: "unknown",
      AI_OFFICE_REDIS_URL: "redis://localhost:6379",
    }),
  ).toMatchObject({ status: "misconfigured" });
});
