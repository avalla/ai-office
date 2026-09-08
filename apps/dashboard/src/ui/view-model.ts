/**
 * Presentation mapping for the dashboard.
 *
 * These functions turn already-computed operational read models into labels,
 * glyphs, and ordering. They deliberately do not derive operational meaning:
 * every status they display was decided by the application layer. If a mapping
 * here ever needs to inspect a task's runs or a pipeline's stages to decide
 * what a thing *is*, that logic belongs in the projection instead.
 */

import type {
  ActivityEntry,
  AgentRunDetail,
  AgentRunEventEntry,
  BoundedList,
  AgentRunState,
  AgentState,
  AttentionReason,
  DashboardOverview,
  PipelineRunState,
  PipelineStageState,
  ProjectDetail,
  ProjectSummary,
  ReviewState,
  TaskOperationalState,
  TaskDetail,
  TaskDivergenceReason,
  TaskOperationalStatus,
  TaskPageQuery,
  TaskPageInfo,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  parseTaskPageQuery,
  taskPageParameters,
} from "@ai-office/application/protocol/query-protocol.ts";

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

export type DashboardRoute =
  | { kind: "overview" }
  | { kind: "project"; projectId: string; taskQuery?: TaskPageQuery }
  | {
      kind: "task";
      projectId: string;
      taskId: string;
      taskQuery?: TaskPageQuery;
    }
  | { kind: "invalid"; message: string }
  | { kind: "run"; runId: string };

