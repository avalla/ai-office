/**
 * Application query service for operational read models.
 *
 * This is the only place that decides which persisted facts feed which read
 * model. Transports call it; they never assemble read models themselves and
 * never reach a repository directly.
 *
 * The service keeps three kinds of query strictly apart:
 *
 * - **authoritative aggregates** decide totals, statuses, and attention;
 * - **scoped projection inputs** describe exactly the entities being projected;
 * - **bounded samples and pages** are displayed, and always travel with the
 *   total or cursor that says what they leave out.
 *
 * A result may be bounded, but bounded evidence must never silently change an
 * authoritative count, status, attention decision, or relationship.
 */

import type { AgentRunStatus } from "@ai-office/domain/agent/agent-run.ts";
import type { TaskProps } from "@ai-office/domain/task/task.ts";
import type { Clock } from "../ports/clock.port.ts";
import type {
  AgentActiveStagesRecord,
  AgentRunFactsRecord,
  TaskLeaseRecord,
  OperationalActivePipelineStageRecord,
  OperationalAgentRecord,
  OperationalPipelineRunRecord,
  OperationalProjectRecord,
  OperationalReadRepository,
  TaskRunFactsRecord,
} from "../ports/operational-read.port.ts";
import {
  encodeActivityCursor,
  queryLimits,
  type ActivityCursor,
} from "../protocol/query-protocol.ts";
import { projectActivityEntry } from "../read-models/activity-sanitization.ts";
import {
  activeAgentRunStatuses,
  agentReference,
  agentRunAttentionReasons,
  projectAgentRunEvent,
  projectAgentRunState,
  projectAgentState,
  unleasedTaskRunsAttention,
  projectMilestoneSummary,
  projectPipelineRunState,
  projectProjectSummary,
  projectReviewState,
  projectRunActions,
  projectTaskOperationalState,
  reviewAttentionReason,
} from "../read-models/operational-projection.ts";
import {
  boundedList,
  type ActivityPage,
  type AgentReference,
  type AgentRunDetail,
  type AgentRunState,
  type AgentState,
  type AttentionReason,
  type BoundedList,
  type DashboardOverview,
  type MilestoneSummary,
  type PipelineRunState,
  type ProjectDetail,
  type ProjectSummary,
  type ReviewState,
  type TaskOperationalState,
} from "../read-models/operational-read-models.ts";

export class OperationalResourceNotFoundError extends Error {
  constructor(resource: string, id: string) {
    super(`${resource} ${id} was not found`);
    this.name = "OperationalResourceNotFoundError";
  }
}

export interface OperationalQueryServiceDependencies {
  reads: OperationalReadRepository;
  clock: Clock;
}

const failedRunStatuses: readonly AgentRunStatus[] = ["failed"];

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

function countsByProject(
  records: readonly { projectId: string; count: number }[],
): Map<string, number> {
  return new Map(records.map((record) => [record.projectId, record.count]));
}

function agentIndex(
  records: readonly OperationalAgentRecord[],
): Map<string, AgentReference> {
  return new Map(
    records.map((record) => [record.id, agentReference(record)] as const),
  );
}

/** Builds the next keyset cursor, or null when the page ended the stream. */
function nextActivityCursor(
  records: readonly { id: string; occurredAt: Date }[],
  limit: number,
): string | null {
  if (records.length < limit) return null;
  const last = records[records.length - 1];
  if (last === undefined) return null;
  return encodeActivityCursor({ occurredAt: last.occurredAt, id: last.id });
}

export class OperationalQueryService {
  private readonly reads: OperationalReadRepository;
  private readonly clock: Clock;

  constructor(dependencies: OperationalQueryServiceDependencies) {
    this.reads = dependencies.reads;
    this.clock = dependencies.clock;
  }

  /* ---------------------------------------------------------------------- */
  /* Overview                                                                */
  /* ---------------------------------------------------------------------- */

