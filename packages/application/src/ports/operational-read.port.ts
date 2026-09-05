/**
 * Read-side port for operational queries.
 *
 * The methods here are deliberately grouped by the guarantee they carry,
 * because that guarantee is the whole point:
 *
 * 1. **Authoritative aggregates** — exact counts over every matching record.
 *    Totals, attention decisions, and status counts come only from these.
 * 2. **Scoped projection inputs** — queries restricted to the exact entities
 *    being projected, returning their current or latest facts. They are bounded
 *    by the number of entities asked about, never by a generic window, so they
 *    cannot omit a fact relevant to the entity they describe.
 * 3. **Bounded presentation samples and pagination pages** — truncated lists,
 *    always accompanied by an authoritative total or a pagination cursor.
 *
 * A result may be bounded, but bounded evidence must never silently change an
 * authoritative count, status, attention decision, or relationship.
 *
 * The existing per-aggregate repositories remain the command side's; this port
 * exists so the read side can ask precisely what it needs without loading whole
 * histories and discarding most of them.
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
import type {
  PipelineRunProps,
  PipelineStageRunStatus,
} from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { TaskProps, TaskStatus } from "@ai-office/domain/task/task.ts";
import type { ActivityCursor } from "../protocol/query-protocol.ts";

/* -------------------------------------------------------------------------- */
/* Records                                                                     */
/* -------------------------------------------------------------------------- */

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

export interface TaskRequirementCountRecord {
  taskId: string;
  status: RequirementStatus;
  count: number;
}

