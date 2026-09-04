import type { Database } from "bun:sqlite";
import type { AgentRunStatus } from "@ai-office/domain/agent/agent-run.ts";
import type {
  MilestoneStatus,
  RequirementStatus,
  ReviewStatus,
  ReviewSubjectType,
} from "@ai-office/domain/governance/governance.ts";
import type { OfficePipeline } from "@ai-office/domain/office/office-manifest.ts";
import type {
  PipelineRunProps,
  PipelineRunStatus,
  PipelineStageRunProps,
  PipelineStageRunStatus,
} from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { TaskProps, TaskStatus } from "@ai-office/domain/task/task.ts";
import type {
  ActivityQuery,
  AgentActiveStageRecord,
  AgentActiveStagesRecord,
  AgentRunFactsRecord,
  AgentRunQuery,
  CountRecord,
  LastActivityRecord,
  OperationalActivePipelineStageRecord,
  OperationalActivityRecord,
  OperationalAgentRecord,
  OperationalAgentRunEventRecord,
  OperationalAgentRunRecord,
  OperationalAttentionTaskRecord,
  OperationalMilestoneRecord,
  OperationalPipelineRunRecord,
  OperationalProjectRecord,
  OperationalReadRepository,
  OperationalReviewRecord,
  PipelineRunQuery,
  RequirementCountRecord,
  ReviewQuery,
  StatusCountRecord,
  TaskLeaseAnomalyRecord,
  TaskLeaseRecord,
  TaskReviewFactsRecord,
  TaskRunFactsRecord,
} from "@ai-office/application/ports/operational-read.port.ts";

/**
 * Read-only SQLite adapter for the operational query surface.
 *
 * Three rules hold throughout:
 *
 * 1. counts are computed by SQL aggregates over every matching row, never by
 *    measuring a truncated list;
 * 2. lists are limited and ordered in SQL, never loaded whole and sliced in
 *    memory;
 * 3. queries that feed a projection are scoped to the exact entities being
 *    projected, so the bound cannot omit a relevant fact.
 *
 * Access paths reuse the existing indexes —
 * `task_project_status_priority_idx`, `agent_run_project_status_idx`,
 * `review_project_idx`, `pipeline_run_project_status_idx`,
 * `audit_event_occurred_at_idx`, `audit_event_project_occurred_at_idx`, and
 * `audit_event_aggregate_idx` for run-scoped activity.
 */
