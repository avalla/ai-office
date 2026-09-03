/**
 * Application query service for operational read models.
 *
 * This is the only place that decides which persisted facts feed which read
 * model. Transports call it; they never assemble read models themselves and
 * never reach a repository directly.
 */

import type { PipelineRunProps } from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { TaskProps, TaskStatus } from "@ai-office/domain/task/task.ts";
import type { Clock } from "../ports/clock.port.ts";
import type {
  OperationalActivePipelineStageRecord,
  OperationalAgentRecord,
  OperationalAgentRunRecord,
  OperationalProjectRecord,
  OperationalReadRepository,
  RequirementCountRecord,
  StatusCountRecord,
} from "../ports/operational-read.port.ts";
import type { PipelineRunRepository } from "../ports/pipeline-run-repository.port.ts";
import type { TaskRepository } from "../ports/task-repository.port.ts";
import { queryLimits } from "../protocol/query-protocol.ts";
import { projectActivityEntry } from "../read-models/activity-sanitization.ts";
import {
  activeAgentRunStatuses,
  agentReference,
  agentRunAttentionReasons,
  isActiveAgentRunStatus,
  projectAgentRunEvent,
  projectAgentRunState,
  projectAgentState,
  projectMilestoneSummary,
  projectPipelineRunState,
  projectProjectSummary,
  projectReviewState,
  projectRunActions,
  projectTaskOperationalState,
  reviewAttentionReason,
} from "../read-models/operational-projection.ts";
import type {
  ActivityEntry,
  AgentReference,
  AgentRunDetail,
  AgentRunState,
  AgentState,
  AttentionReason,
  DashboardOverview,
  MilestoneSummary,
  PipelineRunState,
  ProjectDetail,
  ProjectSummary,
  ReviewState,
  TaskOperationalState,
  TaskReference,
} from "../read-models/operational-read-models.ts";

