/**
 * Pure projections from persisted facts to operational read models.
 *
 * Nothing in this module performs I/O. Every function is deterministic given
 * its inputs, which is what makes "one authoritative computation of operational
 * status" testable and reusable across presentation surfaces.
 */

import type { AgentRunStatus } from "@ai-office/domain/agent/agent-run.ts";
import type {
  RequirementStatus,
  ReviewStatus,
} from "@ai-office/domain/governance/governance.ts";
import type {
  PipelineRunProps,
  PipelineStageRunProps,
} from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { TaskProps, TaskStatus } from "@ai-office/domain/task/task.ts";
import type {
  AgentActiveStageRecord,
  OperationalAgentRecord,
  OperationalAgentRunEventRecord,
  OperationalAgentRunRecord,
  OperationalMilestoneRecord,
  OperationalProjectRecord,
  OperationalReviewRecord,
  RequirementCountRecord,
  StatusCountRecord,
} from "../ports/operational-read.port.ts";
import {
  available,
  unavailable,
  type AgentActivityState,
  type AgentReference,
  type AgentRunActionOutcome,
  type AgentRunEventEntry,
  type AgentRunFailureSummary,
  type AgentRunReference,
  type AgentRunState,
  type AgentState,
  type ApprovalState,
  type AttentionReason,
  type BoundedList,
  type IsoTimestamp,
  type MilestoneSummary,
  type PipelineRunReference,
  type PipelineRunState,
  type PipelineStageCounts,
  type PipelineStageState,
  type ProjectSummary,
  type RequirementCounts,
  type ReviewState,
  type TaskCounts,
  type TaskDivergenceReason,
  type TaskOperationalState,
  type TaskOperationalStatus,
  type TaskReference,
} from "./operational-read-models.ts";

/* -------------------------------------------------------------------------- */
/* Status vocabularies                                                         */
/* -------------------------------------------------------------------------- */

const taskStatuses = [
  "pending",
  "assigned",
  "running",
  "blocked",
  "waiting_review",
  "completed",
  "failed",
  "cancelled",
] as const satisfies readonly TaskStatus[];

const terminalTaskStatuses = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const requirementStatuses = [
  "proposed",
  "accepted",
  "implemented",
  "verified",
  "rejected",
] as const satisfies readonly RequirementStatus[];

const terminalRequirementStatuses = new Set<RequirementStatus>([
  "verified",
  "rejected",
]);

/** Agent-run statuses that mean work is in flight for a task. */
export const activeAgentRunStatuses = [
  "queued",
  "preparing",
  "running",
  "reviewing",
] as const satisfies readonly AgentRunStatus[];

const activeAgentRunStatusSet = new Set<AgentRunStatus>(activeAgentRunStatuses);

/** Statuses that mean the run has not started executing yet. */
const scheduledAgentRunStatusSet = new Set<AgentRunStatus>([
  "queued",
  "preparing",
]);

const terminalAgentRunStatuses = new Set<AgentRunStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export function isActiveAgentRunStatus(status: AgentRunStatus): boolean {
  return activeAgentRunStatusSet.has(status);
}

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return terminalAgentRunStatuses.has(status);
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                               */
/* -------------------------------------------------------------------------- */

function iso(value: Date): IsoTimestamp {
  return value.toISOString();
}

function isoOrNull(value: Date | null | undefined): IsoTimestamp | null {
  return value === undefined || value === null ? null : value.toISOString();
}