export class SqliteOperationalReadRepository
  implements OperationalReadRepository
{
  constructor(private readonly database: Database) {}

  /* ---------------------------------------------------------------------- */
  /* Projects                                                                */
  /* ---------------------------------------------------------------------- */

  async listProjects(): Promise<OperationalProjectRecord[]> {
    return this.database
      .query<ProjectRow, []>(`${projectSelect} ORDER BY p.name, p.id`)
      .all()
      .map(projectRecord);
  }

  async findProject(
    projectId: string,
  ): Promise<OperationalProjectRecord | null> {
    const row = this.database
      .query<ProjectRow, [string]>(`${projectSelect} WHERE p.id = ?`)
      .get(projectId);
    return row === null ? null : projectRecord(row);
  }

  /* ---------------------------------------------------------------------- */
  /* Authoritative aggregates                                                */
  /* ---------------------------------------------------------------------- */

  async countTasksByStatus(
    projectIds: readonly string[],
  ): Promise<StatusCountRecord<TaskStatus>[]> {
    if (projectIds.length === 0) return [];
    return this.database
      .query<
        { project_id: string; status: TaskStatus; count: number },
        string[]
      >(
        `SELECT project_id, status, COUNT(*) AS count
         FROM task
         WHERE project_id IN (${placeholders(projectIds.length)})
         GROUP BY project_id, status`,
      )
      .all(...projectIds)
      .map((row) => ({
        projectId: row.project_id,
        status: row.status,
        count: row.count,
      }));
  }

  async countRequirementsByStatus(
    projectIds: readonly string[],
  ): Promise<RequirementCountRecord[]> {
    if (projectIds.length === 0) return [];
    return this.database
      .query<
        {
          project_id: string;
          milestone_id: string | null;
          status: RequirementStatus;
          count: number;
        },
        string[]
      >(
        `SELECT project_id, milestone_id, status, COUNT(*) AS count
         FROM requirement
         WHERE project_id IN (${placeholders(projectIds.length)})
         GROUP BY project_id, milestone_id, status`,
      )
      .all(...projectIds)
      .map((row) => ({
        projectId: row.project_id,
        milestoneId: row.milestone_id,
        status: row.status,
        count: row.count,
      }));
  }

  async countAgentRuns(query: {
    projectIds?: readonly string[];
    statuses?: readonly AgentRunStatus[];
  }): Promise<CountRecord[]> {
    const scope = scopeClauses(query.projectIds, "project_id");
    if (scope === null) return [];
    const statuses = scopeClauses(query.statuses, "status");
    if (statuses === null) return [];
    return this.groupedCounts(
      `SELECT project_id, COUNT(*) AS count
         FROM agent_run
         ${where(scope.clause, statuses.clause)}
         GROUP BY project_id`,
      [...scope.parameters, ...statuses.parameters],
    );
  }

  async countDistinctRunAgents(query: {
    projectIds?: readonly string[];
    statuses?: readonly AgentRunStatus[];
  }): Promise<CountRecord[]> {
    const scope = scopeClauses(query.projectIds, "project_id");
    if (scope === null) return [];
    const statuses = scopeClauses(query.statuses, "status");
    if (statuses === null) return [];
    // Joined to `agent` and restricted to enabled agents so this count keeps
    // exactly the meaning `AgentActivityState.working` has. A disabled agent
    // never reports `working`, so counting its runs here would publish a total
    // that no agent state can account for.
    return this.groupedCounts(
      `SELECT run.project_id AS project_id,
              COUNT(DISTINCT run.agent_id) AS count
         FROM agent_run run
         JOIN agent ag ON ag.id = run.agent_id AND ag.enabled = 1
         ${where(
           scope.clause === "" ? "" : `run.${scope.clause}`,
           statuses.clause === "" ? "" : `run.${statuses.clause}`,
         )}
         GROUP BY run.project_id`,
      [...scope.parameters, ...statuses.parameters],
    );
  }

  async countReviews(query: {
    projectIds?: readonly string[];
    statuses?: readonly ReviewStatus[];
  }): Promise<CountRecord[]> {
    const scope = scopeClauses(query.projectIds, "project_id");
    if (scope === null) return [];
    const statuses = scopeClauses(query.statuses, "status");
    if (statuses === null) return [];
    return this.groupedCounts(
      `SELECT project_id, COUNT(*) AS count
         FROM review
         ${where(scope.clause, statuses.clause)}
         GROUP BY project_id`,
      [...scope.parameters, ...statuses.parameters],
    );
  }

  async countActivePipelineRuns(
    projectIds: readonly string[],
  ): Promise<CountRecord[]> {
    if (projectIds.length === 0) return [];
    return this.groupedCounts(
      `SELECT project_id, COUNT(*) AS count
         FROM pipeline_run
         WHERE status = 'active'
           AND project_id IN (${placeholders(projectIds.length)})
         GROUP BY project_id`,
      [...projectIds],
    );
  }

  async countAttentionStages(
    projectIds: readonly string[],
  ): Promise<CountRecord[]> {
    if (projectIds.length === 0) return [];
    return this.groupedCounts(
      `SELECT r.project_id, COUNT(*) AS count
         FROM pipeline_run r
         JOIN pipeline_stage_run s
           ON s.pipeline_run_id = r.id AND s.stage_index = r.current_stage_index
        WHERE r.status = 'active'
          AND r.project_id IN (${placeholders(projectIds.length)})
          AND (
            s.status = 'awaiting_approval'
            OR (s.status = 'active' AND s.assigned_agent_id IS NULL)
          )
        GROUP BY r.project_id`,
      [...projectIds],
    );
  }

  /**
   * Tasks holding at least one active run without valid execution authority.
   *
   * Counts distinct *tasks*, so this exact total and
   * `listTasksWithoutValidRunLease` describe the same unit and one attention
   * item means one affected task. `now` comes from the application clock, not
   * from a SQLite wall-clock function, so the aggregate, the per-task
   * projection, and the tests all evaluate validity at the same instant.
   */
  async countTasksWithoutValidRunLease(
    projectIds: readonly string[],
    now: Date,
  ): Promise<CountRecord[]> {
    if (projectIds.length === 0) return [];
    return this.groupedCounts(
      `SELECT run.project_id AS project_id,
              COUNT(DISTINCT run.task_id) AS count
         FROM agent_run run
         LEFT JOIN task_lock lock ON lock.task_id = run.task_id
        WHERE run.project_id IN (${placeholders(projectIds.length)})
          AND run.status IN (${placeholders(activeRunStatuses.length)})
          AND ${invalidLeasePredicate}
        GROUP BY run.project_id`,
      [...projectIds, ...activeRunStatuses, now.toISOString()],
    );
  }

  async countPipelineRuns(
    projectId: string,
    activeOnly: boolean,
  ): Promise<number> {
    const row = this.database
      .query<{ count: number }, string[]>(
        `SELECT COUNT(*) AS count FROM pipeline_run
          WHERE project_id = ?${activeOnly ? " AND status = 'active'" : ""}`,
      )
      .get(projectId);
    return row?.count ?? 0;
  }

  async countAgentRunEvents(runId: string): Promise<number> {
    const row = this.database
      .query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM agent_run_event WHERE run_id = ?",
      )
      .get(runId);
    return row?.count ?? 0;
  }

  async lastActivityAt(
    projectIds: readonly string[],
  ): Promise<LastActivityRecord[]> {
    if (projectIds.length === 0) return [];
    return this.database
      .query<{ project_id: string; occurred_at: string }, string[]>(
        `SELECT project_id, MAX(occurred_at) AS occurred_at
         FROM audit_event
         WHERE project_id IN (${placeholders(projectIds.length)})
         GROUP BY project_id`,
      )
      .all(...projectIds)
      .map((row) => ({
        projectId: row.project_id,
        occurredAt: new Date(row.occurred_at),
      }));
  }

  /* ---------------------------------------------------------------------- */
  /* Full authoritative sets                                                 */
  /* ---------------------------------------------------------------------- */

  async listMilestones(
    projectIds: readonly string[],
  ): Promise<OperationalMilestoneRecord[]> {
    if (projectIds.length === 0) return [];
    return this.database
      .query<MilestoneRow, string[]>(
        `SELECT id, project_id, title, description, status, created_at, updated_at
         FROM milestone
         WHERE project_id IN (${placeholders(projectIds.length)})
         ORDER BY created_at, id`,
      )
      .all(...projectIds)
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        description: row.description,
        status: row.status,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));
  }

  async listAgents(
    projectIds: readonly string[],
  ): Promise<OperationalAgentRecord[]> {
    if (projectIds.length === 0) return [];
    return this.database
      .query<AgentRow, string[]>(
        `SELECT a.id, a.project_id, a.name, a.role_id,
                r.role_key, r.name AS role_name,
                a.enabled, a.created_at, a.updated_at
         FROM agent a
         LEFT JOIN role r ON r.id = a.role_id
         WHERE a.project_id IN (${placeholders(projectIds.length)})
         ORDER BY a.name, a.id`,
      )
      .all(...projectIds)
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        name: row.name,
        roleId: row.role_id,
        roleKey: row.role_key,
        roleName: row.role_name,
        enabled: row.enabled === 1,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));
  }

  /* ---------------------------------------------------------------------- */
  /* Scoped projection inputs                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * The in-flight and most recent run of each named task.
   *
   * `ROW_NUMBER()` keeps this at one row per task per query, so the result is
   * bounded by the page being projected rather than by the project's history.
   */
  async listTaskRunFacts(
    projectId: string,
    taskIds: readonly string[],
    activeRunLimit: number,
  ): Promise<TaskRunFactsRecord[]> {
    if (taskIds.length === 0) return [];
    // `task_lock` is a lease, and an expired lease may be taken over without
    // terminating its previous owner, so a task can hold several active runs.
    // The sample is bounded; the counts that decide the status are exact.
    const active = this.topRunsPerPartition(
      "run.task_id",
      "run.task_id",
      projectId,
      taskIds,
      activeRunStatuses,
      Math.max(1, activeRunLimit),
    );
    const latest = this.topRunsPerPartition(
      "run.task_id",
      "run.task_id",
      projectId,
      taskIds,
      [],
      1,
    );
    const counts = this.countActiveRunsPerColumn("task_id", projectId, taskIds);
    const activeByTask = groupRuns(active, (run) => run.taskId);
    const latestByTask = new Map(latest.map((run) => [run.taskId, run]));
    return taskIds.map((taskId) => ({
      taskId,
      activeRuns: activeByTask.get(taskId) ?? [],
      activeRunCount: counts.get(taskId)?.count ?? 0,
      executingRunCount: counts.get(taskId)?.executing ?? 0,
      latestRun: latestByTask.get(taskId) ?? null,
    }));
  }

  async listTaskLeases(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<TaskLeaseRecord[]> {
    if (taskIds.length === 0) return [];
    // Joined through `task` because `task_lock` carries no project column, and
    // left-joined to the owning run so the projection can tell a live owner
    // from a lease that outlived its owner without a second query.
    return this.database
      .query<
        {
          task_id: string;
          run_id: string;
          acquired_at: string;
          expires_at: string;
          owner_status: AgentRunStatus | null;
        },
        string[]
      >(
        `SELECT lock.task_id, lock.run_id, lock.acquired_at, lock.expires_at,
                run.status AS owner_status
           FROM task_lock lock
           JOIN task t ON t.id = lock.task_id AND t.project_id = ?
           LEFT JOIN agent_run run ON run.id = lock.run_id
          WHERE lock.task_id IN (${placeholders(taskIds.length)})`,
      )
      .all(projectId, ...taskIds)
      .map((row) => ({
        taskId: row.task_id,
        ownerRunId: row.run_id,
        acquiredAt: new Date(row.acquired_at),
        expiresAt: new Date(row.expires_at),
        ownerRunStatus: row.owner_status,
      }));
  }

  async listAgentRunFacts(
    projectId: string,
    agentIds: readonly string[],
    activeRunLimit: number,
  ): Promise<AgentRunFactsRecord[]> {
    if (agentIds.length === 0) return [];
    // Nothing enforces one active run per agent, so the active runs are a
    // bounded *list* beside an exact count rather than a single row.
    const active = this.topRunsPerPartition(
      "run.agent_id",
      "run.agent_id",
      projectId,
      agentIds,
      activeRunStatuses,
      Math.max(1, activeRunLimit),
    );
    const latest = this.topRunsPerPartition(
      "run.agent_id",
      "run.agent_id",
      projectId,
      agentIds,
      [],
      1,
    );
    const activeCounts = this.countActiveRunsPerColumn(
      "agent_id",
      projectId,
      agentIds,
    );
    const activeByAgent = groupRuns(active, (run) => run.agentId);
    const latestByAgent = new Map(latest.map((run) => [run.agentId, run]));
    return agentIds.map((agentId) => ({
      agentId,
      activeRuns: activeByAgent.get(agentId) ?? [],
      activeRunCount: activeCounts.get(agentId)?.count ?? 0,
      latestRun: latestByAgent.get(agentId) ?? null,
    }));
  }

  async listActivePipelineRunsForTasks(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<OperationalPipelineRunRecord[]> {
    if (taskIds.length === 0) return [];
    const rows = this.database
      .query<PipelineRunRow, string[]>(
        `${pipelineRunSelect}
          WHERE r.project_id = ?
            AND r.status = 'active'
            AND r.task_id IN (${placeholders(taskIds.length)})
          ORDER BY r.created_at DESC, r.id DESC`,
      )
      .all(projectId, ...taskIds);
    return this.withStages(rows);
  }

  async listActiveStagesForAgents(
    projectId: string,
    agentIds: readonly string[],
    stageLimit: number,
  ): Promise<AgentActiveStagesRecord[]> {
    if (agentIds.length === 0) return [];
    // Pipeline assignment does not reject an agent that another active stage
    // already names, so an agent can hold several assignments at once. The
    // sample is limited in SQL and the counts stay exact.
    const rows = this.database
      .query<
        {
          assigned_agent_id: string;
          pipeline_run_id: string;
          stage_id: string;
          stage_index: number;
          status: PipelineStageRunStatus;
          definition_json: string;
        },
        (string | number)[]
      >(
        `SELECT * FROM (
           SELECT s.assigned_agent_id, r.id AS pipeline_run_id,
                  s.stage_id, s.stage_index, s.status, r.definition_json,
                  ROW_NUMBER() OVER (
                    PARTITION BY s.assigned_agent_id
                    ORDER BY r.updated_at DESC, r.id
                  ) AS rn
             FROM pipeline_run r
             JOIN pipeline_stage_run s
               ON s.pipeline_run_id = r.id
              AND s.stage_index = r.current_stage_index
            WHERE r.project_id = ?
              AND r.status = 'active'
              AND s.assigned_agent_id IN (${placeholders(agentIds.length)})
         ) WHERE rn <= ?
         ORDER BY assigned_agent_id, rn`,
      )
      .all(projectId, ...agentIds, Math.max(1, stageLimit))
      .map((row) => ({
        agentId: row.assigned_agent_id,
        pipelineRunId: row.pipeline_run_id,
        stageId: row.stage_id,
        stageName:
          parsePipelineDefinition(row.definition_json)?.stages[row.stage_index]
            ?.name ?? row.stage_id,
        stageStatus: row.status,
      }));

    const counts = new Map(
      this.database
        .query<
          {
            assigned_agent_id: string;
            count: number;
            awaiting: number;
          },
          string[]
        >(
          `SELECT s.assigned_agent_id, COUNT(*) AS count,
                  SUM(CASE WHEN s.status = 'awaiting_approval' THEN 1 ELSE 0 END)
                    AS awaiting
             FROM pipeline_run r
             JOIN pipeline_stage_run s
               ON s.pipeline_run_id = r.id
              AND s.stage_index = r.current_stage_index
            WHERE r.project_id = ?
              AND r.status = 'active'
              AND s.assigned_agent_id IN (${placeholders(agentIds.length)})
            GROUP BY s.assigned_agent_id`,
        )
        .all(projectId, ...agentIds)
        .map(
          (row) =>
            [
              row.assigned_agent_id,
              { count: row.count, awaiting: row.awaiting },
            ] as const,
        ),
    );

    const stagesByAgent = new Map<string, AgentActiveStageRecord[]>();
    for (const row of rows) {
      const list = stagesByAgent.get(row.agentId) ?? [];
      list.push(row);
      stagesByAgent.set(row.agentId, list);
    }
    return agentIds.map((agentId) => ({
      agentId,
      stages: stagesByAgent.get(agentId) ?? [],
      stageCount: counts.get(agentId)?.count ?? 0,
      awaitingApprovalCount: counts.get(agentId)?.awaiting ?? 0,
    }));
  }

  async listTaskReviewFacts(
    projectId: string,
    taskIds: readonly string[],
  ): Promise<TaskReviewFactsRecord[]> {
    if (taskIds.length === 0) return [];
    const counts = new Map(
      this.database
        .query<{ subject_id: string; count: number }, string[]>(
          `SELECT subject_id, COUNT(*) AS count
             FROM review
            WHERE project_id = ?
              AND subject_type = 'task'
              AND status = 'pending'
              AND subject_id IN (${placeholders(taskIds.length)})
            GROUP BY subject_id`,
        )
        .all(projectId, ...taskIds)
        .map((row) => [row.subject_id, row.count] as const),
    );

    // One representative pending review per task, so the attention reason can
    // name a real subject without loading every pending review.
    const earliest = new Map(
      this.database
        .query<ReviewRow, string[]>(
          `SELECT * FROM (
             ${reviewSelect},
               ROW_NUMBER() OVER (
                 PARTITION BY v.subject_id ORDER BY v.created_at, v.id
               ) AS rn
             FROM review v
             LEFT JOIN approval a
               ON a.review_id = v.id AND a.project_id = v.project_id
            WHERE v.project_id = ?
              AND v.subject_type = 'task'
              AND v.status = 'pending'
              AND v.subject_id IN (${placeholders(taskIds.length)})
           ) WHERE rn = 1`,
        )
        .all(projectId, ...taskIds)
        .map((row) => [row.subject_id, reviewRecord(row)] as const),
    );

    return taskIds.map((taskId) => ({
      taskId,
      pendingCount: counts.get(taskId) ?? 0,
      earliestPending: earliest.get(taskId) ?? null,
    }));
  }

  /* ---------------------------------------------------------------------- */
  /* Bounded samples and pages                                               */
  /* ---------------------------------------------------------------------- */

  async listTasks(projectId: string, limit: number): Promise<TaskProps[]> {
    return this.database
      .query<TaskRow, [string, number]>(
        `SELECT id, project_id, title, description, status, priority,
                created_at, updated_at
         FROM task
         WHERE project_id = ?
         ORDER BY priority DESC, created_at ASC, id ASC
         LIMIT ?`,
      )
      .all(projectId, limit)
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        title: row.title,
        ...(row.description === null ? {} : { description: row.description }),
        status: row.status,
        priority: row.priority,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.updated_at),
      }));
  }

  async listAttentionTasks(
    projectIds: readonly string[],
    limit: number,
  ): Promise<OperationalAttentionTaskRecord[]> {
    if (projectIds.length === 0) return [];
    return this.database
      .query<
        {
          project_id: string;
          id: string;
          title: string;
          status: "blocked" | "failed";
          updated_at: string;
        },
        (string | number)[]
      >(
        `SELECT project_id, id, title, status, updated_at
         FROM task
         WHERE status IN ('blocked', 'failed')
           AND project_id IN (${placeholders(projectIds.length)})
         ORDER BY updated_at DESC, id
         LIMIT ?`,
      )
      .all(...projectIds, limit)
      .map((row) => ({
        projectId: row.project_id,
        taskId: row.id,
        title: row.title,
        status: row.status,
        updatedAt: new Date(row.updated_at),
      }));
  }

  async listActivePipelineStages(
    projectIds: readonly string[],
    limit: number,
  ): Promise<OperationalActivePipelineStageRecord[]> {
    if (projectIds.length === 0) return [];
    return this.database
      .query<ActiveStageRow, (string | number)[]>(
        `SELECT
           r.project_id,
           r.id AS pipeline_run_id,
           r.definition_json,
           r.updated_at,
           s.stage_id,
           s.stage_index,
           s.status AS stage_status,
           s.assigned_agent_id,
           s.completed_at AS stage_completed_at
         FROM pipeline_run r
         JOIN pipeline_stage_run s
           ON s.pipeline_run_id = r.id
          AND s.stage_index = r.current_stage_index
         WHERE r.status = 'active'
           AND r.project_id IN (${placeholders(projectIds.length)})
           AND (
             s.status = 'awaiting_approval'
             OR (s.status = 'active' AND s.assigned_agent_id IS NULL)
           )
         ORDER BY r.updated_at DESC, r.id
         LIMIT ?`,
      )
      .all(...projectIds, limit)
      .map((row) => {
        const definition = parsePipelineDefinition(row.definition_json);
        const stage = definition?.stages[row.stage_index];
        return {
          projectId: row.project_id,
          pipelineRunId: row.pipeline_run_id,
          pipelineId: definition?.id ?? "",
          pipelineName: definition?.name ?? "",
          stageId: row.stage_id,
          stageName: stage?.name ?? row.stage_id,
          stageStatus: row.stage_status,
          assignedAgentId: row.assigned_agent_id,
          stageCompletedAt:
            row.stage_completed_at === null
              ? null
              : new Date(row.stage_completed_at),
          updatedAt: new Date(row.updated_at),
        };
      });
  }

  /**
   * Recent pipeline runs, newest first, limited in SQL.
   *
   * The command-side repository orders oldest first and returns everything,
   * which is correct for its consumers; slicing that in memory would show a
   * dashboard the project's first runs forever. This query exists so the read
   * side can ask for what it actually displays.
   */
  async listTasksWithoutValidRunLease(
    projectIds: readonly string[],
    limit: number,
    now: Date,
  ): Promise<TaskLeaseAnomalyRecord[]> {
    if (projectIds.length === 0) return [];
    // Grouped per task and limited in SQL, so the sample and the aggregate
    // above count the same thing. The lease columns are functionally dependent
    // within a group: `task_lock` holds at most one row per task.
    //
    // Ordering uses the same instant the projection reports as `since` — never
    // `MAX(run.updated_at)`, which would let a run that keeps working after
    // losing the lease push the anomaly's start time forward.
    const instant = now.toISOString();
    return this.database
      .query<
        {
          project_id: string;
          task_id: string;
          task_title: string | null;
          task_updated_at: string;
          acquired_at: string | null;
          expires_at: string | null;
          runs_without_valid_lease: number;
        },
        (string | number)[]
      >(
        `SELECT run.project_id, run.task_id, t.title AS task_title,
                t.updated_at AS task_updated_at,
                lock.acquired_at, lock.expires_at,
                COUNT(*) AS runs_without_valid_lease
           FROM agent_run run
           LEFT JOIN task_lock lock ON lock.task_id = run.task_id
           LEFT JOIN task t ON t.id = run.task_id
          WHERE run.project_id IN (${placeholders(projectIds.length)})
            AND run.status IN (${placeholders(activeRunStatuses.length)})
            AND ${invalidLeasePredicate}
          GROUP BY run.project_id, run.task_id
          ORDER BY ${leaseAnomalySinceExpression} DESC, run.task_id
          LIMIT ?`,
      )
      .all(...projectIds, ...activeRunStatuses, instant, instant, limit)
      .map((row) => ({
        projectId: row.project_id,
        taskId: row.task_id,
        taskTitle: row.task_title,
        runsWithoutValidLease: row.runs_without_valid_lease,
        lease:
          row.acquired_at === null || row.expires_at === null
            ? null
            : {
                acquiredAt: new Date(row.acquired_at),
                expiresAt: new Date(row.expires_at),
                expired: row.expires_at <= instant,
              },
        taskUpdatedAt: new Date(row.task_updated_at),
      }));
  }

  async listPipelineRuns(
    query: PipelineRunQuery,
  ): Promise<OperationalPipelineRunRecord[]> {
    const rows = this.database
      .query<PipelineRunRow, (string | number)[]>(
        `${pipelineRunSelect}
          WHERE r.project_id = ?
            ${query.activeOnly === true ? "AND r.status = 'active'" : ""}
          ORDER BY r.created_at DESC, r.id DESC
          LIMIT ?`,
      )
      .all(query.projectId, query.limit);
    return this.withStages(rows);
  }

  async findPipelineRun(
    projectId: string,
    pipelineRunId: string,
  ): Promise<OperationalPipelineRunRecord | null> {
    const rows = this.database
      .query<PipelineRunRow, [string, string]>(
        `${pipelineRunSelect} WHERE r.project_id = ? AND r.id = ?`,
      )
      .all(projectId, pipelineRunId);
    return this.withStages(rows)[0] ?? null;
  }

  async listAgentRuns(
    query: AgentRunQuery,
  ): Promise<OperationalAgentRunRecord[]> {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];

    if (query.projectIds !== undefined) {
      if (query.projectIds.length === 0) return [];
      conditions.push(
        `run.project_id IN (${placeholders(query.projectIds.length)})`,
      );
      parameters.push(...query.projectIds);
    }
    if (query.taskIds !== undefined) {
      if (query.taskIds.length === 0) return [];
      conditions.push(`run.task_id IN (${placeholders(query.taskIds.length)})`);
      parameters.push(...query.taskIds);
    }
    if (query.statuses !== undefined) {
      if (query.statuses.length === 0) return [];
      conditions.push(`run.status IN (${placeholders(query.statuses.length)})`);
      parameters.push(...query.statuses);
    }
    parameters.push(query.limit);

    return this.database
      .query<AgentRunRow, (string | number)[]>(
        `${agentRunSelect}
         ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
         ORDER BY run.updated_at DESC, run.id
         LIMIT ?`,
      )
      .all(...parameters)
      .map(agentRunRecord);
  }

  async findAgentRun(runId: string): Promise<OperationalAgentRunRecord | null> {
    const row = this.database
      .query<AgentRunRow, [string]>(`${agentRunSelect} WHERE run.id = ?`)
      .get(runId);
    return row === null ? null : agentRunRecord(row);
  }

  async listAgentRunEvents(
    runId: string,
    limit: number,
  ): Promise<OperationalAgentRunEventRecord[]> {
    return this.database
      .query<
        {
          run_id: string;
          status: string;
          payload_json: string;
          occurred_at: string;
        },
        [string, number]
      >(
        `SELECT run_id, status, payload_json, occurred_at
         FROM agent_run_event
         WHERE run_id = ?
         ORDER BY rowid
         LIMIT ?`,
      )
      .all(runId, limit)
      .map((row) => {
        const payload = parseJsonObject(row.payload_json);
        return {
          runId: row.run_id,
          status: row.status,
          hasResult: payload?.hasResult === true,
          hasError: payload?.hasError === true,
          occurredAt: new Date(row.occurred_at),
        };
      });
  }

  async listReviews(query: ReviewQuery): Promise<OperationalReviewRecord[]> {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];

    if (query.projectIds !== undefined) {
      if (query.projectIds.length === 0) return [];
      conditions.push(
        `v.project_id IN (${placeholders(query.projectIds.length)})`,
      );
      parameters.push(...query.projectIds);
    }
    if (query.subjectIds !== undefined) {
      if (query.subjectIds.length === 0) return [];
      conditions.push(
        `v.subject_id IN (${placeholders(query.subjectIds.length)})`,
      );
      parameters.push(...query.subjectIds);
    }
    if (query.statuses !== undefined) {
      if (query.statuses.length === 0) return [];
      conditions.push(`v.status IN (${placeholders(query.statuses.length)})`);
      parameters.push(...query.statuses);
    }
    parameters.push(query.limit);

    return this.database
      .query<ReviewRow, (string | number)[]>(
        `${reviewSelect}
         FROM review v
         LEFT JOIN approval a ON a.review_id = v.id AND a.project_id = v.project_id
         ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
         ORDER BY v.created_at DESC, v.id
         LIMIT ?`,
      )
      .all(...parameters)
      .map(reviewRecord);
  }

  /**
   * One page of activity in a strict keyset order.
   *
   * The predicate and the ordering describe the same tuple `(occurred_at, id)`.
   * Filtering on the timestamp alone would skip every event sharing an instant
   * with the row that ended the previous page.
   */
  async listActivity(
    query: ActivityQuery,
  ): Promise<OperationalActivityRecord[]> {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];

    if (query.projectId !== undefined) {
      conditions.push("project_id = ?");
      parameters.push(query.projectId);
    }
    if (query.aggregateIds !== undefined) {
      if (query.aggregateIds.length === 0) return [];
      conditions.push(
        `aggregate_id IN (${placeholders(query.aggregateIds.length)})`,
      );
      parameters.push(...query.aggregateIds);
    }
    if (query.cursor !== undefined) {
      conditions.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))");
      const occurredAt = query.cursor.occurredAt.toISOString();
      parameters.push(occurredAt, occurredAt, query.cursor.id);
    }
    parameters.push(query.limit);

    return this.database
      .query<ActivityRow, (string | number)[]>(
        `SELECT id, project_id, event_type, actor_type, actor_id,
                aggregate_type, aggregate_id, payload_json, occurred_at
         FROM audit_event
         ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
         ORDER BY occurred_at DESC, id DESC
         LIMIT ?`,
      )
      .all(...parameters)
      .map((row) => ({
        id: row.id,
        projectId: row.project_id,
        eventType: row.event_type,
        actorType: row.actor_type,
        actorId: row.actor_id,
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        payload: parseJsonObject(row.payload_json) ?? {},
        occurredAt: new Date(row.occurred_at),
      }));
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                               */
  /* ---------------------------------------------------------------------- */

  private groupedCounts(
    sql: string,
    parameters: (string | number)[],
  ): CountRecord[] {
    return this.database
      .query<{ project_id: string; count: number }, (string | number)[]>(sql)
      .all(...parameters)
      .map((row) => ({ projectId: row.project_id, count: row.count }));
  }

  /**
   * Highest-ranked runs per partition, at most `limit` rows per named entity.
   *
   * Ranking is `updated_at` descending, ties broken by run id descending, and
   * rows come back grouped by partition in that order.
   */
  private topRunsPerPartition(
    partition: string,
    column: string,
    projectId: string,
    ids: readonly string[],
    statuses: readonly AgentRunStatus[],
    limit: number,
  ): OperationalAgentRunRecord[] {
    const statusClause =
      statuses.length === 0
        ? ""
        : `AND run.status IN (${placeholders(statuses.length)})`;
    return this.database
      .query<AgentRunRow, (string | number)[]>(
        `SELECT * FROM (
           ${agentRunColumns},
             ROW_NUMBER() OVER (
               PARTITION BY ${partition}
               ORDER BY run.updated_at DESC, run.id DESC
             ) AS rn
           ${agentRunFrom}
          WHERE run.project_id = ?
            AND ${column} IN (${placeholders(ids.length)})
            ${statusClause}
         ) WHERE rn <= ?
         ORDER BY rn`,
      )
      .all(projectId, ...ids, ...statuses, limit)
      .map(agentRunRecord);
  }

  /**
   * Exact active-run counts grouped by `task_id` or `agent_id`, never the
   * length of a bounded sample.
   *
   * `executing` counts the subset that is actually running rather than waiting
   * to start, which is what decides a task's operational status.
   */
  private countActiveRunsPerColumn(
    column: "task_id" | "agent_id",
    projectId: string,
    ids: readonly string[],
  ): Map<string, { count: number; executing: number }> {
    return new Map(
      this.database
        .query<{ key: string; count: number; executing: number }, string[]>(
          `SELECT ${column} AS key, COUNT(*) AS count,
                  SUM(CASE WHEN status IN (
                    ${placeholders(executingRunStatuses.length)}
                  ) THEN 1 ELSE 0 END) AS executing
             FROM agent_run
            WHERE project_id = ?
              AND ${column} IN (${placeholders(ids.length)})
              AND status IN (${placeholders(activeRunStatuses.length)})
            GROUP BY ${column}`,
        )
        .all(
          ...executingRunStatuses,
          projectId,
          ...ids,
          ...activeRunStatuses,
        )
        .map(
          (row) =>
            [row.key, { count: row.count, executing: row.executing }] as const,
        ),
    );
  }

  /** Attaches persisted stage state to pipeline-run rows in one extra query. */
  private withStages(rows: PipelineRunRow[]): OperationalPipelineRunRecord[] {
    if (rows.length === 0) return [];
    const stageRows = this.database
      .query<StageRow, string[]>(
        `SELECT id, pipeline_run_id, stage_id, stage_index, role_id, status,
                assigned_agent_id, assigned_at, completed_at,
                approved_by, approval_decision, approval_rationale, approved_at
         FROM pipeline_stage_run
         WHERE pipeline_run_id IN (${placeholders(rows.length)})
         ORDER BY pipeline_run_id, stage_index`,
      )
      .all(...rows.map((row) => row.id));

    const stagesByRun = new Map<string, PipelineStageRunProps[]>();
    for (const row of stageRows) {
      const list = stagesByRun.get(row.pipeline_run_id) ?? [];
      list.push(stageProps(row));
      stagesByRun.set(row.pipeline_run_id, list);
    }

    return rows.map((row) => ({
      run: pipelineRunProps(row, stagesByRun.get(row.id) ?? []),
      taskTitle: row.task_title,
    }));
  }
}

