import type { Database } from "bun:sqlite";
import { canonicalStringify } from "@ai-office/domain/capability/canonical-json.ts";
import { assertNoSensitiveFields } from "@ai-office/domain/capability/sensitive-fields.ts";
import { DomainValidationError } from "@ai-office/domain/errors.ts";
import type {
  JobOutboxRecord,
  JobOutboxRepository,
} from "@ai-office/application/ports/job-outbox-repository.port.ts";
import type { QueueJobType } from "@ai-office/application/ports/job-queue.port.ts";

interface OutboxRow {
  id: string;
  project_id: string;
  job_type: string;
  aggregate_type: JobOutboxRecord["aggregateType"];
  aggregate_id: string;
  pipeline_stage_run_id: string | null;
  dedupe_key: string;
  payload_json: string;
  available_at: string;
  attempt_count: number;
  dispatched_at: string | null;
  created_at: string;
}

function jobType(value: string): QueueJobType {
  if (value === "orchestrate_pipeline" || value === "execute_agent_run")
    return value;
  throw new DomainValidationError("Stored outbox job type is invalid");
}

function record(row: OutboxRow): JobOutboxRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    jobType: jobType(row.job_type),
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    ...(row.pipeline_stage_run_id === null
      ? {}
      : { pipelineStageRunId: row.pipeline_stage_run_id }),
    dedupeKey: row.dedupe_key,
    payload: JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>,
    availableAt: new Date(row.available_at),
    attemptCount: row.attempt_count,
    ...(row.dispatched_at === null
      ? {}
      : { dispatchedAt: new Date(row.dispatched_at) }),
    createdAt: new Date(row.created_at),
  };
}

export class SqliteJobOutboxRepository implements JobOutboxRepository {
  constructor(private readonly database: Database) {}

  async append(
    input: Parameters<JobOutboxRepository["append"]>[0],
  ): Promise<boolean> {
    assertNoSensitiveFields(input.payload, "Job outbox payload");
    const payload = canonicalStringify(input.payload);
    if (new TextEncoder().encode(payload).byteLength > 4096)
      throw new DomainValidationError("Job outbox payload is too large");
    const result = this.database
      .prepare(
        `INSERT INTO job_outbox(
          id, project_id, job_type, aggregate_type, aggregate_id,
          pipeline_stage_run_id, dedupe_key, payload_json, available_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, dedupe_key) DO NOTHING`,
      )
      .run(
        input.id,
        input.projectId,
        input.jobType,
        input.aggregateType,
        input.aggregateId,
        input.pipelineStageRunId ?? null,
        input.dedupeKey,
        payload,
        input.availableAt.toISOString(),
        input.createdAt.toISOString(),
      );
    return result.changes === 1;
  }

  async pending(now: Date, limit: number): Promise<JobOutboxRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new DomainValidationError("Outbox limit is invalid");
    return this.database
      .query<OutboxRow, [string, number]>(
        `SELECT id, project_id, job_type, aggregate_type, aggregate_id,
          pipeline_stage_run_id, dedupe_key, payload_json, available_at,
          attempt_count, dispatched_at, created_at
         FROM job_outbox
         WHERE dispatched_at IS NULL AND available_at <= ?
         ORDER BY created_at, id LIMIT ?`,
      )
      .all(now.toISOString(), limit)
      .map(record);
  }

  async replayable(limit: number): Promise<JobOutboxRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new DomainValidationError("Outbox replay limit is invalid");
    return this.database
      .query<OutboxRow, [number]>(
        `SELECT jo.id, jo.project_id, jo.job_type, jo.aggregate_type,
          jo.aggregate_id, jo.pipeline_stage_run_id, jo.dedupe_key,
          jo.payload_json, jo.available_at, jo.attempt_count, jo.dispatched_at,
          jo.created_at
         FROM job_outbox jo
         WHERE jo.dispatched_at IS NOT NULL AND (
           (jo.job_type = 'execute_agent_run' AND EXISTS (
             SELECT 1 FROM agent_run ar
             WHERE ar.project_id = jo.project_id AND ar.id = jo.aggregate_id
               AND ar.pipeline_stage_run_id IS jo.pipeline_stage_run_id
               AND ar.status = 'queued'
           )) OR (jo.job_type = 'orchestrate_pipeline' AND
             jo.pipeline_stage_run_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM pipeline_run pr
             JOIN pipeline_stage_run psr
               ON psr.project_id = pr.project_id AND psr.pipeline_run_id = pr.id
              AND psr.id = jo.pipeline_stage_run_id
             WHERE pr.project_id = jo.project_id AND pr.id = jo.aggregate_id
               AND pr.status = 'active' AND psr.status = 'active'
               AND (
                 NOT EXISTS (
                   SELECT 1 FROM agent_run ar
                   WHERE ar.project_id = jo.project_id
                     AND ar.pipeline_stage_run_id = psr.id
                 ) OR EXISTS (
                   SELECT 1 FROM agent_run ar
                   WHERE ar.project_id = jo.project_id
                     AND ar.pipeline_stage_run_id = psr.id
                     AND ar.status = 'completed'
                 )
               )
           ))
         )
         ORDER BY jo.created_at, jo.id LIMIT ?`,
      )
      .all(limit)
      .map(record);
  }

  async markDispatched(id: string, dispatchedAt: Date): Promise<boolean> {
    return (
      this.database
        .prepare(
          "UPDATE job_outbox SET dispatched_at=? WHERE id=? AND dispatched_at IS NULL",
        )
        .run(dispatchedAt.toISOString(), id).changes === 1
    );
  }

  async markFailed(id: string, availableAt: Date): Promise<boolean> {
    return (
      this.database
        .prepare(
          "UPDATE job_outbox SET attempt_count=attempt_count+1, available_at=? WHERE id=? AND dispatched_at IS NULL",
        )
        .run(availableAt.toISOString(), id).changes === 1
    );
  }

  async pendingCount(): Promise<number> {
    return (
      this.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM job_outbox WHERE dispatched_at IS NULL",
        )
        .get()?.count ?? 0
    );
  }
}
