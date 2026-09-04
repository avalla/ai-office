/**
 * Principal established by an application boundary.
 *
 * In the trusted-local single-user model, local client commands receive the
 * application operator role. This is routing inside AI Office, not
 * authentication of a human or of one same-UID process against another. Agent
 * principals are intentionally run-bound so callers cannot manufacture
 * authority by supplying an arbitrary agent identifier.
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