/* -------------------------------------------------------------------------- */
/* Row shapes and helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A run lacks valid execution authority unless it owns a lease row that has
 * not expired.
 *
 * `acquireTaskLock` allows takeover when `task_lock.expires_at <= acquired_at`,
 * so this uses `<=` against the injected instant for the same reason. Binds one
 * parameter: the evaluation instant.
 */
const invalidLeasePredicate = `(
  lock.run_id IS NULL
  OR lock.run_id <> run.id
  OR lock.expires_at <= ?
)`;

/**
 * The instant an anomaly began, matching `taskLeaseAttention` exactly: the
 * expiry for an expired lease, the acquisition for a takeover, and the task's
 * own update when no lease row exists. Binds one parameter.
 */
const leaseAnomalySinceExpression = `CASE
  WHEN lock.expires_at IS NULL THEN t.updated_at
  WHEN lock.expires_at <= ? THEN lock.expires_at
  ELSE lock.acquired_at
END`;

/** Active statuses that mean the run is executing rather than waiting. */
const executingRunStatuses: readonly AgentRunStatus[] = [
  "running",
  "reviewing",
];

const activeRunStatuses: readonly AgentRunStatus[] = [
  "queued",
  "preparing",
  "running",
  "reviewing",
];

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

/** Groups already-ordered rows by key, preserving their SQL order. */
function groupRuns<T>(
  rows: readonly T[],
  key: (row: T) => string,
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const list = grouped.get(id) ?? [];
    list.push(row);
    grouped.set(id, list);
  }
  return grouped;
}

