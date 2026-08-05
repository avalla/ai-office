import type { Database } from "bun:sqlite";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type { AuditEvent } from "@ai-office/domain/event/audit-event.ts";

export class SqliteAuditEventRepository implements AuditEventRepository {
  constructor(private readonly database: Database) {}

  async append(event: AuditEvent): Promise<void> {
    const value = event.snapshot();
    this.database
      .prepare(
        `INSERT INTO audit_event(
           id, project_id, event_type, actor_type, actor_id,
           aggregate_type, aggregate_id, payload_json, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        value.id,
        value.projectId ?? null,
        value.eventType,
        value.actorType,
        value.actorId ?? null,
        value.aggregateType ?? null,
        value.aggregateId ?? null,
        JSON.stringify(value.payload),
        value.occurredAt.toISOString()
      );
  }
}
