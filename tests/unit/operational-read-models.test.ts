import { describe, expect, test } from "vitest";
import type { PipelineRunProps } from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { TaskProps } from "@ai-office/domain/task/task.ts";
import type {
  OperationalAgentRecord,
  OperationalAgentRunRecord,
  OperationalMilestoneRecord,
  OperationalProjectRecord,
  OperationalReviewRecord,
} from "@ai-office/application/ports/operational-read.port.ts";
import {
  projectActivityEntry,
  sanitizeActivityDetail,
} from "@ai-office/application/read-models/activity-sanitization.ts";
import type { AgentReference } from "@ai-office/application/read-models/operational-read-models.ts";
import type {
  AgentActiveStageRecord,
  TaskLeaseRecord,
} from "@ai-office/application/ports/operational-read.port.ts";
import type { AgentRunStatus } from "@ai-office/domain/agent/agent-run.ts";
import {
  agentRunAttentionReasons,
  isActiveAgentRunStatus,
  projectAgentRunState,
  projectAgentState,
  projectPipelineRunState,
  projectProjectSummary,
  projectRequirementCounts,
  projectReviewState,
  projectRunActions,
  projectRunFailure,
  projectTaskCounts,
  projectTaskOperationalState,
} from "@ai-office/application/read-models/operational-projection.ts";

const at = (iso: string): Date => new Date(iso);
const base = "2026-09-03T10:00:00.000Z";

function task(overrides: Partial<TaskProps> = {}): TaskProps {
  return {
    id: "task-1",
    projectId: "project-1",
    title: "Ship the thing",
    status: "pending",
    priority: 3,
    createdAt: at(base),
    updatedAt: at(base),
    ...overrides,
  };
}

function run(
  overrides: Partial<OperationalAgentRunRecord> = {},
): OperationalAgentRunRecord {
  return {
    id: "run-1",
    projectId: "project-1",
    taskId: "task-1",
    taskTitle: "Ship the thing",
    agentId: "agent-1",
    agentName: "Developer",
    agentRoleId: "role-dev",
    agentRoleKey: "developer",
    pipelineRunId: null,
    status: "running",
    worktreePath: null,
    result: null,
    error: null,
    actionIntent: null,
    createdAt: at(base),
    startedAt: at("2026-09-03T10:01:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-09-03T10:02:00.000Z"),
    ...overrides,
  };
}

function agentRecord(
  overrides: Partial<OperationalAgentRecord> = {},
): OperationalAgentRecord {
  return {
    id: "agent-1",
    projectId: "project-1",
    name: "Developer",
    roleId: "role-dev",
    roleKey: "developer",
    roleName: "Developer",
    enabled: true,
    createdAt: at(base),
    updatedAt: at(base),
    ...overrides,
  };
}

function pipelineRun(
  overrides: Partial<PipelineRunProps> = {},
): PipelineRunProps {
  return {
    id: "pipeline-1",
    projectId: "project-1",
    taskId: "task-1",
    manifestRevisionId: "revision-1",
    manifestRevision: 2,
    definition: {
      id: "delivery",
      name: "Delivery",
      description: "Design, build, review",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "design",
          name: "Architect",
          roleId: "role-architect",
          objective: "Design it",
          checks: [],
          requiresApproval: false,
        },
        {
          id: "build",
          name: "Developer",
          roleId: "role-dev",
          objective: "Build it",
          checks: [],
          requiresApproval: true,
        },
        {
          id: "review",
          name: "Reviewer",
          roleId: "role-reviewer",
          objective: "Review it",
          checks: [],
          requiresApproval: false,
        },
      ],
    },
    status: "active",
    currentStageIndex: 1,
    stages: [
      {
        id: "stage-run-1",
        stageId: "design",
        stageIndex: 0,
        roleId: "role-architect",
        status: "completed",
        assignedAgentId: "agent-2",
        completedAt: at("2026-09-03T10:00:30.000Z"),
      },
      {
        id: "stage-run-2",
        stageId: "build",
        stageIndex: 1,
        roleId: "role-dev",
        status: "active",
        assignedAgentId: "agent-1",
        assignedAt: at("2026-09-03T10:01:00.000Z"),
      },
      {
        id: "stage-run-3",
        stageId: "review",
        stageIndex: 2,
        roleId: "role-reviewer",
        status: "pending",
      },
    ],
    startedBy: "operator",
    version: 3,
    createdAt: at(base),
    updatedAt: at("2026-09-03T10:01:00.000Z"),
    ...overrides,
  };
}

function reviewRecord(
  overrides: Partial<OperationalReviewRecord> = {},
): OperationalReviewRecord {
  return {
    id: "review-1",
    projectId: "project-1",
    subjectType: "task",
    subjectId: "task-1",
    reviewerActorType: "user",
    reviewerActorId: "alice",
    reviewerDisplayName: "Alice",
    status: "pending",
    summary: "Please check the migration",
    createdAt: at("2026-09-03T10:03:00.000Z"),
    completedAt: null,
    decision: null,
    ...overrides,
  };
}

