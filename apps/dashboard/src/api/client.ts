import type {
  AgentRunDetail,
  AgentRunState,
  AgentState,
  BoundedList,
  DashboardOverview,
  GlobalMemoryOverview,
  PipelineRunState,
  ProjectDetail,
  ProjectSummary,
  TaskDetail,
  TaskGraph,
} from "@ai-office/application/read-models/operational-read-models.ts";
import { taskPageParameters } from "@ai-office/application/protocol/query-protocol.ts";
import type { DashboardRoute } from "../ui/view-model.ts";

export class DashboardApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { accept: "application/json" },
    cache: "no-store",
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => null);
    const message =
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "object" &&
      body.error !== null &&
      "message" in body.error &&
      typeof body.error.message === "string"
        ? body.error.message
        : `Request failed with HTTP ${response.status}`;
    throw new DashboardApiError(message, response.status);
  }
  return (await response.json()) as T;
}

const projectPath = (id: string) => `/api/projects/${encodeURIComponent(id)}`;

export async function getTaskDetail(
  projectId: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskDetail> {
  return (
    await get<{ task: TaskDetail }>(
      `${projectPath(projectId)}/tasks/${encodeURIComponent(taskId)}`,
      signal,
    )
  ).task;
}
export async function getProjectSummaries(): Promise<
  readonly ProjectSummary[]
> {
  return (await get<{ projects: readonly ProjectSummary[] }>("/api/projects"))
    .projects;
}

export type DashboardData =
  | {
      kind: "overview";
      overview: DashboardOverview;
      pipelines: ReadonlyMap<string, BoundedList<PipelineRunState>>;
    }
  | {
      kind: "projects";
      overview: DashboardOverview;
      pipelines: ReadonlyMap<string, BoundedList<PipelineRunState>>;
    }
  | {
      kind: "work";
      overview: DashboardOverview;
      pipelines: ReadonlyMap<string, BoundedList<PipelineRunState>>;
    }
  | {
      kind: "pipelines";
      overview: DashboardOverview;
      pipelines: ReadonlyMap<string, BoundedList<PipelineRunState>>;
    }
  | {
      kind: "agents";
      overview: DashboardOverview;
      agents: readonly AgentState[];
    }
  | {
      kind: "project";
      project: ProjectDetail;
      activePipelines: BoundedList<PipelineRunState>;
      activeRuns: BoundedList<AgentRunState>;
    }
  | { kind: "graph"; graph: TaskGraph }
  | { kind: "task"; detail: TaskDetail }
  | { kind: "run"; detail: AgentRunDetail; task: TaskDetail | null }
  | { kind: "memory"; memory: GlobalMemoryOverview }
  | { kind: "invalid"; message: string };

async function pipelineSamples(
  overview: DashboardOverview,
): Promise<ReadonlyMap<string, BoundedList<PipelineRunState>>> {
  const active = overview.projects.filter(
    (project) => project.activePipelineRuns > 0,
  );
  return new Map(
    await Promise.all(
      active.map(async (project) => {
        const body = await get<{ pipelines: BoundedList<PipelineRunState> }>(
          `${projectPath(project.projectId)}/pipelines?active=true`,
        );
        return [project.projectId, body.pipelines] as const;
      }),
    ),
  );
}

/** Every value is read from the daemon query API. SSE only asks us to re-run this function. */
export async function queryRoute(
  route: DashboardRoute,
): Promise<DashboardData> {
  if (route.kind === "invalid")
    return { kind: "invalid", message: route.message };
  if (route.kind === "task") {
    return {
      kind: "task",
      detail: await getTaskDetail(route.projectId, route.taskId),
    };
  }
  if (route.kind === "run") {
    const body = await get<{ run: AgentRunDetail }>(
      `/api/runs/${encodeURIComponent(route.runId)}`,
    );
    const task = body.run.run.task;
    let taskDetail: TaskDetail | null = null;
    if (task !== null) {
      try {
        taskDetail = (
          await get<{ task: TaskDetail }>(
            `${projectPath(body.run.run.projectId)}/tasks/${encodeURIComponent(task.taskId)}`,
          )
        ).task;
      } catch {
        // A run remains inspectable if its task detail is no longer available.
      }
    }
    return { kind: "run", detail: body.run, task: taskDetail };
  }
  if (route.kind === "memory") {
    const body = await get<{ memory: GlobalMemoryOverview }>("/api/memory");
    return { kind: "memory", memory: body.memory };
  }
  if (route.kind === "project") {
    if (route.section === "graph") {
      const body = await get<{ graph: TaskGraph }>(
        `${projectPath(route.projectId)}/graph`,
      );
      return { kind: "graph", graph: body.graph };
    }
    const parameters = taskPageParameters(
      route.section === "tasks" ||
        (route.section === undefined && route.taskQuery !== undefined)
        ? (route.taskQuery ?? { status: "active" })
        : {},
    );
    parameters.set("taskView", "paged");
    const [project, activePipelines, activeRuns] = await Promise.all([
      get<{ project: ProjectDetail }>(
        `${projectPath(route.projectId)}?${parameters}`,
      ),
      get<{ pipelines: BoundedList<PipelineRunState> }>(
        `${projectPath(route.projectId)}/pipelines?active=true`,
      ),
      get<{ runs: BoundedList<AgentRunState> }>(
        `/api/runs?project=${encodeURIComponent(route.projectId)}&active=true`,
      ),
    ]);
    return {
      kind: "project",
      project: project.project,
      activePipelines: activePipelines.pipelines,
      activeRuns: activeRuns.runs,
    };
  }
  const body = await get<{ dashboard: DashboardOverview }>("/api/dashboard");
  if (route.kind === "agents") {
    const batches = await Promise.all(
      body.dashboard.projects.map(
        async (project) =>
          (
            await get<{ agents: readonly AgentState[] }>(
              `${projectPath(project.projectId)}/agents`,
            )
          ).agents,
      ),
    );
    return { kind: "agents", overview: body.dashboard, agents: batches.flat() };
  }
  const pipelines = await pipelineSamples(body.dashboard);
  return {
    kind:
      route.kind === "pipelines"
        ? "pipelines"
        : route.kind === "work"
          ? "work"
          : route.kind === "projects"
            ? "projects"
            : "overview",
    overview: body.dashboard,
    pipelines,
  };
}
