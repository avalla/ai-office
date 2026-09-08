import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { ActionStatus } from "@ai-office/domain/capability/action-request.ts";
import type { AgentExecutionProvenance } from "@ai-office/domain/agent/agent-execution.ts";

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

export type ControlledActionTimeout = (
  run: AgentRun,
) => number | Promise<number>;

export interface AgentExecutionResult {
  summary: string;
  artifacts: string[];
  actions?: AgentControlledActionResult[];
  workerOutput?: unknown;
}
export interface AgentExecutor {
  prepare?(run: AgentRun): Promise<PreparedAgentExecution>;
  execute(run: AgentRun, signal?: AbortSignal): Promise<AgentExecutionResult>;
}

export interface PreparedAgentExecution {
  provenance: AgentExecutionProvenance;
  usesWorktree: boolean;
  execute(signal?: AbortSignal): Promise<AgentExecutionResult>;
  accept?(
    run: AgentRun,
    result: AgentExecutionResult,
    acceptedAt: Date,
  ): Promise<void>;
}

export class AgentExecutorNotConfiguredError extends Error {
  constructor() {
    super(
      "No real worker selected. Select a worker or explicitly request simulation.",
    );
    this.name = "AgentExecutorNotConfiguredError";
  }
}

export class UnconfiguredAgentExecutor implements AgentExecutor {
  async prepare(): Promise<PreparedAgentExecution> {
    throw new AgentExecutorNotConfiguredError();
  }
  async execute(): Promise<AgentExecutionResult> {
    throw new AgentExecutorNotConfiguredError();
  }
}

export class SimulatedAgentExecutor implements AgentExecutor {
  async prepare(run: AgentRun): Promise<PreparedAgentExecution> {
    return {
      provenance: {
        kind: "simulation",
        adapterId: "simulated",
        adapterVersion: "1",
      },
      usesWorktree: false,
      execute: (signal) => this.execute(run, signal),
    };
  }
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
    private readonly fallback: AgentExecutor = new UnconfiguredAgentExecutor(),
    private readonly timeoutForRun: ControlledActionTimeout = () => 30_000,
  ) {}

  async prepare(run: AgentRun): Promise<PreparedAgentExecution> {
    if (run.snapshot().actionIntent === undefined) {
      if (this.fallback.prepare !== undefined)
        return this.fallback.prepare(run);
      throw new AgentExecutorNotConfiguredError();
    }
    return {
      provenance: {
        kind: "controlled_action",
        adapterId: "controlled-action",
        adapterVersion: "1",
      },
      usesWorktree: false,
      execute: (signal) => this.execute(run, signal),
    };
  }

  async execute(
    run: AgentRun,
    signal?: AbortSignal,
  ): Promise<AgentExecutionResult> {
    const snapshot = run.snapshot();
    const intent = snapshot.actionIntent;
    if (intent === undefined) return this.fallback.execute(run, signal);
    if (signal?.aborted === true)
      throw new DOMException("Execution cancelled", "AbortError");
    const timeoutMs = await this.timeoutForRun(run);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      throw new Error("Controlled action timeout is invalid");
    const control = new AbortController();
    const abort = () => control.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => control.abort(), timeoutMs);
    if (signal?.aborted) abort();
    try {
      const action = await this.gateway.invoke({
        agentRunId: snapshot.id,
        signal: control.signal,
      });
      return {
        summary: `Controlled action ${action.requestId} reached ${action.status}`,
        artifacts: [`action:${action.requestId}`],
        actions: [action],
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}
