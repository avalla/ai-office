import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, test } from "vitest";
import type {
  AgentRunState,
  DashboardOverview,
  PipelineRunState,
  ProjectDetail,
  ProjectSummary,
  TaskDetail,
  TaskOperationalState,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  DataNote,
  PipelinePanel,
  TaskTable,
} from "../../apps/dashboard/src/components/operations.tsx";
import {
  OverviewPage,
  PipelineDetail,
  PipelinesPage,
  ProjectPage,
  RunPage,
  TaskPage,
  WorkPage,
} from "../../apps/dashboard/src/features/pages.tsx";
import {
  parseRoute,
  routeHref,
} from "../../apps/dashboard/src/ui/view-model.ts";
import {
  milestoneChoiceDisabled,
  taskFilterQuery,
} from "../../apps/dashboard/src/lib/task-filters.ts";
import {
  parseTaskPageQuery,
  taskPageParameters,
} from "@ai-office/application/protocol/query-protocol.ts";
import { SidebarLinks } from "../../apps/dashboard/src/app/app.tsx";

const now = "2026-09-03T12:00:00.000Z";
const agent = {
  agentId: "agent-1",
  name: "Review Agent",
  roleId: "role-1",
  roleKey: "review",
};
const other = {
  agentId: "agent-2",
  name: "Worker Agent",
  roleId: "role-2",
  roleKey: "worker",
};
const stages: PipelineRunState["stages"] = [
  {
    stageRunId: "stage-1",
    stageId: "intake",
    name: "Intake",
    objective: "Gather facts",
    roleId: "role-1",
    index: 0,
    status: "completed",
    requiresApproval: false,
    assignedAgent: agent,
    assignedAt: now,
    completedAt: now,
    approvalDecision: null,
    approvedBy: null,
    approvedAt: null,
  },
  {
    stageRunId: "stage-2",
    stageId: "review",
    name: "Review",
    objective: "Check work",
    roleId: "role-1",
    index: 1,
    status: "active",
    requiresApproval: true,
    assignedAgent: agent,
    assignedAt: now,
    completedAt: null,
    approvalDecision: null,
    approvedBy: null,
    approvedAt: null,
  },
  {
    stageRunId: "stage-3",
    stageId: "release",
    name: "Release",
    objective: "Deliver",
    roleId: "role-2",
    index: 2,
    status: "pending",
    requiresApproval: false,
    assignedAgent: null,
    assignedAt: null,
    completedAt: null,
    approvalDecision: null,
    approvedBy: null,
    approvedAt: null,
  },
];
const pipeline: PipelineRunState = {
  pipelineRunId: "pipeline-1",
  projectId: "project-1",
  task: { taskId: "task-1", title: "Prepare advice" },
  pipelineId: "pack-generic",
  pipelineName: "Generic workflow",
  pipelineDescription: "A configurable workflow",
  manifestRevision: 1,
  status: "active",
  currentStage: stages[1]!,
  stages,
  stageCounts: {
    total: 3,
    completed: 1,
    active: 1,
    awaitingApproval: 0,
    pending: 1,
    cancelled: 0,
  },
  startedBy: "operator",
  createdAt: now,
  updatedAt: now,
  completedAt: null,
  cancelledAt: null,
  attentionReasons: [],
};
const run = (id: string, assigned = other): AgentRunState => ({
  runId: id,
  projectId: "project-1",
  task: { taskId: "task-1", title: "Prepare advice" },
  agent: assigned,
  status: "running",
  terminal: false,
  pipelineRunId: "pipeline-1",
  execution: {
    kind: "worker",
    adapterId: "claude-code",
    adapterVersion: "1",
    inputHash: "0".repeat(64),
  },
  model: null,
  actionIntent: null,
  hasResult: false,
  hasError: false,
  failure: null,
  worktreePath: null,
  createdAt: now,
  startedAt: now,
  completedAt: null,
  updatedAt: now,
  durationMs: null,
});
const summary: ProjectSummary = {
  projectId: "project-1",
  name: "AI Office",
  description: null,
  repository: {
    repositoryId: null,
    localPaths: [],
    remoteUrl: null,
    defaultBranch: null,
  },
  currentMilestone: null,
  milestoneCount: 0,
  activeMilestoneCount: 0,
  tasks: {
    total: 1,
    open: 1,
    terminal: 0,
    byStatus: {
      pending: 1,
      assigned: 0,
      running: 0,
      blocked: 0,
      waiting_review: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
  },
  requirements: {
    total: 0,
    open: 0,
    terminal: 0,
    verified: 0,
    rejected: 0,
    byStatus: {
      proposed: 0,
      accepted: 0,
      implemented: 0,
      verified: 0,
      rejected: 0,
    },
  },
  activeAgentRuns: 2,
  activePipelineRuns: 1,
  pendingReviews: 0,
  agentsWorking: 1,
  attentionRequired: false,
  attention: { total: 0, items: [], truncated: false },
  lastActivityAt: now,
  createdAt: now,
  updatedAt: now,
};
const task: TaskOperationalState = {
  taskId: "task-1",
  projectId: "project-1",
  title: "Prepare advice",
  description: "A clear and readable description.",
  priority: 0,
  recordedStatus: "pending",
  terminal: false,
  operationalStatus: "in_progress",
  divergesFromRecordedStatus: true,
  divergenceReasons: ["agent_run_active_without_task_transition"],
  requirements: {
    availability: "available",
    value: { total: 0, open: 0, terminal: 0, verified: 0, rejected: 0 },
  },
  requirementReferences: [],
  milestone: {
    availability: "unavailable",
    reason: "task_milestone_link_not_modelled",
    explanation: "Direct task milestone relation is unavailable",
  },
  activeAgentRuns: {
    total: 2,
    items: [
      {
        runId: "run-1",
        status: "running",
        agentId: "agent-2",
        agent: other,
        pipelineRunId: "pipeline-1",
        startedAt: now,
        updatedAt: now,
        createdAt: now,
        ownsLeaseRecord: false,
        hasValidLease: false,
      },
      {
        runId: "run-2",
        status: "running",
        agentId: "agent-2",
        agent: other,
        pipelineRunId: "pipeline-1",
        startedAt: now,
        updatedAt: now,
        createdAt: now,
        ownsLeaseRecord: true,
        hasValidLease: true,
      },
    ],
    truncated: false,
  },
  primaryAgentRun: {
    runId: "run-1",
    status: "running",
    agentId: "agent-2",
    agent: other,
    pipelineRunId: "pipeline-1",
    startedAt: now,
    updatedAt: now,
    createdAt: now,
    ownsLeaseRecord: false,
    hasValidLease: false,
  },
  lease: {
    ownerRunId: "run-2",
    acquiredAt: now,
    expiresAt: "2026-09-03T13:00:00.000Z",
    expired: false,
    ownerRunStatus: "running",
  },
  runsWithoutValidLeaseCount: 1,
  activePipelineRun: {
    pipelineRunId: "pipeline-1",
    pipelineId: "pack-generic",
    pipelineName: "Generic workflow",
    status: "active",
    currentStageId: "review",
    currentStageName: "Review",
    currentStageStatus: "active",
    stageIndex: 1,
    stageCount: 3,
  },
  assignedAgent: agent,
  pendingReviewCount: 0,
  blockedReason: null,
  attentionReasons: [],
  createdAt: now,
  updatedAt: now,
  lastActivityAt: now,
};
const detail: TaskDetail = {
  generatedAt: now,
  projectName: "AI Office",
  task,
  pipeline,
  runs: { total: 2, items: [run("run-1"), run("run-2")], truncated: false },
  activity: { items: [], nextCursor: null },
};
const project: ProjectDetail = {
  generatedAt: now,
  summary,
  milestones: [],
  requirements: [],
  agents: [],
  tasks: { total: 1, items: [task], truncated: false },
  pipelines: { total: 1, items: [pipeline], truncated: false },
  runs: { total: 2, items: [run("run-1"), run("run-2")], truncated: false },
  reviews: { total: 0, items: [], truncated: false },
  recentActivity: { items: [], nextCursor: null },
};
const overview: DashboardOverview = {
  generatedAt: now,
  projects: [summary],
  totals: {
    projects: 1,
    openTasks: 1,
    activeAgentRuns: 2,
    activePipelineRuns: 1,
    pendingReviews: 0,
    agentsWorking: 1,
    attentionItems: 0,
  },
  attention: { total: 0, items: [], truncated: false },
  activeRuns: {
    total: 2,
    items: [run("run-1"), run("run-2")],
    truncated: false,
  },
  recentActivity: { items: [], nextCursor: null },
};
const html = (component: unknown, props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        component as React.ComponentType<Record<string, unknown>>,
        props,
      ),
    ),
  );

