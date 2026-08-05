import { DomainValidationError } from "../errors.ts";

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
  status: AgentRunStatus;
  worktreePath?: string;
  result?: unknown;
  error?: unknown;
  createdAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt: Date;
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
    return new AgentRun({
      ...input,
      status: "queued",
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: AgentRunProps): AgentRun {
    return new AgentRun(props);
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