/**
 * Test helper mirroring how the query service scopes facts to one entity.
 *
 * The projection takes an entity's own active/latest run rather than a list, so
 * these helpers make that reduction explicit here instead of hiding it inside
 * each case. The service's real scoping is covered by the integration tests.
 */
function byUpdatedDesc(
  left: OperationalAgentRunRecord,
  right: OperationalAgentRunRecord,
): number {
  return right.updatedAt.getTime() - left.updatedAt.getTime();
}

function taskState(input: {
  task: TaskProps;
  runs?: readonly OperationalAgentRunRecord[];
  pipelineRun?: PipelineRunProps | null;
  reviews?: readonly ReturnType<typeof projectReviewState>[];
  agentsById?: ReadonlyMap<string, AgentReference>;
  lease?: TaskLeaseRecord | null;
  now?: Date;
  /* Overrides that hand the projection a deliberately truncated sample beside
   * a larger exact count. */
  activeRunSample?: readonly OperationalAgentRunRecord[];
  activeRunCount?: number;
  executingRunCount?: number;
}) {
  const runs = [...(input.runs ?? [])].sort(byUpdatedDesc);
  const pending = (input.reviews ?? []).filter(
    (review) => review.status === "pending",
  );
  // Every active run, not just the first: the task lock is a lease, so a task
  // may legitimately hold several.
  const active = runs.filter((run) => isActiveAgentRunStatus(run.status));
  const executing = active.filter(
    (run) => run.status === "running" || run.status === "reviewing",
  );
  return projectTaskOperationalState({
    task: input.task,
    requirementCounts: [],
    activeRuns: input.activeRunSample ?? active,
    activeRunCount: input.activeRunCount ?? active.length,
    executingRunCount: input.executingRunCount ?? executing.length,
    latestRun: runs[0] ?? null,
    lease: input.lease ?? null,
    now: input.now ?? at("2026-09-03T10:10:00.000Z"),
    pipelineRun: input.pipelineRun ?? null,
    pendingReviewCount: pending.length,
    earliestPendingReview: pending[0] ?? null,
    agentsById: input.agentsById ?? new Map(),
  });
}

/** A lease held by `runId`, expiring after the default evaluation instant. */
function lease(input: {
  runId: string;
  ownerRunStatus?: AgentRunStatus | null;
  expiresAt?: Date;
  acquiredAt?: Date;
}): TaskLeaseRecord {
  return {
    taskId: "task-1",
    ownerRunId: input.runId,
    acquiredAt: input.acquiredAt ?? at("2026-09-03T10:00:00.000Z"),
    expiresAt: input.expiresAt ?? at("2026-09-03T10:30:00.000Z"),
    ownerRunStatus:
      input.ownerRunStatus === undefined ? "running" : input.ownerRunStatus,
  };
}

function agentState(input: {
  agent: OperationalAgentRecord;
  runs?: readonly OperationalAgentRunRecord[];
  pipelineRuns?: readonly PipelineRunProps[];
  /* Overrides that let a test hand the projection a deliberately truncated
   * sample beside a larger exact count. */
  activeRunSample?: readonly OperationalAgentRunRecord[];
  activeRunCount?: number;
  activeStageSample?: readonly AgentActiveStageRecord[];
  activeStageCount?: number;
  awaitingApprovalCount?: number;
}) {
  const runs = [...(input.runs ?? [])]
    .filter((run) => run.agentId === input.agent.id)
    .sort(byUpdatedDesc);
  // Every matching stage, not the first: an agent may hold several active
  // assignments at once and the projection must see all of them.
  const stages: AgentActiveStageRecord[] = [];
  for (const pipelineRun of input.pipelineRuns ?? []) {
    if (pipelineRun.status !== "active") continue;
    const current = pipelineRun.stages[pipelineRun.currentStageIndex];
    if (current === undefined || current.assignedAgentId !== input.agent.id)
      continue;
    stages.push({
      agentId: input.agent.id,
      pipelineRunId: pipelineRun.id,
      stageId: current.stageId,
      stageName:
        pipelineRun.definition.stages[current.stageIndex]?.name ??
        current.stageId,
      stageStatus: current.status,
    });
  }
  const activeRuns = runs.filter((run) => isActiveAgentRunStatus(run.status));
  return projectAgentState({
    agent: input.agent,
    activeRuns: input.activeRunSample ?? activeRuns,
    activeRunCount: input.activeRunCount ?? activeRuns.length,
    latestRun: runs[0] ?? null,
    activeStages: input.activeStageSample ?? stages,
    activeStageCount: input.activeStageCount ?? stages.length,
    awaitingApprovalStageCount:
      input.awaitingApprovalCount ??
      stages.filter((stage) => stage.stageStatus === "awaiting_approval")
        .length,
  });
}