describe("React dashboard routes", () => {
  test.each([
    "#/",
    "#/projects",
    "#/work",
    "#/projects/project-1",
    "#/projects/project-1/pipeline",
    "#/projects/project-1/tasks",
    "#/projects/project-1/tasks/task-1",
    "#/projects/project-1/milestones",
    "#/projects/project-1/graph",
    "#/projects/project-1/requirements",
    "#/projects/project-1/agents",
    "#/pipelines",
    "#/agents",
    "#/runs/run-1",
    "#/memory",
  ])("round trips %s", (hash) =>
    expect(routeHref(parseRoute(hash))).toBe(hash),
  );
  test("shows Graph in persistent project navigation", () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SidebarLinks, {
          currentProject: summary,
          path: "/projects/project-1/graph",
        }),
      ),
    );
    expect(html).toContain('href="/projects/project-1/graph"');
    expect(html).toContain('aria-current="page"');
    expect(html).toMatch(
      /href="\/projects\/project-1\/graph"[^>]*>.*?Graph<\/a>/,
    );
  });
  test("rejects malformed task filters", () =>
    expect(parseRoute("#/projects/project-1/tasks?priority=abc").kind).toBe(
      "invalid",
    ));
  test("task filters survive list, detail, and refreshed route parsing", () => {
    const list = parseRoute(
      "#/projects/project-1/tasks?search=advice&status=active&priority=0&agent=agent-1&milestone=milestone-1&sort=short_name&offset=20",
    );
    expect(list.kind).toBe("project");
    if (list.kind !== "project" || list.taskQuery === undefined) return;
    const detailRoute = {
      kind: "task" as const,
      projectId: "project-1",
      taskId: "task-1",
      taskQuery: list.taskQuery,
    };
    expect(parseRoute(routeHref(list))).toEqual(list);
    expect(parseRoute(routeHref(detailRoute))).toEqual(detailRoute);
    const page = html(TaskPage, {
      data: { kind: "task", detail },
      taskQuery: list.taskQuery,
    });
    expect(page).toContain("search=advice");
    expect(page).toContain("agent=agent-1");
    expect(page).toContain("offset=20");
  });
});
describe("operational presentation", () => {
  test("shows assigned and working agents separately, including concurrent runs", () => {
    const markup = html(PipelineDetail, {
      pipeline,
      runs: { total: 2, items: [run("run-1"), run("run-2")], truncated: false },
      agents: [],
    });
    expect(markup).toContain("Current stage");
    expect(markup).toContain("Intake");
    expect(markup).toContain("Release");
    expect(markup).toContain("Review Agent");
    expect(markup).toContain("Worker Agent");
    expect(markup).toContain("run-1");
    expect(markup).toContain("run-2");
    expect(markup).toContain("does not identify a run&#x27;s stage");
  });
  test("assignment alone never appears as a working run", () => {
    const markup = html(PipelineDetail, {
      pipeline,
      runs: { total: 0, items: [], truncated: false },
      agents: [],
    });
    expect(markup).toContain("Review Agent");
    expect(markup).toContain("No matching active run in complete sample");
    expect(markup).not.toContain("Worker Agent");
  });
  test("pipeline detail excludes a terminal run even when it appears in the supplied list", () => {
    const historical: AgentRunState = {
      ...run("run-completed"),
      status: "completed",
      terminal: true,
      completedAt: now,
      durationMs: 1_000,
    };
    const markup = html(PipelineDetail, {
      pipeline,
      runs: { total: 1, items: [historical], truncated: false },
      agents: [],
    });
    expect(markup).toContain("No matching active run in complete sample");
    expect(markup).not.toContain("Worker Agent");
  });
  test("only a non-terminal pipeline run is shown as active execution", () => {
    const markup = html(PipelinePanel, {
      pipeline,
      runs: [run("run-running")],
    });
    expect(markup).toContain("Working on pipeline");
    expect(markup).toContain("Worker Agent");
    expect(markup).toContain("Pipeline active runs:");
    expect(markup).toContain("run-running");
  });
  test.each(["completed", "failed", "cancelled"] as const)(
    "%s run remains historical in a pipeline panel and Run Detail",
    (status) => {
      const historical: AgentRunState = {
        ...run(`run-${status}`),
        status,
        terminal: true,
        completedAt: now,
        durationMs: 1_000,
      };
      const panel = html(PipelinePanel, { pipeline, runs: [historical] });
      expect(panel).toContain("No active run shown in this view");
      expect(panel).toContain(
        "Pipeline active runs: No active run shown in this view",
      );
      expect(panel).not.toContain("Worker Agent");

      const page = html(RunPage, {
        data: {
          kind: "run",
          detail: {
            run: historical,
            pipeline,
            events: { total: 0, items: [], truncated: false },
            reviews: [],
            actions: [],
            activity: { items: [], nextCursor: null },
            attentionReasons: [],
          },
          task: null,
        },
      });
      expect(page).toContain("No active run shown in this view");
      expect(page).toContain(
        "Pipeline active runs: No active run shown in this view",
      );
    },
  );
  test("global pipelines use matching active runs from the overview sample", () => {
    const elsewhere: AgentRunState = {
      ...run("run-elsewhere", {
        agentId: "agent-3",
        name: "Elsewhere Agent",
        roleId: "role-3",
        roleKey: "elsewhere",
      }),
      pipelineRunId: "pipeline-elsewhere",
    };
    const page = html(PipelinesPage, {
      data: {
        kind: "pipelines",
        overview: {
          ...overview,
          activeRuns: {
            total: 2,
            items: [run("run-matching"), elsewhere],
            truncated: false,
          },
        },
        pipelines: new Map([
          ["project-1", { total: 1, items: [pipeline], truncated: false }],
        ]),
      },
    });
    expect(page).toContain("Worker Agent");
    expect(page).not.toContain("Elsewhere Agent");
  });
  test("global pipeline sample absence is explicit when truncated", () => {
    const elsewhere = {
      ...run("run-elsewhere"),
      pipelineRunId: "pipeline-elsewhere",
    };
    const page = html(PipelinesPage, {
      data: {
        kind: "pipelines",
        overview: {
          ...overview,
          activeRuns: { total: 3, items: [elsewhere], truncated: true },
        },
        pipelines: new Map([
          ["project-1", { total: 1, items: [pipeline], truncated: false }],
        ]),
      },
    });
    expect(page).toContain("No matching active run in truncated sample");
    expect(page).toContain("Showing 1 of 3 active runs");
    expect(page).not.toContain("No matching active run in complete sample");
  });
  test("a complete active-run sample can establish exact pipeline absence", () => {
    const page = html(PipelinePanel, {
      pipeline,
      runSample: {
        total: 1,
        items: [{ ...run("run-elsewhere"), pipelineRunId: "other" }],
        truncated: false,
      },
    });
    expect(page).toContain("No matching active run in complete sample");
  });
  test("shows approval and review as separate recorded attention", () => {
    const awaitingStage = {
      ...stages[1]!,
      status: "awaiting_approval" as const,
    };
    const awaitingPipeline: PipelineRunState = {
      ...pipeline,
      currentStage: awaitingStage,
      stages: [stages[0]!, awaitingStage, stages[2]!],
      stageCounts: { ...pipeline.stageCounts, active: 0, awaitingApproval: 1 },
      attentionReasons: [
        {
          kind: "pipeline_stage_awaiting_approval",
          projectId: "project-1",
          subjectType: "pipeline_run",
          subjectId: "pipeline-1",
          summary: "Approval is required before the next stage",
          since: now,
        },
      ],
    };
    const pipelineMarkup = html(PipelineDetail, {
      pipeline: awaitingPipeline,
      runs: { total: 0, items: [], truncated: false },
      agents: [],
    });
    expect(pipelineMarkup).toContain("Approval: waiting");
    expect(pipelineMarkup).toContain(
      "Approval is required before the next stage",
    );
    expect(pipelineMarkup).toContain(
      "No matching active run in complete sample",
    );

    const runMarkup = html(RunPage, {
      data: {
        kind: "run",
        detail: {
          run: run("run-1"),
          events: { total: 0, items: [], truncated: false },
          actions: [],
          pipeline,
          reviews: [
            {
              reviewId: "review-1",
              projectId: "project-1",
              subjectType: "agent_run",
              subjectId: "run-1",
              reviewer: {
                type: "user",
                id: "operator",
                displayName: "Operator",
              },
              status: "pending",
              summary: "Human review requested",
              createdAt: now,
              completedAt: null,
              decision: null,
            },
          ],
          activity: { items: [], nextCursor: null },
          attentionReasons: [],
        },
        task: detail,
      },
    });
    expect(runMarkup).toContain("Human review requested");
    expect(runMarkup).toContain("pending");
  });
  test("shows recorded divergence, representative run, both active runs and valid lease", () => {
    const markup = html(TaskPage, { data: { kind: "task", detail } });
    expect(markup).toContain("Recorded: pending");
    expect(markup).toContain("in progress");
    expect(markup).toContain("run-1");
    expect(markup).toContain("run-2");
    expect(markup).toContain("No valid lease");
    expect(markup).toContain("Valid lease");
    expect(markup).toContain("Working agents and execution authority");
  });
  test("uses authoritative totals and discloses samples", () => {
    const markup = html(DataNote, {
      list: { total: 8, items: [1, 2], truncated: true },
      noun: "runs",
    });
    expect(markup).toContain("Showing 2 of 8 runs");
    const home = html(OverviewPage, {
      data: {
        kind: "overview",
        overview: {
          ...overview,
          totals: { ...overview.totals, activeAgentRuns: 8 },
          activeRuns: { total: 8, items: [run("run-1")], truncated: true },
        },
        pipelines: new Map([
          ["project-1", { total: 1, items: [pipeline], truncated: false }],
        ]),
      },
    });
    expect(home).toContain("8</dd>");
    expect(home).toContain("Showing 1 of 8 active runs");
  });
  test("empty bounded samples do not erase authoritative active work", () => {
    const sampledOverview: DashboardOverview = {
      ...overview,
      activeRuns: { total: 2, items: [], truncated: true },
    };
    const samples = new Map([
      ["project-1", { total: 1, items: [], truncated: true }],
    ]);
    const home = html(OverviewPage, {
      data: { kind: "overview", overview: sampledOverview, pipelines: samples },
    });
    expect(home).toContain("No active run shown in the displayed sample.");
    expect(home).not.toContain("No active runs recorded.");

    const work = html(WorkPage, {
      data: { kind: "work", overview: sampledOverview, pipelines: samples },
    });
    expect(work).toContain(
      "No active pipeline shown in the displayed samples.",
    );
    const globalPipelines = html(PipelinesPage, {
      data: {
        kind: "pipelines",
        overview: sampledOverview,
        pipelines: new Map(),
      },
    });
    expect(globalPipelines).toContain(
      "No active pipeline shown in the displayed samples.",
    );

    const unsampledTask: TaskOperationalState = {
      ...task,
      activeAgentRuns: { total: 2, items: [], truncated: true },
    };
    const row = html(TaskTable, { tasks: [unsampledTask] });
    expect(row).toContain("No active run shown in sample");
    expect(row).toContain("2 active runs; 0 shown");
    expect(row).not.toContain("No active run</td>");
  });
  test("renders generic stage and role names without development vocabulary", () => {
    const markup = html(PipelinePanel, { pipeline });
    expect(markup).toContain("Generic workflow");
    expect(markup).toContain("Intake");
    expect(markup).toContain("Release");
    expect(markup).not.toContain("architect");
  });
  test("renders project sections and task table", () => {
    const page = {
      kind: "project",
      project,
      activePipelines: { total: 1, items: [pipeline], truncated: false },
      activeRuns: {
        total: 2,
        items: [run("run-1"), run("run-2")],
        truncated: false,
      },
    };
    expect(html(ProjectPage, { data: page, section: "pipeline" })).toContain(
      "Stage timeline",
    );
    expect(html(ProjectPage, { data: page, section: "milestones" })).toContain(
      'value="archived"',
    );
    expect(html(TaskTable, { tasks: [task] })).toContain("No linked milestone");
  });
  test("labels the task status filter as operational without changing its value", () => {
    const markup = html(ProjectPage, {
      data: {
        kind: "project",
        project: {
          ...project,
          taskPage: {
            filters: { status: "failed" },
            offset: 0,
            limit: 20,
            options: {
              statuses: ["failed", "completed"],
              priorities: [],
              agents: [],
              hasUnassigned: false,
            },
          },
        },
        activePipelines: { total: 0, items: [], truncated: false },
        activeRuns: { total: 0, items: [], truncated: false },
      },
      section: "tasks",
    });
    expect(markup).toMatch(/Operational status.*?<select/s);
    expect(markup).toContain(
      '<option value="failed">Failed (operational)</option>',
    );
    expect(markup).toContain('<option value="completed">completed</option>');
  });
  test("hides archived milestones in the default project view", () => {
    const page = {
      kind: "project",
      project: {
        ...project,
        milestones: [
          {
            milestoneId: "current",
            title: "Current phase",
            status: "active",
            requirements: summary.requirements,
            createdAt: now,
            updatedAt: now,
          },
          {
            milestoneId: "old",
            title: "Old phase",
            status: "archived",
            requirements: summary.requirements,
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      activePipelines: { total: 0, items: [], truncated: false },
      activeRuns: { total: 0, items: [], truncated: false },
    };
    const markup = html(ProjectPage, { data: page, section: "milestones" });
    expect(markup).toContain("Current phase");
    expect(markup).not.toContain("Old phase");
    expect(markup).toContain("Current (hide archived)");
    expect(markup).toContain("All statuses");
    expect(markup).toContain('value="archived"');
    expect(markup).toContain("1 archived");
  });
  test("renders run failure and controlled action facts safely", () => {
    const report = {
      kind: "run",
      detail: {
        run: {
          ...run("run-1"),
          failure: { code: "WORKER_FAILED", message: "<script>bad</script>" },
          status: "failed",
          terminal: true,
        },
        events: { total: 0, items: [], truncated: false },
        actions: [],
        pipeline,
        reviews: [],
        activity: { items: [], nextCursor: null },
        attentionReasons: [],
      },
      task: detail,
    };
    const markup = html(RunPage, { data: report });
    expect(markup).toContain("WORKER_FAILED");
    expect(markup).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(markup).not.toContain("<script>bad</script>");
  });
});
describe("task filters", () => {
  test("keeps all existing filters and resets offset", () =>
    expect(
      taskFilterQuery({
        search: "task",
        status: "active",
        priority: "0",
        agent: "agent:agent-1",
        milestone: "milestone-1",
        sort: "short_name",
      }),
    ).toEqual({
      search: "task",
      status: "active",
      priority: 0,
      agentId: "agent-1",
      milestoneId: "milestone-1",
      sort: "short_name",
    }));
  test("unassigned is exclusive with an agent", () =>
    expect(
      taskFilterQuery({
        search: "",
        status: "all",
        priority: "",
        agent: "none",
      }),
    ).toMatchObject({ status: "all", unassigned: true }));
  test("round-trips multiple milestone categories and rejects oversized filters", () => {
    const query = taskFilterQuery({
      search: "",
      status: "all",
      priority: "",
      agent: "",
      milestones: ["milestone-1", "unassigned", "milestone-2"],
    });
    expect(query).toEqual({
      status: "all",
      milestoneIds: ["milestone-1", "unassigned", "milestone-2"],
    });
    expect(parseTaskPageQuery(taskPageParameters(query))).toEqual(query);
    const tooMany = new URLSearchParams();
    for (let i = 0; i < 51; i++) tooMany.append("milestone", `m-${i}`);
    expect(() => parseTaskPageQuery(tooMany)).toThrow(
      "Too many milestone filters",
    );
    const duplicates = new URLSearchParams();
    for (let i = 0; i < 51; i++) duplicates.append("milestone", "m-1");
    expect(() => parseTaskPageQuery(duplicates)).toThrow(
      "Too many milestone filters",
    );
    const selected = Array.from({ length: 50 }, (_, index) => `m-${index}`);
    expect(milestoneChoiceDisabled(selected, "m-49")).toBe(false);
    expect(milestoneChoiceDisabled(selected, "m-50")).toBe(true);
    expect(milestoneChoiceDisabled(selected.slice(1), "m-50")).toBe(false);
  });
  test("shows the completed shortcut when all results are paginated", () => {
    const tasksPage: ProjectDetail = {
      ...project,
      summary: {
        ...summary,
        tasks: {
          ...summary.tasks,
          total: 101,
          terminal: 1,
          byStatus: { ...summary.tasks.byStatus, completed: 1 },
        },
      },
      tasks: { total: 101, items: [task], truncated: true },
      taskPage: {
        filters: {
          status: "all",
          milestoneIds: ["milestone-1", "milestone-2"],
        },
        offset: 0,
        limit: 100,
        options: {
          statuses: ["in_progress", "completed"],
          priorities: [0],
          agents: [],
          milestones: [],
          hasUnassigned: true,
          hasUnassignedMilestone: true,
        },
      },
    };
    const markup = html(ProjectPage, {
      data: {
        kind: "project",
        project: tasksPage,
        activePipelines: { total: 0, items: [], truncated: false },
        activeRuns: { total: 0, items: [], truncated: false },
      },
      section: "tasks",
    });
    expect(markup).toContain("1 completed project task");
    expect(markup).toContain("View all completed");
    expect(markup).toContain("?status=completed");
    expect(markup).toContain("1–1 of 101 matching");
    expect(markup).toContain(
      "milestone=milestone-1&amp;milestone=milestone-2&amp;offset=100",
    );
  });
});
