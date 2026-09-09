import { describe, expect, test } from "vitest";
import type {
  AgentRunDetail,
  DashboardOverview,
  PipelineRunState,
  ProjectDetail,
  ProjectSummary,
  TaskOperationalState,
  TaskDetail,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  escapeHtml,
  renderMessage,
  renderOverview,
  renderProject,
  renderRun,
  renderTask,
} from "../../apps/dashboard/src/ui/render.ts";
import {
  formatDuration,
  formatTimestamp,
  overviewViewModel,
  parseRoute,
  projectViewModel,
  routeHref,
  runViewModel,
  stageChips,
  taskStatusLabel,
  taskStatusTone,
  taskViewModel,
} from "../../apps/dashboard/src/ui/view-model.ts";
import {
  renderAgentWorkload,
  renderTaskDistribution,
} from "../../apps/dashboard/src/ui/charts.ts";
import { taskFilterQuery } from "../../apps/dashboard/src/ui/task-filters.ts";
import {
  parseTaskPageQuery,
  QueryValidationError,
} from "@ai-office/application/protocol/query-protocol.ts";
import {
  decideAccess,
  readSessionCookie,
  sessionCookieValue,
} from "../../apps/dashboard/src/dashboard-session.ts";

const now = "2026-09-03T12:00:00.000Z";

function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    projectId: "project-1",
    name: "AutoEpoque",
    description: null,
    repository: {
      repositoryId: "repo-1",
      localPaths: ["/tmp/autoepoque"],
      remoteUrl: null,
      defaultBranch: "main",
    },
    currentMilestone: {
      milestoneId: "milestone-1",
      title: "M8",
      status: "active",
      requirements: {
        total: 4,
        open: 1,
        terminal: 3,
        verified: 3,
        rejected: 0,
        byStatus: {
          proposed: 1,
          accepted: 0,
          implemented: 0,
          verified: 3,
          rejected: 0,
        },
      },
      createdAt: now,
      updatedAt: now,
    },
    milestoneCount: 1,
    activeMilestoneCount: 1,
    tasks: {
      total: 49,
      open: 12,
      terminal: 37,
      byStatus: {
        pending: 12,
        assigned: 0,
        running: 0,
        blocked: 0,
        waiting_review: 0,
        completed: 37,
        failed: 0,
        cancelled: 0,
      },
    },
    requirements: {
      total: 4,
      open: 1,
      terminal: 3,
      verified: 3,
      rejected: 0,
      byStatus: {
        proposed: 1,
        accepted: 0,
        implemented: 0,
        verified: 3,
        rejected: 0,
      },
    },
    activeAgentRuns: 2,
    activePipelineRuns: 1,
    pendingReviews: 1,
    agentsWorking: 2,
    attentionRequired: true,
    attention: {
      total: 1,
      items: [
        {
          kind: "review_pending",
          projectId: "project-1",
          subjectType: "review",
          subjectId: "review-1",
          summary: "Review of task task-1 is pending",
          since: now,
        },
      ],
      truncated: false,
    },
    lastActivityAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function overview(
  overrides: Partial<DashboardOverview> = {},
): DashboardOverview {
  return {
    generatedAt: now,
    projects: [summary()],
    totals: {
      projects: 1,
      openTasks: 12,
      activeAgentRuns: 2,
      activePipelineRuns: 1,
      pendingReviews: 1,
      agentsWorking: 2,
      attentionItems: 1,
    },
    attention: summary().attention,
    activeRuns: { total: 0, items: [], truncated: false },
    recentActivity: { items: [], nextCursor: null },
    ...overrides,
  };
}

