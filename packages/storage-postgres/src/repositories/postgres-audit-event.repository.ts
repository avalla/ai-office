import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import {
  PostgresTenantScopeError,
  requirePostgresTenantId,
} from "../database/postgres-tenant-context.ts";
import { PostgresClient } from "../database/postgres-client.ts";

export class PostgresAuditEventRepository implements AuditEventRepository {
  private readonly tenantId: string;

  constructor(
    private readonly database: PostgresClient,
    tenantId: string,
  ) {
    this.tenantId = requirePostgresTenantId(tenantId);
  }

  async append(event: AuditEvent): Promise<void> {
    const value = event.snapshot();
    const rows = await this.database.query<{ id: string }>(
      `
      INSERT INTO core.audit_event(
        id, project_id, event_type, actor_type, actor_id,
        aggregate_type, aggregate_id, payload_json, occurred_at
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9
      WHERE $2::text IS NULL OR EXISTS (
        SELECT 1 FROM core.project
        WHERE id = $2 AND tenant_id = $10
      )
      RETURNING id
    `,
      [
        value.id,
        value.projectId ?? null,
        value.eventType,
        value.actorType,
        value.actorId ?? null,
        value.aggregateType ?? null,
        value.aggregateId ?? null,
        value.payload,
        value.occurredAt,
        this.tenantId,
      ],
    );
    if (rows.length !== 1)
      throw new PostgresTenantScopeError("AuditEvent", value.id);
  }
}
