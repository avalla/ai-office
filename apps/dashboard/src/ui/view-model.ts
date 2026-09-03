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
  working: "working",
  awaiting_approval: "waiting",
  last_run_failed: "last run failed",
};

export function agentStateLabel(state: AgentState["state"]): string {
  return agentStateLabels[state];
}

export function agentStateTone(state: AgentState["state"]): ToneName {
  if (state === "working") return "active";
  if (state === "awaiting_approval" || state === "last_run_failed")
    return "attention";
  if (state === "disabled") return "muted";
  return "neutral";
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

export interface OverviewView {
  generatedAt: string;
  totals: DashboardOverview["totals"];
  projects: readonly ProjectSummary[];
  attention: readonly AttentionReason[];
  activeRuns: readonly AgentRunState[];
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
    attention: dashboard.attentionReasons,
    activeRuns: dashboard.activeRuns,
    activity: dashboard.recentActivity,
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
  attention: readonly AttentionReason[];
  tasks: readonly TaskOperationalState[];
  divergentTasks: readonly TaskOperationalState[];
  pipelines: readonly PipelineRunState[];
  activePipelines: readonly PipelineRunState[];
  agents: readonly AgentState[];
  reviews: readonly ReviewState[];
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
  const tasks = [...detail.tasks].sort((left, right) => {
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
    attention: detail.summary.attentionReasons,
    tasks,
    divergentTasks: tasks.filter((task) => task.divergesFromRecordedStatus),
    pipelines: detail.pipelines,
    activePipelines: detail.pipelines.filter(
      (pipeline) => pipeline.status === "active",
    ),
    agents: detail.agents,
    reviews: detail.reviews,
    pendingReviews: detail.reviews.filter(
      (review) => review.status === "pending",
    ),
    activity: detail.recentActivity,
    empty:
      detail.tasks.length === 0 &&
      detail.pipelines.length === 0 &&
      detail.runs.length === 0
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
  events: AgentRunDetail["events"];
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
    events: detail.events,
    actions: detail.actions,
    pipeline: detail.pipeline,
    reviews: detail.reviews,
    activity: detail.activity,
    attention: detail.attentionReasons,
  };
}