function where(...clauses: readonly string[]): string {
  const present = clauses.filter((clause) => clause !== "");
  return present.length === 0 ? "" : `WHERE ${present.join(" AND ")}`;
}

/**
 * Builds an optional `IN` restriction.
 *
 * `undefined` means "no restriction"; an empty array means "nothing matches"
 * and is reported as `null` so callers return early instead of accidentally
 * querying every row.
 */
function scopeClauses(
  values: readonly string[] | undefined,
  column: string,
): { clause: string; parameters: string[] } | null {
  if (values === undefined) return { clause: "", parameters: [] };
  if (values.length === 0) return null;
  return {
    clause: `${column} IN (${placeholders(values.length)})`,
    parameters: [...values],
  };
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parsePipelineDefinition(value: string): OfficePipeline | null {
  const parsed = parseJsonObject(value);
  if (parsed === null || !Array.isArray(parsed.stages)) return null;
  return parsed as unknown as OfficePipeline;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  repository_id: string | null;
  local_paths: string | null;
  remote_url: string | null;
  default_branch: string | null;
}

/**
 * Project identity joined with its repository association and sources.
 *
 * `group_concat` keeps the source list in one row so listing every project
 * stays a single statement; the separator is a newline because a filesystem
 * path may legitimately contain a comma.
 */
const projectSelect = `
  SELECT
    p.id, p.name, p.description, p.created_at, p.updated_at,
    ri.repository_id,
    (SELECT group_concat(s.local_path, char(10))
       FROM project_source s
      WHERE s.project_id = p.id AND s.local_path IS NOT NULL) AS local_paths,
    (SELECT s.remote_url FROM project_source s
      WHERE s.project_id = p.id AND s.remote_url IS NOT NULL
      ORDER BY s.created_at LIMIT 1) AS remote_url,
    (SELECT s.default_branch FROM project_source s
      WHERE s.project_id = p.id AND s.default_branch IS NOT NULL
      ORDER BY s.created_at LIMIT 1) AS default_branch
  FROM project p
  LEFT JOIN project_repository_identity ri ON ri.project_id = p.id
`;

function projectRecord(row: ProjectRow): OperationalProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    repositoryId: row.repository_id,
    localPaths:
      row.local_paths === null || row.local_paths === ""
        ? []
        : row.local_paths.split("\n"),
    remoteUrl: row.remote_url,
    defaultBranch: row.default_branch,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  created_at: string;
  updated_at: string;
}