/** Parses a location hash such as `#/projects/p-1`. Unknown routes fall back. */
export function parseRoute(hash: string): DashboardRoute {
  const [path = "", queryString = ""] = hash
    .replace(/^#/, "")
    .replace(/^\//, "")
    .split("?");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  // Invalid percent-encoding must not prevent the shell from starting.
  try {
    for (const segment of segments) decodeURIComponent(segment);
  } catch {
    return { kind: "overview" };
  }
  let taskQuery: TaskPageQuery = {};
  if (segments[0] === "projects") {
    try {
      taskQuery = parseTaskPageQuery(new URLSearchParams(queryString));
    } catch (error) {
      return {
        kind: "invalid",
        message:
          error instanceof Error ? error.message : "Invalid task filters",
      };
    }
  }
  const query = Object.keys(taskQuery).length === 0 ? {} : { taskQuery };
  if (
    segments.length === 4 &&
    segments[0] === "projects" &&
    segments[2] === "tasks"
  )
    return {
      kind: "task",
      projectId: decodeURIComponent(segments[1]!),
      taskId: decodeURIComponent(segments[3]!),
      ...query,
    };
  if (segments.length === 2 && segments[0] === "projects")
    return {
      kind: "project",
      projectId: decodeURIComponent(segments[1]!),
      ...query,
    };
  if (segments.length === 2 && segments[0] === "runs")
    return { kind: "run", runId: decodeURIComponent(segments[1]!) };
  return { kind: "overview" };
}

export function routeHref(route: DashboardRoute): string {
  const query =
    route.kind === "project" || route.kind === "task"
      ? taskPageParameters(route.taskQuery ?? {}).toString()
      : "";
  const suffix = query === "" ? "" : `?${query}`;
  if (route.kind === "invalid")
    return `#/invalid/${encodeURIComponent(route.message)}`;
  if (route.kind === "task")
    return `#/projects/${encodeURIComponent(route.projectId)}/tasks/${encodeURIComponent(route.taskId)}${suffix}`;
  if (route.kind === "project")
    return `#/projects/${encodeURIComponent(route.projectId)}${suffix}`;
  if (route.kind === "run") return `#/runs/${encodeURIComponent(route.runId)}`;
  return "#/";
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                      */
/* -------------------------------------------------------------------------- */

const taskStatusLabels: Record<TaskOperationalStatus, string> = {
  not_started: "not started",
  scheduled: "scheduled",
  in_progress: "in progress",
  awaiting_review: "awaiting review",
  blocked: "blocked",
  failed: "failed",
  completed: "completed",
  cancelled: "cancelled",
};

export function taskStatusLabel(status: TaskOperationalStatus): string {
  return taskStatusLabels[status];
}

const divergenceLabels: Record<TaskDivergenceReason, string> = {
  agent_run_scheduled_without_task_transition:
    "A run is queued, but the task record has not advanced.",
  agent_run_active_without_task_transition:
    "A run is active, but the task record has not advanced.",
  agent_run_failed_without_task_transition:
    "The latest run failed, but the task record has not advanced.",
  pipeline_stage_awaiting_approval:
    "The pipeline stage is waiting for approval.",
  review_pending: "A review is pending for this task.",
};

export function taskDivergenceLabel(reason: TaskDivergenceReason): string {
  return divergenceLabels[reason];
}

/** Colour bucket, so the stylesheet never has to know status vocabularies. */
export type ToneName = "neutral" | "active" | "attention" | "good" | "muted";

export function taskStatusTone(status: TaskOperationalStatus): ToneName {
  if (status === "in_progress" || status === "scheduled") return "active";
  if (
    status === "awaiting_review" ||
    status === "blocked" ||
    status === "failed"
  )
    return "attention";
  if (status === "completed") return "good";
  if (status === "cancelled") return "muted";
  return "neutral";
}

const agentStateLabels: Record<AgentState["state"], string> = {
  disabled: "disabled",
  idle: "idle",
  assigned: "assigned",
  working: "active run",
  awaiting_approval: "waiting",
  last_run_failed: "last run failed",
};

export function agentStateLabel(state: AgentState["state"]): string {
  return agentStateLabels[state];
}

export function agentStateTone(state: AgentState["state"]): ToneName {
  if (state === "working" || state === "assigned") return "active";
  if (state === "awaiting_approval" || state === "last_run_failed")
    return "attention";
  if (state === "disabled") return "muted";
  return "neutral";
}

/**
 * "and N more" for an agent's concurrent runs or stage assignments.
 *
 * An agent may hold several of either, and the row shows one representative.
 * This says how many the row does not name, read from the exact `total` rather
 * than from the sample length, so a truncated sample never understates it.
 */
export function concurrencyNote<T>(list: BoundedList<T>): string | null {
  return list.total > 1 ? `+${list.total - 1} more` : null;
}

export function runStatusTone(status: AgentRunState["status"]): ToneName {
  if (status === "failed") return "attention";
  if (status === "completed") return "good";
  if (status === "cancelled") return "muted";
  return "active";
}

const attentionLabels: Record<AttentionReason["kind"], string> = {
  review_pending: "Review pending",
  pipeline_stage_awaiting_approval: "Approval waiting",
  pipeline_stage_unassigned: "Stage unassigned",
  agent_run_failed: "Run failed",
  task_blocked: "Task blocked",
  task_failed: "Task failed",
  task_run_without_lease: "Run without lease",
  task_lease_expired: "Lease expired",
};

export function attentionLabel(kind: AttentionReason["kind"]): string {
  return attentionLabels[kind];
}

/* -------------------------------------------------------------------------- */
/* Pipeline stage rendering                                                    */
/* -------------------------------------------------------------------------- */

export interface StageChip {
  name: string;
  glyph: string;
  status: PipelineStageState["status"];
  tone: ToneName;
  agentName: string | null;
}

const stageGlyphs: Record<PipelineStageState["status"], string> = {
  completed: "✓",
  active: "●",
  awaiting_approval: "⏸",
  pending: "○",
  cancelled: "✕",
};

const stageTones: Record<PipelineStageState["status"], ToneName> = {
  completed: "good",
  active: "active",
  awaiting_approval: "attention",
  pending: "neutral",
  cancelled: "muted",
};

/**
 * Renders the persisted stage sequence of a run. Stage names and order come
 * from the run's own definition, so no role vocabulary is hardcoded here.
 */
export function stageChips(pipeline: PipelineRunState): StageChip[] {
  return pipeline.stages.map((stage) => ({
    name: stage.name,
    glyph: stageGlyphs[stage.status],
    status: stage.status,
    tone: stageTones[stage.status],
    agentName: stage.assignedAgent?.name ?? null,
  }));
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                  */
/* -------------------------------------------------------------------------- */

export function formatTimestamp(value: string | null): string {
  if (value === null) return "—";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export function formatDuration(milliseconds: number | null): string {
  if (milliseconds === null) return "—";
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function shortId(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 8)}…`;
}

/* -------------------------------------------------------------------------- */
/* View models                                                                 */
/* -------------------------------------------------------------------------- */

export interface EmptyState {
  headline: string;
  detail: string;
}

/**
 * A displayed sample plus the sentence that says what it leaves out.
 *
 * The dashboard renders `items`, but it must never let a reader mistake that
 * page for the count: `note` is non-null exactly when the sample is truncated.
 */
export interface SampleView<T> {
  items: readonly T[];
  total: number;
  note: string | null;
}

export function sampleView<T>(
  list: BoundedList<T>,
  noun: string,
): SampleView<T> {
  return {
    items: list.items,
    total: list.total,
    note: list.truncated
      ? `showing ${list.items.length} of ${list.total} ${noun}`
      : null,
  };
}

export interface OverviewView {
  generatedAt: string;
  totals: DashboardOverview["totals"];
  projects: readonly ProjectSummary[];
  attention: SampleView<AttentionReason>;
  activeRuns: SampleView<AgentRunState>;
  activity: readonly ActivityEntry[];
  empty: EmptyState | null;
}

export function overviewViewModel(dashboard: DashboardOverview): OverviewView {
  return {
    generatedAt: formatTimestamp(dashboard.generatedAt),
    totals: dashboard.totals,
    projects: [...dashboard.projects].sort((left, right) =>
      left.name.localeCompare(right.name),
    ),
    attention: sampleView(dashboard.attention, "items needing attention"),
    activeRuns: sampleView(dashboard.activeRuns, "active runs"),
    activity: dashboard.recentActivity.items,
    empty:
      dashboard.projects.length > 0
        ? null
        : {
            headline: "No projects yet",
            detail:
              "Run ai-office install in a repository to hand it to the office.",
          },
  };
}

export interface ProjectView {
  generatedAt: string;
  summary: ProjectSummary;
  attention: SampleView<AttentionReason>;
  tasks: SampleView<TaskOperationalState>;
  taskPage?: TaskPageInfo;
  pipelines: SampleView<PipelineRunState>;
  agents: readonly AgentState[];
  reviews: SampleView<ReviewState>;
  activity: readonly ActivityEntry[];
}

const taskOrder: readonly TaskOperationalStatus[] = [
  "blocked",
  "failed",
  "awaiting_review",
  "in_progress",
  "scheduled",
  "not_started",
  "completed",
  "cancelled",
];

export function projectViewModel(detail: ProjectDetail): ProjectView {
  // Sorting reorders the displayed page only; which tasks are on it, and every
  // count beside them, were decided by the query surface.
  const tasks = [...detail.tasks.items].sort((left, right) => {
    if (detail.taskPage !== undefined) return 0; // Server order spans all pages.
    const byStatus =
      taskOrder.indexOf(left.operationalStatus) -
      taskOrder.indexOf(right.operationalStatus);
    if (byStatus !== 0) return byStatus;
    if (left.priority !== right.priority) return right.priority - left.priority;
    return left.title.localeCompare(right.title);
  });

  return {
    generatedAt: formatTimestamp(detail.generatedAt),
    summary: detail.summary,
    attention: sampleView(detail.summary.attention, "items needing attention"),
    tasks: {
      items: tasks,
      total: detail.tasks.total,
      note: detail.tasks.truncated
        ? `showing ${tasks.length} of ${detail.tasks.total} tasks`
        : null,
    },
    ...(detail.taskPage === undefined ? {} : { taskPage: detail.taskPage }),
    pipelines: sampleView(detail.pipelines, "pipeline runs"),
    agents: detail.agents,
    reviews: sampleView(detail.reviews, "reviews"),
    activity: detail.recentActivity.items,
  };
}

export interface RunView {
  run: AgentRunState;
  workerOutput?: AgentRunDetail["workerOutput"];
  duration: string;
  events: SampleView<AgentRunEventEntry>;
  actions: AgentRunDetail["actions"];
  pipeline: PipelineRunState | null;
  reviews: readonly ReviewState[];
  activity: readonly ActivityEntry[];
  attention: readonly AttentionReason[];
}

export interface TaskView {
  detail: TaskDetail;
  taskQuery?: TaskPageQuery;
  runs: SampleView<AgentRunState>;
  activeRuns: SampleView<
    TaskOperationalState["activeAgentRuns"]["items"][number]
  >;
}

export function taskViewModel(
  detail: TaskDetail,
  taskQuery?: TaskPageQuery,
): TaskView {
  return {
    detail,
    ...(taskQuery === undefined ? {} : { taskQuery }),
    runs: sampleView(detail.runs, "runs"),
    activeRuns: sampleView(detail.task.activeAgentRuns, "active runs"),
  };
}

export function runViewModel(detail: AgentRunDetail): RunView {
  return {
    run: detail.run,
    workerOutput: detail.workerOutput ?? null,
    duration: formatDuration(detail.run.durationMs),
    events: sampleView(detail.events, "run events"),
    actions: detail.actions,
    pipeline: detail.pipeline,
    reviews: detail.reviews,
    activity: detail.activity.items,
    attention: detail.attentionReasons,
  };
}