describe("task operational state", () => {
  test("reports a pending task with a queued run as scheduled and divergent", () => {
    const state = taskState({
      task: task({ status: "pending" }),
      runs: [run({ status: "queued", startedAt: null })],
      pipelineRun: null,
      reviews: [],
      agentsById: new Map(),
    });

    expect(state.recordedStatus).toBe("pending");
    expect(state.operationalStatus).toBe("scheduled");
    expect(state.divergesFromRecordedStatus).toBe(true);
    expect(state.divergenceReasons).toEqual([
      "agent_run_scheduled_without_task_transition",
    ]);
    expect(state.primaryAgentRun?.runId).toBe("run-1");
    expect(state.activeAgentRuns.total).toBe(1);
  });

  test("reports a pending task with a running run as in progress and divergent", () => {
    const state = taskState({
      task: task({ status: "pending" }),
      runs: [run({ status: "running" })],
      pipelineRun: null,
      reviews: [],
      agentsById: new Map(),
    });

    expect(state.operationalStatus).toBe("in_progress");
    expect(state.divergenceReasons).toEqual([
      "agent_run_active_without_task_transition",
    ]);
  });

  test("derives status from every active run, not from the representative", () => {
    // `queued` sorts first here, but one run is executing, so the task is in
    // progress. Reading the representative alone would report `scheduled`.
    const inProgress = taskState({
      task: task({ status: "pending" }),
      runs: [
        run({
          id: "run-running",
          status: "running",
          updatedAt: at("2026-09-03T10:01:00.000Z"),
        }),
        run({
          id: "run-queued",
          status: "queued",
          startedAt: null,
          updatedAt: at("2026-09-03T10:09:00.000Z"),
        }),
      ],
    });
    expect(inProgress.primaryAgentRun?.runId).toBe("run-queued");
    expect(inProgress.operationalStatus).toBe("in_progress");
    expect(inProgress.divergenceReasons).toEqual([
      "agent_run_active_without_task_transition",
    ]);
    expect(inProgress.activeAgentRuns.total).toBe(2);

    // Nothing has started executing yet.
    const scheduled = taskState({
      task: task({ status: "pending" }),
      runs: [
        run({ id: "run-queued", status: "queued", startedAt: null }),
        run({
          id: "run-preparing",
          status: "preparing",
          updatedAt: at("2026-09-03T10:09:00.000Z"),
        }),
      ],
    });
    expect(scheduled.operationalStatus).toBe("scheduled");
    expect(scheduled.divergenceReasons).toEqual([
      "agent_run_scheduled_without_task_transition",
    ]);

    const reviewing = taskState({
      task: task({ status: "running" }),
      runs: [
        run({ id: "run-running", status: "running" }),
        run({
          id: "run-reviewing",
          status: "reviewing",
          updatedAt: at("2026-09-03T10:09:00.000Z"),
        }),
      ],
    });
    expect(reviewing.operationalStatus).toBe("in_progress");
    expect(reviewing.activeAgentRuns.total).toBe(2);
  });

  test("a truncated active-run sample never changes the task status", () => {
    // The sample carries only the queued run; the exact counts say one of the
    // task's active runs is executing.
    const state = taskState({
      task: task({ status: "pending" }),
      runs: [],
      activeRunSample: [run({ id: "run-queued", status: "queued" })],
      activeRunCount: 4,
      executingRunCount: 2,
    });

    expect(state.operationalStatus).toBe("in_progress");
    expect(state.activeAgentRuns.total).toBe(4);
    expect(state.activeAgentRuns.truncated).toBe(true);
    expect(state.primaryAgentRun?.runId).toBe("run-queued");
  });

  test("reports which active run owns the task lease after a takeover", () => {
    const state = taskState({
      task: task({ status: "running" }),
      runs: [
        run({
          id: "run-a",
          status: "running",
          updatedAt: at("2026-09-03T10:01:00.000Z"),
        }),
        run({
          id: "run-b",
          status: "queued",
          startedAt: null,
          updatedAt: at("2026-09-03T10:09:00.000Z"),
        }),
      ],
      lease: lease({ runId: "run-b", ownerRunStatus: "queued" }),
    });

    expect(state.lease?.ownerRunId).toBe("run-b");
    expect(state.lease?.expired).toBe(false);
    const byId = new Map(
      state.activeAgentRuns.items.map((item) => [item.runId, item]),
    );
    // run-b owns the row and the lease is still in force, so it has authority.
    expect(byId.get("run-b")?.ownsLeaseRecord).toBe(true);
    expect(byId.get("run-b")?.hasValidLease).toBe(true);
    // run-a owns nothing and holds nothing.
    expect(byId.get("run-a")?.ownsLeaseRecord).toBe(false);
    expect(byId.get("run-a")?.hasValidLease).toBe(false);

    // Exactly one active run is executing without exclusivity.
    expect(state.runsWithoutValidLeaseCount).toBe(1);
    expect(
      state.attentionReasons.find(
        (reason) => reason.kind === "task_run_without_lease",
      ),
    ).toMatchObject({
      subjectType: "task",
      subjectId: "task-1",
      summary: "1 active run of this task no longer owns its execution lease",
    });
  });

  test("an expired lease is row ownership, not execution authority", () => {
    const state = taskState({
      task: task({ status: "running" }),
      runs: [run({ id: "run-a", status: "running" })],
      lease: lease({
        runId: "run-a",
        expiresAt: at("2026-09-03T10:05:00.000Z"),
      }),
      now: at("2026-09-03T10:10:00.000Z"),
    });

    expect(state.lease?.expired).toBe(true);
    expect(state.lease?.ownerRunId).toBe("run-a");
    // The row still names run-a, but `acquireTaskLock` would hand the task to
    // anyone now, so run-a holds no exclusivity.
    expect(state.primaryAgentRun?.ownsLeaseRecord).toBe(true);
    expect(state.primaryAgentRun?.hasValidLease).toBe(false);
    expect(state.runsWithoutValidLeaseCount).toBe(1);
    expect(
      state.attentionReasons.find(
        (reason) => reason.kind === "task_lease_expired",
      ),
    ).toEqual({
      kind: "task_lease_expired",
      projectId: "project-1",
      subjectType: "task",
      subjectId: "task-1",
      summary:
        "1 active run of this task continues after its execution lease expired",
      // Exclusivity lapsed at expiry, not at acquisition.
      since: "2026-09-03T10:05:00.000Z",
    });
  });

  test("a lease exactly at its expiry instant is already takeable", () => {
    // `acquireTaskLock` takes over on `expires_at <= acquired_at`, so the read
    // model must call the boundary expired for the same reason.
    const state = taskState({
      task: task({ status: "running" }),
      runs: [run({ id: "run-a", status: "running" })],
      lease: lease({
        runId: "run-a",
        expiresAt: at("2026-09-03T10:10:00.000Z"),
      }),
      now: at("2026-09-03T10:10:00.000Z"),
    });

    expect(state.lease?.expired).toBe(true);
    expect(state.primaryAgentRun?.hasValidLease).toBe(false);
    expect(state.runsWithoutValidLeaseCount).toBe(1);
  });

  test("an active run with no lease row is named as holding none", () => {
    // An integrity/recovery anomaly, not an ordinary lifecycle state:
    // `ExecuteAgentRun` persists the run's terminal status *before* its
    // `finally` releases the lock, and a crash before finalization skips the
    // `finally` entirely — leaving the lock row behind, not removing it. This
    // shape comes from corrupted, manually altered, or partially restored
    // state, and the read model stays honest about it rather than guessing.
    const state = taskState({
      task: task({ status: "running" }),
      runs: [run({ id: "run-a", status: "running" })],
      lease: null,
    });

    expect(state.lease).toBeNull();
    expect(state.primaryAgentRun?.ownsLeaseRecord).toBe(false);
    expect(state.primaryAgentRun?.hasValidLease).toBe(false);
    expect(state.runsWithoutValidLeaseCount).toBe(1);
    expect(
      state.attentionReasons.find(
        (reason) => reason.kind === "task_run_without_lease",
      )?.summary,
    ).toBe("1 active run of this task holds no execution lease");
  });

  test("a lease that outlived its terminal owner leaves the live run unleased", () => {
    const state = taskState({
      task: task({ status: "running" }),
      runs: [run({ id: "run-b", status: "running" })],
      lease: lease({ runId: "run-a", ownerRunStatus: "completed" }),
    });

    // The lease owner is terminal, so no active run holds exclusivity.
    expect(state.lease?.ownerRunStatus).toBe("completed");
    expect(state.runsWithoutValidLeaseCount).toBe(1);
  });

  test("a running task with no run and a failed last run is reported as failed", () => {
    const state = taskState({
      task: task({ status: "running" }),
      runs: [
        run({
          status: "failed",
          startedAt: at("2026-09-03T10:01:00.000Z"),
          completedAt: at("2026-09-03T10:04:00.000Z"),
          updatedAt: at("2026-09-03T10:04:00.000Z"),
          error: { message: "boom", code: "EXECUTION_FAILED" },
        }),
      ],
      pipelineRun: null,
      reviews: [],
      agentsById: new Map(),
    });

    expect(state.operationalStatus).toBe("failed");
    expect(state.divergenceReasons).toEqual([
      "agent_run_failed_without_task_transition",
    ]);
    expect(state.attentionReasons.map((reason) => reason.kind)).toContain(
      "agent_run_failed",
    );
  });

  test("a pending review makes the task await review and raises attention", () => {
    const state = taskState({
      task: task({ status: "running" }),
      runs: [],
      pipelineRun: null,
      reviews: [projectReviewState(reviewRecord())],
      agentsById: new Map(),
    });

    expect(state.operationalStatus).toBe("awaiting_review");
    expect(state.pendingReviewCount).toBe(1);
    expect(state.divergenceReasons).toEqual(["review_pending"]);
    expect(state.attentionReasons[0]?.kind).toBe("review_pending");
  });

  test("a stage awaiting approval makes the task await review", () => {
    const awaiting = pipelineRun();
    const stages = [...awaiting.stages];
    stages[1] = { ...stages[1]!, status: "awaiting_approval" };
    const state = taskState({
      task: task({ status: "running" }),
      runs: [],
      pipelineRun: { ...awaiting, stages },
      reviews: [],
      agentsById: new Map(),
    });

    expect(state.operationalStatus).toBe("awaiting_review");
    expect(state.divergenceReasons).toEqual([
      "pipeline_stage_awaiting_approval",
    ]);
  });

  test("terminal task statuses win over run activity and never diverge", () => {
    for (const status of ["completed", "cancelled", "failed"] as const) {
      const state = taskState({
        task: task({ status }),
        runs: [run({ status: "failed", completedAt: at(base) })],
        pipelineRun: null,
        reviews: [],
        agentsById: new Map(),
      });
      expect(state.operationalStatus).toBe(status);
      expect(state.divergesFromRecordedStatus).toBe(false);
    }
  });

  test("a blocked task reports its blocker and needs attention", () => {
    const state = taskState({
      task: task({ status: "blocked" }),
      runs: [],
      pipelineRun: null,
      reviews: [],
      agentsById: new Map(),
    });

    expect(state.operationalStatus).toBe("blocked");
    expect(state.blockedReason).toBe("Task is blocked");
    expect(state.attentionReasons.map((reason) => reason.kind)).toEqual([
      "task_blocked",
    ]);
  });

  test("a task with no runs and no reviews is not started", () => {
    const state = taskState({
      task: task(),
      runs: [],
      pipelineRun: null,
      reviews: [],
      agentsById: new Map(),
    });
    expect(state.operationalStatus).toBe("not_started");
    expect(state.divergesFromRecordedStatus).toBe(false);
  });

  test("an empty explicit requirement relation is available while milestone linkage is not inferred", () => {
    const state = taskState({
      task: task(),
      runs: [],
      pipelineRun: null,
      reviews: [],
      agentsById: new Map(),
    });

    expect(state.requirements).toEqual({
      availability: "available",
      value: { total: 0, open: 0, terminal: 0, verified: 0, rejected: 0 },
    });
    expect(state.milestone.availability).toBe("unavailable");
  });

  test("the assigned agent comes from the active pipeline stage", () => {
    const state = taskState({
      task: task({ status: "running" }),
      runs: [],
      pipelineRun: pipelineRun(),
      reviews: [],
      agentsById: new Map([
        [
          "agent-1",
          {
            agentId: "agent-1",
            name: "Developer",
            roleId: "role-dev",
            roleKey: "developer",
          },
        ],
      ]),
    });

    expect(state.assignedAgent?.name).toBe("Developer");
    expect(state.activePipelineRun?.currentStageName).toBe("Developer");
    expect(state.activePipelineRun?.stageIndex).toBe(1);
  });
});

