import { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import type { AuditEventRepository } from "../ports/audit-event-repository.port.ts";
import type { Clock } from "../ports/clock.port.ts";
import type { IdGenerator } from "../ports/id-generator.port.ts";

export class RecordAuditEvent {
  constructor(
    private readonly events: AuditEventRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock
  ) {}

  async execute(input: {
    eventType: string;
    actorType: "daemon" | "cli" | "system";
    actorId?: string;
    aggregateType?: string;
    aggregateId?: string;
    projectId?: string;
    payload?: Readonly<Record<string, unknown>>;
  }): Promise<string> {
    const event = AuditEvent.create({
      id: this.ids.generate(),
      eventType: input.eventType,
      actorType: input.actorType,
      ...(input.actorId === undefined ? {} : { actorId: input.actorId }),
      ...(input.aggregateType === undefined ? {} : { aggregateType: input.aggregateType }),
      ...(input.aggregateId === undefined ? {} : { aggregateId: input.aggregateId }),
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      payload: input.payload ?? {},
      occurredAt: this.clock.now()
    });

    await this.events.append(event);
    return event.snapshot().id;
  }
}
