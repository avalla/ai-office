import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import type {
  AgentRunState,
  AgentState,
  BoundedList,
  PipelineRunState,
  ProjectDetail,
  ProjectSummary,
  RequirementSummary,
  TaskGraph,
  TaskPageQuery,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  queryLimits,
  taskPageParameters,
} from "@ai-office/application/protocol/query-protocol.ts";
import type { DashboardData } from "../api/client.ts";
import {
  ActivityList,
  activePipelineRuns,
  activeRunAbsence,
  AgentTable,
  AttentionList,
  DataNote,
  Divergence,
  Empty,
  FactGrid,
  Id,
  PipelinePanel,
  PipelineStateBadge,
  PipelineTimeline,
  ProjectCard,
  ReviewList,
  RunStateBadge,
  RunTable,
  Section,
  StatusBadge,
  TaskTable,
} from "../components/operations.tsx";
import {
  Button,
  Card,
  Input,
  Select,
  Separator,
} from "../components/ui/primitives.tsx";
import { TaskGraphView } from "./task-graph.tsx";
import { elapsed, formatDuration, formatTimestamp } from "../lib/formatting.ts";
import {
  milestoneChoiceDisabled,
  taskFilterQuery,
  type TaskFilterValues,
} from "../lib/task-filters.ts";
import {
  milestoneStatusTone,
  requirementStatusTone,
  taskOperationalFilterLabel,
  taskStatusLabel,
  taskStatusTone,
} from "../ui/view-model.ts";