function latest(
  ...values: readonly (IsoTimestamp | null)[]
): IsoTimestamp | null {
  let result: IsoTimestamp | null = null;
  for (const value of values) {
    if (value === null) continue;
    if (result === null || value > result) result = value;
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Counts                                                                      */
/* -------------------------------------------------------------------------- */

/** Mutable working shape; the returned read model stays readonly. */
interface MutableTaskCounts {
  total: number;
  open: number;
  terminal: number;
  byStatus: Record<TaskStatus, number>;
}

function newTaskCounts(): MutableTaskCounts {
  const byStatus = Object.fromEntries(
    taskStatuses.map((status) => [status, 0]),
  ) as Record<TaskStatus, number>;
  return { total: 0, open: 0, terminal: 0, byStatus };
}

export function emptyTaskCounts(): TaskCounts {
  return newTaskCounts();
}

export function projectTaskCounts(
  records: readonly StatusCountRecord<TaskStatus>[],
): TaskCounts {
  const counts = newTaskCounts();
  for (const record of records) {
    counts.byStatus[record.status] += record.count;
    counts.total += record.count;
    if (terminalTaskStatuses.has(record.status))
      counts.terminal += record.count;
    else counts.open += record.count;
  }
  return counts;
}

interface MutableRequirementCounts {
  total: number;
  open: number;
  terminal: number;
  verified: number;
  rejected: number;
  byStatus: Record<RequirementStatus, number>;
}

function newRequirementCounts(): MutableRequirementCounts {
  const byStatus = Object.fromEntries(
    requirementStatuses.map((status) => [status, 0]),
  ) as Record<RequirementStatus, number>;
  return { total: 0, open: 0, terminal: 0, verified: 0, rejected: 0, byStatus };
}

export function emptyRequirementCounts(): RequirementCounts {
  return newRequirementCounts();
}

export function projectRequirementCounts(
  records: readonly { status: RequirementStatus; count: number }[],
): RequirementCounts {
  const counts = newRequirementCounts();
  for (const record of records) {
    counts.byStatus[record.status] += record.count;
    counts.total += record.count;
    if (terminalRequirementStatuses.has(record.status))
      counts.terminal += record.count;
    else counts.open += record.count;
    if (record.status === "verified") counts.verified += record.count;
    if (record.status === "rejected") counts.rejected += record.count;
  }
  return counts;
}

/* -------------------------------------------------------------------------- */
/* Milestones                                                                  */
/* -------------------------------------------------------------------------- */

export function projectMilestoneSummary(
  record: OperationalMilestoneRecord,
  requirementCounts: readonly RequirementCountRecord[],
): MilestoneSummary {
  return {
    milestoneId: record.id,
    title: record.title,
    status: record.status,
    requirements: projectRequirementCounts(
      requirementCounts.filter((value) => value.milestoneId === record.id),
    ),
    createdAt: iso(record.createdAt),
    updatedAt: iso(record.updatedAt),
  };
}

/* -------------------------------------------------------------------------- */
/* References                                                                  */
/* -------------------------------------------------------------------------- */

export function agentReferenceFromRun(
  record: OperationalAgentRunRecord,
): AgentReference | null {
  if (record.agentName === null || record.agentRoleId === null) return null;
  return {
    agentId: record.agentId,
    name: record.agentName,
    roleId: record.agentRoleId,
    roleKey: record.agentRoleKey,
  };
}

export function agentReference(record: OperationalAgentRecord): AgentReference {
  return {
    agentId: record.id,
    name: record.name,
    roleId: record.roleId,
    roleKey: record.roleKey,
  };
}

export function agentRunReference(
  record: OperationalAgentRunRecord,
): AgentRunReference {
  return {
    runId: record.id,
    status: record.status,
    agentId: record.agentId,
    startedAt: isoOrNull(record.startedAt),
    updatedAt: iso(record.updatedAt),
  };
}

export function pipelineRunReference(
  run: PipelineRunProps,
): PipelineRunReference {
  const stage =
    run.status === "active" ? run.stages[run.currentStageIndex] : undefined;
  const definition =
    stage === undefined ? undefined : run.definition.stages[stage.stageIndex];
  return {
    pipelineRunId: run.id,
    pipelineId: run.definition.id,
    pipelineName: run.definition.name,
    status: run.status,
    currentStageId: stage?.stageId ?? null,
    currentStageName: definition?.name ?? null,
    currentStageStatus: stage?.status ?? null,
    stageIndex: stage === undefined ? null : stage.stageIndex,
    stageCount: run.stages.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Pipeline runs                                                               */
/* -------------------------------------------------------------------------- */

function projectStage(
  run: PipelineRunProps,
  stage: PipelineStageRunProps,
  agentsById: ReadonlyMap<string, AgentReference>,
): PipelineStageState {
  const definition = run.definition.stages[stage.stageIndex];
  const assigned =
    stage.assignedAgentId === undefined
      ? null
      : (agentsById.get(stage.assignedAgentId) ?? {
          agentId: stage.assignedAgentId,
          name: stage.assignedAgentId,
          roleId: stage.roleId,
          roleKey: null,
        });
  return {
    stageRunId: stage.id,
    stageId: stage.stageId,
    name: definition?.name ?? stage.stageId,
    objective: definition?.objective ?? "",
    roleId: stage.roleId,
    index: stage.stageIndex,
    status: stage.status,
    requiresApproval: definition?.requiresApproval ?? false,
    assignedAgent: assigned,
    assignedAt: isoOrNull(stage.assignedAt),
    completedAt: isoOrNull(stage.completedAt),
    approvalDecision: stage.approvalDecision ?? null,
    approvedBy: stage.approvedBy ?? null,
    approvedAt: isoOrNull(stage.approvedAt),
  };
}

function stageCounts(
  stages: readonly PipelineStageState[],
): PipelineStageCounts {
  const counts: PipelineStageCounts = {
    total: stages.length,
    completed: 0,
    active: 0,
    awaitingApproval: 0,
    pending: 0,
    cancelled: 0,
  };
  for (const stage of stages) {
    if (stage.status === "completed") counts.completed += 1;
    else if (stage.status === "active") counts.active += 1;
    else if (stage.status === "awaiting_approval") counts.awaitingApproval += 1;
    else if (stage.status === "pending") counts.pending += 1;
    else counts.cancelled += 1;
  }
  return counts;
}

export function projectPipelineRunState(input: {
  run: PipelineRunProps;
  task: TaskReference | null;
  agentsById: ReadonlyMap<string, AgentReference>;
}): PipelineRunState {
  const stages = input.run.stages.map((stage) =>
    projectStage(input.run, stage, input.agentsById),
  );
  const current =
    input.run.status === "active"
      ? (stages[input.run.currentStageIndex] ?? null)
      : null;
  const attentionReasons: AttentionReason[] = [];
  if (current !== null && current.status === "awaiting_approval")
    attentionReasons.push({
      kind: "pipeline_stage_awaiting_approval",
      projectId: input.run.projectId,
      subjectType: "pipeline_run",
      subjectId: input.run.id,
      summary: `Stage ${current.name} is awaiting approval`,
      since: current.completedAt ?? iso(input.run.updatedAt),
    });
  if (
    current !== null &&
    current.status === "active" &&
    current.assignedAgent === null
  )
    attentionReasons.push({
      kind: "pipeline_stage_unassigned",
      projectId: input.run.projectId,
      subjectType: "pipeline_run",
      subjectId: input.run.id,
      summary: `Stage ${current.name} has no assigned agent`,
      since: iso(input.run.updatedAt),
    });

  return {
    pipelineRunId: input.run.id,
    projectId: input.run.projectId,
    task: input.task,
    pipelineId: input.run.definition.id,
    pipelineName: input.run.definition.name,
    pipelineDescription: input.run.definition.description,
    manifestRevision: input.run.manifestRevision,
    status: input.run.status,
    currentStage: current,
    stages,
    stageCounts: stageCounts(stages),
    startedBy: input.run.startedBy,
    createdAt: iso(input.run.createdAt),
    updatedAt: iso(input.run.updatedAt),
    completedAt: isoOrNull(input.run.completedAt),
    cancelledAt: isoOrNull(input.run.cancelledAt),
    attentionReasons,
  };
}

/* -------------------------------------------------------------------------- */
/* Agent runs                                                                  */
/* -------------------------------------------------------------------------- */

const maxFailureMessageLength = 500;

/**
 * Extracts a bounded failure summary from the persisted error value. Only the
 * documented `{ message, code }` execution-error shape is published; anything
 * else is reported as present without republishing its content.
 */
export function projectRunFailure(
  error: unknown,
): AgentRunFailureSummary | null {
  if (error === undefined || error === null) return null;
  if (typeof error !== "object" || Array.isArray(error))
    return { code: null, message: null };
  const candidate = error as Record<string, unknown>;
  const message =
    typeof candidate.message === "string"
      ? candidate.message.slice(0, maxFailureMessageLength)
      : null;
  const code = typeof candidate.code === "string" ? candidate.code : null;
  return { code, message };
}

/**
 * Extracts controlled-action outcomes from a run result. Only the known
 * `{ actions: [{ requestId, status }] }` shape is read; other result content is
 * never published.
 */
export function projectRunActions(
  result: unknown,
): readonly AgentRunActionOutcome[] {
  if (typeof result !== "object" || result === null || Array.isArray(result))
    return [];
  const actions = (result as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return [];
  const outcomes: AgentRunActionOutcome[] = [];
  for (const action of actions) {
    if (typeof action !== "object" || action === null) continue;
    const record = action as Record<string, unknown>;
    if (
      typeof record.requestId === "string" &&
      typeof record.status === "string"
    )
      outcomes.push({ requestId: record.requestId, status: record.status });
  }
  return outcomes;
}

export function projectAgentRunState(
  record: OperationalAgentRunRecord,
): AgentRunState {
  const startedAt = record.startedAt;
  const completedAt = record.completedAt;
  return {
    runId: record.id,
    projectId: record.projectId,
    task:
      record.taskTitle === null
        ? null
        : { taskId: record.taskId, title: record.taskTitle },
    agent: agentReferenceFromRun(record),
    status: record.status,
    terminal: isTerminalAgentRunStatus(record.status),
    pipelineRunId: record.pipelineRunId,
    actionIntent:
      record.actionIntent === null
        ? null
        : {
            resourceId: record.actionIntent.resourceId,
            operation: record.actionIntent.operation,
            argumentKeys: [...record.actionIntent.argumentKeys],
          },
    hasResult: record.result !== undefined && record.result !== null,
    hasError: record.error !== undefined && record.error !== null,
    failure: projectRunFailure(record.error),
    worktreePath: record.worktreePath,
    createdAt: iso(record.createdAt),
    startedAt: isoOrNull(startedAt),
    completedAt: isoOrNull(completedAt),
    updatedAt: iso(record.updatedAt),
    durationMs:
      startedAt === null || completedAt === null
        ? null
        : Math.max(0, completedAt.getTime() - startedAt.getTime()),
  };
}

export function projectAgentRunEvent(
  record: OperationalAgentRunEventRecord,
): AgentRunEventEntry {
  return {
    status: record.status,
    hasResult: record.hasResult,
    hasError: record.hasError,
    occurredAt: iso(record.occurredAt),
  };
}

export function agentRunAttentionReasons(
  run: AgentRunState,
): readonly AttentionReason[] {
  if (run.status !== "failed") return [];
  return [
    {
      kind: "agent_run_failed",
      projectId: run.projectId,
      subjectType: "agent_run",
      subjectId: run.runId,
      summary:
        run.failure?.code === null || run.failure?.code === undefined
          ? "Agent run failed"
          : `Agent run failed (${run.failure.code})`,
      since: run.completedAt ?? run.updatedAt,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Reviews                                                                     */
/* -------------------------------------------------------------------------- */

export function projectReviewState(
  record: OperationalReviewRecord,
): ReviewState {
  const decision: ApprovalState | null =
    record.decision === null
      ? null
      : {
          approvalId: record.decision.id,
          projectId: record.projectId,
          reviewId: record.id,
          decision: record.decision.decision,
          actor: {
            type: record.decision.actorType,
            id: record.decision.actorId,
            displayName: record.decision.displayName,
          },
          rationale: record.decision.rationale,
          createdAt: iso(record.decision.createdAt),
        };
  return {
    reviewId: record.id,
    projectId: record.projectId,
    subjectType: record.subjectType,
    subjectId: record.subjectId,
    reviewer: {
      type: record.reviewerActorType,
      id: record.reviewerActorId,
      displayName: record.reviewerDisplayName,
    },
    status: record.status,
    summary: record.summary,
    createdAt: iso(record.createdAt),
    completedAt: isoOrNull(record.completedAt),
    decision,
  };
}

export function reviewAttentionReason(
  review: ReviewState,
): AttentionReason | null {
  if (review.status !== "pending") return null;
  return {
    kind: "review_pending",
    projectId: review.projectId,
    subjectType: "review",
    subjectId: review.reviewId,
    summary: `Review of ${review.subjectType} ${review.subjectId} is pending`,
    since: review.createdAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Task operational state                                                      */
/* -------------------------------------------------------------------------- */

const requirementLinkageExplanation =
  "Requirements are owned by projects and milestones. The current domain " +
  "persists no task/requirement association, so a per-task requirement " +
  "summary cannot be computed authoritatively.";

const milestoneLinkageExplanation =
  "The current task record carries no milestone reference, so a task's " +
  "milestone cannot be resolved authoritatively.";

/**
 * The single authoritative derivation of a task's operational status.
 *
 * Inputs are the persisted task record plus the persisted facts that the task
 * record does not currently reflect: its in-flight run, its most recent run,
 * its active pipeline run, and its pending reviews. `schedule-agent-run`
 * deliberately does not transition the task, so a task can legitimately read
 * `pending` while a run for it is already executing; that difference is
 * reported, never hidden.
 *
 * Every input is scoped to this task. Passing a generic "latest N runs of the
 * project" window here would silently change a task's status the moment its own
 * runs fell outside that window, which is exactly the failure this signature
 * makes impossible to express.
 */
export function projectTaskOperationalState(input: {
  task: TaskProps;
  /** The task's in-flight run, or null. */
  activeRun: OperationalAgentRunRecord | null;
  /** The task's most recently updated run of any status, or null. */
  latestRun: OperationalAgentRunRecord | null;
  pipelineRun: PipelineRunProps | null;
  /** Exact number of pending reviews of this task. */
  pendingReviewCount: number;
  /** Oldest pending review of this task, for the attention reason. */
  earliestPendingReview: ReviewState | null;
  agentsById: ReadonlyMap<string, AgentReference>;
}): TaskOperationalState {
  const activeRun = input.activeRun ?? undefined;
  const latestRun = input.latestRun ?? undefined;
  const hasPendingReview = input.pendingReviewCount > 0;
  const pipelineStage =
    input.pipelineRun !== null && input.pipelineRun.status === "active"
      ? (input.pipelineRun.stages[input.pipelineRun.currentStageIndex] ?? null)
      : null;

  const divergenceReasons: TaskDivergenceReason[] = [];
  let operationalStatus: TaskOperationalStatus;

  // The latest run failed and nothing else is carrying the work forward. An
  // active pipeline stage counts as work in flight even when no agent run is,
  // so a stale failure never masks a live stage.
  const stoppedOnFailure =
    activeRun === undefined &&
    latestRun?.status === "failed" &&
    pipelineStage === null;

  if (input.task.status === "cancelled") operationalStatus = "cancelled";
  else if (input.task.status === "failed") operationalStatus = "failed";
  else if (input.task.status === "completed") operationalStatus = "completed";
  else if (input.task.status === "blocked") operationalStatus = "blocked";
  else if (hasPendingReview || pipelineStage?.status === "awaiting_approval")
    operationalStatus = "awaiting_review";
  else if (input.task.status === "waiting_review")
    operationalStatus = "awaiting_review";
  else if (activeRun !== undefined)
    operationalStatus = scheduledAgentRunStatusSet.has(activeRun.status)
      ? "scheduled"
      : "in_progress";
  else if (stoppedOnFailure) operationalStatus = "failed";
  else if (input.task.status === "running") operationalStatus = "in_progress";
  else operationalStatus = "not_started";

  // Divergence is only recorded when the persisted status genuinely disagrees
  // with a persisted fact, so a client can trust it as a defect signal.
  if (
    (input.task.status === "pending" || input.task.status === "assigned") &&
    activeRun !== undefined
  )
    divergenceReasons.push(
      scheduledAgentRunStatusSet.has(activeRun.status)
        ? "agent_run_scheduled_without_task_transition"
        : "agent_run_active_without_task_transition",
    );
  if (!terminalTaskStatuses.has(input.task.status) && stoppedOnFailure)
    divergenceReasons.push("agent_run_failed_without_task_transition");
  if (
    input.task.status !== "waiting_review" &&
    pipelineStage?.status === "awaiting_approval"
  )
    divergenceReasons.push("pipeline_stage_awaiting_approval");
  if (input.task.status !== "waiting_review" && hasPendingReview)
    divergenceReasons.push("review_pending");

  const attentionReasons: AttentionReason[] = [];
  if (input.earliestPendingReview !== null) {
    const reason = reviewAttentionReason(input.earliestPendingReview);
    if (reason !== null)
      attentionReasons.push(
        input.pendingReviewCount === 1
          ? reason
          : {
              ...reason,
              summary: `${input.pendingReviewCount} reviews of task ${input.task.id} are pending`,
            },
      );
  }
  if (input.task.status === "blocked")
    attentionReasons.push({
      kind: "task_blocked",
      projectId: input.task.projectId,
      subjectType: "task",
      subjectId: input.task.id,
      summary: "Task is blocked",
      since: iso(input.task.updatedAt),
    });
  if (input.task.status === "failed")
    attentionReasons.push({
      kind: "task_failed",
      projectId: input.task.projectId,
      subjectType: "task",
      subjectId: input.task.id,
      summary: "Task failed",
      since: iso(input.task.updatedAt),
    });
  if (latestRun !== undefined && latestRun.status === "failed")
    attentionReasons.push(
      ...agentRunAttentionReasons(projectAgentRunState(latestRun)),
    );

  const assignedAgentId =
    pipelineStage?.assignedAgentId ?? activeRun?.agentId ?? undefined;

  return {
    taskId: input.task.id,
    projectId: input.task.projectId,
    title: input.task.title,
    description: input.task.description ?? null,
    priority: input.task.priority,
    recordedStatus: input.task.status,
    operationalStatus,
    divergesFromRecordedStatus: divergenceReasons.length > 0,
    divergenceReasons,
    requirements: unavailable(
      "task_requirement_link_not_modelled",
      requirementLinkageExplanation,
    ),
    milestone: unavailable(
      "task_milestone_link_not_modelled",
      milestoneLinkageExplanation,
    ),
    activeAgentRun:
      activeRun === undefined ? null : agentRunReference(activeRun),
    activePipelineRun:
      input.pipelineRun === null || input.pipelineRun.status !== "active"
        ? null
        : pipelineRunReference(input.pipelineRun),
    assignedAgent:
      assignedAgentId === undefined
        ? null
        : (input.agentsById.get(assignedAgentId) ?? null),
    pendingReviewCount: input.pendingReviewCount,
    blockedReason: input.task.status === "blocked" ? "Task is blocked" : null,
    attentionReasons,
    createdAt: iso(input.task.createdAt),
    updatedAt: iso(input.task.updatedAt),
    lastActivityAt: latest(
      iso(input.task.updatedAt),
      latestRun === undefined ? null : iso(latestRun.updatedAt),
      input.pipelineRun === null ? null : iso(input.pipelineRun.updatedAt),
    ),
  };
}

/**
 * Kept alongside the projection so a client never has to re-derive the mapping
 * from a task's requirement availability to a displayable value.
 */
export function availableTaskRequirementSummary(input: {
  total: number;
  open: number;
  terminal: number;
  verified: number;
  rejected: number;
}) {
  return available(input);
}

/* -------------------------------------------------------------------------- */
/* Agent state                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Derives one agent's activity from facts scoped to that agent.
 *
 * As with tasks, the inputs are per-agent on purpose: an agent's state must not
 * change because its run happens to sit outside a project-wide display window.
 */
export function projectAgentState(input: {
  agent: OperationalAgentRecord;
  /** The agent's in-flight run, or null. */
  activeRun: OperationalAgentRunRecord | null;
  /** The agent's most recently updated run of any status, or null. */
  latestRun: OperationalAgentRunRecord | null;
  /** The active pipeline stage assigned to this agent, or null. */
  stage: AgentActiveStageRecord | null;
}): AgentState {
  const activeRun = input.activeRun ?? undefined;
  const latestRun = input.latestRun ?? undefined;
  const stage: AgentState["currentStage"] =
    input.stage === null
      ? null
      : {
          pipelineRunId: input.stage.pipelineRunId,
          stageId: input.stage.stageId,
          name: input.stage.stageName,
          status: input.stage.stageStatus,
        };

  let state: AgentActivityState;
  if (!input.agent.enabled) state = "disabled";
  else if (stage?.status === "awaiting_approval") state = "awaiting_approval";
  else if (activeRun !== undefined) state = "working";
  else if (stage !== null) state = "working";
  else if (latestRun?.status === "failed") state = "last_run_failed";
  else state = "idle";

  const currentRunRecord = activeRun ?? null;
  return {
    agentId: input.agent.id,
    projectId: input.agent.projectId,
    name: input.agent.name,
    roleId: input.agent.roleId,
    roleKey: input.agent.roleKey,
    roleName: input.agent.roleName,
    enabled: input.agent.enabled,
    state,
    currentRun:
      currentRunRecord === null ? null : agentRunReference(currentRunRecord),
    currentTask:
      currentRunRecord === null || currentRunRecord.taskTitle === null
        ? null
        : {
            taskId: currentRunRecord.taskId,
            title: currentRunRecord.taskTitle,
          },
    currentStage: stage,
    lastActivityAt: latestRun === undefined ? null : iso(latestRun.updatedAt),
  };
}

/* -------------------------------------------------------------------------- */
/* Project summary                                                             */
/* -------------------------------------------------------------------------- */

export function projectProjectSummary(input: {
  project: OperationalProjectRecord;
  taskCounts: readonly StatusCountRecord<TaskStatus>[];
  requirementCounts: readonly RequirementCountRecord[];
  milestones: readonly OperationalMilestoneRecord[];
  activePipelineRuns: number;
  activeAgentRuns: number;
  agentsWorking: number;
  /** Exact count of pending reviews, never the length of a displayed sample. */
  pendingReviews: number;
  /** Bounded sample beside its authoritative total. */
  attention: BoundedList<AttentionReason>;
  lastActivityAt: Date | null;
}): ProjectSummary {
  const activeMilestones = input.milestones.filter(
    (milestone) => milestone.status === "active",
  );
  const currentMilestone =
    activeMilestones.length === 1 && activeMilestones[0] !== undefined
      ? projectMilestoneSummary(activeMilestones[0], input.requirementCounts)
      : null;
  return {
    projectId: input.project.id,
    name: input.project.name,
    description: input.project.description,
    repository: {
      repositoryId: input.project.repositoryId,
      localPaths: [...input.project.localPaths],
      remoteUrl: input.project.remoteUrl,
      defaultBranch: input.project.defaultBranch,
    },
    currentMilestone,
    milestoneCount: input.milestones.length,
    activeMilestoneCount: activeMilestones.length,
    tasks: projectTaskCounts(input.taskCounts),
    requirements: projectRequirementCounts(input.requirementCounts),
    activeAgentRuns: input.activeAgentRuns,
    activePipelineRuns: input.activePipelineRuns,
    pendingReviews: input.pendingReviews,
    agentsWorking: input.agentsWorking,
    // Authoritative: the total, not the length of the displayed sample.
    attentionRequired: input.attention.total > 0,
    attention: input.attention,
    lastActivityAt: latest(
      isoOrNull(input.lastActivityAt),
      iso(input.project.updatedAt),
    ),
    createdAt: iso(input.project.createdAt),
    updatedAt: iso(input.project.updatedAt),
  };
}

export type { ReviewStatus };