describe("pipeline run state", () => {
  test("projects persisted stages, counts, and the current stage", () => {
    const state = projectPipelineRunState({
      run: pipelineRun(),
      task: { taskId: "task-1", title: "Ship the thing" },
      agentsById: new Map(),
    });

    expect(state.stages.map((stage) => stage.name)).toEqual([
      "Architect",
      "Developer",
      "Reviewer",
    ]);
    expect(state.stageCounts).toEqual({
      total: 3,
      completed: 1,
      active: 1,
      awaitingApproval: 0,
      pending: 1,
      cancelled: 0,
    });
    expect(state.currentStage?.stageId).toBe("build");
    expect(state.currentStage?.requiresApproval).toBe(true);
    expect(state.attentionReasons).toEqual([]);
  });

  test("a stage awaiting approval is surfaced as attention", () => {
    const source = pipelineRun();
    const stages = [...source.stages];
    stages[1] = {
      ...stages[1]!,
      status: "awaiting_approval",
      completedAt: at("2026-09-03T10:05:00.000Z"),
    };
    const state = projectPipelineRunState({
      run: { ...source, stages },
      task: null,
      agentsById: new Map(),
    });

    expect(state.attentionReasons).toEqual([
      {
        kind: "pipeline_stage_awaiting_approval",
        projectId: "project-1",
        subjectType: "pipeline_run",
        subjectId: "pipeline-1",
        summary: "Stage Developer is awaiting approval",
        since: "2026-09-03T10:05:00.000Z",
      },
    ]);
  });

  test("an active stage without an agent is surfaced as attention", () => {
    const source = pipelineRun();
    const stages = [...source.stages];
    const { assignedAgentId: _unassigned, ...unassignedStage } = stages[1]!;
    stages[1] = unassignedStage;
    const state = projectPipelineRunState({
      run: { ...source, stages },
      task: null,
      agentsById: new Map(),
    });

    expect(state.attentionReasons[0]?.kind).toBe("pipeline_stage_unassigned");
  });

  test("a completed run reports no current stage", () => {
    const state = projectPipelineRunState({
      run: {
        ...pipelineRun(),
        status: "completed",
        completedAt: at("2026-09-03T11:00:00.000Z"),
      },
      task: null,
      agentsById: new Map(),
    });
    expect(state.currentStage).toBeNull();
    expect(state.completedAt).toBe("2026-09-03T11:00:00.000Z");
  });
});

