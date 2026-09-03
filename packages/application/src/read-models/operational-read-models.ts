/**
 * Operational read models.
 *
 * These types are the authoritative, presentation-neutral interpretation of AI
 * Office operational state. Every observability surface — the daemon query API,
 * the dashboard, a future CLI query command, a future MCP tool — consumes these
 * models rather than re-deriving semantics from persisted rows.
 *
 * Design rules for this module:
 *
 * - timestamps are ISO-8601 UTC strings so a read model is also its own wire
 *   representation and no second mapping layer can drift from it;
 * - state that the current domain cannot express is reported through
 *   {@link Maybe} rather than a misleading default;
 * - nothing here reads storage; projections live in `operational-projection.ts`.
 */

import type { AgentRunStatus } from "@ai-office/domain/agent/agent-run.ts";
import type {
  MilestoneStatus,
  RequirementStatus,
  ReviewStatus,
  ReviewSubjectType,
} from "@ai-office/domain/governance/governance.ts";
import type {
  PipelineRunStatus,
  PipelineStageRunStatus,
} from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { TaskStatus } from "@ai-office/domain/task/task.ts";

/**
 * Version of the read-model contract itself. It is independent of
 * `daemonProtocolVersion`: the command protocol and the query contract evolve
 * for different reasons.
 */
export const operationalReadModelVersion = 1 as const;

/** ISO-8601 UTC instant, for example `2026-09-03T18:00:00.000Z`. */
export type IsoTimestamp = string;

export interface Available<T> {
  availability: "available";
  value: T;
}

/**
 * Explicitly unavailable state. `reason` is a stable machine-readable code and
 * `explanation` is safe human text; neither guesses a value.
 */
export interface Unavailable {
  availability: "unavailable";
  reason: UnavailableReason;
  explanation: string;
}

export type UnavailableReason =
  "task_requirement_link_not_modelled" | "task_milestone_link_not_modelled";

export type Maybe<T> = Available<T> | Unavailable;

export function available<T>(value: T): Available<T> {
  return { availability: "available", value };
}

export function unavailable(
  reason: UnavailableReason,
  explanation: string,
): Unavailable {
  return { availability: "unavailable", reason, explanation };
}

/* -------------------------------------------------------------------------- */
/* Bounded results                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A truncated sample beside its authoritative total.
 *
 * The point of this type is that a client can never mistake a display page for
 * a count. `total` is always exact; `items` may be shorter; `truncated` says so
 * explicitly rather than leaving the reader to compare lengths.
 */
export interface BoundedList<T> {
  /** Exact number of matching records, independent of `items`. */
  total: number;
  /** Bounded sample, at most the requested limit. */
  items: readonly T[];
  /** True when `items` does not contain every matching record. */
  truncated: boolean;
}

export function boundedList<T>(
  items: readonly T[],
  total: number,
): BoundedList<T> {
  return { total, items, truncated: items.length < total };
}

/**
 * One page of the activity stream.
 *
 * Activity is unbounded and append-only, so it is paged rather than counted:
 * `nextCursor` is an opaque keyset position, and `null` means this page is the
 * end of the stream.
 */
export interface ActivityPage {
  items: readonly ActivityEntry[];
  nextCursor: string | null;
}

/* -------------------------------------------------------------------------- */
/* Attention                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why a human should look at something. Every reason is backed by a persisted
 * fact; there is deliberately no aggregate "health score".
 */
export type AttentionKind =
  | "review_pending"
  | "pipeline_stage_awaiting_approval"
  | "pipeline_stage_unassigned"
  | "agent_run_failed"
  | "task_blocked"
  | "task_failed";

export type AttentionSubjectType =
  "task" | "agent_run" | "pipeline_run" | "review";

