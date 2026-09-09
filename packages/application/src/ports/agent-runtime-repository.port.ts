import type { Agent } from "@ai-office/domain/agent/agent.ts";
import type { AgentExecutionProvenance } from "@ai-office/domain/agent/agent-execution.ts";
import type { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { Role } from "@ai-office/domain/agent/role.ts";
import type { AgentExecutionResult } from "@ai-office/agent-runtime/executor.ts";

export interface WorkerAuthorityFence {
  runId: string;
  projectId: string;
  taskId: string;
  taskStatus: string;
  taskUpdatedAt: Date;
  agentId: string;
  agentRoleId: string;
  agentUpdatedAt: Date;
  roleId: string;
  roleKey: string;
  roleVersion: number;
  roleLimits: {
    maxIterations: number;
    maxCostMicros: bigint;
    timeoutSeconds: number;
  };
  roleUpdatedAt: Date;
  pipeline: {
    id: string;
    version: number;
    currentStageIndex: number;
    stageId: string;
    stageRoleId: string;
    assignedAgentId: string;
  } | null;
  execution: AgentExecutionProvenance;
}

export interface AgentRunEvent {
  runId: string;
  status: ReturnType<AgentRun["snapshot"]>["status"];
  payload: { hasResult: boolean; hasError: boolean };
  occurredAt: Date;
}

export interface AgentRuntimeRepository {
  /** Atomic queued-state CAS and event; observed authority must still match. */
  admitQueuedRun(input: RunAdmission): Promise<AgentRun | null>;
  executionOwner(runId: string): Promise<string | null>;
  findTaskLock(
    taskId: string,
  ): Promise<{ runId: string; expiresAt: Date } | null>;
  saveRole(role: Role): Promise<void>;
  findRole(roleId: string, projectId: string): Promise<Role | null>;
  saveAgent(agent: Agent): Promise<void>;
  listAgents(projectId: string): Promise<Agent[]>;
  findAgent(agentId: string): Promise<Agent | null>;
  saveRun(run: AgentRun): Promise<void>;
  /** Atomically validates worker authority and publishes the result as reviewing. */
  acceptWorkerResult(input: {
    fence: WorkerAuthorityFence;
    run: AgentRun;
    result: AgentExecutionResult;
    acceptedAt: Date;
  }): Promise<boolean>;
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

export interface RunAdmission {
  runId: string;
  ownerId?: string;
  now: Date;
  authority: null | {
    taskStatus: string;
    taskUpdatedAt: Date;
    agentRoleId: string;
    agentUpdatedAt: Date;
    pipelineId: string | null;
    pipelineVersion: number | null;
  };
}