interface MilestoneRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: MilestoneStatus;
  created_at: string;
  updated_at: string;
}

interface AgentRow {
  id: string;
  project_id: string;
  name: string;
  role_id: string;
  role_key: string | null;
  role_name: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
}

interface ActiveStageRow {
  project_id: string;
  pipeline_run_id: string;
  definition_json: string;
  updated_at: string;
  stage_id: string;
  stage_index: number;
  stage_status: PipelineStageRunStatus;
  assigned_agent_id: string | null;
  stage_completed_at: string | null;
}

interface ActivityRow {
  id: string;
  project_id: string | null;
  event_type: string;
  actor_type: "daemon" | "cli" | "system";
  actor_id: string | null;
  aggregate_type: string | null;
  aggregate_id: string | null;
  payload_json: string;
  occurred_at: string;
}

interface AgentRunRow {
  id: string;
  project_id: string;
  task_id: string;
  task_title: string | null;
  agent_id: string;
  agent_name: string | null;
  agent_role_id: string | null;
  agent_role_key: string | null;
  pipeline_run_id: string | null;
  status: AgentRunStatus;
  worktree_path: string | null;
  result_json: string | null;
  error_json: string | null;
  action_intent_json: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

const agentRunColumns = `
  SELECT
    run.id, run.project_id, run.task_id, t.title AS task_title,
    run.agent_id, ag.name AS agent_name, ag.role_id AS agent_role_id,
    r.role_key AS agent_role_key,
    run.pipeline_run_id, run.status, run.worktree_path,
    run.result_json, run.error_json, run.action_intent_json,
    run.created_at, run.started_at, run.completed_at, run.updated_at`;

const agentRunFrom = `
  FROM agent_run run
  LEFT JOIN task t ON t.id = run.task_id
  LEFT JOIN agent ag ON ag.id = run.agent_id
  LEFT JOIN role r ON r.id = ag.role_id`;

const agentRunSelect = `${agentRunColumns}${agentRunFrom}`;

function agentRunRecord(row: AgentRunRow): OperationalAgentRunRecord {
  const intent = parseJsonObject(row.action_intent_json);
  const intentArguments =
    intent === null ? null : parseJsonObject(JSON.stringify(intent.arguments));
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    taskTitle: row.task_title,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentRoleId: row.agent_role_id,
    agentRoleKey: row.agent_role_key,
    pipelineRunId: row.pipeline_run_id,
    status: row.status,
    worktreePath: row.worktree_path,
    result: row.result_json === null ? null : safeParse(row.result_json),
    error: row.error_json === null ? null : safeParse(row.error_json),
    actionIntent:
      intent === null ||
      typeof intent.resourceId !== "string" ||
      typeof intent.operation !== "string"
        ? null
        : {
            resourceId: intent.resourceId,
            operation: intent.operation,
            argumentKeys:
              intentArguments === null ? [] : Object.keys(intentArguments),
          },
    createdAt: new Date(row.created_at),
    startedAt: row.started_at === null ? null : new Date(row.started_at),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
    updatedAt: new Date(row.updated_at),
  };
}

