import type { AuditEvent } from "@ai-office/domain/event/audit-event.ts";

export interface AuditEventRepository {
  append(event: AuditEvent): Promise<void>;
}
