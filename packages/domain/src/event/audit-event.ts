import { DomainValidationError } from "../errors.ts";

export interface AuditEventProps {
  id: string;
  eventType: string;
  actorType: "daemon" | "cli" | "system";
  actorId?: string;
  aggregateType?: string;
  aggregateId?: string;
  projectId?: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}

export class AuditEvent {
  private constructor(private readonly props: AuditEventProps) {}

  static create(props: AuditEventProps): AuditEvent {
    if (props.eventType.trim().length === 0) {
      throw new DomainValidationError("Audit event type cannot be empty");
    }

    return new AuditEvent({
      ...props,
      eventType: props.eventType.trim(),
      payload: { ...props.payload },
      occurredAt: new Date(props.occurredAt)
    });
  }

  snapshot(): AuditEventProps {
    return {
      ...this.props,
      payload: { ...this.props.payload },
      occurredAt: new Date(this.props.occurredAt)
    };
  }
}