describe("agent state", () => {
  test("an agent with an active run is working", () => {
    const state = agentState({
      agent: agentRecord(),
      runs: [run({ status: "running" })],
      pipelineRuns: [],
    });
    expect(state.state).toBe("working");
    expect(state.primaryRun?.task?.title).toBe("Ship the thing");
    expect(state.primaryRun?.runId).toBe("run-1");
    expect(state.activeRuns.total).toBe(1);
    expect(state.activeStages.total).toBe(0);
  });

  test("an agent on a stage awaiting approval is waiting", () => {
    const source = pipelineRun();
    const stages = [...source.stages];
    stages[1] = { ...stages[1]!, status: "awaiting_approval" };
    const state = agentState({
      agent: agentRecord(),
      runs: [],
      pipelineRuns: [{ ...source, stages }],
    });
    expect(state.state).toBe("awaiting_approval");
    expect(state.primaryStage?.name).toBe("Developer");
    expect(state.activeStages.total).toBe(1);
  });

  test("a stage assigned before any run is scheduled reports assigned", () => {
    const state = agentState({
      agent: agentRecord(),
      runs: [],
      pipelineRuns: [pipelineRun()],
    });

    // The stage is assigned and active, but no AgentRun exists yet. Calling
    // this `working` is what made `agentsWorking` — a count of agents holding
    // active runs — contradict the agent's own state.
    expect(state.state).toBe("assigned");
    expect(state.activeStages.total).toBe(1);
    expect(state.activeRuns.total).toBe(0);
    expect(state.primaryRun).toBeNull();
    expect(state.primaryStage?.stageId).toBe("build");
  });

  test("an active run outranks a stage awaiting approval", () => {
    const source = pipelineRun();
    const stages = [...source.stages];
    stages[1] = { ...stages[1]!, status: "awaiting_approval" };
    const state = agentState({
      agent: agentRecord(),
      runs: [run({ status: "running" })],
      pipelineRuns: [{ ...source, stages }],
    });

    // `agentsWorking` counts every enabled agent holding an active run, so an
    // agent that holds one must report `working` for the two to agree. The
    // pending approval is still published in `activeStages`.
    expect(state.state).toBe("working");
    expect(state.activeStages.items[0]?.status).toBe("awaiting_approval");
  });

  test("several concurrent runs are all reported, none silently dropped", () => {
    const first = run({
      id: "run-a",
      taskId: "task-a",
      status: "running",
      updatedAt: at("2026-09-03T10:03:00.000Z"),
    });
    const second = run({
      id: "run-b",
      taskId: "task-b",
      status: "queued",
      updatedAt: at("2026-09-03T10:09:00.000Z"),
    });
    const state = agentState({
      agent: agentRecord(),
      runs: [first, second],
      pipelineRuns: [],
    });

    expect(state.state).toBe("working");
    expect(state.activeRuns.total).toBe(2);
    expect(state.activeRuns.truncated).toBe(false);
    expect(state.activeRuns.items.map((item) => item.runId)).toEqual([
      "run-b",
      "run-a",
    ]);
    // The representative is the newest-updated run, and it is labelled as one
    // of several rather than as the only one.
    expect(state.primaryRun?.runId).toBe("run-b");
  });

  test("several concurrent stage assignments are all reported", () => {
    const first = pipelineRun();
    const second = {
      ...first,
      id: "pipeline-2",
      taskId: "task-b",
      updatedAt: at("2026-09-03T10:20:00.000Z"),
    };
    const state = agentState({
      agent: agentRecord(),
      runs: [],
      pipelineRuns: [first, second],
    });

    expect(state.state).toBe("assigned");
    expect(state.activeStages.total).toBe(2);
    expect(
      state.activeStages.items.map((item) => item.pipelineRunId).sort(),
    ).toEqual(["pipeline-1", "pipeline-2"]);
  });

  test("a truncated sample never changes the derived state or the counts", () => {
    const active = run({ status: "running" });
    const state = agentState({
      agent: agentRecord(),
      runs: [],
      pipelineRuns: [],
      // Nothing is in the samples; only the exact counts say work exists.
      activeRunSample: [active],
      activeRunCount: 7,
      activeStageSample: [],
      activeStageCount: 3,
      awaitingApprovalCount: 2,
    });

    expect(state.state).toBe("working");
    expect(state.activeRuns.total).toBe(7);
    expect(state.activeRuns.truncated).toBe(true);
    expect(state.activeStages.total).toBe(3);
    expect(state.activeStages.truncated).toBe(true);
    // The awaiting-approval fact is read from the exact count, so an empty
    // sample cannot hide it — here it is outranked by the active run.
    expect(
      agentState({
        agent: agentRecord(),
        runs: [],
        pipelineRuns: [],
        activeStageSample: [],
        activeStageCount: 3,
        awaitingApprovalCount: 2,
      }).state,
    ).toBe("awaiting_approval");
  });

  test("an agent whose last run failed reports it and is otherwise idle", () => {
    const state = agentState({
      agent: agentRecord(),
      runs: [
        run({ status: "failed", completedAt: at("2026-09-03T10:04:00.000Z") }),
      ],
      pipelineRuns: [],
    });
    expect(state.state).toBe("last_run_failed");
    expect(state.primaryRun).toBeNull();
    expect(state.activeRuns.total).toBe(0);
  });

  test("an agent with no runs is idle and a disabled agent is disabled", () => {
    expect(
      agentState({ agent: agentRecord(), runs: [], pipelineRuns: [] }).state,
    ).toBe("idle");
    expect(
      agentState({
        agent: agentRecord({ enabled: false }),
        runs: [run({ status: "running" })],
        pipelineRuns: [],
      }).state,
    ).toBe("disabled");
  });

  test("runs belonging to other agents are ignored", () => {
    const state = agentState({
      agent: agentRecord({ id: "agent-9" }),
      runs: [run({ status: "running" })],
      pipelineRuns: [],
    });
    expect(state.state).toBe("idle");
  });
});