  async getDashboardOverview(options?: {
    activityLimit?: number;
    runLimit?: number;
    attentionLimit?: number;
  }): Promise<DashboardOverview> {
    const projects = await this.reads.listProjects();
    const projectIds = projects.map((project) => project.id);
    const runLimit = options?.runLimit ?? queryLimits.runs.default;
    const attentionLimit =
      options?.attentionLimit ?? queryLimits.attention.default;
    const activityLimit =
      options?.activityLimit ?? queryLimits.activity.default;

    const [
      // Authoritative aggregates.
      taskCounts,
      requirementCounts,
      activeRunCounts,
      failedRunCounts,
      workingAgentCounts,
      pendingReviewCounts,
      activePipelineCounts,
      attentionStageCounts,
      unleasedTaskCounts,
      lastActivity,
      milestones,
      // Bounded samples, each shown beside one of the totals above.
      activeRuns,
      failedRunSample,
      pendingReviewSample,
      attentionTaskSample,
      attentionStageSample,
      unleasedTaskSample,
      activity,
    ] = await Promise.all([
      this.reads.countTasksByStatus(projectIds),
      this.reads.countRequirementsByStatus(projectIds),
      this.reads.countAgentRuns({
        projectIds,
        statuses: activeAgentRunStatuses,
      }),
      this.reads.countAgentRuns({ projectIds, statuses: failedRunStatuses }),
      this.reads.countDistinctRunAgents({
        projectIds,
        statuses: activeAgentRunStatuses,
      }),
      this.reads.countReviews({ projectIds, statuses: ["pending"] }),
      this.reads.countActivePipelineRuns(projectIds),
      this.reads.countAttentionStages(projectIds),
      this.reads.countTasksWithUnleasedRuns(projectIds),
      this.reads.lastActivityAt(projectIds),
      this.reads.listMilestones(projectIds),
      this.reads.listAgentRuns({
        projectIds,
        statuses: activeAgentRunStatuses,
        limit: runLimit,
      }),
      this.reads.listAgentRuns({
        projectIds,
        statuses: failedRunStatuses,
        limit: attentionLimit,
      }),
      this.reads.listReviews({
        projectIds,
        statuses: ["pending"],
        limit: attentionLimit,
      }),
      this.reads.listAttentionTasks(projectIds, attentionLimit),
      this.reads.listActivePipelineStages(projectIds, attentionLimit),
      this.reads.listUnleasedTaskRuns(projectIds, attentionLimit),
      this.reads.listActivity({ limit: activityLimit }),
    ]);

    const tasksByProject = groupBy(taskCounts, (value) => value.projectId);
    const requirementsByProject = groupBy(
      requirementCounts,
      (value) => value.projectId,
    );
    const milestonesByProject = groupBy(milestones, (value) => value.projectId);
    const activeRunCount = countsByProject(activeRunCounts);
    const failedRunCount = countsByProject(failedRunCounts);
    const workingAgentCount = countsByProject(workingAgentCounts);
    const pendingReviewCount = countsByProject(pendingReviewCounts);
    const pipelineCount = countsByProject(activePipelineCounts);
    const attentionStageCount = countsByProject(attentionStageCounts);
    const unleasedTaskCount = countsByProject(unleasedTaskCounts);
    const activityAt = new Map(
      lastActivity.map((value) => [value.projectId, value.occurredAt]),
    );

    const failedRunsByProject = groupBy(
      failedRunSample,
      (value) => value.projectId,
    );
    const reviewsByProject = groupBy(
      pendingReviewSample,
      (value) => value.projectId,
    );
    const attentionTasksByProject = groupBy(
      attentionTaskSample,
      (value) => value.projectId,
    );
    const attentionStagesByProject = groupBy(
      attentionStageSample,
      (value) => value.projectId,
    );
    const unleasedTasksByProject = groupBy(
      unleasedTaskSample,
      (value) => value.projectId,
    );

    const summaries: ProjectSummary[] = [];
    const attentionItems: AttentionReason[] = [];
    let attentionTotal = 0;

    for (const project of projects) {
      // The total is the sum of exact counts; the items are what the samples
      // happened to contain. The two are computed independently on purpose.
      const projectAttentionTotal =
        (pendingReviewCount.get(project.id) ?? 0) +
        (failedRunCount.get(project.id) ?? 0) +
        (attentionStageCount.get(project.id) ?? 0) +
        (unleasedTaskCount.get(project.id) ?? 0) +
        this.attentionTaskTotal(tasksByProject.get(project.id) ?? []);

      const items: AttentionReason[] = [];
      for (const review of reviewsByProject.get(project.id) ?? []) {
        const reason = reviewAttentionReason(projectReviewState(review));
        if (reason !== null) items.push(reason);
      }
      for (const run of failedRunsByProject.get(project.id) ?? [])
        items.push(...agentRunAttentionReasons(projectAgentRunState(run)));
      for (const stage of attentionStagesByProject.get(project.id) ?? []) {
        const reason = activePipelineStageAttention(stage);
        if (reason !== null) items.push(reason);
      }
      for (const task of attentionTasksByProject.get(project.id) ?? [])
        items.push(attentionTaskReason(task));
      for (const task of unleasedTasksByProject.get(project.id) ?? [])
        items.push(unleasedTaskRunsAttention(task));

      const attention: BoundedList<AttentionReason> = {
        total: projectAttentionTotal,
        items: items.slice(0, attentionLimit),
        truncated: items.length < projectAttentionTotal,
      };

      summaries.push(
        projectProjectSummary({
          project,
          taskCounts: tasksByProject.get(project.id) ?? [],
          requirementCounts: requirementsByProject.get(project.id) ?? [],
          milestones: milestonesByProject.get(project.id) ?? [],
          activePipelineRuns: pipelineCount.get(project.id) ?? 0,
          activeAgentRuns: activeRunCount.get(project.id) ?? 0,
          agentsWorking: workingAgentCount.get(project.id) ?? 0,
          pendingReviews: pendingReviewCount.get(project.id) ?? 0,
          attention,
          lastActivityAt: activityAt.get(project.id) ?? null,
        }),
      );
      attentionItems.push(...attention.items);
      attentionTotal += projectAttentionTotal;
    }

    const totalActiveRuns = sum(activeRunCounts);
    return {
      generatedAt: this.clock.now().toISOString(),
      projects: summaries,
      totals: {
        projects: summaries.length,
        openTasks: summaries.reduce(
          (total, summary) => total + summary.tasks.open,
          0,
        ),
        activeAgentRuns: totalActiveRuns,
        activePipelineRuns: sum(activePipelineCounts),
        pendingReviews: sum(pendingReviewCounts),
        agentsWorking: sum(workingAgentCounts),
        attentionItems: attentionTotal,
      },
      attention: {
        total: attentionTotal,
        items: attentionItems.slice(0, attentionLimit),
        truncated: attentionItems.length < attentionTotal,
      },
      activeRuns: boundedList(
        activeRuns.map(projectAgentRunState),
        totalActiveRuns,
      ),
      recentActivity: {
        items: activity.map(projectActivityEntry),
        nextCursor: nextActivityCursor(activity, activityLimit),
      },
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
    options?: {
      taskLimit?: number;
      runLimit?: number;
      activityLimit?: number;
      pipelineLimit?: number;
    },
  ): Promise<ProjectDetail> {
    const project = await this.requireProject(projectId);
    const projectIds = [projectId];
    const taskLimit = options?.taskLimit ?? queryLimits.tasks.default;
    const runLimit = options?.runLimit ?? queryLimits.runs.default;
    const pipelineLimit =
      options?.pipelineLimit ?? queryLimits.pipelines.default;
    const activityLimit =
      options?.activityLimit ?? queryLimits.activity.default;
    const attentionLimit = queryLimits.attention.default;

    const [
      // Authoritative aggregates.
      taskCounts,
      requirementCounts,
      activeRunCounts,
      failedRunCounts,
      workingAgentCounts,
      pendingReviewCounts,
      reviewTotalCounts,
      activePipelineCounts,
      attentionStageCounts,
      unleasedTaskCounts,
      pipelineTotal,
      runTotalCounts,
      lastActivity,
      milestoneRecords,
      agentRecords,
      // Bounded samples.
      taskPage,
      runSample,
      reviewSample,
      pipelineSample,
      attentionTaskSample,
      attentionStageSample,
      unleasedTaskSample,
      failedRunSample,
      pendingReviewSample,
      activity,
    ] = await Promise.all([
      this.reads.countTasksByStatus(projectIds),
      this.reads.countRequirementsByStatus(projectIds),
      this.reads.countAgentRuns({
        projectIds,
        statuses: activeAgentRunStatuses,
      }),
      this.reads.countAgentRuns({ projectIds, statuses: failedRunStatuses }),
      this.reads.countDistinctRunAgents({
        projectIds,
        statuses: activeAgentRunStatuses,
      }),
      this.reads.countReviews({ projectIds, statuses: ["pending"] }),
      this.reads.countReviews({
        projectIds,
        statuses: ["pending", "approved", "rejected"],
      }),
      this.reads.countActivePipelineRuns(projectIds),
      this.reads.countAttentionStages(projectIds),
      this.reads.countTasksWithUnleasedRuns(projectIds),
      this.reads.countPipelineRuns(projectId, false),
      this.reads.countAgentRuns({ projectIds }),
      this.reads.lastActivityAt(projectIds),
      this.reads.listMilestones(projectIds),
      this.reads.listAgents(projectIds),
      this.reads.listTasks(projectId, taskLimit),
      this.reads.listAgentRuns({ projectIds, limit: runLimit }),
      this.reads.listReviews({
        projectIds,
        limit: queryLimits.reviews.default,
      }),
      this.reads.listPipelineRuns({ projectId, limit: pipelineLimit }),
      this.reads.listAttentionTasks(projectIds, attentionLimit),
      this.reads.listActivePipelineStages(projectIds, attentionLimit),
      this.reads.listUnleasedTaskRuns(projectIds, attentionLimit),
      this.reads.listAgentRuns({
        projectIds,
        statuses: failedRunStatuses,
        limit: attentionLimit,
      }),
      this.reads.listReviews({
        projectIds,
        statuses: ["pending"],
        limit: attentionLimit,
      }),
      this.reads.listActivity({ projectId, limit: activityLimit }),
    ]);

    const agents = agentIndex(agentRecords);
    const tasks = await this.projectTasks(projectId, taskPage, agents);
    const agentStates = await this.projectAgents(projectId, agentRecords);

    // Attention is computed from project-wide aggregates and samples, never
    // from the displayed task page: a blocked task on page two still counts.
    const attentionTotal =
      (pendingReviewCounts[0]?.count ?? 0) +
      (failedRunCounts[0]?.count ?? 0) +
      (attentionStageCounts[0]?.count ?? 0) +
      (unleasedTaskCounts[0]?.count ?? 0) +
      this.attentionTaskTotal(taskCounts);

    const attentionItems: AttentionReason[] = [];
    for (const review of pendingReviewSample) {
      const reason = reviewAttentionReason(projectReviewState(review));
      if (reason !== null) attentionItems.push(reason);
    }
    for (const run of failedRunSample)
      attentionItems.push(
        ...agentRunAttentionReasons(projectAgentRunState(run)),
      );
    for (const stage of attentionStageSample) {
      const reason = activePipelineStageAttention(stage);
      if (reason !== null) attentionItems.push(reason);
    }
    for (const task of attentionTaskSample)
      attentionItems.push(attentionTaskReason(task));
    for (const task of unleasedTaskSample)
      attentionItems.push(unleasedTaskRunsAttention(task));

    const summary = projectProjectSummary({
      project,
      taskCounts,
      requirementCounts,
      milestones: milestoneRecords,
      activePipelineRuns: activePipelineCounts[0]?.count ?? 0,
      activeAgentRuns: activeRunCounts[0]?.count ?? 0,
      agentsWorking: workingAgentCounts[0]?.count ?? 0,
      pendingReviews: pendingReviewCounts[0]?.count ?? 0,
      attention: {
        total: attentionTotal,
        items: attentionItems.slice(0, attentionLimit),
        truncated: attentionItems.length < attentionTotal,
      },
      lastActivityAt: lastActivity[0]?.occurredAt ?? null,
    });

    const milestones: MilestoneSummary[] = milestoneRecords.map((record) =>
      projectMilestoneSummary(record, requirementCounts),
    );

    const taskTotal = taskCounts.reduce(
      (total, record) => total + record.count,
      0,
    );

    return {
      generatedAt: this.clock.now().toISOString(),
      summary,
      milestones,
      agents: agentStates,
      tasks: boundedList(tasks, taskTotal),
      pipelines: boundedList(
        pipelineSample.map((record) =>
          projectPipelineRunState({
            run: record.run,
            task:
              record.taskTitle === null
                ? null
                : { taskId: record.run.taskId, title: record.taskTitle },
            agentsById: agents,
          }),
        ),
        pipelineTotal,
      ),
      runs: boundedList(
        runSample.map(projectAgentRunState),
        runTotalCounts[0]?.count ?? 0,
      ),
      reviews: boundedList(
        reviewSample.map(projectReviewState),
        reviewTotalCounts[0]?.count ?? 0,
      ),
      recentActivity: {
        items: activity.map(projectActivityEntry),
        nextCursor: nextActivityCursor(activity, activityLimit),
      },
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Tasks and pipelines                                                     */
  /* ---------------------------------------------------------------------- */

  async listTasks(
    projectId: string,
    limit: number = queryLimits.tasks.default,
  ): Promise<BoundedList<TaskOperationalState>> {
    await this.requireProject(projectId);
    const [taskPage, taskCounts, agentRecords] = await Promise.all([
      this.reads.listTasks(projectId, limit),
      this.reads.countTasksByStatus([projectId]),
      this.reads.listAgents([projectId]),
    ]);
    const tasks = await this.projectTasks(
      projectId,
      taskPage,
      agentIndex(agentRecords),
    );
    return boundedList(
      tasks,
      taskCounts.reduce((total, record) => total + record.count, 0),
    );
  }

  async listPipelineRuns(
    projectId: string,
    options?: { activeOnly?: boolean; limit?: number },
  ): Promise<BoundedList<PipelineRunState>> {
    await this.requireProject(projectId);
    const activeOnly = options?.activeOnly === true;
    const limit = options?.limit ?? queryLimits.pipelines.default;
    const [records, total, agentRecords] = await Promise.all([
      this.reads.listPipelineRuns({ projectId, activeOnly, limit }),
      this.reads.countPipelineRuns(projectId, activeOnly),
      this.reads.listAgents([projectId]),
    ]);
    const agents = agentIndex(agentRecords);
    return boundedList(
      records.map((record) =>
        projectPipelineRunState({
          run: record.run,
          task:
            record.taskTitle === null
              ? null
              : { taskId: record.run.taskId, title: record.taskTitle },
          agentsById: agents,
        }),
      ),
      total,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Runs                                                                    */
  /* ---------------------------------------------------------------------- */

  async listRuns(options?: {
    projectId?: string;
    activeOnly?: boolean;
    limit?: number;
  }): Promise<BoundedList<AgentRunState>> {
    if (options?.projectId !== undefined)
      await this.requireProject(options.projectId);
    const projectFilter =
      options?.projectId === undefined
        ? {}
        : { projectIds: [options.projectId] };
    const statuses = options?.activeOnly === true ? activeAgentRunStatuses : [];
    const [runs, counts] = await Promise.all([
      this.reads.listAgentRuns({
        ...projectFilter,
        ...(options?.activeOnly === true ? { statuses } : {}),
        limit: options?.limit ?? queryLimits.runs.default,
      }),
      this.reads.countAgentRuns({
        ...projectFilter,
        ...(options?.activeOnly === true ? { statuses } : {}),
      }),
    ]);
    return boundedList(runs.map(projectAgentRunState), sum(counts));
  }

  async getRunDetail(runId: string): Promise<AgentRunDetail> {
    const record = await this.reads.findAgentRun(runId);
    if (record === null)
      throw new OperationalResourceNotFoundError("Agent run", runId);

    // Activity is filtered to this run's aggregates inside SQL, before the
    // limit. Filtering a project page afterwards would report "no activity"
    // for any run whose events fell outside the latest project window.
    const aggregateIds =
      record.pipelineRunId === null ? [runId] : [runId, record.pipelineRunId];

    const [
      events,
      eventTotal,
      reviewRecords,
      activity,
      agentRecords,
      pipeline,
    ] = await Promise.all([
      // Bounded page, published beside its exact total.
      this.reads.listAgentRunEvents(runId, queryLimits.runEvents.default),
      this.reads.countAgentRunEvents(runId),
      // Scoped to this one run's reviews, so the limit bounds work rather
      // than evidence: a run's reviews are per-subject and few.
      this.reads.listReviews({
        projectIds: [record.projectId],
        subjectIds: [runId],
        limit: queryLimits.reviews.default,
      }),
      this.reads.listActivity({
        projectId: record.projectId,
        aggregateIds,
        limit: queryLimits.activity.default,
      }),
      this.reads.listAgents([record.projectId]),
      record.pipelineRunId === null
        ? Promise.resolve(null)
        : this.reads.findPipelineRun(record.projectId, record.pipelineRunId),
    ]);

    const run = projectAgentRunState(record);
    return {
      run,
      events: boundedList(events.map(projectAgentRunEvent), eventTotal),
      actions: projectRunActions(record.result),
      pipeline:
        pipeline === null
          ? null
          : projectPipelineRunState({
              run: pipeline.run,
              task:
                record.taskTitle === null
                  ? null
                  : { taskId: record.taskId, title: record.taskTitle },
              agentsById: agentIndex(agentRecords),
            }),
      reviews: reviewRecords.map(projectReviewState),
      activity: {
        items: activity.map(projectActivityEntry),
        nextCursor: nextActivityCursor(activity, queryLimits.activity.default),
      },
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
  }): Promise<BoundedList<ReviewState>> {
    if (options?.projectId !== undefined)
      await this.requireProject(options.projectId);
    const projectFilter =
      options?.projectId === undefined
        ? {}
        : { projectIds: [options.projectId] };
    const statusFilter =
      options?.pendingOnly === true ? { statuses: ["pending" as const] } : {};
    const [records, counts] = await Promise.all([
      this.reads.listReviews({
        ...projectFilter,
        ...statusFilter,
        limit: options?.limit ?? queryLimits.reviews.default,
      }),
      this.reads.countReviews({ ...projectFilter, ...statusFilter }),
    ]);
    return boundedList(records.map(projectReviewState), sum(counts));
  }

  async listApprovals(options?: {
    projectId?: string;
    limit?: number;
  }): Promise<BoundedList<ReviewState>> {
    if (options?.projectId !== undefined)
      await this.requireProject(options.projectId);
    const projectFilter =
      options?.projectId === undefined
        ? {}
        : { projectIds: [options.projectId] };
    const [records, counts] = await Promise.all([
      this.reads.listReviews({
        ...projectFilter,
        statuses: ["approved", "rejected"],
        limit: options?.limit ?? queryLimits.reviews.default,
      }),
      this.reads.countReviews({
        ...projectFilter,
        statuses: ["approved", "rejected"],
      }),
    ]);
    return boundedList(records.map(projectReviewState), sum(counts));
  }

  async listAgents(projectId: string): Promise<readonly AgentState[]> {
    await this.requireProject(projectId);
    return this.projectAgents(
      projectId,
      await this.reads.listAgents([projectId]),
    );
  }

  async listActivity(options?: {
    projectId?: string;
    cursor?: ActivityCursor;
    limit?: number;
  }): Promise<ActivityPage> {
    if (options?.projectId !== undefined)
      await this.requireProject(options.projectId);
    const limit = options?.limit ?? queryLimits.activity.default;
    const records = await this.reads.listActivity({
      ...(options?.projectId === undefined
        ? {}
        : { projectId: options.projectId }),
      ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
      limit,
    });
    return {
      items: records.map(projectActivityEntry),
      nextCursor: nextActivityCursor(records, limit),
    };
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

  /**
   * Projects a page of tasks from facts scoped to exactly those task IDs.
   *
   * The three follow-up queries are bounded by the size of the page, not by a
   * project-wide window, so a task's status never depends on how much unrelated
   * history exists.
   */
  private async projectTasks(
    projectId: string,
    tasks: readonly TaskProps[],
    agents: ReadonlyMap<string, AgentReference>,
  ): Promise<TaskOperationalState[]> {
    if (tasks.length === 0) return [];
    const taskIds = tasks.map((task) => task.id);
    const now = this.clock.now();
    const [runFacts, leases, pipelineRuns, reviewFacts] = await Promise.all([
      this.reads.listTaskRunFacts(
        projectId,
        taskIds,
        queryLimits.concurrency.default,
      ),
      this.reads.listTaskLeases(projectId, taskIds),
      this.reads.listActivePipelineRunsForTasks(projectId, taskIds),
      this.reads.listTaskReviewFacts(projectId, taskIds),
    ]);

    const runsByTask = new Map<string, TaskRunFactsRecord>(
      runFacts.map((record) => [record.taskId, record]),
    );
    // At most one lease row exists per task, so keying by task id here loses
    // nothing — unlike the runs, which are aggregated inside their record.
    const leaseByTask = new Map<string, TaskLeaseRecord>(
      leases.map((record) => [record.taskId, record]),
    );
    const pipelineByTask = new Map<string, OperationalPipelineRunRecord>(
      pipelineRuns.map((record) => [record.run.taskId, record]),
    );
    const reviewsByTask = new Map(
      reviewFacts.map((record) => [record.taskId, record]),
    );

    return tasks.map((task) => {
      const runs = runsByTask.get(task.id);
      const reviews = reviewsByTask.get(task.id);
      return projectTaskOperationalState({
        task,
        activeRuns: runs?.activeRuns ?? [],
        activeRunCount: runs?.activeRunCount ?? 0,
        executingRunCount: runs?.executingRunCount ?? 0,
        latestRun: runs?.latestRun ?? null,
        lease: leaseByTask.get(task.id) ?? null,
        now,
        pipelineRun: pipelineByTask.get(task.id)?.run ?? null,
        pendingReviewCount: reviews?.pendingCount ?? 0,
        earliestPendingReview:
          reviews?.earliestPending === undefined ||
          reviews.earliestPending === null
            ? null
            : projectReviewState(reviews.earliestPending),
        agentsById: agents,
      });
    });
  }

  /** Projects agent states from facts scoped to exactly those agent IDs. */
  private async projectAgents(
    projectId: string,
    agents: readonly OperationalAgentRecord[],
  ): Promise<AgentState[]> {
    if (agents.length === 0) return [];
    const agentIds = agents.map((agent) => agent.id);
    const concurrencyLimit = queryLimits.concurrency.default;
    const [runFacts, stageFacts] = await Promise.all([
      this.reads.listAgentRunFacts(projectId, agentIds, concurrencyLimit),
      this.reads.listActiveStagesForAgents(
        projectId,
        agentIds,
        concurrencyLimit,
      ),
    ]);
    // Both queries already return one record per agent, with that agent's runs
    // and stages aggregated inside it. Keying a map by `agentId` over raw rows
    // would keep only the last row per agent and silently drop the rest.
    const runsByAgent = new Map<string, AgentRunFactsRecord>(
      runFacts.map((record) => [record.agentId, record]),
    );
    const stagesByAgent = new Map<string, AgentActiveStagesRecord>(
      stageFacts.map((record) => [record.agentId, record]),
    );
    return agents.map((agent) => {
      const runs = runsByAgent.get(agent.id);
      const stages = stagesByAgent.get(agent.id);
      return projectAgentState({
        agent,
        activeRuns: runs?.activeRuns ?? [],
        activeRunCount: runs?.activeRunCount ?? 0,
        latestRun: runs?.latestRun ?? null,
        activeStages: stages?.stages ?? [],
        activeStageCount: stages?.stageCount ?? 0,
        awaitingApprovalStageCount: stages?.awaitingApprovalCount ?? 0,
      });
    });
  }

  /** Blocked plus failed tasks, taken from the exact per-status counts. */
  private attentionTaskTotal(
    counts: readonly { status: string; count: number }[],
  ): number {
    return counts
      .filter(
        (record) => record.status === "blocked" || record.status === "failed",
      )
      .reduce((total, record) => total + record.count, 0);
  }
}

function sum(records: readonly { count: number }[]): number {
  return records.reduce((total, record) => total + record.count, 0);
}

function attentionTaskReason(task: {
  projectId: string;
  taskId: string;
  status: "blocked" | "failed";
  updatedAt: Date;
}): AttentionReason {
  return {
    kind: task.status === "blocked" ? "task_blocked" : "task_failed",
    projectId: task.projectId,
    subjectType: "task",
    subjectId: task.taskId,
    summary: task.status === "blocked" ? "Task is blocked" : "Task failed",
    since: task.updatedAt.toISOString(),
  };
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