export interface AttentionReason {
  kind: AttentionKind;
  projectId: string;
  subjectType: AttentionSubjectType;
  subjectId: string;
  /** Safe human text. Never contains payloads, credentials, or stack traces. */
  summary: string;
  since: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Shared references                                                           */
/* -------------------------------------------------------------------------- */

export interface TaskReference {
  taskId: string;
  title: string;
}

export interface AgentReference {
  agentId: string;
  name: string;
  roleId: string;
  roleKey: string | null;
}

export interface AgentRunReference {
  runId: string;
  status: AgentRunStatus;
  agentId: string;
  startedAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp;
}

export interface PipelineRunReference {
  pipelineRunId: string;
  pipelineId: string;
  pipelineName: string;
  status: PipelineRunStatus;
  currentStageId: string | null;
  currentStageName: string | null;
  currentStageStatus: PipelineStageRunStatus | null;
  stageIndex: number | null;
  stageCount: number;
}

export interface MilestoneSummary {
  milestoneId: string;
  title: string;
  status: MilestoneStatus;
  requirements: RequirementCounts;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Counts                                                                      */
/* -------------------------------------------------------------------------- */

export interface TaskCounts {
  total: number;
  /** Not yet terminal: pending, assigned, running, blocked, waiting_review. */
  open: number;
  /** Terminal: completed, failed, cancelled. */
  terminal: number;
  byStatus: Readonly<Record<TaskStatus, number>>;
}

export interface RequirementCounts {
  total: number;
  /** Neither verified nor rejected. */
  open: number;
  /** Verified or rejected. */
  terminal: number;
  verified: number;
  rejected: number;
  byStatus: Readonly<Record<RequirementStatus, number>>;
}

/* -------------------------------------------------------------------------- */
/* Project                                                                     */
/* -------------------------------------------------------------------------- */

export interface ProjectRepositoryIdentity {
  /** Portable repository identity, when the project has been installed. */
  repositoryId: string | null;
  /** Absolute local worktree paths currently associated with the project. */
  localPaths: readonly string[];
  remoteUrl: string | null;
  defaultBranch: string | null;
}

export interface ProjectSummary {
  projectId: string;
  name: string;
  description: string | null;
  repository: ProjectRepositoryIdentity;
  /**
   * The single active milestone when exactly one exists. `null` when the
   * project has no active milestone; `milestoneCount` still reports the total.
   */
  currentMilestone: MilestoneSummary | null;
  milestoneCount: number;
  activeMilestoneCount: number;
  tasks: TaskCounts;
  requirements: RequirementCounts;
  /** Exact totals, never the length of a displayed sample. */
  activeAgentRuns: number;
  activePipelineRuns: number;
  pendingReviews: number;
  agentsWorking: number;
  /** Authoritative: derived from `attention.total`, not from `attention.items`. */
  attentionRequired: boolean;
  attention: BoundedList<AttentionReason>;
  lastActivityAt: IsoTimestamp | null;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
}

/* -------------------------------------------------------------------------- */
/* Task                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Derived operational status.
 *
 * This deliberately uses its own vocabulary rather than reusing
 * {@link TaskStatus}: the persisted status is one input among several, and a
 * distinct vocabulary makes the difference impossible to miss in a client.
 */
export type TaskOperationalStatus =
  | "not_started"
  | "scheduled"
  | "in_progress"
  | "awaiting_review"
  | "blocked"
  | "failed"
  | "completed"
  | "cancelled";

/**
 * Why the derived status differs from the persisted `task.status`. Each value
 * names a concrete, persisted fact that the task record does not reflect.
 */
export type TaskDivergenceReason =
  | "agent_run_scheduled_without_task_transition"
  | "agent_run_active_without_task_transition"
  | "agent_run_failed_without_task_transition"
  | "pipeline_stage_awaiting_approval"
  | "review_pending";

export interface TaskRequirementSummary {
  total: number;
  open: number;
  terminal: number;
  verified: number;
  rejected: number;
}

export interface TaskOperationalState {
  taskId: string;
  projectId: string;
  title: string;
  description: string | null;
  priority: number;
  /** Exactly what `task.status` holds. */
  recordedStatus: TaskStatus;
  /** The authoritative interpretation used by every presentation surface. */
  operationalStatus: TaskOperationalStatus;
  divergesFromRecordedStatus: boolean;
  divergenceReasons: readonly TaskDivergenceReason[];
  /**
   * Unavailable in the current domain: requirements are owned by projects and
   * milestones, and no task/requirement association is persisted.
   */
  requirements: Maybe<TaskRequirementSummary>;
  /** Unavailable in the current domain: tasks carry no milestone reference. */
  milestone: Maybe<MilestoneSummary | null>;
  activeAgentRun: AgentRunReference | null;
  activePipelineRun: PipelineRunReference | null;
  assignedAgent: AgentReference | null;
  pendingReviewCount: number;
  blockedReason: string | null;
  attentionReasons: readonly AttentionReason[];
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  lastActivityAt: IsoTimestamp | null;
}

/* -------------------------------------------------------------------------- */
/* Pipeline                                                                    */
/* -------------------------------------------------------------------------- */

export interface PipelineStageState {
  stageRunId: string;
  stageId: string;
  name: string;
  objective: string;
  roleId: string;
  index: number;
  status: PipelineStageRunStatus;
  requiresApproval: boolean;
  assignedAgent: AgentReference | null;
  assignedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  approvalDecision: "approved" | "rejected" | null;
  approvedBy: string | null;
  approvedAt: IsoTimestamp | null;
}

export interface PipelineStageCounts {
  total: number;
  completed: number;
  active: number;
  awaitingApproval: number;
  pending: number;
  cancelled: number;
}

export interface PipelineRunState {
  pipelineRunId: string;
  projectId: string;
  task: TaskReference | null;
  pipelineId: string;
  pipelineName: string;
  pipelineDescription: string;
  manifestRevision: number;
  status: PipelineRunStatus;
  currentStage: PipelineStageState | null;
  stages: readonly PipelineStageState[];
  stageCounts: PipelineStageCounts;
  startedBy: string;
  createdAt: IsoTimestamp;
  updatedAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
  cancelledAt: IsoTimestamp | null;
  attentionReasons: readonly AttentionReason[];
}

/* -------------------------------------------------------------------------- */
/* Agent                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Derived agent activity. Only states supported by persisted facts exist here:
 * there is no heartbeat, so "unreachable" or "stalled" are not derivable.
 */
export type AgentActivityState =
  "disabled" | "idle" | "working" | "awaiting_approval" | "last_run_failed";

export interface AgentState {
  agentId: string;
  projectId: string;
  name: string;
  roleId: string;
  roleKey: string | null;
  roleName: string | null;
  enabled: boolean;
  state: AgentActivityState;
  currentRun: AgentRunReference | null;
  currentTask: TaskReference | null;
  currentStage: {
    pipelineRunId: string;
    stageId: string;
    name: string;
    status: PipelineStageRunStatus;
  } | null;
  lastActivityAt: IsoTimestamp | null;
}

/* -------------------------------------------------------------------------- */
/* Agent runs                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A controlled-action intent recorded on a run. Arguments are never exposed:
 * only the argument key names, which are enough to understand the intent
 * without republishing caller-supplied values.
 */
export interface AgentRunActionIntentSummary {
  resourceId: string;
  operation: string;
  argumentKeys: readonly string[];
}

/** Bounded, sanitized failure information. */
export interface AgentRunFailureSummary {
  code: string | null;
  message: string | null;
}

/** Controlled action produced by a run, as persisted in its result. */
export interface AgentRunActionOutcome {
  requestId: string;
  status: string;
}

export interface AgentRunState {
  runId: string;
  projectId: string;
  task: TaskReference | null;
  agent: AgentReference | null;
  status: AgentRunStatus;
  terminal: boolean;
  pipelineRunId: string | null;
  actionIntent: AgentRunActionIntentSummary | null;
  hasResult: boolean;
  hasError: boolean;
  failure: AgentRunFailureSummary | null;
  worktreePath: string | null;
  createdAt: IsoTimestamp;
  startedAt: IsoTimestamp | null;
  completedAt: IsoTimestamp | null;
  updatedAt: IsoTimestamp;
  durationMs: number | null;
}

export interface AgentRunEventEntry {
  status: string;
  hasResult: boolean;
  hasError: boolean;
  occurredAt: IsoTimestamp;
}

export interface AgentRunDetail {
  run: AgentRunState;
  events: BoundedList<AgentRunEventEntry>;
  actions: readonly AgentRunActionOutcome[];
  pipeline: PipelineRunState | null;
  reviews: readonly ReviewState[];
  /** Activity naming this run, filtered in SQL rather than after a page. */
  activity: ActivityPage;
  attentionReasons: readonly AttentionReason[];
}

/* -------------------------------------------------------------------------- */
/* Reviews and approvals                                                       */
/* -------------------------------------------------------------------------- */

export interface GovernanceActorSummary {
  type: "user" | "agent" | "system";
  id: string;
  displayName: string | null;
}

export interface ApprovalState {
  approvalId: string;
  projectId: string;
  reviewId: string;
  decision: "approved" | "rejected";
  actor: GovernanceActorSummary;
  rationale: string | null;
  createdAt: IsoTimestamp;
}

export interface ReviewState {
  reviewId: string;
  projectId: string;
  subjectType: ReviewSubjectType;
  subjectId: string;
  reviewer: GovernanceActorSummary;
  status: ReviewStatus;
  summary: string | null;
  createdAt: IsoTimestamp;
  completedAt: IsoTimestamp | null;
  decision: ApprovalState | null;
}

/* -------------------------------------------------------------------------- */
/* Activity                                                                    */
/* -------------------------------------------------------------------------- */

/** Sanitized scalar audit payload value. */
export type ActivityDetailValue = string | number | boolean;

export interface ActivityEntry {
  eventId: string;
  projectId: string | null;
  eventType: string;
  actorType: "daemon" | "cli" | "system";
  actorId: string | null;
  aggregateType: string | null;
  aggregateId: string | null;
  occurredAt: IsoTimestamp;
  /** Whitelisted scalar payload fields; sensitive keys are dropped. */
  detail: Readonly<Record<string, ActivityDetailValue>>;
  /** True when payload content was dropped during sanitization. */
  detailTruncated: boolean;
}

/* -------------------------------------------------------------------------- */
/* Aggregate views                                                             */
/* -------------------------------------------------------------------------- */

export interface DashboardOverview {
  generatedAt: IsoTimestamp;
  /** Every known project; project count is inherently small. */
  projects: readonly ProjectSummary[];
  /** Exact totals across every project, from aggregate queries only. */
  totals: {
    projects: number;
    openTasks: number;
    activeAgentRuns: number;
    activePipelineRuns: number;
    pendingReviews: number;
    agentsWorking: number;
    attentionItems: number;
  };
  attention: BoundedList<AttentionReason>;
  activeRuns: BoundedList<AgentRunState>;
  recentActivity: ActivityPage;
}

export interface ProjectDetail {
  generatedAt: IsoTimestamp;
  /** Counts and attention here are exact regardless of the samples below. */
  summary: ProjectSummary;
  milestones: readonly MilestoneSummary[];
  /** Every agent of the project; each state is projected from its own facts. */
  agents: readonly AgentState[];
  tasks: BoundedList<TaskOperationalState>;
  pipelines: BoundedList<PipelineRunState>;
  runs: BoundedList<AgentRunState>;
  reviews: BoundedList<ReviewState>;
  recentActivity: ActivityPage;
}