describe("agent run state", () => {
  test("computes duration and terminality and never exposes the raw result", () => {
    const state = projectAgentRunState(
      run({
        status: "completed",
        completedAt: at("2026-09-03T10:04:00.000Z"),
        result: { actions: [{ requestId: "action-1", status: "executed" }] },
      }),
    );

    expect(state.terminal).toBe(true);
    expect(state.durationMs).toBe(180_000);
    expect(state.hasResult).toBe(true);
    expect(Object.keys(state)).not.toContain("result");
  });

  test("action intents publish argument names but never argument values", () => {
    const state = projectAgentRunState(
      run({
        actionIntent: {
          resourceId: "resource-1",
          operation: "write",
          argumentKeys: ["path", "contents"],
        },
      }),
    );
    expect(state.actionIntent).toEqual({
      resourceId: "resource-1",
      operation: "write",
      argumentKeys: ["path", "contents"],
    });
  });

  test("failures publish only a bounded code and message", () => {
    expect(projectRunFailure({ message: "boom", code: "E" })).toEqual({
      code: "E",
      message: "boom",
    });
    expect(projectRunFailure(null)).toBeNull();
    expect(projectRunFailure("unexpected")).toEqual({
      code: null,
      message: null,
    });
    const long = projectRunFailure({ message: "x".repeat(2000) });
    expect(long?.message).toHaveLength(500);
  });

  test("only the known controlled-action result shape is published", () => {
    expect(
      projectRunActions({
        actions: [
          { requestId: "a", status: "executed" },
          { requestId: "b" },
          "nonsense",
        ],
        secret: "should never be read",
      }),
    ).toEqual([{ requestId: "a", status: "executed" }]);
    expect(projectRunActions({ notActions: 1 })).toEqual([]);
    expect(projectRunActions(null)).toEqual([]);
  });

  test("a failed run raises attention with its code", () => {
    const state = projectAgentRunState(
      run({
        status: "failed",
        completedAt: at("2026-09-03T10:04:00.000Z"),
        error: { message: "boom", code: "EXECUTION_FAILED" },
      }),
    );
    expect(agentRunAttentionReasons(state)).toEqual([
      {
        kind: "agent_run_failed",
        projectId: "project-1",
        subjectType: "agent_run",
        subjectId: "run-1",
        summary: "Agent run failed (EXECUTION_FAILED)",
        since: "2026-09-03T10:04:00.000Z",
      },
    ]);
    expect(
      agentRunAttentionReasons(
        projectAgentRunState(run({ status: "running" })),
      ),
    ).toEqual([]);
  });
});