export interface CountRecord {
  projectId: string;
  count: number;
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

export interface LastActivityRecord {
  projectId: string;
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

/** The current stage of an active pipeline run. */
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

/**
 * A pipeline run with the persisted stage state the read model renders.
 *
 * The command-side `PipelineRunRepository` returns whole aggregates oldest
 * first and unbounded, which is right for its consumers and wrong for a
 * dashboard. This record is produced by a read-side query that limits and
 * orders in SQL, and it still carries the full persisted definition and stages.
 */
export interface OperationalPipelineRunRecord {
  run: PipelineRunProps;
  taskTitle: string | null;
}

/**
 * The runs that decide one task's operational status.
 *
 * Scoped to the task on purpose: a generic "latest N project runs" window would
 * omit a task's own runs the moment they fell outside it.
 *
 * A task can hold several active runs at once. `task_lock` is a *lease*, and
 * `acquireTaskLock` deliberately lets an expired lease be taken over
 * (`ON CONFLICT ... WHERE task_lock.expires_at <= excluded.acquired_at`) without
 * terminating the previous run, which `ExecuteAgentRun` never renews mid-flight.
 * So the active runs are a bounded list beside exact counts, not one row.
 */
export interface TaskRunFactsRecord {
  taskId: string;
  /**
   * Bounded sample of the task's in-flight runs, most recently updated first,
   * ties broken by run id descending.
   */
  activeRuns: readonly OperationalAgentRunRecord[];
  /** Exact number of in-flight runs. Never `activeRuns.length`. */
  activeRunCount: number;
  /**
   * Exact number of in-flight runs that are actually executing, that is whose
   * status is `running` or `reviewing` rather than `queued` or `preparing`.
   * The operational status reads this rather than inspecting a sample.
   */
  executingRunCount: number;
  /** The task's most recently updated run of any status, or null. */
  latestRun: OperationalAgentRunRecord | null;
}

/**
 * The current execution lease of one task.
 *
 * `task_lock` answers exactly one operationally meaningful question: which run
 * currently owns execution exclusivity for this task. It is a lease with an
 * expiry, so an owner can be present, expired, or absent, and the read side
 * reports whichever it finds rather than inferring one from the runs.
 */
export interface TaskLeaseRecord {
  taskId: string;
  ownerRunId: string;
  acquiredAt: Date;
  expiresAt: Date;
  /**
   * Status of the owning run, or null when no run row matches. Lets the
   * projection tell "the owner is still working" from "the lease outlived its
   * owner" without a second query.
   */
  ownerRunStatus: AgentRunStatus | null;
}

/**
 * A task holding at least one active run without valid execution authority.
 *
 * Aggregated per task so that its exact count and this sample describe the same
 * unit. It carries the lease facts rather than a pre-rendered reason so the
 * projection derives the attention kind, summary, and instant from exactly the
 * same inputs the per-task projection uses.
 */
export interface TaskLeaseAnomalyRecord {
  projectId: string;
  taskId: string;
  taskTitle: string | null;
  /**
   * Exact number of this task's active runs without valid authority: every
   * active run except a lease owner whose lease has not expired.
   */
  runsWithoutValidLease: number;
  /** Lease row facts, or null when the task holds no lease row at all. */
  lease: {
    acquiredAt: Date;
    expiresAt: Date;
    /** `expiresAt <= now`, evaluated at the instant passed to the query. */
    expired: boolean;
  } | null;
  /** Persisted fallback instant used when no lease row exists. */
  taskUpdatedAt: Date;
}

/**
 * The runs that decide one agent's activity.
 *
 * Nothing in the persisted model enforces one active run per agent — the task
 * lock is per task, not per agent — so this record carries *every* active run,
 * bounded by an explicit limit and paired with the exact `activeRunCount`. A
 * single `activeRun` field would silently drop valid persisted work.
 */
export interface AgentRunFactsRecord {
  agentId: string;
  /**
   * Bounded sample of the agent's in-flight runs, most recently updated first,
   * ties broken by run id descending.
   */
  activeRuns: readonly OperationalAgentRunRecord[];
  /** Exact number of in-flight runs, independent of `activeRuns.length`. */
  activeRunCount: number;
  /** The agent's most recently updated run of any status, or null. */
  latestRun: OperationalAgentRunRecord | null;
}

/** One active pipeline stage assigned to an agent. */
export interface AgentActiveStageRecord {
  agentId: string;
  pipelineRunId: string;
  stageId: string;
  stageName: string;
  stageStatus: PipelineStageRunStatus;
}

/**
 * The active pipeline stages assigned to one agent.
 *
 * Pipeline assignment does not reject an agent merely because another active
 * stage already names it, so this is a list with an exact count for the same
 * reason {@link AgentRunFactsRecord} is.
 */
export interface AgentActiveStagesRecord {
  agentId: string;
  /**
   * Bounded sample, ordered by the owning pipeline run's `updatedAt`
   * descending, ties broken by pipeline run id ascending.
   */
  stages: readonly AgentActiveStageRecord[];
  /** Exact number of active stage assignments, independent of `stages`. */
  stageCount: number;
  /**
   * Exact number of those assignments whose stage is `awaiting_approval`.
   *
   * Counted separately because the derived agent state depends on it: reading
   * it off the bounded `stages` sample would let a truncated page change an
   * authoritative state.
   */
  awaitingApprovalCount: number;
}

/**
 * Pending-review facts for one task: the exact count, and the oldest pending
 * review so an attention reason can name a real subject and instant.
 */
export interface TaskReviewFactsRecord {
  taskId: string;
  pendingCount: number;
  earliestPending: OperationalReviewRecord | null;
}

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

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
  /**
   * Restrict to events naming one of these aggregates. Applied in SQL, before
   * the limit, so a run's own events are never lost behind a project window.
   */
  aggregateIds?: readonly string[];
  cursor?: ActivityCursor;
  limit: number;
}

export interface PipelineRunQuery {
  projectId: string;
  activeOnly?: boolean;
  limit: number;
}

/**
 * Every method is read-only. Aggregates are exact; sample lists are bounded and
 * always paired with a total or a cursor; scoped queries are bounded by the
 * entities they were asked about.
 */
export interface OperationalReadRepository {
  /** Exact per-status aggregates, bounded by the requested task IDs. */
  listTaskRequirementCounts(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<TaskRequirementCountRecord[]>;
  /* --- projects ---------------------------------------------------------- */

  listProjects(): Promise<OperationalProjectRecord[]>;
  findProject(projectId: string): Promise<OperationalProjectRecord | null>;

  /* --- authoritative aggregates ------------------------------------------ */

  countTasksByStatus(
    projectIds: readonly string[],
  ): Promise<StatusCountRecord<TaskStatus>[]>;
  countRequirementsByStatus(
    projectIds: readonly string[],
  ): Promise<RequirementCountRecord[]>;
  /**
   * Exact run counts per project.
   *
   * An omitted filter means "no restriction"; an empty array means "nothing
   * matches" and yields no rows. The distinction matters: `projectIds: []` must
   * never be read as "every project".
   */
  countAgentRuns(query: {
    projectIds?: readonly string[];
    statuses?: readonly AgentRunStatus[];
  }): Promise<CountRecord[]>;
  /**
   * Distinct **enabled** agents holding at least one run in the given statuses.
   *
   * Restricted to enabled agents so the count matches the `working` state in
   * `AgentActivityState`, which a disabled agent never reports. A run belonging
   * to a deleted or unknown agent is not counted either: there is no
   * `AgentState` for it to contradict.
   */
  countDistinctRunAgents(query: {
    projectIds?: readonly string[];
    statuses?: readonly AgentRunStatus[];
  }): Promise<CountRecord[]>;
  countReviews(query: {
    projectIds?: readonly string[];
    statuses?: readonly ReviewStatus[];
  }): Promise<CountRecord[]>;
  countActivePipelineRuns(
    projectIds: readonly string[],
  ): Promise<CountRecord[]>;
  /** Active stages that are awaiting approval or have no assigned agent. */
  countAttentionStages(projectIds: readonly string[]): Promise<CountRecord[]>;
  /**
   * Distinct tasks holding at least one active run without valid execution
   * authority.
   *
   * A run has valid authority only when it owns the task's lease row *and*
   * that lease has not expired — the same predicate `acquireTaskLock` uses to
   * decide takeover. So this counts tasks whose lease is missing, expired,
   * owned by a run that is not active, or owned by a different run.
   *
   * `now` is the evaluation instant, passed explicitly from the application
   * clock rather than read from SQLite, so tests stay deterministic and the
   * aggregate and the per-task projection agree exactly.
   *
   * Counted per *task* rather than per run so that this exact total and
   * {@link OperationalReadRepository.listTasksWithoutValidRunLease} describe
   * the same unit, and one attention item is one affected task.
   */
  countTasksWithoutValidRunLease(
    projectIds: readonly string[],
    now: Date,
  ): Promise<CountRecord[]>;
  countPipelineRuns(projectId: string, activeOnly: boolean): Promise<number>;
  lastActivityAt(projectIds: readonly string[]): Promise<LastActivityRecord[]>;

  /* --- full authoritative sets ------------------------------------------- */
  /*
   * Returned complete and unbounded on purpose. Both are inherently small — a
   * project's milestones and its synchronized agents — and both feed
   * authoritative output: `activeMilestoneCount` and per-agent state would be
   * wrong if either were truncated.
   */

  listMilestones(
    projectIds: readonly string[],
  ): Promise<OperationalMilestoneRecord[]>;
  listAgents(projectIds: readonly string[]): Promise<OperationalAgentRecord[]>;

  /* --- scoped projection inputs ------------------------------------------ */

  /**
   * Per-task run facts. `activeRunLimit` bounds the returned active-run sample
   * only; `activeRunCount` and `executingRunCount` stay exact, so concurrent
   * runs are never lost and no status is decided from a truncated list.
   */
  listTaskRunFacts(
    projectId: string,
    taskIds: readonly string[],
    activeRunLimit: number,
  ): Promise<TaskRunFactsRecord[]>;
  /**
   * Current execution lease of each named task. Tasks with no lease row are
   * simply absent from the result — the read side reports the lease it finds
   * and never invents one.
   */
  listTaskLeases(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<TaskLeaseRecord[]>;
  /**
   * Per-agent run facts. `activeRunLimit` bounds the returned active-run sample
   * only; `activeRunCount` stays exact, so concurrent runs are never lost.
   */
  listAgentRunFacts(
    projectId: string,
    agentIds: readonly string[],
    activeRunLimit: number,
  ): Promise<AgentRunFactsRecord[]>;
  listActivePipelineRunsForTasks(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<OperationalPipelineRunRecord[]>;
  /**
   * Per-agent active stage assignments. `stageLimit` bounds the sample only;
   * `stageCount` stays exact.
   */
  listActiveStagesForAgents(
    projectId: string,
    agentIds: readonly string[],
    stageLimit: number,
  ): Promise<AgentActiveStagesRecord[]>;
  listTaskReviewFacts(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<TaskReviewFactsRecord[]>;

  /* --- bounded samples and pages ----------------------------------------- */

  listTasks(projectId: string, limit: number): Promise<TaskProps[]>;
  listAgentRuns(query: AgentRunQuery): Promise<OperationalAgentRunRecord[]>;
  findAgentRun(runId: string): Promise<OperationalAgentRunRecord | null>;
  listAgentRunEvents(
    runId: string,
    limit: number,
  ): Promise<OperationalAgentRunEventRecord[]>;
  countAgentRunEvents(runId: string): Promise<number>;
  listReviews(query: ReviewQuery): Promise<OperationalReviewRecord[]>;
  listAttentionTasks(
    projectIds: readonly string[],
    limit: number,
  ): Promise<OperationalAttentionTaskRecord[]>;
  listActivePipelineStages(
    projectIds: readonly string[],
    limit: number,
  ): Promise<OperationalActivePipelineStageRecord[]>;
  /**
   * Bounded sample beside `countTasksWithoutValidRunLease`, newest first by the
   * same instant the projection reports as the anomaly's `since`.
   */
  listTasksWithoutValidRunLease(
    projectIds: readonly string[],
    limit: number,
    now: Date,
  ): Promise<TaskLeaseAnomalyRecord[]>;
  listPipelineRuns(
    query: PipelineRunQuery,
  ): Promise<OperationalPipelineRunRecord[]>;
  findPipelineRun(
    projectId: string,
    pipelineRunId: string,
  ): Promise<OperationalPipelineRunRecord | null>;
  listActivity(query: ActivityQuery): Promise<OperationalActivityRecord[]>;
}
