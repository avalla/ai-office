import type { QueueJob, QueueJobType } from "./job-queue.port.ts";

export type QueueJobDisposition =
  | "completed"
  | "retryable"
  | "terminal"
  | "requires_reconciliation"
  | "requires_approval";

export interface QueueJobHandler {
  process(job: QueueJob): Promise<QueueJobDisposition>;
}

export interface JobQueueConsumer {
  start(handler: QueueJobHandler): Promise<void>;
  stop(): Promise<void>;
  readonly consuming: Readonly<Record<QueueJobType, boolean>>;
}