interface ReviewRow {
  id: string;
  project_id: string;
  subject_type: ReviewSubjectType;
  subject_id: string;
  reviewer_actor_type: "user" | "agent" | "system";
  reviewer_actor_id: string;
  reviewer_display_name: string | null;
  status: ReviewStatus;
  summary: string | null;
  created_at: string;
  completed_at: string | null;
  approval_id: string | null;
  approval_decision: "approved" | "rejected" | null;
  approval_actor_type: "user" | "agent" | "system" | null;
  approval_actor_id: string | null;
  approval_display_name: string | null;
  approval_rationale: string | null;
  approval_created_at: string | null;
}

const reviewSelect = `
  SELECT
    v.id, v.project_id, v.subject_type, v.subject_id,
    v.reviewer_actor_type, v.reviewer_actor_id, v.reviewer_display_name,
    v.status, v.summary, v.created_at, v.completed_at,
    a.id AS approval_id, a.decision AS approval_decision,
    a.actor_type AS approval_actor_type, a.actor_id AS approval_actor_id,
    a.display_name AS approval_display_name,
    a.rationale AS approval_rationale, a.created_at AS approval_created_at`;

function reviewRecord(row: ReviewRow): OperationalReviewRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    reviewerActorType: row.reviewer_actor_type,
    reviewerActorId: row.reviewer_actor_id,
    reviewerDisplayName: row.reviewer_display_name,
    status: row.status,
    summary: row.summary,
    createdAt: new Date(row.created_at),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at),
    decision:
      row.approval_id === null ||
      row.approval_decision === null ||
      row.approval_actor_type === null ||
      row.approval_actor_id === null ||
      row.approval_created_at === null
        ? null
        : {
            id: row.approval_id,
            decision: row.approval_decision,
            actorType: row.approval_actor_type,
            actorId: row.approval_actor_id,
            displayName: row.approval_display_name,
            rationale: row.approval_rationale,
            createdAt: new Date(row.approval_created_at),
          },
  };
}

