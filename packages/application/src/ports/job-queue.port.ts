import type { CanonicalJsonValue } from "@ai-office/domain/capability/canonical-json.ts";

export type QueueJobType = "orchestrate_pipeline" | "execute_agent_run";

export interface QueueJob {
  type: QueueJobType;
  jobId: string;
  payload: Readonly<Record<string, CanonicalJsonValue>>;
}

export interface QueueEnqueueResult {
  accepted: boolean;
  duplicate: boolean;
}

/** Delivery only. Queue state never establishes application authority. */
export interface JobQueue {
  enqueue(job: QueueJob): Promise<QueueEnqueueResult>;
  health(): Promise<"reachable" | "unreachable">;
  close(): Promise<void>;
}
