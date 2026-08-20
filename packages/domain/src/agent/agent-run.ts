import { DomainValidationError } from "../errors.ts";
import {
  normalizeCanonicalJson,
  type CanonicalJsonValue,
} from "../capability/canonical-json.ts";

export type AgentRunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "reviewing"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentRunProps {
  id: string;
  projectId: string;
  taskId: string;
  agentId: string;
  actionIntent?: AgentActionIntent;
  status: AgentRunStatus;
  worktreePath?: string;
  result?: unknown;
  error?: unknown;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
}

export interface AgentActionIntent {
  resourceId: string;
  operation: string;
  arguments: Readonly<Record<string, CanonicalJsonValue>>;
}

export interface AgentActionIntentInput {
  resourceId: string;
  operation: string;
  arguments: Readonly<Record<string, unknown>>;
}

function normalizeActionIntent(intent: AgentActionIntentInput): AgentActionIntent {
  const resourceId = intent.resourceId.trim();
  const operation = intent.operation.trim();
  if (resourceId === "" || operation === "")
    throw new DomainValidationError(
      "Agent action resource and operation cannot be empty",
    );
  const arguments_ = normalizeCanonicalJson(intent.arguments);
  if (
    typeof arguments_ !== "object" ||
    arguments_ === null ||
    Array.isArray(arguments_)
  )
    throw new DomainValidationError("Agent action arguments must be an object");
  return Object.freeze({
    resourceId,
    operation,
    arguments: arguments_ as Readonly<Record<string, CanonicalJsonValue>>,
  });
}

const transitions: Record<AgentRunStatus, readonly AgentRunStatus[]> = {
  queued: ["preparing", "cancelled"],
  preparing: ["running", "failed", "cancelled"],
  running: ["reviewing", "completed", "failed", "cancelled"],
  reviewing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export class AgentRun {
  private constructor(private props: AgentRunProps) {}

  static create(input: {
    id: string;
    projectId: string;
    taskId: string;
    agentId: string;
    actionIntent?: AgentActionIntentInput;
    now: Date;
  }): AgentRun {
    for (const value of [
      input.id,
      input.projectId,
      input.taskId,
      input.agentId,
    ]) {
      if (value.trim() === "")
        throw new DomainValidationError(
          "Agent run identifiers cannot be empty",
        );
    }
    const { now, actionIntent, ...identifiers } = input;
    return new AgentRun({
      ...identifiers,
      ...(actionIntent === undefined
        ? {}
        : { actionIntent: normalizeActionIntent(actionIntent) }),
      status: "queued",
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: AgentRunProps): AgentRun {
    return new AgentRun({
      ...props,
      ...(props.actionIntent === undefined
        ? {}
        : { actionIntent: normalizeActionIntent(props.actionIntent) }),
    });
  }

  transition(
    status: AgentRunStatus,
    now: Date,
    details: { worktreePath?: string; result?: unknown; error?: unknown } = {},
  ): void {
    if (!transitions[this.props.status].includes(status)) {
      throw new DomainValidationError(
        `Cannot transition agent run from ${this.props.status} to ${status}`,
      );
    }
    this.props = {
      ...this.props,
      ...(this.props.actionIntent === undefined
        ? {}
        : { actionIntent: this.props.actionIntent }),
      ...details,
      status,
      ...(status === "running" && this.props.startedAt === undefined
        ? { startedAt: now }
        : {}),
      ...(["completed", "failed", "cancelled"].includes(status)
        ? { completedAt: now }
        : {}),
      updatedAt: now,
    };
  }

  snapshot(): AgentRunProps {
    return {
      ...this.props,
      createdAt: new Date(this.props.createdAt),
      ...(this.props.startedAt === undefined
        ? {}
        : { startedAt: new Date(this.props.startedAt) }),
      ...(this.props.completedAt === undefined
        ? {}
        : { completedAt: new Date(this.props.completedAt) }),
      updatedAt: new Date(this.props.updatedAt),
    };
  }
}