interface PipelineRunRow {
  id: string;
  project_id: string;
  task_id: string;
  task_title: string | null;
  manifest_revision_id: string;
  manifest_revision: number;
  definition_json: string;
  status: PipelineRunStatus;
  current_stage_index: number;
  started_by: string;
  version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  cancelled_at: string | null;
}

const pipelineRunSelect = `
  SELECT
    r.id, r.project_id, r.task_id, t.title AS task_title,
    r.manifest_revision_id, r.manifest_revision, r.definition_json,
    r.status, r.current_stage_index, r.started_by, r.version,
    r.created_at, r.updated_at, r.completed_at, r.cancelled_at
  FROM pipeline_run r
  LEFT JOIN task t ON t.id = r.task_id`;

interface StageRow {
  id: string;
  pipeline_run_id: string;
  stage_id: string;
  stage_index: number;
  role_id: string;
  status: PipelineStageRunStatus;
  assigned_agent_id: string | null;
  assigned_at: string | null;
  completed_at: string | null;
  approved_by: string | null;
  approval_decision: "approved" | "rejected" | null;
  approval_rationale: string | null;
  approved_at: string | null;
}

function stageProps(row: StageRow): PipelineStageRunProps {
  return {
    id: row.id,
    stageId: row.stage_id,
    stageIndex: row.stage_index,
    roleId: row.role_id,
    status: row.status,
    ...(row.assigned_agent_id === null
      ? {}
      : { assignedAgentId: row.assigned_agent_id }),
    ...(row.assigned_at === null
      ? {}
      : { assignedAt: new Date(row.assigned_at) }),
    ...(row.completed_at === null
      ? {}
      : { completedAt: new Date(row.completed_at) }),
    ...(row.approved_by === null ? {} : { approvedBy: row.approved_by }),
    ...(row.approval_decision === null
      ? {}
      : { approvalDecision: row.approval_decision }),
    ...(row.approval_rationale === null
      ? {}
      : { approvalRationale: row.approval_rationale }),
    ...(row.approved_at === null
      ? {}
      : { approvedAt: new Date(row.approved_at) }),
  };
}

function pipelineRunProps(
  row: PipelineRunRow,
  stages: readonly PipelineStageRunProps[],
): PipelineRunProps {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    manifestRevisionId: row.manifest_revision_id,
    manifestRevision: row.manifest_revision,
    definition: (parsePipelineDefinition(row.definition_json) ?? {
      id: "",
      name: "",
      description: "",
      defaultFor: [],
      stages: [],
    }) as OfficePipeline,
    status: row.status,
    currentStageIndex: row.current_stage_index,
    stages,
    startedBy: row.started_by,
    version: row.version,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    ...(row.completed_at === null
      ? {}
      : { completedAt: new Date(row.completed_at) }),
    ...(row.cancelled_at === null
      ? {}
      : { cancelledAt: new Date(row.cancelled_at) }),
  };
}