describe("reviews", () => {
  test("a decided review carries its approval", () => {
    const state = projectReviewState(
      reviewRecord({
        status: "approved",
        completedAt: at("2026-09-03T11:00:00.000Z"),
        decision: {
          id: "approval-1",
          decision: "approved",
          actorType: "user",
          actorId: "bob",
          displayName: "Bob",
          rationale: "Looks right",
          createdAt: at("2026-09-03T11:00:00.000Z"),
        },
      }),
    );
    expect(state.status).toBe("approved");
    expect(state.decision?.actor.displayName).toBe("Bob");
  });
});

describe("counts", () => {
  test("task counts split open from terminal", () => {
    const counts = projectTaskCounts([
      { projectId: "p", status: "pending", count: 2 },
      { projectId: "p", status: "running", count: 1 },
      { projectId: "p", status: "completed", count: 5 },
      { projectId: "p", status: "cancelled", count: 1 },
    ]);
    expect(counts.total).toBe(9);
    expect(counts.open).toBe(3);
    expect(counts.terminal).toBe(6);
    expect(counts.byStatus.completed).toBe(5);
    expect(counts.byStatus.blocked).toBe(0);
  });

  test("requirement counts treat verified and rejected as terminal", () => {
    const counts = projectRequirementCounts([
      { status: "proposed", count: 1 },
      { status: "accepted", count: 2 },
      { status: "implemented", count: 1 },
      { status: "verified", count: 4 },
      { status: "rejected", count: 1 },
    ]);
    expect(counts.total).toBe(9);
    expect(counts.open).toBe(4);
    expect(counts.terminal).toBe(5);
    expect(counts.verified).toBe(4);
    expect(counts.rejected).toBe(1);
  });
});

