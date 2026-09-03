import type { Database } from "bun:sqlite";
import type { AgentRunStatus } from "@ai-office/domain/agent/agent-run.ts";
import type {
  MilestoneStatus,
  RequirementStatus,
  ReviewStatus,
  ReviewSubjectType,
} from "@ai-office/domain/governance/governance.ts";
import type { OfficePipeline } from "@ai-office/domain/office/office-manifest.ts";
import type { PipelineStageRunStatus } from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { TaskStatus } from "@ai-office/domain/task/task.ts";
import type {
  ActivityQuery,
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
  OperationalProjectRecord,
  OperationalReadRepository,
  OperationalReviewRecord,
  RequirementCountRecord,
  ReviewQuery,
  StatusCountRecord,
} from "@ai-office/application/ports/operational-read.port.ts";

/**
 * Read-only SQLite adapter for the operational query surface.
 *
 * Every method issues a fixed number of statements regardless of how many
 * projects, tasks, or runs exist, and every list is bounded by an explicit
 * limit. No index is added for these queries: they reuse the existing
 * `task_project_status_priority_idx`, `agent_run_project_status_idx`,
 * `review_project_idx`, `audit_event_occurred_at_idx`,
 * `audit_event_project_occurred_at_idx`, and `pipeline_run_project_status_idx`
 * access paths.
 */
export class SqliteOperationalReadRepository implements OperationalReadRepository {
  constructor(private readonly database: Database) {}

  async listProjects(): Promise<OperationalProjectRecord[]> {
    const rows = this.database
      .query<ProjectRow, []>(`${projectSelect} ORDER BY p.name, p.id`)
      .all();
    return rows.map(projectRecord);
  }

  async findProject(
    projectId: string,
  ): Promise<OperationalProjectRecord | null> {
    const row = this.database
      .query<ProjectRow, [string]>(`${projectSelect} WHERE p.id = ?`)
      .get(projectId);
    return row === null ? null : projectRecord(row);
  }

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

  async countActivePipelineRuns(
    projectIds: readonly string[],
  ): Promise<CountRecord[]> {
    if (projectIds.length === 0) return [];
    return this.database
      .query<{ project_id: string; count: number }, string[]>(
        `SELECT project_id, COUNT(*) AS count
         FROM pipeline_run
         WHERE status = 'active' AND project_id IN (${placeholders(projectIds.length)})
         GROUP BY project_id`,
      )
      .all(...projectIds)
      .map((row) => ({ projectId: row.project_id, count: row.count }));
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
        [...string[], number]
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
  ): Promise<OperationalActivePipelineStageRecord[]> {
    if (projectIds.length === 0) return [];
    return this.database
      .query<ActiveStageRow, string[]>(
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
         ORDER BY r.updated_at DESC, r.id`,
      )
      .all(...projectIds)
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

  async listMilestones(
    projectIds: readonly string[],
  ): Promise<OperationalMilestoneRecord[]> {
    if (projectIds.length === 0) return [];
    return this.database
      .query<
        {
          id: string;
          project_id: string;
          title: string;
          description: string | null;
          status: MilestoneStatus;
          created_at: string;
          updated_at: string;
        },
        string[]
      >(
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
      .query<
        {
          id: string;
          project_id: string;
          name: string;
          role_id: string;
          role_key: string | null;
          role_name: string | null;
          enabled: number;
          created_at: string;
          updated_at: string;
        },
        string[]
      >(
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
        `SELECT
           v.id, v.project_id, v.subject_type, v.subject_id,
           v.reviewer_actor_type, v.reviewer_actor_id, v.reviewer_display_name,
           v.status, v.summary, v.created_at, v.completed_at,
           a.id AS approval_id, a.decision AS approval_decision,
           a.actor_type AS approval_actor_type, a.actor_id AS approval_actor_id,
           a.display_name AS approval_display_name,
           a.rationale AS approval_rationale, a.created_at AS approval_created_at
         FROM review v
         LEFT JOIN approval a ON a.review_id = v.id AND a.project_id = v.project_id
         ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
         ORDER BY v.created_at DESC, v.id
         LIMIT ?`,
      )
      .all(...parameters)
      .map((row) => ({
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
        completedAt:
          row.completed_at === null ? null : new Date(row.completed_at),
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
      }));
  }

  async listActivity(
    query: ActivityQuery,
  ): Promise<OperationalActivityRecord[]> {
    const conditions: string[] = [];
    const parameters: (string | number)[] = [];

    if (query.projectId !== undefined) {
      conditions.push("project_id = ?");
      parameters.push(query.projectId);
    }
    if (query.before !== undefined) {
      conditions.push("occurred_at < ?");
      parameters.push(query.before.toISOString());
    }
    parameters.push(query.limit);

    return this.database
      .query<
        {
          id: string;
          project_id: string | null;
          event_type: string;
          actor_type: "daemon" | "cli" | "system";
          actor_id: string | null;
          aggregate_type: string | null;
          aggregate_id: string | null;
          payload_json: string;
          occurred_at: string;
        },
        (string | number)[]
      >(
        `SELECT id, project_id, event_type, actor_type, actor_id,
                aggregate_type, aggregate_id, payload_json, occurred_at
         FROM audit_event
         ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
         ORDER BY occurred_at DESC, rowid DESC
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
}

/* -------------------------------------------------------------------------- */
/* Row shapes and helpers                                                      */
/* -------------------------------------------------------------------------- */

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
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

const agentRunSelect = `
  SELECT
    run.id, run.project_id, run.task_id, t.title AS task_title,
    run.agent_id, ag.name AS agent_name, ag.role_id AS agent_role_id,
    r.role_key AS agent_role_key,
    run.pipeline_run_id, run.status, run.worktree_path,
    run.result_json, run.error_json, run.action_intent_json,
    run.created_at, run.started_at, run.completed_at, run.updated_at
  FROM agent_run run
  LEFT JOIN task t ON t.id = run.task_id
  LEFT JOIN agent ag ON ag.id = run.agent_id
  LEFT JOIN role r ON r.id = ag.role_id
`;

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

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
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
