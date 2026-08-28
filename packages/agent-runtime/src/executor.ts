import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { ActionStatus } from "@ai-office/domain/capability/action-request.ts";

export type AgentControlledActionOutcome =
  "allowed" | "denied" | "simulation_required" | "approval_required";

export interface AgentControlledActionResult {
  requestId: string;
  outcome: AgentControlledActionOutcome;
  status: ActionStatus;
}

export interface AgentControlledActionGateway {
  invoke(input: {
    agentRunId: string;
    signal?: AbortSignal;
  }): Promise<AgentControlledActionResult>;
}

export interface AgentExecutionResult {
  summary: string;
  artifacts: string[];
  actions?: AgentControlledActionResult[];
}
export interface AgentExecutor {
  execute(run: AgentRun, signal?: AbortSignal): Promise<AgentExecutionResult>;
}

export class SimulatedAgentExecutor implements AgentExecutor {
  async execute(
    run: AgentRun,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    if (signal?.aborted === true)
      throw new DOMException("Execution cancelled", "AbortError");
    return {
      summary: `Simulated execution completed for run ${run.snapshot().id}`,
      artifacts: [],
    };
  }
}

export class ControlledActionAgentExecutor implements AgentExecutor {
  constructor(
    private readonly gateway: AgentControlledActionGateway,
    private readonly fallback: AgentExecutor = new SimulatedAgentExecutor(),
  ) {}

  async execute(
    run: AgentRun,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const snapshot = run.snapshot();
    const intent = snapshot.actionIntent;
    if (intent === undefined) return this.fallback.execute(run, signal);
    if (signal?.aborted === true)
      throw new DOMException("Execution cancelled", "AbortError");
    const action = await this.gateway.invoke({
      agentRunId: snapshot.id,
      ...(signal === undefined ? {} : { signal }),
    });
    return {
      summary: `Controlled action ${action.requestId} reached ${action.status}`,
      artifacts: [`action:${action.requestId}`],
      actions: [action],
    };
  }
}