describe("project summary", () => {
  const project: OperationalProjectRecord = {
    id: "project-1",
    name: "AutoEpoque",
    description: null,
    repositoryId: "repo-1",
    localPaths: ["/tmp/autoepoque"],
    remoteUrl: "git@example.com:acme/autoepoque.git",
    defaultBranch: "main",
    createdAt: at(base),
    updatedAt: at("2026-09-03T10:10:00.000Z"),
  };

  const milestone: OperationalMilestoneRecord = {
    id: "milestone-1",
    projectId: "project-1",
    title: "M8",
    description: null,
    status: "active",
    createdAt: at(base),
    updatedAt: at(base),
  };

  test("summarizes counts, milestone, and attention", () => {
    const summary = projectProjectSummary({
      project,
      taskCounts: [
        { projectId: "project-1", status: "pending", count: 12 },
        { projectId: "project-1", status: "completed", count: 37 },
      ],
      requirementCounts: [
        {
          projectId: "project-1",
          milestoneId: "milestone-1",
          status: "verified",
          count: 3,
        },
        {
          projectId: "project-1",
          milestoneId: null,
          status: "proposed",
          count: 1,
        },
      ],
      milestones: [milestone],
      activePipelineRuns: 1,
      activeAgentRuns: 2,
      agentsWorking: 2,
      pendingReviews: 1,
      attention: {
        total: 1,
        truncated: false,
        items: [
          {
            kind: "review_pending",
            projectId: "project-1",
            subjectType: "review",
            subjectId: "review-1",
            summary: "Review of task task-1 is pending",
            since: "2026-09-03T10:03:00.000Z",
          },
        ],
      },
      lastActivityAt: at("2026-09-03T10:20:00.000Z"),
    });

    expect(summary.tasks.open).toBe(12);
    expect(summary.tasks.byStatus.completed).toBe(37);
    expect(summary.requirements.total).toBe(4);
    expect(summary.currentMilestone?.title).toBe("M8");
    // Milestone requirement counts exclude requirements not bound to it.
    expect(summary.currentMilestone?.requirements.total).toBe(3);
    expect(summary.pendingReviews).toBe(1);
    expect(summary.attentionRequired).toBe(true);
    expect(summary.lastActivityAt).toBe("2026-09-03T10:20:00.000Z");
  });

  test("more than one active milestone reports no single current milestone", () => {
    const summary = projectProjectSummary({
      project,
      taskCounts: [],
      requirementCounts: [],
      milestones: [milestone, { ...milestone, id: "milestone-2" }],
      activePipelineRuns: 0,
      activeAgentRuns: 0,
      agentsWorking: 0,
      pendingReviews: 0,
      attention: { total: 0, items: [], truncated: false },
      lastActivityAt: null,
    });
    expect(summary.currentMilestone).toBeNull();
    expect(summary.activeMilestoneCount).toBe(2);
    expect(summary.attentionRequired).toBe(false);
  });
});

describe("activity sanitization", () => {
  test("keeps scalars and drops everything else", () => {
    const { detail, truncated } = sanitizeActivityDetail({
      command: "task:create",
      exitCode: 0,
      interactionRequired: false,
      nested: { a: 1 },
      list: [1, 2],
      missing: null,
    });
    expect(detail).toEqual({
      command: "task:create",
      exitCode: 0,
      interactionRequired: false,
    });
    expect(truncated).toBe(true);
  });

  test("drops sensitive key names", () => {
    const { detail, truncated } = sanitizeActivityDetail({
      apiKey: "sk-live-secret",
      "access-token": "abc",
      password: "hunter2",
      command: "status",
    });
    expect(detail).toEqual({ command: "status" });
    expect(truncated).toBe(true);
    expect(JSON.stringify(detail)).not.toContain("sk-live-secret");
  });

  test("truncates long strings and caps the number of keys", () => {
    const long = sanitizeActivityDetail({ note: "x".repeat(1000) });
    expect(long.detail.note).toHaveLength(241);
    expect(long.truncated).toBe(true);

    const many = sanitizeActivityDetail(
      Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [`k${index}`, index]),
      ),
    );
    expect(Object.keys(many.detail)).toHaveLength(12);
    expect(many.truncated).toBe(true);
  });

  test("drops non-finite numbers rather than serializing null", () => {
    const { detail, truncated } = sanitizeActivityDetail({
      ratio: Number.NaN,
      count: 4,
    });
    expect(detail).toEqual({ count: 4 });
    expect(truncated).toBe(true);
  });

  test("projects an audit record into a safe activity entry", () => {
    const entry = projectActivityEntry({
      id: "event-1",
      projectId: "project-1",
      eventType: "command.completed",
      actorType: "daemon",
      actorId: "request-1",
      aggregateType: null,
      aggregateId: null,
      payload: { command: "task:create", exitCode: 0 },
      occurredAt: at(base),
    });
    expect(entry).toEqual({
      eventId: "event-1",
      projectId: "project-1",
      eventType: "command.completed",
      actorType: "daemon",
      actorId: "request-1",
      aggregateType: null,
      aggregateId: null,
      occurredAt: base,
      detail: { command: "task:create", exitCode: 0 },
      detailTruncated: false,
    });
  });
});
