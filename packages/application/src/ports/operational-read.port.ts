/**
 * Read-side port for operational queries.
 *
 * The existing per-aggregate repositories answer single-project questions well
 * and remain the source for project detail. They cannot answer cross-project
 * roll-up questions without issuing one query per project per aggregate, so
 * this port adds bounded, purpose-built reads for exactly those cases plus the
 * joins (agent -> role, run -> task/agent, audit activity) that the write-side
 * repositories deliberately do not model.
 *
 * Records here are application-level values, not database rows: adapters own
 * the SQL and the schema stays out of the query contract.
 */

import type { AgentRunStatus } from "@ai-office/domain/agent/agent-run.ts";
import type {
  MilestoneStatus,
  RequirementStatus,
  ReviewStatus,
  ReviewSubjectType,
} from "@ai-office/domain/governance/governance.ts";
import type { PipelineStageRunStatus } from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { TaskStatus } from "@ai-office/domain/task/task.ts";

export interface OperationalProjectRecord {
  id: string;
  name: string;
  description: string | null;
  repositoryId: string | null;
  localPaths: readonly string[];
  remoteUrl: string | null;
  defaultBranch: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StatusCountRecord<TStatus extends string> {
  projectId: string;
  status: TStatus;
  count: number;
}

export interface RequirementCountRecord extends StatusCountRecord<RequirementStatus> {
  milestoneId: string | null;
}

export interface OperationalMilestoneRecord {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: MilestoneStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperationalAgentRecord {
  id: string;
  projectId: string;
  name: string;
  roleId: string;
  roleKey: string | null;
  roleName: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface OperationalAgentRunRecord {
  id: string;
  projectId: string;
  taskId: string;
  taskTitle: string | null;
  agentId: string;
  agentName: string | null;
  agentRoleId: string | null;
  agentRoleKey: string | null;
  pipelineRunId: string | null;
  status: AgentRunStatus;
  worktreePath: string | null;
  /** Raw persisted result. Callers must sanitize before publishing it. */
  result: unknown;
  /** Raw persisted error. Callers must sanitize before publishing it. */
  error: unknown;
  actionIntent: {
    resourceId: string;
    operation: string;
    argumentKeys: readonly string[];
  } | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface OperationalAgentRunEventRecord {
  runId: string;
  status: string;
  hasResult: boolean;
  hasError: boolean;
  occurredAt: Date;
}

export interface OperationalReviewRecord {
  id: string;
  projectId: string;
  subjectType: ReviewSubjectType;
  subjectId: string;
  reviewerActorType: "user" | "agent" | "system";
  reviewerActorId: string;
  reviewerDisplayName: string | null;
  status: ReviewStatus;
  summary: string | null;
  createdAt: Date;
  completedAt: Date | null;
  decision: {
    id: string;
    decision: "approved" | "rejected";
    actorType: "user" | "agent" | "system";
    actorId: string;
    displayName: string | null;
    rationale: string | null;
    createdAt: Date;
  } | null;
}

export interface OperationalActivityRecord {
  id: string;
  projectId: string | null;
  eventType: string;
  actorType: "daemon" | "cli" | "system";
  actorId: string | null;
  aggregateType: string | null;
  aggregateId: string | null;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
}

/**
 * A task whose persisted status already asks for human attention. Kept separate
 * from the full task projection so a cross-project overview stays one query.
 */
export interface OperationalAttentionTaskRecord {
  projectId: string;
  taskId: string;
  title: string;
  status: Extract<TaskStatus, "blocked" | "failed">;
  updatedAt: Date;
}

/** The current stage of every active pipeline run, in one query. */
export interface OperationalActivePipelineStageRecord {
  projectId: string;
  pipelineRunId: string;
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
  stageStatus: PipelineStageRunStatus;
  assignedAgentId: string | null;
  stageCompletedAt: Date | null;
  updatedAt: Date;
}

export interface LastActivityRecord {
  projectId: string;
  occurredAt: Date;
}

export interface CountRecord {
  projectId: string;
  count: number;
}

export interface AgentRunQuery {
  /** Restrict to these projects. Omitted means every project. */
  projectIds?: readonly string[];
  taskIds?: readonly string[];
  statuses?: readonly AgentRunStatus[];
  limit: number;
}

export interface ReviewQuery {
  projectIds?: readonly string[];
  subjectIds?: readonly string[];
  statuses?: readonly ReviewStatus[];
  limit: number;
}

export interface ActivityQuery {
  projectId?: string;
  /** Keyset cursor: only events strictly older than this instant. */
  before?: Date;
  limit: number;
}

/**
 * Every method is read-only and bounded. Implementations must not mutate state
 * and must not return unbounded result sets.
 */
export interface OperationalReadRepository {
  listProjects(): Promise<OperationalProjectRecord[]>;
  findProject(projectId: string): Promise<OperationalProjectRecord | null>;

  countTasksByStatus(
    projectIds: readonly string[],
  ): Promise<StatusCountRecord<TaskStatus>[]>;
  countRequirementsByStatus(
    projectIds: readonly string[],
  ): Promise<RequirementCountRecord[]>;
  countActivePipelineRuns(
    projectIds: readonly string[],
  ): Promise<CountRecord[]>;
  lastActivityAt(projectIds: readonly string[]): Promise<LastActivityRecord[]>;

  listAttentionTasks(
    projectIds: readonly string[],
    limit: number,
  ): Promise<OperationalAttentionTaskRecord[]>;
  listActivePipelineStages(
    projectIds: readonly string[],
  ): Promise<OperationalActivePipelineStageRecord[]>;

  listMilestones(
    projectIds: readonly string[],
  ): Promise<OperationalMilestoneRecord[]>;
  listAgents(projectIds: readonly string[]): Promise<OperationalAgentRecord[]>;

  listAgentRuns(query: AgentRunQuery): Promise<OperationalAgentRunRecord[]>;
  findAgentRun(runId: string): Promise<OperationalAgentRunRecord | null>;
  listAgentRunEvents(
    runId: string,
    limit: number,
  ): Promise<OperationalAgentRunEventRecord[]>;

  listReviews(query: ReviewQuery): Promise<OperationalReviewRecord[]>;

  listActivity(query: ActivityQuery): Promise<OperationalActivityRecord[]>;
}
