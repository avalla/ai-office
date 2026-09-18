import type { AiOfficeRuntime } from "@ai-office/application/runtime/ai-office-runtime.ts";
import { DispatchJobOutbox } from "@ai-office/application/queue/dispatch-job-outbox.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { JobOutboxRepository } from "@ai-office/application/ports/job-outbox-repository.port.ts";
import type {
  JobQueue,
  QueueJob,
} from "@ai-office/application/ports/job-queue.port.ts";
import type {
  JobQueueConsumer,
  QueueJobHandler,
  QueueJobDisposition,
} from "@ai-office/application/ports/job-worker.port.ts";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function payload(value: QueueJob["payload"], key: string): string | null {
  return text(value[key]);
}

/** Daemon-owned delivery lifecycle; SQLite remains the only input to commands. */
export class QueueRuntime {
  private timer: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private stopping = false;
  private readonly dispatcher: DispatchJobOutbox;

  constructor(
    private readonly runtime: AiOfficeRuntime,
    outbox: JobOutboxRepository,
    private readonly queue: JobQueue & JobQueueConsumer,
    clock: Clock,
    private readonly worker?: "claude" | "gateway",
  ) {
    this.dispatcher = new DispatchJobOutbox(outbox, queue, clock);
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    await this.dispatcher.dispatch();
    await this.dispatcher.replay();
    await this.queue.start(this.handler());
    this.timer = setInterval(() => {
      void this.dispatcher.dispatch();
      void this.dispatcher.replay();
    }, 250);
  }

  async stop(): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    await this.queue.stop();
    await this.queue.close();
  }

  private handler(): QueueJobHandler {
    return { process: (job) => this.process(job) };
  }

  private async process(job: QueueJob): Promise<QueueJobDisposition> {
    if (this.stopping) return "terminal";
    const projectId = payload(job.payload, "projectId");
    const runId =
      payload(job.payload, "pipelineRunId") ?? payload(job.payload, "runId");
    const stageRunId = payload(job.payload, "pipelineStageRunId");
    if (
      projectId === null ||
      runId === null ||
      (job.type === "orchestrate_pipeline" && stageRunId === null)
    )
      return "terminal";
    const args =
      job.type === "orchestrate_pipeline"
        ? [
            "pipeline:orchestrate",
            "--project",
            projectId,
            "--run",
            runId,
            "--stage-run",
            stageRunId!,
          ]
        : [
            "run:tick",
            "--project",
            projectId,
            "--run",
            runId,
            ...(this.worker === undefined ? [] : ["--worker", this.worker]),
          ];
    const result = await this.runtime.execute({ args });
    if (result.exitCode !== 0) {
      const diagnostic = result.stderr.join(" ").trim();
      if (diagnostic !== "") console.error("Queue command failed:", diagnostic);
    }
    return result.exitCode === 0 ? "completed" : "terminal";
  }
}
