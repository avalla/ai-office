import { normalizeCanonicalJson } from "@ai-office/domain/capability/canonical-json.ts";
import type { Clock } from "../ports/clock.port.ts";
import type {
  JobOutboxRecord,
  JobOutboxRepository,
} from "../ports/job-outbox-repository.port.ts";
import type { JobQueue } from "../ports/job-queue.port.ts";

const maxDispatchBatch = 50;
const maxBackoffMs = 60_000;

function jobId(record: JobOutboxRecord): string {
  if (record.jobType === "execute_agent_run")
    return `agent-run-${record.aggregateId}`;
  return `pipeline-orchestration-${record.aggregateId}-${record.dedupeKey}`.replaceAll(
    ":",
    "-",
  );
}

function retryAt(now: Date, attemptCount: number): Date {
  const exponent = Math.min(Math.max(attemptCount, 0), 6);
  return new Date(now.getTime() + Math.min(1000 * 2 ** exponent, maxBackoffMs));
}

/** Publishes durable delivery intents. It never changes authoritative state. */
export class DispatchJobOutbox {
  constructor(
    private readonly outbox: JobOutboxRepository,
    private readonly queue: JobQueue,
    private readonly clock: Clock,
  ) {}

  async dispatch(limit = maxDispatchBatch): Promise<number> {
    const now = this.clock.now();
    const pending = await this.outbox.pending(now, limit);
    let dispatched = 0;
    for (const record of pending) {
      try {
        await this.queue.enqueue({
          type: record.jobType,
          jobId: jobId(record),
          payload: normalizeCanonicalJson(record.payload) as Readonly<
            Record<
              string,
              import("@ai-office/domain/capability/canonical-json.ts").CanonicalJsonValue
            >
          >,
        });
        if (await this.outbox.markDispatched(record.id, this.clock.now()))
          dispatched += 1;
      } catch {
        // Delivery failures are the only failures retried here. Execution
        // ambiguity and stale authority are classified by the worker.
        await this.outbox.markFailed(
          record.id,
          retryAt(this.clock.now(), record.attemptCount),
        );
      }
    }
    return dispatched;
  }

  async replay(limit = maxDispatchBatch): Promise<number> {
    const candidates = await this.outbox.replayable(limit);
    let accepted = 0;
    for (const record of candidates) {
      try {
        await this.queue.enqueue({
          type: record.jobType,
          jobId: jobId(record),
          payload: normalizeCanonicalJson(record.payload) as Readonly<
            Record<
              string,
              import("@ai-office/domain/capability/canonical-json.ts").CanonicalJsonValue
            >
          >,
        });
        accepted += 1;
      } catch {
        // A later dispatcher tick retries while SQLite retains the active or
        // queued authoritative state.
      }
    }
    return accepted;
  }
}
