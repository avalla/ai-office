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
  TaskOperationalStatus,
} from "@ai-office/application/read-models/operational-read-models.ts";

/* -------------------------------------------------------------------------- */
/* Routing                                                                     */
/* -------------------------------------------------------------------------- */

export type DashboardRoute =
  | { kind: "overview" }
  | { kind: "project"; projectId: string }
  | { kind: "run"; runId: string };

/** Parses a location hash such as `#/projects/p-1`. Unknown routes fall back. */
export function parseRoute(hash: string): DashboardRoute {
  const path = hash.replace(/^#/, "").replace(/^\//, "");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 2 && segments[0] === "projects")
    return { kind: "project", projectId: decodeURIComponent(segments[1]!) };
  if (segments.length === 2 && segments[0] === "runs")
    return { kind: "run", runId: decodeURIComponent(segments[1]!) };
  return { kind: "overview" };
}

export function routeHref(route: DashboardRoute): string {
  if (route.kind === "project")
    return `#/projects/${encodeURIComponent(route.projectId)}`;
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
  working: "working",
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
  divergentTasks: readonly TaskOperationalState[];
  pipelines: SampleView<PipelineRunState>;
  activePipelines: readonly PipelineRunState[];
  agents: readonly AgentState[];
  reviews: SampleView<ReviewState>;
  pendingReviews: readonly ReviewState[];
  activity: readonly ActivityEntry[];
  empty: EmptyState | null;
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
    divergentTasks: tasks.filter((task) => task.divergesFromRecordedStatus),
    pipelines: sampleView(detail.pipelines, "pipeline runs"),
    activePipelines: detail.pipelines.items.filter(
      (pipeline) => pipeline.status === "active",
    ),
    agents: detail.agents,
    reviews: sampleView(detail.reviews, "reviews"),
    pendingReviews: detail.reviews.items.filter(
      (review) => review.status === "pending",
    ),
    activity: detail.recentActivity.items,
    empty:
      detail.tasks.total === 0 &&
      detail.pipelines.total === 0 &&
      detail.runs.total === 0
        ? {
            headline: "No activity yet",
            detail:
              "This project has no tasks, pipeline runs, or agent runs on record.",
          }
        : null,
  };
}

export interface RunView {
  run: AgentRunState;
  duration: string;
  events: SampleView<AgentRunEventEntry>;
  actions: AgentRunDetail["actions"];
  pipeline: PipelineRunState | null;
  reviews: readonly ReviewState[];
  activity: readonly ActivityEntry[];
  attention: readonly AttentionReason[];
}

export function runViewModel(detail: AgentRunDetail): RunView {
  return {
    run: detail.run,
    duration: formatDuration(detail.run.durationMs),
    events: sampleView(detail.events, "run events"),
    actions: detail.actions,
    pipeline: detail.pipeline,
    reviews: detail.reviews,
    activity: detail.activity.items,
    attention: detail.attentionReasons,
  };
}
