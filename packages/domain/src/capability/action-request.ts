import type { PolicyDecisionKind, RiskLevel } from "./capability.ts";
import { normalizeCanonicalJson } from "./canonical-json.ts";
import {
  CapabilityValidationError,
  InvalidActionTransitionError,
  InvalidActionTimestampError,
} from "./errors.ts";

export type ActionStatus =
  | "requested"
  | "authorized"
  | "denied"
  | "simulating"
  | "simulated"
  | "approval_pending"
  | "approved"
  | "rejected"
  | "executing"
  | "completed"
  | "failed"
  | "cancelled"
  | "expired";

export type ActionOperationMode = "read" | "mutation";

export interface CanonicalActionPayload {
  schemaVersion: 1;
  projectId: string;
  agentId: string;
  resourceId: string;
  connector: string;
  connectorVersion: string;
  operation: string;
  normalizedArguments: unknown;
  effectiveConstraints: unknown;
}

export interface ActionRequestProps {
  id: string;
  projectId: string;
  agentId: string;
  resourceId: string;
  connector: string;
  connectorVersion: string;
  operation: string;
  normalizedArguments: unknown;
  effectiveConstraints: unknown;
  payloadHash: string;
  decision: PolicyDecisionKind;
  riskLevel: RiskLevel;
  matchedGrantIds: readonly string[];
  reasons: readonly string[];
  status: ActionStatus;
  createdAt: Date;
  updatedAt: Date;
}

const transitions: Record<ActionStatus, readonly ActionStatus[]> = {
  requested: ["authorized", "denied"],
  authorized: ["simulating", "executing"],
  denied: [],
  simulating: ["simulated", "failed"],
  simulated: ["approval_pending"],
  approval_pending: [],
  approved: [],
  rejected: [],
  executing: ["completed", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
  expired: [],
};

function isDecisionStatusCompatible(
  decision: PolicyDecisionKind,
  status: ActionStatus,
): boolean {
  if (decision === "deny") return status === "requested" || status === "denied";
  if (status === "denied") return false;
  if (status === "executing" || status === "completed")
    return decision === "allow";
  if (status === "simulating" || status === "simulated")
    return (
      decision === "allow_simulation_only" || decision === "allow_with_approval"
    );
  if (status === "approval_pending") return decision === "allow_with_approval";
  return true;
}

export class ActionRequest {
  private constructor(private props: ActionRequestProps) {}

  static create(
    input: Omit<ActionRequestProps, "status" | "createdAt" | "updatedAt"> & {
      now: Date;
    },
  ): ActionRequest {
    for (const value of [
      input.id,
      input.projectId,
      input.agentId,
      input.resourceId,
      input.operation,
    ]) {
      if (value.trim().length === 0)
        throw new CapabilityValidationError(
          "Action request identifiers and operation cannot be empty",
        );
    }
    if (!Number.isFinite(input.now.getTime()))
      throw new InvalidActionTimestampError();
    return new ActionRequest({
      ...input,
      normalizedArguments: normalizeCanonicalJson(input.normalizedArguments),
      effectiveConstraints: normalizeCanonicalJson(input.effectiveConstraints),
      matchedGrantIds: Object.freeze([...input.matchedGrantIds]),
      reasons: Object.freeze([...input.reasons]),
      status: "requested",
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: ActionRequestProps): ActionRequest {
    if (!isDecisionStatusCompatible(props.decision, props.status))
      throw new InvalidActionTransitionError("requested", props.status);
    return new ActionRequest({
      ...props,
      normalizedArguments: normalizeCanonicalJson(props.normalizedArguments),
      effectiveConstraints: normalizeCanonicalJson(props.effectiveConstraints),
      matchedGrantIds: Object.freeze([...props.matchedGrantIds]),
      reasons: Object.freeze([...props.reasons]),
    });
  }

  transition(
    status: ActionStatus,
    now: Date,
    operationMode?: ActionOperationMode,
    requiresApproval = false,
  ): void {
    if (!transitions[this.props.status].includes(status))
      throw new InvalidActionTransitionError(this.props.status, status);
    if (!isDecisionStatusCompatible(this.props.decision, status))
      throw new InvalidActionTransitionError(this.props.status, status);
    if (this.props.status === "authorized") {
      const validReadLease =
        status === "executing" &&
        operationMode === "read" &&
        !requiresApproval &&
        this.props.decision === "allow";
      const validMutationLease =
        status === "simulating" &&
        operationMode === "mutation" &&
        (requiresApproval
          ? this.props.decision === "allow_with_approval"
          : this.props.decision === "allow_simulation_only");
      if (!validReadLease && !validMutationLease)
        throw new InvalidActionTransitionError(this.props.status, status);
    }
    if (
      this.props.status === "simulated" &&
      status === "approval_pending" &&
      (this.props.decision !== "allow_with_approval" || !requiresApproval)
    )
      throw new InvalidActionTransitionError(this.props.status, status);
    if (
      !Number.isFinite(now.getTime()) ||
      now.getTime() < this.props.updatedAt.getTime()
    )
      throw new InvalidActionTimestampError();
    this.props = { ...this.props, status, updatedAt: now };
  }

  canonicalPayload(): CanonicalActionPayload {
    return {
      schemaVersion: 1,
      projectId: this.props.projectId,
      agentId: this.props.agentId,
      resourceId: this.props.resourceId,
      connector: this.props.connector,
      connectorVersion: this.props.connectorVersion,
      operation: this.props.operation,
      normalizedArguments: this.props.normalizedArguments,
      effectiveConstraints: this.props.effectiveConstraints,
    };
  }

  snapshot(): ActionRequestProps {
    return {
      ...this.props,
      matchedGrantIds: [...this.props.matchedGrantIds],
      reasons: [...this.props.reasons],
      createdAt: new Date(this.props.createdAt),
      updatedAt: new Date(this.props.updatedAt),
    };
  }
}