const projectNames = (
  projects: readonly { projectId: string; name: string }[],
) => new Map(projects.map((project) => [project.projectId, project.name]));
function heading(title: string, subtitle?: string) {
  return (
    <header className="space-y-1">
      <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
        {title}
      </h1>
      {subtitle && <p className="text-sm text-subtle">{subtitle}</p>}
    </header>
  );
}
function stats(items: readonly { label: string; value: number }[]) {
  return (
    <dl className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
      {items.map(({ label, value }) => (
        <div
          key={label}
          className="rounded-xl border border-border bg-surface p-4"
        >
          <dt className="text-xs font-medium text-subtle">{label}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function OverviewPage({
  data,
}: {
  data: Extract<DashboardData, { kind: "overview" }>;
}) {
  const { overview, pipelines } = data;
  const names = projectNames(overview.projects);
  const currentPipelines = [...pipelines.values()].flatMap(
    (sample) => sample.items,
  );
  const runPipeline = (run: AgentRunState) =>
    currentPipelines.find(
      (pipeline) => pipeline.pipelineRunId === run.pipelineRunId,
    );
  const activeProjects = overview.projects.filter(
    (project) => project.activeAgentRuns > 0 || project.activePipelineRuns > 0,
  ).length;
  const approvals = overview.attention.items.filter(
    (item) => item.kind === "pipeline_stage_awaiting_approval",
  ).length;
  return (
    <div className="page-stack">
      {heading(
        "Operations overview",
        "What AI Office is doing now · authoritative Runtime snapshot",
      )}
      {stats([
        { label: "Active projects", value: activeProjects },
        {
          label: "Active pipelines",
          value: overview.totals.activePipelineRuns,
        },
        { label: "Working agents", value: overview.totals.agentsWorking },
        { label: "Active runs", value: overview.totals.activeAgentRuns },
        { label: "Open tasks", value: overview.totals.openTasks },
        { label: "Needs attention", value: overview.totals.attentionItems },
        { label: "Pending reviews", value: overview.totals.pendingReviews },
      ])}
      <Section
        title="Active work"
        detail={`${overview.activeRuns.total} active runs · ${overview.totals.activePipelineRuns} active pipelines`}
      >
        {overview.activeRuns.items.length ? (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full min-w-[900px] text-left text-sm">
              <thead>
                <tr>
                  {[
                    "Project / task",
                    "Pipeline / stage",
                    "Assigned",
                    "Working",
                    "Run",
                    "Status / elapsed",
                  ].map((label) => (
                    <th key={label}>{label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {overview.activeRuns.items.map((run) => {
                  const pipeline = runPipeline(run);
                  return (
                    <tr key={run.runId}>
                      <td>
                        <Link
                          to={`/projects/${encodeURIComponent(run.projectId)}`}
                        >
                          {names.get(run.projectId) ?? "Project"}
                        </Link>
                        <div className="text-xs text-subtle">
                          {run.task ? (
                            <Link
                              to={`/projects/${encodeURIComponent(run.projectId)}/tasks/${encodeURIComponent(run.task.taskId)}`}
                            >
                              {run.task.title}
                            </Link>
                          ) : (
                            "No task linked"
                          )}
                        </div>
                      </td>
                      <td>
                        {pipeline ? (
                          <Link
                            to={`/projects/${encodeURIComponent(run.projectId)}/pipeline`}
                          >
                            {pipeline.pipelineName} ·{" "}
                            {pipeline.currentStage?.name ?? "—"}
                          </Link>
                        ) : run.pipelineRunId ? (
                          <Id value={run.pipelineRunId} />
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {pipeline?.currentStage?.assignedAgent?.name ??
                          "No assignment shown"}
                      </td>
                      <td className="font-medium">
                        {run.agent?.name ?? "Agent unavailable"}
                        {pipeline?.currentStage?.assignedAgent &&
                          pipeline.currentStage.assignedAgent.agentId !==
                            run.agent?.agentId && (
                            <span className="block text-xs text-amber-700 dark:text-amber-300">
                              Differs from stage assignment
                            </span>
                          )}
                      </td>
                      <td>
                        <Link to={`/runs/${encodeURIComponent(run.runId)}`}>
                          <Id value={run.runId} />
                        </Link>
                      </td>
                      <td>
                        <RunStateBadge status={run.status} />
                        <div className="mt-1 text-xs text-subtle">
                          {elapsed(run.startedAt)}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>
            {overview.activeRuns.total === 0
              ? "No active runs recorded."
              : "No active run shown in the displayed sample."}
          </Empty>
        )}
        <DataNote list={overview.activeRuns} noun="active runs" />
        {currentPipelines.length > 0 && (
          <div className="grid gap-3 lg:grid-cols-2">
            {currentPipelines.map((pipeline) => (
              <PipelinePanel
                key={pipeline.pipelineRunId}
                pipeline={pipeline}
                runSample={overview.activeRuns}
                compact
              />
            ))}
          </div>
        )}
        {[...pipelines.values()].map((sample, index) => (
          <DataNote key={index} list={sample} noun="active pipelines" />
        ))}
      </Section>
      <Section
        title="Working now"
        detail="One row per active run; concurrent work remains visible"
      >
        <RunTable runs={overview.activeRuns.items} projectNames={names} />
        <DataNote list={overview.activeRuns} noun="active runs" />
      </Section>
      <Section
        title="Needs attention"
        detail={`${overview.attention.total} total`}
      >
        <AttentionList items={overview.attention.items} />
        <DataNote list={overview.attention} noun="attention items" />
        {approvals > 0 && (
          <p className="text-sm text-subtle">
            {approvals} approval items appear in this sample; the total
            attention count may include more.
          </p>
        )}
      </Section>
      <Section title="Projects" detail={`${overview.totals.projects} total`}>
        <div className="grid gap-4 xl:grid-cols-2">
          {overview.projects.map((project) => (
            <ProjectCard
              key={project.projectId}
              project={project}
              {...(pipelines.get(project.projectId)?.items[0]
                ? { pipeline: pipelines.get(project.projectId)!.items[0] }
                : {})}
            />
          ))}
        </div>
        {overview.projects.length === 0 && (
          <Empty>
            No projects recorded. Install a repository through the AI Office
            CLI.
          </Empty>
        )}
      </Section>
      <Section title="Recent activity">
        <ActivityList
          entries={overview.recentActivity.items}
          nextCursor={overview.recentActivity.nextCursor}
        />
      </Section>
    </div>
  );
}
export function WorkPage({
  data,
}: {
  data: Extract<DashboardData, { kind: "work" }>;
}) {
  const names = projectNames(data.overview.projects);
  const currentPipelines = [...data.pipelines.values()].flatMap(
    (sample) => sample.items,
  );
  return (
    <div className="page-stack">
      {heading("Work", "Active runs, pipelines and work needing attention")}
      {stats([
        { label: "Active runs", value: data.overview.totals.activeAgentRuns },
        { label: "Working agents", value: data.overview.totals.agentsWorking },
        {
          label: "Active pipelines",
          value: data.overview.totals.activePipelineRuns,
        },
        {
          label: "Needs attention",
          value: data.overview.totals.attentionItems,
        },
      ])}
      <Section
        title="Working now"
        detail={`${data.overview.activeRuns.total} active runs`}
      >
        <RunTable runs={data.overview.activeRuns.items} projectNames={names} />
        <DataNote list={data.overview.activeRuns} noun="active runs" />
      </Section>
      <Section title="Active pipelines">
        <div className="grid gap-4 xl:grid-cols-2">
          {currentPipelines.map((pipeline) => (
            <PipelinePanel
              key={pipeline.pipelineRunId}
              pipeline={pipeline}
              runSample={data.overview.activeRuns}
              compact
            />
          ))}
        </div>
        {currentPipelines.length === 0 && (
          <Empty>
            {data.overview.totals.activePipelineRuns === 0
              ? "No active pipelines."
              : "No active pipeline shown in the displayed samples."}
          </Empty>
        )}
        {[...data.pipelines.values()].map((sample, index) => (
          <DataNote key={index} list={sample} noun="active pipelines" />
        ))}
      </Section>
      <Section
        title="Needs attention"
        detail={`${data.overview.attention.total} total`}
      >
        <AttentionList items={data.overview.attention.items} />
        <DataNote list={data.overview.attention} noun="attention items" />
      </Section>
    </div>
  );
}
export function ProjectsPage({
  data,
}: {
  data: Extract<DashboardData, { kind: "projects" }>;
}) {
  return (
    <div className="page-stack">
      {heading(
        "Projects",
        `${data.overview.totals.projects} projects in the Runtime`,
      )}
      <div className="grid gap-4 xl:grid-cols-2">
        {data.overview.projects.map((project) => (
          <ProjectCard
            key={project.projectId}
            project={project}
            {...(data.pipelines.get(project.projectId)?.items[0]
              ? { pipeline: data.pipelines.get(project.projectId)!.items[0] }
              : {})}
          />
        ))}
      </div>
      {data.overview.projects.length === 0 && (
        <Empty>No projects recorded.</Empty>
      )}
    </div>
  );
}
export function PipelinesPage({
  data,
}: {
  data: Extract<DashboardData, { kind: "pipelines" }>;
}) {
  const samples = [...data.pipelines.entries()];
  const names = projectNames(data.overview.projects);
  return (
    <div className="page-stack">
      {heading(
        "Active pipelines",
        `${data.overview.totals.activePipelineRuns} active across all projects`,
      )}
      <DataNote list={data.overview.activeRuns} noun="active runs" />
      {samples.length ? (
        samples.map(([id, sample]) => (
          <Section
            key={id}
            title={names.get(id) ?? "Project"}
            detail={
              <Link to={`/projects/${encodeURIComponent(id)}/pipeline`}>
                Open project pipeline
              </Link>
            }
          >
            <div className="grid gap-4 xl:grid-cols-2">
              {sample.items.map((pipeline) => (
                <PipelinePanel
                  key={pipeline.pipelineRunId}
                  pipeline={pipeline}
                  runSample={data.overview.activeRuns}
                  compact
                />
              ))}
            </div>
            <DataNote list={sample} noun="active pipelines" />
          </Section>
        ))
      ) : (
        <Empty>
          {data.overview.totals.activePipelineRuns === 0
            ? "No active pipelines recorded."
            : "No active pipeline shown in the displayed samples."}
        </Empty>
      )}
    </div>
  );
}
export function AgentsPage({
  data,
}: {
  data: Extract<DashboardData, { kind: "agents" }>;
}) {
  const order: Record<AgentState["state"], number> = {
    working: 0,
    assigned: 1,
    awaiting_approval: 2,
    last_run_failed: 3,
    idle: 4,
    disabled: 5,
  };
  const sorted = [...data.agents].sort(
    (a, b) => order[a.state] - order[b.state] || a.name.localeCompare(b.name),
  );
  return (
    <div className="page-stack">
      {heading("Agents", "Who is working now, and who is only assigned")}
      {stats([
        { label: "Working agents", value: data.overview.totals.agentsWorking },
        { label: "Active runs", value: data.overview.totals.activeAgentRuns },
        { label: "Agents shown", value: data.agents.length },
      ])}
      <Section title="Working now">
        <AgentTable
          agents={sorted.filter((agent) => agent.state === "working")}
          projectNames={projectNames(data.overview.projects)}
        />
      </Section>
      <Section title="All agents">
        <AgentTable
          agents={sorted}
          projectNames={projectNames(data.overview.projects)}
        />
      </Section>
    </div>
  );
}

function ProjectHeader({
  header,
  section,
}: {
  header: {
    projectId: string;
    name: string;
    description: string | null;
    localPaths: readonly string[];
  };
  section?: string;
}) {
  const id = encodeURIComponent(header.projectId);
  const sections = [
    ["Overview", `/projects/${id}`],
    ["Pipeline", `/projects/${id}/pipeline`],
    ["Tasks", `/projects/${id}/tasks`],
    ["Milestones", `/projects/${id}/milestones`],
    ["Graph", `/projects/${id}/graph`],
    ["Requirements", `/projects/${id}/requirements`],
    ["Agents", `/projects/${id}/agents`],
  ] as const;
  return (
    <>
      <div>
        {heading(
          header.name,
          header.description ??
            (header.localPaths.join(" · ") || "Project operations"),
        )}
      </div>
      <nav
        aria-label="Project sections"
        className="flex gap-1 overflow-x-auto border-b border-border pb-2"
      >
        {sections.map(([label, path]) => (
          <Link
            key={path}
            aria-current={
              section === label.toLowerCase() ||
              (section === undefined && label === "Overview")
                ? "page"
                : undefined
            }
            className="whitespace-nowrap rounded-md px-3 py-2 text-sm hover:bg-muted aria-[current=page]:bg-muted aria-[current=page]:font-semibold"
            to={path}
          >
            {label}
          </Link>
        ))}
      </nav>
    </>
  );
}

function ProjectOverview({
  data,
}: {
  data: Extract<DashboardData, { kind: "project" }>;
}) {
  const { project, activePipelines, activeRuns } = data;
  const summary = project.summary;
  const working = project.agents.filter((agent) => agent.state === "working");
  const currentTasks = new Map(
    activeRuns.items
      .filter((run) => run.task !== null)
      .map((run) => [run.task!.taskId, run.task!] as const),
  );
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        {[
          ["Active pipelines", summary.activePipelineRuns],
          ["Working agents", summary.agentsWorking],
          ["Active runs", summary.activeAgentRuns],
          ["Needs attention", summary.attention.total],
          ["Pending reviews", summary.pendingReviews],
          ["Open tasks", summary.tasks.open],
        ].map(([label, value]) => (
          <Card key={label} className="py-4">
            <p className="text-xs text-subtle">{label}</p>
            <p className="text-2xl font-semibold tabular-nums">{value}</p>
          </Card>
        ))}
      </div>
      <Section
        title="Current work"
        detail={
          <Link
            to={`/projects/${encodeURIComponent(summary.projectId)}/pipeline`}
          >
            Pipeline details
          </Link>
        }
      >
        <div className="grid gap-4 xl:grid-cols-2">
          {activePipelines.items.map((pipeline) => (
            <PipelinePanel
              key={pipeline.pipelineRunId}
              pipeline={pipeline}
              runSample={activeRuns}
              compact
            />
          ))}
        </div>
        {activePipelines.total === 0 && <Empty>No active pipelines.</Empty>}
        <DataNote list={activePipelines} noun="active pipelines" />
      </Section>
      <Section title="Working agents">
        <AgentTable agents={working} />
      </Section>
      <Section title="Current tasks">
        {currentTasks.size > 0 ? (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
            {[...currentTasks.values()].map((task) => (
              <li key={task.taskId} className="p-4">
                <Link
                  to={`/projects/${encodeURIComponent(summary.projectId)}/tasks/${encodeURIComponent(task.taskId)}`}
                >
                  {task.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No task in the active-run sample.</Empty>
        )}
        <DataNote
          list={activeRuns}
          noun="active runs supplying current tasks"
        />
      </Section>
      <Section title="Needs attention">
        <AttentionList items={summary.attention.items} />
        <DataNote list={summary.attention} noun="attention items" />
      </Section>
      <Section title="Progress">
        <FactGrid
          facts={[
            {
              label: "Milestone",
              value:
                summary.currentMilestone?.title ??
                "No single current milestone",
            },
            {
              label: "Verified requirements",
              value: `${summary.requirements.verified} / ${summary.requirements.total}`,
            },
            {
              label: "Open tasks",
              value: `${summary.tasks.open} / ${summary.tasks.total}`,
            },
          ]}
        />
      </Section>
      <Section title="Recent activity">
        <ActivityList
          entries={project.recentActivity.items}
          nextCursor={project.recentActivity.nextCursor}
        />
      </Section>
    </>
  );
}

function ProjectPipeline({
  data,
}: {
  data: Extract<DashboardData, { kind: "project" }>;
}) {
  const { project, activePipelines, activeRuns } = data;
  return (
    <>
      <Section
        title="Current pipelines"
        detail={`${activePipelines.total} active`}
      >
        <div className="space-y-5">
          {activePipelines.items.map((pipeline) => (
            <PipelineDetail
              key={pipeline.pipelineRunId}
              pipeline={pipeline}
              runs={activeRuns}
              agents={project.agents}
            />
          ))}
        </div>
        {activePipelines.total === 0 && (
          <Empty>No active pipeline. Recent history appears below.</Empty>
        )}
        <DataNote list={activePipelines} noun="active pipelines" />
      </Section>
      <Section title="Recent pipeline history">
        <div className="grid gap-4 xl:grid-cols-2">
          {project.pipelines.items
            .filter((pipeline) => pipeline.status !== "active")
            .map((pipeline) => (
              <PipelinePanel
                key={pipeline.pipelineRunId}
                pipeline={pipeline}
                compact
              />
            ))}
        </div>
        <DataNote list={project.pipelines} noun="recent pipeline runs" />
      </Section>
    </>
  );
}
export function PipelineDetail({
  pipeline,
  runs,
  agents,
}: {
  pipeline: PipelineRunState;
  runs: BoundedList<AgentRunState>;
  agents: readonly AgentState[];
}) {
  const matching = activePipelineRuns(runs.items, pipeline.pipelineRunId);
  const current = pipeline.currentStage;
  const involved = agents.filter(
    (agent) =>
      pipeline.stages.some(
        (stage) => stage.assignedAgent?.agentId === agent.agentId,
      ) || matching.some((run) => run.agent?.agentId === agent.agentId),
  );
  return (
    <Card className="space-y-6">
      <div className="flex flex-wrap justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase text-subtle">
            Pipeline run · <Id value={pipeline.pipelineRunId} />
          </p>
          <h3 className="mt-1 text-xl font-semibold">
            {pipeline.pipelineName}
          </h3>
          <p className="text-sm text-subtle">{pipeline.pipelineDescription}</p>
        </div>
        <PipelineStateBadge status={pipeline.status} />
      </div>
      <FactGrid
        facts={[
          {
            label: "Task",
            value: pipeline.task ? (
              <Link
                to={`/projects/${encodeURIComponent(pipeline.projectId)}/tasks/${encodeURIComponent(pipeline.task.taskId)}`}
              >
                {pipeline.task.title}
              </Link>
            ) : (
              "No task linked"
            ),
          },
          { label: "Started", value: formatTimestamp(pipeline.createdAt) },
          {
            label: "Elapsed",
            value: elapsed(
              pipeline.createdAt,
              pipeline.completedAt ?? pipeline.cancelledAt,
            ),
          },
          {
            label: "Completed stages",
            value: `${pipeline.stageCounts.completed} / ${pipeline.stageCounts.total}`,
          },
        ]}
      />
      <Separator />
      <div className="rounded-xl border-2 border-blue-300 bg-blue-50 p-5 dark:border-blue-800 dark:bg-blue-950">
        <p className="text-xs font-bold uppercase tracking-widest text-blue-700 dark:text-blue-300">
          Current stage
        </p>
        <h4 className="mt-1 text-2xl font-semibold">
          {current?.name ?? "No current stage"}
        </h4>
        <FactGrid
          facts={[
            { label: "Recorded stage state", value: current?.status ?? "—" },
            {
              label: "Assigned agent",
              value: current?.assignedAgent?.name ?? "No agent assigned",
            },
            {
              label: "Working on pipeline",
              value: matching.length
                ? [
                    ...new Set(
                      matching.map(
                        (run) => run.agent?.name ?? "Agent unavailable",
                      ),
                    ),
                  ].join(", ")
                : activeRunAbsence(runs),
            },
            { label: "Active runs shown", value: matching.length },
          ]}
        />
        {current?.assignedAgent && matching.length === 0 && (
          <p className="mt-3 text-sm">
            Assignment recorded; execution is waiting or not visible in the run
            sample.
          </p>
        )}
      </div>
      <Section title="Stage timeline">
        <PipelineTimeline
          pipeline={pipeline}
          runs={matching}
          runSample={runs}
        />
      </Section>
      <Section
        title="Agents involved"
        detail="Project activity state comes from authoritative agent read models"
      >
        <AgentTable agents={involved} />
      </Section>
      <Section title="Active runs on this pipeline">
        <RunTable runs={matching} />
        <DataNote list={runs} noun="project active runs" />
        <p className="text-xs text-subtle">
          The read model links runs to a pipeline, but does not identify a run's
          stage. The current stage above is pipeline state, not a per-run stage
          claim.
        </p>
      </Section>
      {pipeline.attentionReasons.length > 0 && (
        <Section title="Needs attention">
          <AttentionList items={pipeline.attentionReasons} />
        </Section>
      )}
    </Card>
  );
}

function TaskFilters({ project }: { project: ProjectDetail }) {
  const page = project.taskPage;
  const navigate = useNavigate();
  const id = project.summary.projectId;
  const [values, setValues] = useState<TaskFilterValues>({
    search: "",
    status: "active",
    priority: "",
    agent: "",
    milestones: [],
    sort: "milestone",
  });
  const [error, setError] = useState<string | null>(null);
  const routeKey = JSON.stringify(page?.filters ?? {});
  useEffect(() => {
    if (!page) return;
    const f = page.filters;
    setValues({
      search: f.search ?? "",
      status: f.status ?? "active",
      priority: f.priority === undefined ? "" : String(f.priority),
      agent: f.unassigned ? "none" : f.agentId ? `agent:${f.agentId}` : "",
      milestones:
        f.milestoneIds ?? (f.milestoneId === undefined ? [] : [f.milestoneId]),
      sort: f.sort ?? "milestone",
    });
  }, [routeKey]);
  if (!page) return null;
  const options = page.options;
  const update = (
    key: Exclude<keyof TaskFilterValues, "milestone" | "milestones">,
    value: string,
  ) => setValues((current) => ({ ...current, [key]: value }));
  const select = (
    label: string,
    key: Exclude<keyof TaskFilterValues, "milestone" | "milestones">,
    choices: readonly [string, string][],
  ) => (
    <label className="flex min-w-[10rem] flex-col gap-1 text-xs font-medium text-subtle">
      {label}
      <Select
        value={values[key] ?? ""}
        onChange={(event) => update(key, event.target.value)}
      >
        {choices.map(([value, text]) => (
          <option key={value} value={value}>
            {text}
          </option>
        ))}
      </Select>
    </label>
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        try {
          const query = taskFilterQuery(values);
          navigate(
            `/projects/${encodeURIComponent(id)}/tasks?${taskPageParameters(query)}`,
          );
          setError(null);
        } catch (issue) {
          setError(issue instanceof Error ? issue.message : "Invalid filters");
        }
      }}
    >
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-[15rem] flex-1 flex-col gap-1 text-xs font-medium text-subtle">
          Search
          <Input
            type="search"
            placeholder="Title, description, or task ID"
            value={values.search}
            onChange={(event) => update("search", event.target.value)}
          />
        </label>
        {select("Operational status", "status", [
          ["active", "Active tasks"],
          ["all", "All statuses"],
          ...options.statuses.map(
            (s) => [s, taskOperationalFilterLabel(s)] as [string, string],
          ),
        ])}
        {select("Priority", "priority", [
          ["", "All priorities"],
          ...options.priorities.map(
            (n) => [String(n), String(n)] as [string, string],
          ),
        ])}
        {select("Current agent", "agent", [
          ["", "All agents"],
          ...(options.hasUnassigned
            ? [["none", "No current agent"] as [string, string]]
            : []),
          ...options.agents.map(
            (a) => [`agent:${a.agentId}`, a.name] as [string, string],
          ),
        ])}
        <details className="w-full text-sm">
          <summary className="flex h-10 w-fit max-w-full cursor-pointer items-center rounded-md border border-border bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {values.milestones?.length
              ? `${values.milestones.length} milestone${values.milestones.length === 1 ? "" : "s"} selected`
              : "All milestones"}
          </summary>
          <div
            role="group"
            aria-label="Select task milestones"
            className="mt-2 flex max-h-64 w-full flex-col gap-2 overflow-y-auto rounded-md border border-border bg-surface p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold">Milestones</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={!values.milestones?.length}
                onClick={() =>
                  setValues((current) => ({ ...current, milestones: [] }))
                }
              >
                Clear
              </Button>
            </div>
            <p className="text-xs text-subtle" aria-live="polite">
              {values.milestones?.length === queryLimits.maxTaskMilestoneFilters
                ? `Limit of ${queryLimits.maxTaskMilestoneFilters} reached. Deselect one to choose another.`
                : `Select up to ${queryLimits.maxTaskMilestoneFilters} milestone categories.`}
            </p>
            {[
              ...(options.hasUnassignedMilestone
                ? [{ id: "unassigned", title: "No milestone" }]
                : []),
              ...(options.milestones ?? []).map((m) => ({
                id: m.milestoneId,
                title: m.title,
              })),
            ].map(({ id, title }) => (
              <label key={id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={values.milestones?.includes(id) ?? false}
                  disabled={milestoneChoiceDisabled(
                    values.milestones ?? [],
                    id,
                  )}
                  onChange={() =>
                    setValues((current) => ({
                      ...current,
                      milestones: current.milestones?.includes(id)
                        ? current.milestones.filter((value) => value !== id)
                        : [...(current.milestones ?? []), id].sort(),
                    }))
                  }
                />
                <span className="truncate" title={title}>
                  {title}
                </span>
              </label>
            ))}
          </div>
        </details>
        {select("Sort", "sort", [
          ["milestone", "Milestone, short name"],
          ["short_name", "Short name"],
        ])}
        <Button type="submit">Apply</Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      )}
      <p className="text-xs text-subtle">
        Active tasks are shown by default. Choose filters, then Apply. All
        statuses includes completed tasks across all result pages. Milestones
        come from explicit task → requirement links.
      </p>
    </form>
  );
}
function ProjectTasks({ project }: { project: ProjectDetail }) {
  const page = project.taskPage;
  const id = encodeURIComponent(project.summary.projectId);
  const offset = page?.offset ?? 0;
  const query = `?${taskPageParameters({ ...page?.filters, ...(offset ? { offset } : {}) })}`;
  const pageHref = (next: number) =>
    `/projects/${id}/tasks?${taskPageParameters({ ...page?.filters, ...(next ? { offset: next } : {}) })}`;
  const completedCount = project.summary.tasks.byStatus.completed;
  return (
    <Section
      title="Tasks"
      detail={`${project.tasks.total} matching · ${project.summary.tasks.total} project tasks`}
    >
      <TaskFilters project={project} />
      {completedCount > 0 && page?.filters.status !== "completed" && (
        <p className="text-sm text-subtle">
          {completedCount.toLocaleString()} completed project{" "}
          {completedCount === 1 ? "task" : "tasks"}. Results are paginated;{" "}
          <Link
            className="font-medium text-foreground underline underline-offset-2"
            to={`/projects/${id}/tasks?status=completed`}
          >
            View all completed
          </Link>
          .
        </p>
      )}
      <TaskTable tasks={project.tasks.items} query={query} />
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-subtle">
        <span>
          {project.tasks.items.length ? offset + 1 : 0}–
          {offset + project.tasks.items.length} of {project.tasks.total}{" "}
          matching
        </span>
        <div className="flex gap-2">
          {offset > 0 && (
            <Button variant="outline" asChild>
              <Link to={pageHref(Math.max(0, offset - (page?.limit ?? 1)))}>
                Previous
              </Link>
            </Button>
          )}
          {offset + project.tasks.items.length < project.tasks.total && (
            <Button variant="outline" asChild>
              <Link to={pageHref(offset + (page?.limit ?? 1))}>Next</Link>
            </Button>
          )}
        </div>
      </div>
    </Section>
  );
}
function ProjectMilestones({ project }: { project: ProjectDetail }) {
  const [status, setStatus] = useState("current");
  const archivedCount = project.milestones.filter(
    (milestone) => milestone.status === "archived",
  ).length;
  const visible = project.milestones.filter(
    (m) =>
      status === "all" ||
      (status === "current" ? m.status !== "archived" : m.status === status),
  );
  return (
    <Section
      title="Milestones"
      detail={`${project.summary.activeMilestoneCount} active · ${archivedCount} archived · ${project.summary.milestoneCount} total`}
    >
      <label className="flex w-52 flex-col gap-1 text-xs text-subtle">
        Status
        <Select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
        >
          <option value="current">Current (hide archived)</option>
          <option value="all">All statuses</option>
          {[
            ...new Set([
              ...project.milestones.map((m) => m.status),
              "archived",
            ]),
          ].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </label>
      <p className="text-sm text-subtle">
        {visible.length} of {project.milestones.length} milestones
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        {visible.map((m) => (
          <Card key={m.milestoneId}>
            <div className="flex justify-between gap-2">
              <h3 className="font-semibold">{m.title}</h3>
              <StatusBadge
                label={m.status}
                tone={milestoneStatusTone(m.status)}
              />
            </div>
            <p className="mt-3 text-sm">
              {m.requirements.verified} / {m.requirements.total} requirements
              verified
            </p>
            <progress
              aria-label={`${m.title} verified requirements`}
              value={m.requirements.verified}
              max={Math.max(1, m.requirements.total)}
              className="mt-2 block h-2 w-full accent-emerald-600"
            />
            <p className="mt-3 text-xs text-subtle">
              Updated {formatTimestamp(m.updatedAt)}
            </p>
          </Card>
        ))}
      </div>
      {visible.length === 0 && <Empty>No milestones match this status.</Empty>}
      <p className="text-xs text-subtle">
        Task membership is shown only through explicit task → requirement →
        milestone links; direct task milestone membership is not modelled.
      </p>
    </Section>
  );
}
function ProjectRequirements({ project }: { project: ProjectDetail }) {
  const [status, setStatus] = useState("");
  const [milestone, setMilestone] = useState("");
  const filtered = project.requirements.filter(
    (r) =>
      (!status || r.status === status) &&
      (!milestone || r.milestoneId === milestone),
  );
  return (
    <Section
      title="Requirements"
      detail={`${project.summary.requirements.verified} verified of ${project.summary.requirements.total}`}
    >
      <div className="flex flex-wrap gap-3">
        <label className="flex w-48 flex-col gap-1 text-xs text-subtle">
          Status
          <Select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
          >
            <option value="">All statuses</option>
            {[...new Set(project.requirements.map((r) => r.status))].map(
              (s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ),
            )}
          </Select>
        </label>
        <label className="flex w-56 flex-col gap-1 text-xs text-subtle">
          Milestone
          <Select
            value={milestone}
            onChange={(event) => setMilestone(event.target.value)}
          >
            <option value="">All milestones</option>
            {project.milestones.map((m) => (
              <option key={m.milestoneId} value={m.milestoneId}>
                {m.title}
              </option>
            ))}
          </Select>
        </label>
      </div>
      <p className="text-sm text-subtle">
        {filtered.length} of {project.requirements.length} requirements
      </p>
      <div className="space-y-3">
        {filtered.map((r: RequirementSummary) => (
          <Card key={r.requirementId}>
            <div className="flex flex-wrap justify-between gap-2">
              <div>
                <span className="font-mono text-xs text-subtle">{r.key}</span>
                <h3 className="font-semibold">{r.title}</h3>
              </div>
              <StatusBadge
                label={r.status}
                tone={requirementStatusTone(r.status)}
              />
            </div>
            <p className="mt-2 max-w-prose whitespace-pre-wrap text-sm leading-relaxed">
              {r.description}
            </p>
            <p className="mt-3 text-xs text-subtle">
              {project.milestones.find((m) => m.milestoneId === r.milestoneId)
                ?.title ?? "No milestone"}{" "}
              · {r.taskReferences.length} linked tasks
            </p>
            {r.taskReferences.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                {r.taskReferences.map((t) => (
                  <Link
                    key={t.taskId}
                    to={`/projects/${encodeURIComponent(project.summary.projectId)}/tasks/${encodeURIComponent(t.taskId)}`}
                  >
                    {t.title}
                  </Link>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>
      {filtered.length === 0 && (
        <Empty>No requirements match these filters.</Empty>
      )}
    </Section>
  );
}
export function ProjectPage({
  data,
  section,
}: {
  data: Extract<DashboardData, { kind: "project" }>;
  section?: string;
}) {
  const project = data.project;
  return (
    <div className="page-stack">
      <ProjectHeader
        header={{
          projectId: project.summary.projectId,
          name: project.summary.name,
          description: project.summary.description,
          localPaths: project.summary.repository.localPaths,
        }}
        {...(section === undefined ? {} : { section })}
      />
      {section === "pipeline" ? (
        <ProjectPipeline data={data} />
      ) : section === "tasks" ? (
        <ProjectTasks project={project} />
      ) : section === "milestones" ? (
        <ProjectMilestones project={project} />
      ) : section === "requirements" ? (
        <ProjectRequirements project={project} />
      ) : section === "agents" ? (
        <Section
          title="Project agents"
          detail={`${project.agents.filter((agent) => agent.state === "working").length} working`}
        >
          <AgentTable agents={project.agents} />
        </Section>
      ) : (
        <ProjectOverview data={data} />
      )}
    </div>
  );
}

export function ProjectGraphPage({
  graph,
  project,
}: {
  graph: TaskGraph;
  project: ProjectSummary | null;
}) {
  const current = project?.projectId === graph.projectId ? project : null;
  return (
    <div className="page-stack">
      <ProjectHeader
        header={{
          projectId: graph.projectId,
          name: graph.projectName,
          description: current?.description ?? null,
          localPaths: current?.repository.localPaths ?? [],
        }}
        section="graph"
      />
      <TaskGraphView graph={graph} projectId={graph.projectId} />
    </div>
  );
}

export function TaskPage({
  data,
  taskQuery,
}: {
  data: Extract<DashboardData, { kind: "task" }>;
  taskQuery?: TaskPageQuery;
}) {
  const { task, pipeline, projectName, runs, activity } = data.detail;
  const active = task.activeAgentRuns;
  return (
    <div className="page-stack">
      <nav aria-label="Breadcrumb" className="text-sm text-subtle">
        <Link to="/">Overview</Link> /{" "}
        <Link to={`/projects/${encodeURIComponent(task.projectId)}`}>
          {projectName}
        </Link>{" "}
        /{" "}
        <Link
          to={`/projects/${encodeURIComponent(task.projectId)}/tasks${taskQuery ? `?${taskPageParameters(taskQuery)}` : ""}`}
        >
          Tasks
        </Link>{" "}
        / Detail
      </nav>
      {heading(task.title, `Task · ${task.taskId}`)}
      <div className="flex flex-wrap gap-2">
        <StatusBadge
          label={taskStatusLabel(task.operationalStatus)}
          tone={taskStatusTone(task.operationalStatus)}
        />
        <StatusBadge label={`Recorded: ${task.recordedStatus}`} />
        <StatusBadge label={`Priority ${task.priority}`} />
      </div>
      <Divergence task={task} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <div className="space-y-8">
          <Section title="Description">
            <Card>
              <p className="max-w-prose whitespace-pre-wrap break-words text-base leading-7">
                {task.description?.trim() || "No description recorded."}
              </p>
            </Card>
          </Section>
          <Section title="Current execution">
            <Card className="space-y-5">
              <FactGrid
                facts={[
                  {
                    label: "Pipeline",
                    value: task.activePipelineRun ? (
                      <Link
                        to={`/projects/${encodeURIComponent(task.projectId)}/pipeline`}
                      >
                        {task.activePipelineRun.pipelineName}
                      </Link>
                    ) : (
                      "No active pipeline"
                    ),
                  },
                  {
                    label: "Current stage",
                    value: task.activePipelineRun?.currentStageName ?? "—",
                  },
                  {
                    label: "Stage assignment",
                    value:
                      pipeline?.currentStage?.assignedAgent?.name ??
                      "No current stage agent",
                  },
                  { label: "Active runs", value: active.total },
                  {
                    label: "Representative run",
                    value: task.primaryAgentRun ? (
                      <Link
                        to={`/runs/${encodeURIComponent(task.primaryAgentRun.runId)}`}
                      >
                        <Id value={task.primaryAgentRun.runId} />
                      </Link>
                    ) : (
                      "—"
                    ),
                  },
                  {
                    label: "Runs without valid lease",
                    value: task.runsWithoutValidLeaseCount,
                  },
                ]}
              />
              <div>
                <h3 className="mb-2 font-semibold">
                  Working agents and execution authority
                </h3>
                {active.items.length ? (
                  <ul className="space-y-2">
                    {active.items.map((run) => (
                      <li
                        key={run.runId}
                        className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
                      >
                        <Link to={`/runs/${encodeURIComponent(run.runId)}`}>
                          <Id value={run.runId} />
                        </Link>
                        <strong>
                          {run.agent?.name ?? "Agent unavailable"}
                        </strong>
                        <RunStateBadge status={run.status} />
                        <StatusBadge
                          label={
                            run.hasValidLease
                              ? "Valid lease"
                              : run.ownsLeaseRecord
                                ? "Lease expired"
                                : "No valid lease"
                          }
                          tone={run.hasValidLease ? "good" : "attention"}
                        />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <Empty>
                    No active run. An assignment does not mean an agent is
                    working.
                  </Empty>
                )}
                <DataNote list={active} noun="active runs" />
              </div>
              <p className="text-sm text-subtle">
                {task.lease
                  ? `Lease record: ${task.lease.ownerRunId} · expires ${formatTimestamp(task.lease.expiresAt)}${task.lease.expired ? " · expired" : ""}`
                  : "No lease record."}{" "}
                The representative run does not hide concurrent runs.
              </p>
            </Card>
          </Section>
          {pipeline && (
            <Section title="Pipeline">
              <PipelinePanel pipeline={pipeline} runs={runs.items} />
              <DataNote list={runs} noun="task run history" />
            </Section>
          )}
          <Section title="Run history" detail={`${runs.total} total`}>
            <RunTable runs={runs.items} />
            <DataNote list={runs} noun="runs" />
          </Section>
          <Section title="Activity">
            <ActivityList
              entries={activity.items}
              nextCursor={activity.nextCursor}
            />
            {activity.items.length === 0 && (
              <p className="text-sm text-subtle">
                Task creation alone does not currently produce an audit event.
              </p>
            )}
          </Section>
        </div>
        <aside className="space-y-8">
          <Section title="Requirements">
            <Card>
              {task.requirements.availability === "available" ? (
                <>
                  <p className="font-semibold">
                    {task.requirements.value.verified} /{" "}
                    {task.requirements.value.total} verified
                  </p>
                  <div className="mt-3 space-y-3">
                    {(task.requirementReferences ?? []).map((r) => (
                      <div key={r.requirementId}>
                        <Link
                          to={`/projects/${encodeURIComponent(task.projectId)}/requirements`}
                        >
                          <span className="font-mono text-xs">{r.key}</span>{" "}
                          {r.title}
                        </Link>
                        <p className="mt-1 text-sm text-subtle">
                          {r.description}
                        </p>
                        <StatusBadge
                          label={r.status}
                          tone={requirementStatusTone(r.status)}
                        />
                      </div>
                    ))}
                  </div>
                  {task.requirements.value.total === 0 && (
                    <p className="mt-2 text-sm text-subtle">
                      No requirements linked.
                    </p>
                  )}
                </>
              ) : (
                <p>{task.requirements.explanation}</p>
              )}
            </Card>
          </Section>
          <Section title="Needs attention">
            <AttentionList items={task.attentionReasons} />
          </Section>
          <Section title="Dates and recorded state">
            <Card>
              <FactGrid
                facts={[
                  { label: "Recorded status", value: task.recordedStatus },
                  { label: "Created", value: formatTimestamp(task.createdAt) },
                  { label: "Updated", value: formatTimestamp(task.updatedAt) },
                  {
                    label: "Last activity",
                    value: formatTimestamp(task.lastActivityAt),
                  },
                  { label: "Pending reviews", value: task.pendingReviewCount },
                ]}
              />
            </Card>
          </Section>
        </aside>
      </div>
    </div>
  );
}

export function RunPage({
  data,
}: {
  data: Extract<DashboardData, { kind: "run" }>;
}) {
  const {
    run,
    pipeline,
    events,
    reviews,
    actions,
    activity,
    attentionReasons,
    workerOutput,
  } = data.detail;
  const authority = data.task?.task.activeAgentRuns.items.find(
    (item) => item.runId === run.runId,
  );
  return (
    <div className="page-stack">
      <nav aria-label="Breadcrumb" className="text-sm text-subtle">
        <Link to="/">Overview</Link> /{" "}
        <Link to={`/projects/${encodeURIComponent(run.projectId)}`}>
          Project
        </Link>{" "}
        / Run
      </nav>
      {heading(`Run ${run.runId}`, run.task?.title ?? "No task linked")}
      <div className="flex flex-wrap gap-2">
        <RunStateBadge status={run.status} />
        {authority && (
          <StatusBadge
            label={
              authority.hasValidLease
                ? "Valid execution lease"
                : authority.ownsLeaseRecord
                  ? "Lease expired"
                  : "No valid lease"
            }
            tone={authority.hasValidLease ? "good" : "attention"}
          />
        )}
      </div>
      <Section title="Execution">
        <Card>
          <FactGrid
            facts={[
              {
                label: "Project",
                value: (
                  <Link to={`/projects/${encodeURIComponent(run.projectId)}`}>
                    Open project
                  </Link>
                ),
              },
              {
                label: "Task",
                value: run.task ? (
                  <Link
                    to={`/projects/${encodeURIComponent(run.projectId)}/tasks/${encodeURIComponent(run.task.taskId)}`}
                  >
                    {run.task.title}
                  </Link>
                ) : (
                  "No task linked"
                ),
              },
              { label: "Agent", value: run.agent?.name ?? "Agent unavailable" },
              {
                label: "Pipeline",
                value: pipeline ? (
                  <Link
                    to={`/projects/${encodeURIComponent(run.projectId)}/pipeline`}
                  >
                    {pipeline.pipelineName}
                  </Link>
                ) : (
                  "No pipeline linked"
                ),
              },
              {
                label: "Pipeline current stage",
                value: pipeline?.currentStage?.name ?? "—",
              },
              {
                label: "Executor kind",
                value: run.execution?.kind ?? "Not recorded",
              },
              {
                label: "Adapter ID",
                value: run.execution?.adapterId ?? "Not recorded",
              },
              {
                label: "Adapter version",
                value: run.execution?.adapterVersion ?? "Not recorded",
              },
              {
                label: "Input SHA-256",
                value: run.execution?.inputHash ? (
                  <code className="break-all font-mono text-xs">
                    {run.execution.inputHash}
                  </code>
                ) : (
                  "Not recorded"
                ),
              },
              {
                label: "Model routing before execution",
                value:
                  run.model === null
                    ? "Not recorded (historical run)"
                    : run.model.status === "unrouted"
                      ? "Unrouted · executor default"
                      : "Resolved",
              },
              ...(run.model?.status === "resolved"
                ? [
                    {
                      label: "Selected model",
                      value: run.model.selection.modelRef,
                    },
                    {
                      label: "Selection source",
                      value: run.model.selection.source,
                    },
                    {
                      label: "Model policy",
                      value: run.model.selection.policy,
                    },
                    {
                      label: "Model profile",
                      value: run.model.selection.profile ?? "No profile",
                    },
                    {
                      label: "Selected reasoning effort",
                      value:
                        run.model.selection.reasoningEffort ?? "Not specified",
                    },
                    {
                      label: "Selected max output tokens",
                      value:
                        run.model.selection.maxOutputTokens ?? "Not specified",
                    },
                  ]
                : []),
              ...(run.worktreePath
                ? [{ label: "Worktree path", value: run.worktreePath }]
                : []),
              { label: "Created", value: formatTimestamp(run.createdAt) },
              { label: "Started", value: formatTimestamp(run.startedAt) },
              { label: "Ended", value: formatTimestamp(run.completedAt) },
              {
                label: "Duration",
                value: run.terminal
                  ? formatDuration(run.durationMs)
                  : elapsed(run.startedAt),
              },
              {
                label: "Authority",
                value: authority
                  ? authority.hasValidLease
                    ? "Valid task lease"
                    : authority.ownsLeaseRecord
                      ? "Expired lease record"
                      : "No valid lease"
                  : run.terminal
                    ? "Run is terminal"
                    : "Task authority not available in this view",
              },
            ]}
          />
          <p className="mt-4 text-xs text-subtle">
            Pipeline current stage is pipeline state; this read model does not
            identify a run-specific stage.
          </p>
        </Card>
      </Section>
      {attentionReasons.length > 0 && (
        <Section title="Needs attention">
          <AttentionList items={attentionReasons} />
        </Section>
      )}
      {run.failure && (
        <Section title="Failure">
          <Card>
            <strong>{run.failure.code ?? "Failure"}</strong>
            <p className="text-sm">
              {run.failure.message ?? "No message recorded"}
            </p>
          </Card>
        </Section>
      )}
      {pipeline && (
        <Section title="Pipeline">
          <PipelinePanel pipeline={pipeline} runs={[run]} />
        </Section>
      )}
      <div className="grid gap-6 xl:grid-cols-2">
        <Section title="Execution events" detail={`${events.total} total`}>
          <Card>
            <ActivityEvents events={events.items} />
          </Card>
          <DataNote list={events} noun="run events" />
        </Section>
        <Section title="Reviews and approvals">
          <ReviewList reviews={reviews} />
        </Section>
        <Section title="Controlled actions">
          <Card>
            {run.actionIntent ? (
              <>
                <p className="font-medium">
                  {run.actionIntent.operation} · {run.actionIntent.resourceId}
                </p>
                <p className="text-xs text-subtle">
                  Argument names:{" "}
                  {run.actionIntent.argumentKeys.join(", ") || "none"}. Values
                  are not exposed.
                </p>
              </>
            ) : (
              <p className="text-sm text-subtle">No action intent recorded.</p>
            )}
            {actions.length > 0 && (
              <ul className="mt-3 space-y-2">
                {actions.map((action) => (
                  <li key={action.requestId}>
                    <Id value={action.requestId} /> · {action.status}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </Section>
        <Section title="Run activity">
          <ActivityList
            entries={activity.items}
            nextCursor={activity.nextCursor}
          />
        </Section>
      </div>
      {workerOutput && (
        <Section title="Worker output">
          <Card className="space-y-5">
            <p className="text-sm text-subtle">
              Generated content does not establish file changes, test success or
              approval.
            </p>
            <h3 className="font-semibold">{workerOutput.summary}</h3>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-sm">
              {workerOutput.content}
            </pre>
            <div className="border-t border-border pt-4">
              <h3 className="mb-3 font-semibold">Worker report</h3>
              <FactGrid
                facts={[
                  {
                    label: "Reported model",
                    value: workerOutput.model ?? "Not reported",
                  },
                  {
                    label: "Session ID",
                    value: workerOutput.sessionId ?? "Not reported",
                  },
                  {
                    label: "Worker reported input tokens",
                    value: workerOutput.usage?.inputTokens ?? "Not reported",
                  },
                  {
                    label: "Worker reported output tokens",
                    value: workerOutput.usage?.outputTokens ?? "Not reported",
                  },
                  {
                    label: "CLI cost estimate (advisory)",
                    value:
                      workerOutput.estimatedCostUsd === null
                        ? "Not reported"
                        : `USD ${new Intl.NumberFormat("en-US", { maximumSignificantDigits: 8 }).format(workerOutput.estimatedCostUsd)}`,
                  },
                ]}
              />
            </div>
            {workerOutput.metering && (
              <div className="border-t border-border pt-4">
                <h3 className="mb-3 font-semibold">Gateway metering</h3>
                <FactGrid
                  facts={[
                    {
                      label: "Provider",
                      value: workerOutput.metering.providerId,
                    },
                    {
                      label: "Actual model",
                      value: workerOutput.metering.model,
                    },
                    {
                      label: "Provider request ID",
                      value:
                        workerOutput.metering.providerRequestId ??
                        "Not reported",
                    },
                    {
                      label: "Input tokens",
                      value: workerOutput.metering.usage.inputTokens,
                    },
                    {
                      label: "Cached input tokens",
                      value: workerOutput.metering.usage.cachedInputTokens,
                    },
                    {
                      label: "Output tokens",
                      value: workerOutput.metering.usage.outputTokens,
                    },
                    {
                      label: "Reasoning tokens",
                      value: workerOutput.metering.usage.reasoningTokens,
                    },
                    {
                      label: "Applied reasoning effort",
                      value:
                        workerOutput.metering.appliedParameters
                          .reasoningEffort ?? "Not applied",
                    },
                    {
                      label: "Max output tokens",
                      value:
                        workerOutput.metering.appliedParameters.maxOutputTokens,
                    },
                    {
                      label: "Pricing version",
                      value: workerOutput.metering.pricingVersionId,
                    },
                    {
                      label: "Budget scope",
                      value: workerOutput.metering.budgetScope,
                    },
                    {
                      label: "Budget limit",
                      value: `${workerOutput.metering.budgetLimitMicros} micros ${workerOutput.metering.currency}`,
                    },
                    {
                      label: "Reserved cost",
                      value: `${workerOutput.metering.reservedMicros} micros ${workerOutput.metering.currency}`,
                    },
                    {
                      label: "Estimated gateway cost",
                      value: `${workerOutput.metering.estimatedMicros} micros ${workerOutput.metering.currency}`,
                    },
                    {
                      label: "Actual gateway cost",
                      value: `${workerOutput.metering.actualMicros} micros ${workerOutput.metering.currency}`,
                    },
                    {
                      label: "Currency",
                      value: workerOutput.metering.currency,
                    },
                  ]}
                />
                <p className="mt-3 text-xs text-subtle">
                  Gateway metering is authoritative for gateway runs. The CLI
                  estimate above is advisory.
                </p>
              </div>
            )}
          </Card>
        </Section>
      )}
    </div>
  );
}
function ActivityEvents({
  events,
}: {
  events: readonly {
    status: string;
    occurredAt: string;
    hasResult: boolean;
    hasError: boolean;
  }[];
}) {
  return events.length ? (
    <ol className="border-l border-border pl-5">
      {events.map((event, index) => (
        <li key={`${event.occurredAt}:${index}`} className="relative pb-5">
          <span className="absolute -left-[1.54rem] top-1 h-2 w-2 rounded-full bg-primary" />
          <strong>{event.status}</strong>
          <p className="text-xs text-subtle">
            {formatTimestamp(event.occurredAt)} · result{" "}
            {event.hasResult ? "yes" : "no"} · error{" "}
            {event.hasError ? "yes" : "no"}
          </p>
        </li>
      ))}
    </ol>
  ) : (
    <Empty>No execution events recorded.</Empty>
  );
}

export function MemoryPage({
  data,
}: {
  data: Extract<DashboardData, { kind: "memory" }>;
}) {
  const { memory } = data;
  return (
    <div className="page-stack">
      {heading(
        "Memory",
        "Reusable roles, patterns and lessons from the Runtime",
      )}
      <Section title={`Roles · ${memory.roles.length}`}>
        <div className="grid gap-4 xl:grid-cols-2">
          {memory.roles.map((role) => (
            <Card key={role.id}>
              <div className="flex flex-wrap justify-between gap-2">
                <h3 className="font-semibold">{role.name}</h3>
                <StatusBadge
                  label={role.status}
                  tone={role.status === "active" ? "good" : "muted"}
                />
              </div>
              <p className="mt-2 max-w-prose text-sm leading-relaxed">
                {role.description}
              </p>
              <FactGrid
                facts={[
                  {
                    label: "Responsibilities",
                    value: role.responsibilities.join(", ") || "—",
                  },
                  {
                    label: "Capabilities",
                    value: role.capabilities.join(", ") || "—",
                  },
                  { label: "Tools", value: role.tools.join(", ") || "—" },
                  { label: "Model policy", value: role.modelPolicy },
                  {
                    label: "Limits",
                    value: `${role.limits.maxIterations} iterations · ${role.limits.timeoutSeconds}s`,
                  },
                ]}
              />
            </Card>
          ))}
        </div>
        {memory.roles.length === 0 && <Empty>No roles recorded.</Empty>}
      </Section>
      <Section title={`Patterns · ${memory.patterns.length}`}>
        <div className="grid gap-4 xl:grid-cols-2">
          {memory.patterns.map((pattern) => (
            <Card key={pattern.id}>
              <h3 className="font-semibold">{pattern.name}</h3>
              <FactGrid
                facts={[
                  { label: "Problem", value: pattern.problem },
                  { label: "Context", value: pattern.context },
                  { label: "Solution", value: pattern.solution },
                  {
                    label: "Applicability",
                    value: pattern.applicability.join(", ") || "—",
                  },
                  {
                    label: "Constraints",
                    value: pattern.constraints.join(", ") || "—",
                  },
                  { label: "Risks", value: pattern.risks.join(", ") || "—" },
                ]}
              />
            </Card>
          ))}
        </div>
        {memory.patterns.length === 0 && <Empty>No patterns recorded.</Empty>}
      </Section>
      <Section title={`Lessons · ${memory.lessons.length}`}>
        <div className="grid gap-4 xl:grid-cols-2">
          {memory.lessons.map((lesson) => (
            <Card key={lesson.id}>
              <h3 className="font-semibold">{lesson.title}</h3>
              <p className="mt-2 max-w-prose whitespace-pre-wrap text-sm leading-relaxed">
                {lesson.content}
              </p>
              <p className="mt-3 text-xs text-subtle">
                Confidence {lesson.confidence} · source project{" "}
                {lesson.sourceProjectId ?? "not recorded"} · task{" "}
                {lesson.sourceTaskId ?? "not recorded"}
              </p>
            </Card>
          ))}
        </div>
        {memory.lessons.length === 0 && <Empty>No lessons recorded.</Empty>}
      </Section>
    </div>
  );
}

export function RuntimePage({
  data,
}: {
  data: Extract<DashboardData, { kind: "runtime" }>;
}) {
  const { status } = data;
  const knowledgeTone =
    status.knowledge.startup === "connected"
      ? "good"
      : status.knowledge.startup === "disabled"
        ? "muted"
        : "attention";
  const redisTone =
    status.queue.redis === "reachable"
      ? "good"
      : status.queue.redis === "unreachable"
        ? "attention"
        : "muted";
  return (
    <div className="page-stack">
      {heading("Runtime", "Daemon identity and subsystem state · read-only")}
      <Section
        title="Daemon"
        detail="The local Runtime host answering these queries"
      >
        <Card>
          <FactGrid
            facts={[
              {
                label: "Status",
                value: <StatusBadge label={status.status} tone="good" />,
              },
              { label: "Protocol version", value: status.protocolVersion },
              { label: "Started", value: formatTimestamp(status.startedAt) },
              {
                label: "Uptime",
                value: formatDuration(status.uptimeSeconds * 1000),
              },
            ]}
          />
        </Card>
      </Section>
      <Section
        title="Knowledge store"
        detail="Connection result observed at startup, not a live probe"
      >
        <Card>
          <FactGrid
            facts={[
              { label: "Provider", value: status.knowledge.provider },
              {
                label: "Startup",
                value: (
                  <StatusBadge
                    label={status.knowledge.startup}
                    tone={knowledgeTone}
                  />
                ),
              },
            ]}
          />
          {status.knowledge.startup === "disabled" && (
            <p className="mt-3 text-sm text-subtle">
              Agent knowledge is disabled on this Runtime.
            </p>
          )}
        </Card>
      </Section>
      <Section title="Queue" detail="Durable job queue and workers">
        <Card>
          <FactGrid
            facts={[
              { label: "Provider", value: status.queue.provider },
              {
                label: "Redis",
                value: (
                  <StatusBadge label={status.queue.redis} tone={redisTone} />
                ),
              },
              { label: "Outbox pending", value: status.queue.outboxPending },
              {
                label: "Orchestration worker",
                value: status.queue.orchestrationWorker ? "yes" : "no",
              },
              {
                label: "Agent run worker",
                value: status.queue.agentRunWorker ? "yes" : "no",
              },
            ]}
          />
        </Card>
      </Section>
      <Section title="Storage" detail="Authoritative project state">
        <Card>
          <FactGrid
            facts={[
              {
                label: "Project store",
                value: (
                  <StatusBadge
                    label={status.storage.project}
                    tone={
                      status.storage.project === "available"
                        ? "good"
                        : "attention"
                    }
                  />
                ),
              },
            ]}
          />
        </Card>
      </Section>
      <Section title="Distribution" detail="How the running code was obtained">
        <Card>
          <FactGrid
            facts={[
              { label: "Product version", value: status.productVersion },
              {
                label: "Source revision",
                value:
                  status.sourceRevision === null ? (
                    "Unknown"
                  ) : (
                    <code
                      className="font-mono text-xs"
                      title={status.sourceRevision}
                    >
                      {status.sourceRevision.slice(0, 12)}
                    </code>
                  ),
              },
            ]}
          />
        </Card>
      </Section>
    </div>
  );
}
