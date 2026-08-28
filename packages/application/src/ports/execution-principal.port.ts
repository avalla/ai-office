/**
 * Principal established by an application boundary.
 *
 * The local CLI is the trusted single-user operator surface. Agent principals
 * are intentionally run-bound so an agent cannot manufacture authority by
 * supplying an arbitrary agent identifier.
 */
export interface OperatorPrincipal {
  readonly kind: "operator";
  readonly source: "local_cli";
  readonly id: "local-operator";
}

export interface AgentExecutionPrincipal {
  readonly kind: "agent";
  readonly agentRunId: string;
  /** Resolved from the persisted AgentRun; callers do not choose this value. */
  readonly agentId: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly pipelineRunId?: string;
}

export type ExecutionPrincipal = OperatorPrincipal | AgentExecutionPrincipal;

export const localOperatorPrincipal: OperatorPrincipal = Object.freeze({
  kind: "operator",
  source: "local_cli",
  id: "local-operator",
});
