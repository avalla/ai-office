import type { QueueJobType } from "./job-queue.port.ts";

export interface JobOutboxRecord {
  id: string;
  projectId: string;
  jobType: QueueJobType;
  aggregateType: "pipeline_run" | "agent_run";
  aggregateId: string;
  dedupeKey: string;
  payload: Readonly<Record<string, unknown>>;
  availableAt: Date;
  attemptCount: number;
  dispatchedAt?: Date;
  createdAt: Date;
}

export interface JobOutboxRepository {
  append(input: {
    id: string;
    projectId: string;
    jobType: QueueJobType;
    aggregateType: JobOutboxRecord["aggregateType"];
    aggregateId: string;
    dedupeKey: string;
    payload: Readonly<Record<string, unknown>>;
    availableAt: Date;
    createdAt: Date;
  }): Promise<boolean>;
  pending(now: Date, limit: number): Promise<JobOutboxRecord[]>;
  /** Active authoritative work that may need reconstruction after queue loss. */
  replayable(limit: number): Promise<JobOutboxRecord[]>;
  markDispatched(id: string, dispatchedAt: Date): Promise<boolean>;
  markFailed(id: string, availableAt: Date): Promise<boolean>;
  pendingCount(): Promise<number>;
}
