import { CapabilityValidationError } from "./errors.ts";

export type ActionApprovalStatus = "pending" | "approved" | "rejected";

export interface ActionApprovalProps {
  id: string;
  projectId: string;
  actionRequestId: string;
  simulationId: string;
  actionPayloadHash: string;
  simulationArtifactHash: string;
  connector: string;
  connectorVersion: string;
  operation: string;
  status: ActionApprovalStatus;
  requestedAt: Date;
  decidedAt?: Date;
  actor?: string;
}

function validHash(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function assertIdentifier(value: string): void {
  if (value.trim().length === 0 || value.trim() !== value)
    throw new CapabilityValidationError(
      "Action approval identifiers must be canonical and non-empty",
    );
}

function normalize(props: ActionApprovalProps): ActionApprovalProps {
  for (const value of [
    props.id,
    props.projectId,
    props.actionRequestId,
    props.simulationId,
    props.connector,
    props.connectorVersion,
    props.operation,
  ])
    assertIdentifier(value);
  if (
    !validHash(props.actionPayloadHash) ||
    !validHash(props.simulationArtifactHash)
  )
    throw new CapabilityValidationError("Action approval hash is invalid");
  if (!Number.isFinite(props.requestedAt.getTime()))
    throw new CapabilityValidationError("Action approval timestamp is invalid");
  if (props.status === "pending") {
    if (props.decidedAt !== undefined || props.actor !== undefined)
      throw new CapabilityValidationError(
        "Pending action approval cannot have a decision",
      );
  } else {
    if (
      props.decidedAt === undefined ||
      !Number.isFinite(props.decidedAt.getTime()) ||
      props.decidedAt.getTime() < props.requestedAt.getTime() ||
      props.actor === undefined ||
      props.actor.trim().length === 0
    )
      throw new CapabilityValidationError(
        "Decided action approval requires actor and monotonic timestamp",
      );
  }
  return {
    ...props,
    requestedAt: new Date(props.requestedAt),
    ...(props.decidedAt === undefined
      ? {}
      : { decidedAt: new Date(props.decidedAt) }),
  };
}

export class ActionApproval {
  private constructor(private props: ActionApprovalProps) {}

  static request(
    props: Omit<
      ActionApprovalProps,
      "status" | "requestedAt" | "decidedAt" | "actor"
    > & { now: Date },
  ): ActionApproval {
    return new ActionApproval(
      normalize({
        ...props,
        status: "pending",
        requestedAt: props.now,
      }),
    );
  }

  static restore(props: ActionApprovalProps): ActionApproval {
    return new ActionApproval(normalize(props));
  }

  approve(actor: string, now: Date): void {
    this.decide("approved", actor, now);
  }

  reject(actor: string, now: Date): void {
    this.decide("rejected", actor, now);
  }

  private decide(
    status: Exclude<ActionApprovalStatus, "pending">,
    actor: string,
    now: Date,
  ): void {
    if (this.props.status !== "pending")
      throw new CapabilityValidationError("Action approval is already decided");
    this.props = normalize({
      ...this.props,
      status,
      decidedAt: now,
      actor,
    });
  }

  snapshot(): ActionApprovalProps {
    return {
      ...this.props,
      requestedAt: new Date(this.props.requestedAt),
      ...(this.props.decidedAt === undefined
        ? {}
        : { decidedAt: new Date(this.props.decidedAt) }),
    };
  }
}
