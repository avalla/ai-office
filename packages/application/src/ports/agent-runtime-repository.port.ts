import type { Agent } from "@ai-office/domain/agent/agent.ts";
import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { Role } from "@ai-office/domain/agent/role.ts";

export interface AgentRunEvent {
  runId: string;
  status: ReturnType<AgentRun["snapshot"]>["status"];
  payload: { hasResult: boolean; hasError: boolean };
  occurredAt: Date;
}

export interface AgentRuntimeRepository {
  saveRole(role: Role): Promise<void>;
  saveAgent(agent: Agent): Promise<void>;
  listAgents(projectId: string): Promise<Agent[]>;
  findAgent(agentId: string): Promise<Agent | null>;
  saveRun(run: AgentRun): Promise<void>;
  findRun(runId: string): Promise<AgentRun | null>;
  listRuns(projectId: string): Promise<AgentRun[]>;
  listQueuedRuns(projectId: string, limit: number): Promise<AgentRun[]>;
  listRecoverableRuns(projectId: string): Promise<AgentRun[]>;
  listRunEvents(runId: string): Promise<AgentRunEvent[]>;
  acquireTaskLock(
    taskId: string,
    runId: string,
    acquiredAt: Date,
    expiresAt: Date,
  ): Promise<boolean>;
  renewTaskLock(runId: string, now: Date, newExpiresAt: Date): Promise<boolean>;
  releaseTaskLock(runId: string): Promise<boolean>;
}