export class OperationalResourceNotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} was not found`);
    this.name = "OperationalResourceNotFoundError";
  }
}

export interface OperationalQueryServiceDependencies {
  reads: OperationalReadRepository;
  tasks: TaskRepository;
  pipelines: PipelineRunRepository;
  clock: Clock;
}

function groupBy<T, K>(
  values: readonly T[],
  key: (value: T) => K,
): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const value of values) {
    const group = result.get(key(value));
    if (group === undefined) result.set(key(value), [value]);
    else group.push(value);
  }
  return result;
}

function agentIndex(
  records: readonly OperationalAgentRecord[],
): Map<string, AgentReference> {
  return new Map(
    records.map((record) => [record.id, agentReference(record)] as const),
  );
}

export class OperationalQueryService {
  private readonly reads: OperationalReadRepository;
  private readonly tasks: TaskRepository;
  private readonly pipelines: PipelineRunRepository;
  private readonly clock: Clock;

  constructor(dependencies: OperationalQueryServiceDependencies) {
    this.reads = dependencies.reads;
    this.tasks = dependencies.tasks;
    this.pipelines = dependencies.pipelines;
    this.clock = dependencies.clock;
  }

  /* ---------------------------------------------------------------------- */
  /* Overview                                                                */
  /* ---------------------------------------------------------------------- */

  async getDashboardOverview(options?: {
    activityLimit?: number;
    runLimit?: number;
  }): Promise<DashboardOverview> {
    const projects = await this.reads.listProjects();
    const projectIds = projects.map((project) => project.id);

    // Each of these is one bounded query across every project, so the number of
    // queries stays constant as projects are added.
    const [
      taskCounts,
      requirementCounts,
      milestones,
      agents,
      activePipelineCounts,
      lastActivity,
      activeRuns,
      failedRuns,
      pendingReviews,
      activity,
      attentionTasks,
      activeStages,
    ] = await Promise.all([
      this.reads.countTasksByStatus(projectIds),
      this.reads.countRequirementsByStatus(projectIds),
      this.reads.listMilestones(projectIds),
      this.reads.listAgents(projectIds),
      this.reads.countActivePipelineRuns(projectIds),
      this.reads.lastActivityAt(projectIds),
      this.reads.listAgentRuns({
        projectIds,
        statuses: activeAgentRunStatuses,
        limit: options?.runLimit ?? queryLimits.runs.default,
      }),
      this.reads.listAgentRuns({
        projectIds,
        statuses: ["failed"],
        limit: queryLimits.runs.default,
      }),
      this.reads.listReviews({
        projectIds,
        statuses: ["pending"],
        limit: queryLimits.reviews.max,
      }),
      this.reads.listActivity({
        limit: options?.activityLimit ?? queryLimits.activity.default,
      }),
      this.reads.listAttentionTasks(projectIds, queryLimits.tasks.default),
      this.reads.listActivePipelineStages(projectIds),
    ]);

    const tasksByProject = groupBy(taskCounts, (value) => value.projectId);
    const requirementsByProject = groupBy(
      requirementCounts,
      (value) => value.projectId,
    );
    const milestonesByProject = groupBy(milestones, (value) => value.projectId);
    const activeRunsByProject = groupBy(activeRuns, (value) => value.projectId);
    const failedRunsByProject = groupBy(failedRuns, (value) => value.projectId);
    const reviewsByProject = groupBy(
      pendingReviews,
      (value) => value.projectId,
    );
    const pipelineCounts = new Map(
      activePipelineCounts.map((value) => [value.projectId, value.count]),
    );
    const activityAt = new Map(
      lastActivity.map((value) => [value.projectId, value.occurredAt]),
    );
    const agentsByProject = groupBy(agents, (value) => value.projectId);
    const attentionTasksByProject = groupBy(
      attentionTasks,
      (value) => value.projectId,
    );
    const activeStagesByProject = groupBy(
      activeStages,
      (value) => value.projectId,
    );

    const summaries: ProjectSummary[] = [];
    const allAttention: AttentionReason[] = [];

    for (const project of projects) {
      const reviews = (reviewsByProject.get(project.id) ?? []).map(
        projectReviewState,
      );
      const attention: AttentionReason[] = [];
      for (const review of reviews) {
        const reason = reviewAttentionReason(review);
        if (reason !== null) attention.push(reason);
      }
      for (const run of failedRunsByProject.get(project.id) ?? [])
        attention.push(...agentRunAttentionReasons(projectAgentRunState(run)));
      for (const stage of activeStagesByProject.get(project.id) ?? []) {
        const reason = activePipelineStageAttention(stage);
        if (reason !== null) attention.push(reason);
      }
      for (const task of attentionTasksByProject.get(project.id) ?? [])
        attention.push({
          kind: task.status === "blocked" ? "task_blocked" : "task_failed",
          projectId: task.projectId,
          subjectType: "task",
          subjectId: task.taskId,
          summary:
            task.status === "blocked" ? "Task is blocked" : "Task failed",
          since: task.updatedAt.toISOString(),
        });

      const projectActiveRuns = activeRunsByProject.get(project.id) ?? [];
      const workingAgents = new Set(
        projectActiveRuns.map((run) => run.agentId),
      );
      const projectAgents = agentsByProject.get(project.id) ?? [];

      summaries.push(
        projectProjectSummary({
          project,
          taskCounts: tasksByProject.get(project.id) ?? [],
          requirementCounts: requirementsByProject.get(project.id) ?? [],
          milestones: milestonesByProject.get(project.id) ?? [],
          activePipelineRuns: pipelineCounts.get(project.id) ?? 0,
          activeAgentRuns: projectActiveRuns.length,
          agentsWorking: projectAgents.filter((agent) =>
            workingAgents.has(agent.id),
          ).length,
          reviews,
          attentionReasons: attention,
          lastActivityAt: activityAt.get(project.id) ?? null,
        }),
      );
      allAttention.push(...attention);
    }

    return {
      generatedAt: this.clock.now().toISOString(),
      projects: summaries,
      totals: {
        projects: summaries.length,
        openTasks: summaries.reduce(
          (total, summary) => total + summary.tasks.open,
          0,
        ),
        activeAgentRuns: activeRuns.length,
        activePipelineRuns: summaries.reduce(
          (total, summary) => total + summary.activePipelineRuns,
          0,
        ),
        pendingReviews: pendingReviews.length,
        agentsWorking: summaries.reduce(
          (total, summary) => total + summary.agentsWorking,
          0,
        ),
        attentionItems: allAttention.length,
      },
      attentionReasons: allAttention,
      activeRuns: activeRuns.map(projectAgentRunState),
      recentActivity: activity.map(projectActivityEntry),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Projects                                                                */
  /* ---------------------------------------------------------------------- */

  async listProjects(): Promise<readonly ProjectSummary[]> {
    return (await this.getDashboardOverview({ activityLimit: 1 })).projects;
  }

  async getProjectDetail(
    projectId: string,
    options?: { taskLimit?: number; runLimit?: number; activityLimit?: number },
  ): Promise<ProjectDetail> {
    const project = await this.requireProject(projectId);
    const projectIds = [projectId];

    const [
      taskCounts,
      requirementCounts,
      milestoneRecords,
      agentRecords,
      activePipelineCounts,
      lastActivity,
      runs,
      reviewRecords,
      activity,
      taskAggregates,
      pipelineAggregates,
    ] = await Promise.all([
      this.reads.countTasksByStatus(projectIds),
      this.reads.countRequirementsByStatus(projectIds),
      this.reads.listMilestones(projectIds),
      this.reads.listAgents(projectIds),
      this.reads.countActivePipelineRuns(projectIds),
      this.reads.lastActivityAt(projectIds),
      this.reads.listAgentRuns({
        projectIds,
        limit: options?.runLimit ?? queryLimits.runs.default,
      }),
      this.reads.listReviews({
        projectIds,
        limit: queryLimits.reviews.max,
      }),
      this.reads.listActivity({
        projectId,
        limit: options?.activityLimit ?? queryLimits.activity.default,
      }),
      this.tasks.listByProject(projectId),
      this.pipelines.listByProject(projectId),
    ]);

    const agents = agentIndex(agentRecords);
    const pipelineRuns = pipelineAggregates.map((run) => run.snapshot());
    const reviews = reviewRecords.map(projectReviewState);
    const taskLimit = options?.taskLimit ?? queryLimits.tasks.default;
    const taskSnapshots = taskAggregates
      .map((task) => task.snapshot())
      .slice(0, taskLimit);

    const tasks = taskSnapshots.map((task) =>
      this.taskState({ task, runs, pipelineRuns, reviews, agents }),
    );
    const pipelines = pipelineRuns.map((run) =>
      projectPipelineRunState({
        run,
        task: this.taskReference(run.taskId, taskAggregates),
        agentsById: agents,
      }),
    );
    const agentStates = agentRecords.map((agent) =>
      projectAgentState({ agent, runs, pipelineRuns }),
    );

    const attention: AttentionReason[] = [];
    for (const task of tasks) attention.push(...task.attentionReasons);
    for (const pipeline of pipelines)
      attention.push(...pipeline.attentionReasons);
    for (const run of runs)
      if (run.status === "failed")
        attention.push(...agentRunAttentionReasons(projectAgentRunState(run)));
    for (const review of reviews) {
      const reason = reviewAttentionReason(review);
      // Reviews already surfaced through their task must not be counted twice.
      if (
        reason !== null &&
        !attention.some(
          (existing) =>
            existing.kind === reason.kind &&
            existing.subjectId === reason.subjectId,
        )
      )
        attention.push(reason);
    }

    const activeRuns = runs.filter((run) => isActiveAgentRunStatus(run.status));
    const workingAgents = new Set(activeRuns.map((run) => run.agentId));

    const summary = projectProjectSummary({
      project,
      taskCounts: taskCounts as readonly StatusCountRecord<TaskStatus>[],
      requirementCounts: requirementCounts as readonly RequirementCountRecord[],
      milestones: milestoneRecords,
      activePipelineRuns: activePipelineCounts[0]?.count ?? 0,
      activeAgentRuns: activeRuns.length,
      agentsWorking: agentRecords.filter((agent) => workingAgents.has(agent.id))
        .length,
      reviews,
      attentionReasons: attention,
      lastActivityAt: lastActivity[0]?.occurredAt ?? null,
    });

    const milestones: MilestoneSummary[] = milestoneRecords.map((record) =>
      projectMilestoneSummary(record, requirementCounts),
    );

    return {
      generatedAt: this.clock.now().toISOString(),
      summary,
      milestones,
      tasks,
      pipelines,
      agents: agentStates,
      runs: runs.map(projectAgentRunState),
      reviews,
      recentActivity: activity.map(projectActivityEntry),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Tasks and pipelines                                                     */
  /* ---------------------------------------------------------------------- */

  async listTasks(
    projectId: string,
    limit: number = queryLimits.tasks.default,
  ): Promise<readonly TaskOperationalState[]> {
    await this.requireProject(projectId);
    const [
      taskAggregates,
      runs,
      reviewRecords,
      pipelineAggregates,
      agentRecords,
    ] = await Promise.all([
      this.tasks.listByProject(projectId),
      this.reads.listAgentRuns({
        projectIds: [projectId],
        limit: queryLimits.runs.max,
      }),
      this.reads.listReviews({
        projectIds: [projectId],
        limit: queryLimits.reviews.max,
      }),
      this.pipelines.listActiveByProject(projectId),
      this.reads.listAgents([projectId]),
    ]);
    const reviews = reviewRecords.map(projectReviewState);
    const pipelineRuns = pipelineAggregates.map((run) => run.snapshot());
    const agents = agentIndex(agentRecords);
    return taskAggregates.slice(0, limit).map((task) =>
      this.taskState({
        task: task.snapshot(),
        runs,
        pipelineRuns,
        reviews,
        agents,
      }),
    );
  }

  async listPipelineRuns(
    projectId: string,
    options?: { activeOnly?: boolean; limit?: number },
  ): Promise<readonly PipelineRunState[]> {
    await this.requireProject(projectId);
    const [aggregates, taskAggregates, agentRecords] = await Promise.all([
      options?.activeOnly === true
        ? this.pipelines.listActiveByProject(projectId)
        : this.pipelines.listByProject(projectId),
      this.tasks.listByProject(projectId),
      this.reads.listAgents([projectId]),
    ]);
    const agents = agentIndex(agentRecords);
    return aggregates
      .slice(0, options?.limit ?? queryLimits.pipelines.default)
      .map((run) =>
        projectPipelineRunState({
          run: run.snapshot(),
          task: this.taskReference(run.snapshot().taskId, taskAggregates),
          agentsById: agents,
        }),
      );
  }

  /* ---------------------------------------------------------------------- */
  /* Runs                                                                    */
  /* ---------------------------------------------------------------------- */

  async listRuns(options?: {
    projectId?: string;
    activeOnly?: boolean;
    limit?: number;
  }): Promise<readonly AgentRunState[]> {
    if (options?.projectId !== undefined)
      await this.requireProject(options.projectId);
    const runs = await this.reads.listAgentRuns({
      ...(options?.projectId === undefined
        ? {}
        : { projectIds: [options.projectId] }),
      ...(options?.activeOnly === true
        ? { statuses: activeAgentRunStatuses }
        : {}),
      limit: options?.limit ?? queryLimits.runs.default,
    });
    return runs.map(projectAgentRunState);
  }

  async getRunDetail(runId: string): Promise<AgentRunDetail> {
    const record = await this.reads.findAgentRun(runId);
    if (record === null)
      throw new OperationalResourceNotFoundError("Agent run", runId);

    const [events, reviewRecords, activity, agentRecords] = await Promise.all([
      this.reads.listAgentRunEvents(runId, queryLimits.runEvents.default),
      this.reads.listReviews({
        projectIds: [record.projectId],
        subjectIds: [runId],
        limit: queryLimits.reviews.default,
      }),
      this.reads.listActivity({
        projectId: record.projectId,
        limit: queryLimits.activity.default,
      }),
      this.reads.listAgents([record.projectId]),
    ]);

    let pipeline: PipelineRunState | null = null;
    if (record.pipelineRunId !== null) {
      const aggregate = await this.pipelines.findById(
        record.pipelineRunId,
        record.projectId,
      );
      if (aggregate !== null)
        pipeline = projectPipelineRunState({
          run: aggregate.snapshot(),
          task:
            record.taskTitle === null
              ? null
              : { taskId: record.taskId, title: record.taskTitle },
          agentsById: agentIndex(agentRecords),
        });
    }

    const run = projectAgentRunState(record);
    return {
      run,
      events: events.map(projectAgentRunEvent),
      actions: projectRunActions(record.result),
      pipeline,
      reviews: reviewRecords.map(projectReviewState),
      // Run-scoped activity is not persisted as such; the surrounding project
      // activity is returned instead, filtered to events that name this run.
      activity: activity
        .filter((entry) => entry.aggregateId === runId)
        .map(projectActivityEntry),
      attentionReasons: agentRunAttentionReasons(run),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Governance and activity                                                 */
  /* ---------------------------------------------------------------------- */

  async listReviews(options?: {
    projectId?: string;
    pendingOnly?: boolean;
    limit?: number;
  }): Promise<readonly ReviewState[]> {
    if (options?.projectId !== undefined)
      await this.requireProject(options.projectId);
    const records = await this.reads.listReviews({
      ...(options?.projectId === undefined
        ? {}
        : { projectIds: [options.projectId] }),
      ...(options?.pendingOnly === true ? { statuses: ["pending"] } : {}),
      limit: options?.limit ?? queryLimits.reviews.default,
    });
    return records.map(projectReviewState);
  }

  async listApprovals(options?: {
    projectId?: string;
    limit?: number;
  }): Promise<readonly ReviewState[]> {
    if (options?.projectId !== undefined)
      await this.requireProject(options.projectId);
    const records = await this.reads.listReviews({
      ...(options?.projectId === undefined
        ? {}
        : { projectIds: [options.projectId] }),
      statuses: ["approved", "rejected"],
      limit: options?.limit ?? queryLimits.reviews.default,
    });
    return records.map(projectReviewState);
  }

  async listAgents(projectId: string): Promise<readonly AgentState[]> {
    await this.requireProject(projectId);
    const [agentRecords, runs, pipelineAggregates] = await Promise.all([
      this.reads.listAgents([projectId]),
      this.reads.listAgentRuns({
        projectIds: [projectId],
        limit: queryLimits.runs.max,
      }),
      this.pipelines.listActiveByProject(projectId),
    ]);
    const pipelineRuns = pipelineAggregates.map((run) => run.snapshot());
    return agentRecords.map((agent) =>
      projectAgentState({ agent, runs, pipelineRuns }),
    );
  }

  async listActivity(options?: {
    projectId?: string;
    before?: Date;
    limit?: number;
  }): Promise<readonly ActivityEntry[]> {
    if (options?.projectId !== undefined)
      await this.requireProject(options.projectId);
    const records = await this.reads.listActivity({
      ...(options?.projectId === undefined
        ? {}
        : { projectId: options.projectId }),
      ...(options?.before === undefined ? {} : { before: options.before }),
      limit: options?.limit ?? queryLimits.activity.default,
    });
    return records.map(projectActivityEntry);
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private async requireProject(
    projectId: string,
  ): Promise<OperationalProjectRecord> {
    const project = await this.reads.findProject(projectId);
    if (project === null)
      throw new OperationalResourceNotFoundError("Project", projectId);
    return project;
  }

  private taskState(input: {
    task: TaskProps;
    runs: readonly OperationalAgentRunRecord[];
    pipelineRuns: readonly PipelineRunProps[];
    reviews: readonly ReviewState[];
    agents: ReadonlyMap<string, AgentReference>;
  }): TaskOperationalState {
    return projectTaskOperationalState({
      task: input.task,
      runs: input.runs.filter((run) => run.taskId === input.task.id),
      pipelineRun:
        input.pipelineRuns.find(
          (run) => run.taskId === input.task.id && run.status === "active",
        ) ?? null,
      reviews: input.reviews.filter(
        (review) =>
          review.subjectType === "task" && review.subjectId === input.task.id,
      ),
      agentsById: input.agents,
    });
  }

  private taskReference(
    taskId: string,
    tasks: readonly { snapshot(): TaskProps }[],
  ): TaskReference | null {
    const task = tasks.find((value) => value.snapshot().id === taskId);
    return task === undefined ? null : { taskId, title: task.snapshot().title };
  }
}

/**
 * Attention derived from the current stage of an active pipeline run, without
 * loading the full run aggregate. It mirrors the reasons that
 * `projectPipelineRunState` produces for the same stage.
 */
function activePipelineStageAttention(
  stage: OperationalActivePipelineStageRecord,
): AttentionReason | null {
  if (stage.stageStatus === "awaiting_approval")
    return {
      kind: "pipeline_stage_awaiting_approval",
      projectId: stage.projectId,
      subjectType: "pipeline_run",
      subjectId: stage.pipelineRunId,
      summary: `Stage ${stage.stageName} is awaiting approval`,
      since: (stage.stageCompletedAt ?? stage.updatedAt).toISOString(),
    };
  if (stage.stageStatus === "active" && stage.assignedAgentId === null)
    return {
      kind: "pipeline_stage_unassigned",
      projectId: stage.projectId,
      subjectType: "pipeline_run",
      subjectId: stage.pipelineRunId,
      summary: `Stage ${stage.stageName} has no assigned agent`,
      since: stage.updatedAt.toISOString(),
    };
  return null;
}