const pipeline: PipelineRunState = {
  pipelineRunId: "pipeline-1",
  projectId: "project-1",
  task: { taskId: "task-1", title: "Ship the thing" },
  pipelineId: "delivery",
  pipelineName: "Delivery",
  pipelineDescription: "Design, build, review",
  manifestRevision: 1,
  status: "active",
  currentStage: null,
  stages: [
    {
      stageRunId: "s1",
      stageId: "design",
      name: "Architect",
      objective: "Design",
      roleId: "role-architect",
      index: 0,
      status: "completed",
      requiresApproval: false,
      assignedAgent: null,
      assignedAt: null,
      completedAt: now,
      approvalDecision: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      stageRunId: "s2",
      stageId: "build",
      name: "Developer",
      objective: "Build",
      roleId: "role-dev",
      index: 1,
      status: "active",
      requiresApproval: true,
      assignedAgent: {
        agentId: "agent-1",
        name: "Dev One",
        roleId: "role-dev",
        roleKey: "developer",
      },
      assignedAt: now,
      completedAt: null,
      approvalDecision: null,
      approvedBy: null,
      approvedAt: null,
    },
    {
      stageRunId: "s3",
      stageId: "review",
      name: "Reviewer",
      objective: "Review",
      roleId: "role-reviewer",
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
  ],
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

const task: TaskOperationalState = {
  taskId: "task-1",
  projectId: "project-1",
  title: "Ship the thing",
  description: null,
  priority: 3,
  recordedStatus: "pending",
  operationalStatus: "in_progress",
  divergesFromRecordedStatus: true,
  divergenceReasons: ["agent_run_active_without_task_transition"],
  requirements: {
    availability: "available",
    value: { total: 2, verified: 1, rejected: 0, open: 1, terminal: 1 },
  },
  milestone: {
    availability: "unavailable",
    reason: "task_milestone_link_not_modelled",
    explanation: "not modelled",
  },
  activeAgentRuns: {
    total: 1,
    truncated: false,
    items: [
      {
        runId: "run-1",
        status: "running",
        agentId: "agent-1",
        startedAt: now,
        updatedAt: now,
        createdAt: now,
        pipelineRunId: "pipeline-1",
        agent: null,
        ownsLeaseRecord: true,
        hasValidLease: true,
      },
    ],
  },
  primaryAgentRun: {
    runId: "run-1",
    status: "running",
    agentId: "agent-1",
    startedAt: now,
    updatedAt: now,
    createdAt: now,
    pipelineRunId: "pipeline-1",
    agent: null,
    ownsLeaseRecord: true,
    hasValidLease: true,
  },
  lease: {
    ownerRunId: "run-1",
    acquiredAt: now,
    expiresAt: now,
    expired: false,
    ownerRunStatus: "running",
  },
  runsWithoutValidLeaseCount: 0,
  activePipelineRun: {
    pipelineRunId: "pipeline-1",
    pipelineId: "delivery",
    pipelineName: "Delivery",
    status: "active",
    currentStageId: "build",
    currentStageName: "Developer",
    currentStageStatus: "active",
    stageIndex: 1,
    stageCount: 3,
  },
  assignedAgent: {
    agentId: "agent-1",
    name: "Dev One",
    roleId: "role-dev",
    roleKey: "developer",
  },
  pendingReviewCount: 0,
  blockedReason: null,
  attentionReasons: [],
  createdAt: now,
  updatedAt: now,
  lastActivityAt: now,
};

function projectDetail(overrides: Partial<ProjectDetail> = {}): ProjectDetail {
  return {
    generatedAt: now,
    summary: summary(),
    milestones: [],
    tasks: { total: 1, items: [task], truncated: false },
    pipelines: { total: 1, items: [pipeline], truncated: false },
    agents: [
      {
        agentId: "agent-1",
        projectId: "project-1",
        name: "Dev One",
        roleId: "role-dev",
        roleKey: "developer",
        roleName: "Developer",
        enabled: true,
        state: "working",
        activeRuns: {
          total: 1,
          truncated: false,
          items: [
            {
              runId: "run-1",
              status: "running",
              agentId: "agent-1",
              startedAt: now,
              updatedAt: now,
              task: { taskId: "task-1", title: "Ship the thing" },
            },
          ],
        },
        activeStages: {
          total: 1,
          truncated: false,
          items: [
            {
              pipelineRunId: "pipeline-1",
              stageId: "build",
              name: "Developer",
              status: "active",
            },
          ],
        },
        primaryRun: {
          runId: "run-1",
          status: "running",
          agentId: "agent-1",
          startedAt: now,
          updatedAt: now,
          task: { taskId: "task-1", title: "Ship the thing" },
        },
        primaryStage: {
          pipelineRunId: "pipeline-1",
          stageId: "build",
          name: "Developer",
          status: "active",
        },
        lastActivityAt: now,
      },
    ],
    runs: { total: 0, items: [], truncated: false },
    reviews: { total: 0, items: [], truncated: false },
    recentActivity: { items: [], nextCursor: null },
    ...overrides,
  };
}

describe("routing", () => {
  test("filter routes preserve search, zero priority, agent and page through task navigation", () => {
    const taskQuery = {
      search: "Café & 100%_",
      priority: 0,
      status: "in_progress" as const,
      agentId: "agent:one",
      offset: 100,
    };
    const route = {
      kind: "task" as const,
      projectId: "project-1",
      taskId: "task-1",
      taskQuery,
    };
    expect(parseRoute(routeHref(route))).toEqual(route);
    expect(
      taskFilterQuery({
        search: "  evidence  ",
        priority: "-7",
        status: "",
        agent: "none",
      }),
    ).toEqual({ search: "evidence", priority: -7, unassigned: true });
    expect(parseRoute("#/projects/p?priority=invalid").kind).toBe("invalid");
    for (const query of [
      "status=unknown",
      "priority=1.5",
      "priority=9007199254740992",
      "offset=-1",
      "agent=bad%20id",
      "agent=a&unassigned=true",
    ])
      expect(() => parseTaskPageQuery(new URLSearchParams(query))).toThrow(
        QueryValidationError,
      );
  });
  test("task routes round-trip both scoped identifiers and reject malformed encoding", () => {
    const route = {
      kind: "task" as const,
      projectId: "project:one",
      taskId: "task:one",
    };
    expect(parseRoute(routeHref(route))).toEqual(route);
    expect(parseRoute("#/projects/p/tasks/%broken")).toEqual({
      kind: "overview",
    });
  });
  test("parses the routes the dashboard links to", () => {
    expect(parseRoute("")).toEqual({ kind: "overview" });
    expect(parseRoute("#/")).toEqual({ kind: "overview" });
    expect(parseRoute("#/projects/project-1")).toEqual({
      kind: "project",
      projectId: "project-1",
    });
    expect(parseRoute("#/runs/run-1")).toEqual({ kind: "run", runId: "run-1" });
    expect(parseRoute("#/nonsense/x/y/z")).toEqual({ kind: "overview" });
  });

  test("round-trips identifiers that need encoding", () => {
    const href = routeHref({ kind: "project", projectId: "a b/c" });
    expect(href).toBe("#/projects/a%20b%2Fc");
    expect(parseRoute(href)).toEqual({ kind: "project", projectId: "a b/c" });
  });
});

describe("formatting and labels", () => {
  test("timestamps and durations degrade to a dash rather than lying", () => {
    expect(formatTimestamp(now)).toBe("2026-09-03 12:00:00Z");
    expect(formatTimestamp(null)).toBe("—");
    expect(formatTimestamp("not a date")).toBe("—");
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(185_000)).toBe("3m 5s");
    expect(formatDuration(7_500_000)).toBe("2h 5m");
  });

  test("operational statuses map to labels and tones", () => {
    expect(taskStatusLabel("awaiting_review")).toBe("awaiting review");
    expect(taskStatusTone("in_progress")).toBe("active");
    expect(taskStatusTone("blocked")).toBe("attention");
    expect(taskStatusTone("completed")).toBe("good");
  });

  test("stage chips follow the persisted stage sequence, not fixed roles", () => {
    expect(stageChips(pipeline)).toEqual([
      {
        name: "Architect",
        glyph: "✓",
        status: "completed",
        tone: "good",
        agentName: null,
      },
      {
        name: "Developer",
        glyph: "●",
        status: "active",
        tone: "active",
        agentName: "Dev One",
      },
      {
        name: "Reviewer",
        glyph: "○",
        status: "pending",
        tone: "neutral",
        agentName: null,
      },
    ]);
  });
});

describe("view models", () => {
  test("an empty office reports an empty state, not zeroes pretending to be data", () => {
    const view = overviewViewModel(
      overview({
        projects: [],
        totals: {
          projects: 0,
          openTasks: 0,
          activeAgentRuns: 0,
          activePipelineRuns: 0,
          pendingReviews: 0,
          agentsWorking: 0,
          attentionItems: 0,
        },
        attention: { total: 0, items: [], truncated: false },
      }),
    );
    expect(view.empty?.headline).toBe("No projects yet");
    const html = renderOverview(view);
    expect(html).toContain("No projects yet");
    expect(html).toContain("ai-office install");
  });

  test("a project with no pipeline work omits the section and its navigation", () => {
    const view = projectViewModel(
      projectDetail({
        tasks: { total: 0, items: [], truncated: false },
        pipelines: { total: 0, items: [], truncated: false },
        runs: { total: 0, items: [], truncated: false },
      }),
    );
    const html = renderProject(view);
    expect(html).not.toContain('id="jump-pipelines"');
    expect(html).not.toContain('id="project-pipelines"');
  });

  test("tasks are ordered by urgency then priority", () => {
    const view = projectViewModel(
      projectDetail({
        tasks: {
          total: 3,
          truncated: false,
          items: [
            { ...task, taskId: "t-done", operationalStatus: "completed" },
            { ...task, taskId: "t-blocked", operationalStatus: "blocked" },
            { ...task, taskId: "t-active", operationalStatus: "in_progress" },
          ],
        },
      }),
    );
    expect(view.tasks.items.map((value) => value.taskId)).toEqual([
      "t-blocked",
      "t-active",
      "t-done",
    ]);
  });

  test("divergent tasks show the mismatch once in their task row", () => {
    const view = projectViewModel(projectDetail());
    const html = renderProject(view);
    expect(html).not.toContain("Stored status differs from operational status");
    expect(html.match(/class="task-title"/g)).toHaveLength(1);
    expect(html).toContain("stored: pending");
    expect(html).toContain("in progress");
    expect(html).toContain("<th>Requirements</th>");
    expect(html).toContain("1/2 verified");
  });

  test("active and historical pipelines remain visible", () => {
    const view = projectViewModel(
      projectDetail({
        pipelines: {
          total: 2,
          truncated: false,
          items: [
            pipeline,
            { ...pipeline, pipelineRunId: "p2", status: "completed" },
          ],
        },
      }),
    );
    const html = renderProject(view);
    expect(html.match(/class="pipeline-title"/g)).toHaveLength(2);
    expect(html).toContain("completed");
  });
});

describe("rendering", () => {
  test("filters use runtime facets and counts, with no invented priority scale", () => {
    const detail = projectDetail({
      taskPage: {
        filters: { priority: -7, agentId: "agent-1" },
        offset: 7,
        limit: 7,
        options: {
          statuses: ["in_progress"],
          priorities: [42, -7],
          agents: [task.assignedAgent!],
          hasUnassigned: true,
        },
      },
      tasks: { total: 15, items: [task], truncated: true },
    });
    const html = renderProject(projectViewModel(detail));
    expect(html).toContain('value="-7" selected');
    expect(html).toContain('value="42"');
    expect(html).not.toContain('value="high"');
    expect(html).toContain("8–8 of 15 matching");
    expect(html).toContain("offset=14");
    expect(html).toContain("tasks/task-1?priority=-7&agent=agent-1&offset=7");
    expect(html).toContain("No current agent");
  });

  test("task detail exposes assignments, bounded concurrency and escaped description", () => {
    const detail: TaskDetail = {
      generatedAt: now,
      projectName: "AutoEpoque",
      task: {
        ...task,
        description: 'First line\n<script>alert("x")</script>',
        activeAgentRuns: {
          ...task.activeAgentRuns,
          total: 30,
          truncated: true,
        },
      },
      pipeline: { ...pipeline, currentStage: pipeline.stages[1]! },
      runs: { total: 0, items: [], truncated: false },
      activity: { items: [], nextCursor: null },
    };
    const html = renderTask(taskViewModel(detail));
    expect(html).toContain("Assigned agent");
    expect(html).toContain("Dev One");
    expect(html).toContain("showing 1 of 30 active runs");
    expect(html).toContain("1/2 verified");
    expect(html).toContain(
      "A run is active, but the task record has not advanced.",
    );
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain("#/runs/run-1");
    const unassigned = renderTask(
      taskViewModel({
        ...detail,
        pipeline: {
          ...pipeline,
          currentStage: { ...pipeline.stages[1]!, assignedAgent: null },
        },
      }),
    );
    expect(unassigned).toContain("Not assigned");
    const noPipeline = renderTask(taskViewModel({ ...detail, pipeline: null }));
    expect(noPipeline).toContain("No active pipeline stage");
    expect(noPipeline).not.toContain("<dt>Assigned agent</dt>");
    expect(noPipeline).toContain("Task activity");
    expect(noPipeline).toContain(
      "No audit events recorded for this task or its runs.",
    );
    expect(noPipeline).toContain(
      "Task creation alone does not currently produce an audit event.",
    );
    expect(noPipeline).toContain(
      "Execution events are available from each run in Run history.",
    );
  });

  test("charts render exact aggregates, distinguish statuses and handle empty work", () => {
    const html = renderProject(projectViewModel(projectDetail()));
    expect(html).toContain("49 tasks · recorded status");
    expect(html).toContain('class="chart-value">37</span>');
    expect(html).toContain("Operational status in the table may differ");
    expect(html).toContain("#/projects/project-1/tasks/task-1");
    const agent = projectDetail().agents[0]!;
    const chart = renderAgentWorkload([
      {
        ...agent,
        name: "<agent>",
        activeRuns: { ...agent.activeRuns, total: 40, truncated: true },
        activeStages: { total: 12, items: [], truncated: true },
      },
    ]);
    expect(chart).toContain('class="chart-value">40</span>');
    expect(chart).toContain('class="chart-value">12</span>');
    expect(chart).toContain("&lt;agent&gt;");
    expect(chart).not.toContain('style="');
    expect(renderTaskDistribution({ ...summary().tasks, total: 0 })).toContain(
      "Create a task",
    );
    expect(renderAgentWorkload([])).toContain("Synchronize agents");
  });
  test("renders the overview with attention and project facts", () => {
    const html = renderOverview(overviewViewModel(overview()));
    expect(html).toContain("AutoEpoque");
    expect(html).toContain("needs attention");
    expect(html).toContain("Review of task task-1 is pending");
    expect(html).toContain("12 open / 37 completed");
    expect(html).toContain("#/projects/project-1");
  });

  test("renders a project pipeline as a stage track", () => {
    const html = renderProject(projectViewModel(projectDetail()));
    expect(html).toContain("Architect");
    expect(html).toContain("Developer");
    expect(html).toContain("Reviewer");
    expect(html).toContain("✓");
    expect(html).toContain("●");
    expect(html).toContain("○");
  });

  test("renders agent state from the projection", () => {
    const html = renderProject(projectViewModel(projectDetail()));
    expect(html).toContain("Dev One");
    expect(html).toContain("active run");
  });

  test("shows a pending approval as attention on the project page", () => {
    const awaiting = {
      ...pipeline,
      attentionReasons: [
        {
          kind: "pipeline_stage_awaiting_approval" as const,
          projectId: "project-1",
          subjectType: "pipeline_run" as const,
          subjectId: "pipeline-1",
          summary: "Stage Developer is awaiting approval",
          since: now,
        },
      ],
    };
    const detail = projectDetail({
      pipelines: { total: 1, items: [awaiting], truncated: false },
    });
    const html = renderProject(
      projectViewModel({
        ...detail,
        summary: {
          ...detail.summary,
          attention: {
            total: 1,
            items: awaiting.attentionReasons,
            truncated: false,
          },
        },
      }),
    );
    expect(html).toContain("Approval waiting");
    expect(html).toContain("Stage Developer is awaiting approval");
  });

  test("renders a failed run without exposing raw payloads", () => {
    const detail: AgentRunDetail = {
      run: {
        runId: "run-1",
        projectId: "project-1",
        task: { taskId: "task-1", title: "Ship the thing" },
        agent: {
          agentId: "agent-1",
          name: "Dev One",
          roleId: "role-dev",
          roleKey: "developer",
        },
        status: "failed",
        terminal: true,
        pipelineRunId: null,
        actionIntent: {
          resourceId: "resource-1",
          operation: "write",
          argumentKeys: ["path"],
        },
        hasResult: false,
        hasError: true,
        failure: { code: "EXECUTION_FAILED", message: "boom" },
        worktreePath: null,
        createdAt: now,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        durationMs: 1000,
      },
      events: {
        total: 1,
        truncated: false,
        items: [
          {
            status: "running",
            hasResult: false,
            hasError: false,
            occurredAt: now,
          },
        ],
      },
      actions: [{ requestId: "action-1", status: "approval_pending" }],
      pipeline: null,
      reviews: [],
      activity: { items: [], nextCursor: null },
      attentionReasons: [
        {
          kind: "agent_run_failed",
          projectId: "project-1",
          subjectType: "agent_run",
          subjectId: "run-1",
          summary: "Agent run failed (EXECUTION_FAILED)",
          since: now,
        },
      ],
    };
    const html = renderRun(runViewModel(detail));
    expect(html).toContain("EXECUTION_FAILED");
    expect(html).toContain("Run failed");
    expect(html).toContain("action-1");
    expect(html).toContain("values are not exposed");
    expect(html).toContain("1s");
  });

  test("renders a message page for load failures", () => {
    expect(renderMessage("Nope", "because")).toContain("Nope");
  });
});

describe("html escaping", () => {
  test("escapes every dangerous character", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;",
    );
  });

  test("hostile read-model content cannot inject markup", () => {
    const html = renderProject(
      projectViewModel(
        projectDetail({
          summary: summary({ name: `</h2><script>alert(1)</script>` }),
          tasks: {
            total: 1,
            truncated: false,
            items: [{ ...task, title: `<script>alert("task")</script>` }],
          },
        }),
      ),
    );
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("dashboard session access", () => {
  const policy = {
    token: "0123456789abcdef",
    allowedHosts: new Set(["127.0.0.1:4278", "localhost:4278"]),
  };
  const request = {
    method: "GET",
    pathname: "/",
    hostHeader: "127.0.0.1:4278",
    cookieHeader: null,
    queryToken: null,
  };

  test("a matching cookie is allowed", () => {
    expect(
      decideAccess(
        {
          ...request,
          cookieHeader: `ai_office_dashboard=${policy.token}; other=1`,
        },
        policy,
      ),
    ).toEqual({ kind: "allow" });
  });

  test("a matching query token is adopted once", () => {
    expect(
      decideAccess({ ...request, queryToken: policy.token }, policy),
    ).toEqual({ kind: "adopt_token" });
  });

  test("no token is refused", () => {
    const decision = decideAccess(request, policy);
    expect(decision.kind).toBe("deny");
    expect(decision).toMatchObject({ status: 403 });
  });

  test("a wrong or truncated token is refused", () => {
    expect(
      decideAccess({ ...request, queryToken: "0123456789abcdee" }, policy).kind,
    ).toBe("deny");
    expect(decideAccess({ ...request, queryToken: "0123" }, policy).kind).toBe(
      "deny",
    );
  });

  test("an unexpected Host is refused before the token is considered", () => {
    const decision = decideAccess(
      {
        ...request,
        hostHeader: "attacker.example.com",
        queryToken: policy.token,
      },
      policy,
    );
    expect(decision).toMatchObject({ status: 400 });
  });

  test("a missing Host is refused", () => {
    expect(
      decideAccess(
        { ...request, hostHeader: null, queryToken: policy.token },
        policy,
      ).kind,
    ).toBe("deny");
  });

  test("non-GET methods are refused", () => {
    const decision = decideAccess(
      {
        ...request,
        method: "POST",
        cookieHeader: `ai_office_dashboard=${policy.token}`,
      },
      policy,
    );
    expect(decision).toMatchObject({ status: 405 });
  });

  test("the session cookie is host-only, HttpOnly, and same-site", () => {
    const value = sessionCookieValue("abc");
    expect(value).toContain("HttpOnly");
    expect(value).toContain("SameSite=Strict");
    expect(value).not.toContain("Domain=");
    expect(readSessionCookie(value.split(";")[0]!)).toBe("abc");
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie("unrelated=1")).toBeNull();
  });
});
