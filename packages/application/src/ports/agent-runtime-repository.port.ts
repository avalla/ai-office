import type { Agent } from "@ai-office/domain/agent/agent.ts";
import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { Role } from "@ai-office/domain/agent/role.ts";

export interface AgentRuntimeRepository {
  saveRole(role: Role): Promise<void>;
  saveAgent(agent: Agent): Promise<void>;
  listAgents(projectId: string): Promise<Agent[]>;
  findAgent(agentId: string): Promise<Agent | null>;
  saveRun(run: AgentRun): Promise<void>;
  findRun(runId: string): Promise<AgentRun | null>;
  listRuns(projectId: string): Promise<AgentRun[]>;
  listQueuedRuns(projectId: string, limit: number): Promise<AgentRun[]>;
  acquireTaskLock(
    taskId: string,
    runId: string,
    acquiredAt: Date,
    expiresAt: Date,
  ): Promise<boolean>;
  releaseTaskLock(runId: string): Promise<void>;
}
