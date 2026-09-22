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
    if (value.projectId === undefined)
      throw new PostgresTenantScopeError("AuditEvent", value.id);
    const rows = await this.database.query<{ id: string }>(
      `
      INSERT INTO core.audit_event(
        id, project_id, event_type, actor_type, actor_id,
        aggregate_type, aggregate_id, payload_json, occurred_at
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9
      FROM core.project AS project
      WHERE project.id = $2 AND project.tenant_id = $10
      RETURNING id
    `,
      [
        value.id,
        value.projectId,
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

/** Explicit host authority for host-global audit only. */
export class PostgresHostAuditEventRepository implements AuditEventRepository {
  constructor(private readonly database: PostgresClient) {}

  async append(event: AuditEvent): Promise<void> {
    const value = event.snapshot();
    if (value.projectId !== undefined)
      throw new PostgresTenantScopeError("HostAuditEvent", value.id);
    await this.database.query(
      `
      INSERT INTO core.audit_event(
        id, project_id, event_type, actor_type, actor_id,
        aggregate_type, aggregate_id, payload_json, occurred_at
      ) VALUES ($1, NULL, $2, $3, $4, $5, $6, $7::jsonb, $8)
      `,
      [
        value.id,
        value.eventType,
        value.actorType,
        value.actorId ?? null,
        value.aggregateType ?? null,
        value.aggregateId ?? null,
        value.payload,
        value.occurredAt,
      ],
    );
  }
}
