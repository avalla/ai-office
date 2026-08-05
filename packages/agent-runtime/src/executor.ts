import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";

export interface AgentExecutionResult {
  summary: string;
  artifacts: string[];
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
