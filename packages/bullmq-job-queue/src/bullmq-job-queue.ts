import { Queue, Worker, type Job, type QueueOptions } from "bullmq";
import type {
  JobQueue,
  QueueEnqueueResult,
  QueueJob,
  QueueJobType,
} from "@ai-office/application/ports/job-queue.port.ts";
import type { CanonicalJsonValue } from "@ai-office/domain/capability/canonical-json.ts";
import type {
  JobQueueConsumer,
  QueueJobHandler,
} from "@ai-office/application/ports/job-worker.port.ts";

export const queueNames = {
  // BullMQ reserves `:` in queue names; Redis key prefixes remain namespaced by BullMQ.
  orchestration: "ai-office-orchestration",
  agentRuns: "ai-office-agent-runs",
} as const;

export function sanitizedRedisDiagnostic(_error: unknown): string {
  // Redis errors can contain a credential-bearing URL or server response.
  return "Redis queue unavailable";
}

export const queueJobOptions = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 250 },
  removeOnComplete: { age: 86_400, count: 1_000 },
  // Final retryable failures must release the deterministic ID so SQLite
  // recovery can enqueue the still-authoritative queued work again.
  removeOnFail: true,
};

function queueFor(job: QueueJob): string {
  return job.type === "execute_agent_run"
    ? queueNames.agentRuns
    : queueNames.orchestration;
}

export class BullMqJobQueue implements JobQueue, JobQueueConsumer {
  private readonly queues: ReadonlyMap<string, Queue>;
  private readonly workers: Worker[] = [];
  private readonly redisUrl: string;

  constructor(redisUrl: string) {
    this.redisUrl = redisUrl;
    const connection = { url: redisUrl } as QueueOptions["connection"];
    this.queues = new Map(
      Object.values(queueNames).map((name) => {
        const queue = new Queue(name, { connection });
        queue.on("error", (error) => {
          console.error(
            "Queue Redis diagnostic:",
            sanitizedRedisDiagnostic(error),
          );
        });
        return [name, queue];
      }),
    );
  }

  async enqueue(job: QueueJob): Promise<QueueEnqueueResult> {
    const queue = this.queues.get(queueFor(job));
    if (queue === undefined) throw new Error("Queue is not configured");
    const result = await queue.add(job.type, job.payload, {
      jobId: job.jobId,
      ...queueJobOptions,
    });
    return { accepted: true, duplicate: result.id !== job.jobId };
  }

  async health(): Promise<"reachable" | "unreachable"> {
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("queue health timeout")), 1_000),
    );
    try {
      await Promise.race([
        Promise.all(
          [...this.queues.values()].map((queue) => queue.getJobCounts()),
        ),
        timeout,
      ]);
      return "reachable";
    } catch {
      return "unreachable";
    }
  }

  get consuming(): Readonly<Record<QueueJobType, boolean>> {
    return {
      orchestrate_pipeline: this.workers.length > 0,
      execute_agent_run: this.workers.length > 0,
    };
  }

  async start(handler: QueueJobHandler): Promise<void> {
    if (this.workers.length > 0) return;
    for (const [name, type] of [
      [queueNames.orchestration, "orchestrate_pipeline"],
      [queueNames.agentRuns, "execute_agent_run"],
    ] as const) {
      const worker = new Worker(
        name,
        async (job: Job<Readonly<Record<string, unknown>>>) => {
          const payload = job.data;
          if (
            typeof payload !== "object" ||
            payload === null ||
            Array.isArray(payload)
          )
            return;
          let disposition: Awaited<ReturnType<QueueJobHandler["process"]>>;
          try {
            disposition = await handler.process({
              type,
              jobId: String(job.id ?? ""),
              payload: payload as Readonly<Record<string, CanonicalJsonValue>>,
            });
          } catch {
            // An unexpected handler failure is ambiguous at the delivery
            // boundary; do not turn it into an automatic duplicate attempt.
            return;
          }
          if (disposition === "retryable")
            throw new Error("Queue work is retryable");
        },
        { connection: { url: this.redisUrl } as QueueOptions["connection"] },
      );
      worker.on("error", (error) => {
        console.error(
          "Queue Redis diagnostic:",
          sanitizedRedisDiagnostic(error),
        );
      });
      this.workers.push(worker);
    }
  }

  async stop(): Promise<void> {
    await Promise.all(this.workers.splice(0).map((worker) => worker.close()));
  }

  async close(): Promise<void> {
    await this.stop();
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }
}
