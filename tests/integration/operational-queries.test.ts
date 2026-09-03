import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqliteOperationalReadRepository } from "@ai-office/storage-sqlite/repositories/sqlite-operational-read.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import {
  OperationalQueryService,
  OperationalResourceNotFoundError,
} from "@ai-office/application/queries/operational-query-service.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";

const roots: string[] = [];
const now = new Date("2026-09-03T10:00:00.000Z");

class FixedClock implements Clock {
  now(): Date {
    return new Date(now);
  }
}

class SequenceIds implements IdGenerator {
  private next = 0;
  generate(): string {
    this.next += 1;
    return `generated-${this.next}`;
  }
}

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Deliver",
    goals: [],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Office",
    roles: [
      {
        id: "architect",
        title: "Architect",
        purpose: "Design",
        responsibilities: [],
      },
      {
        id: "developer",
        title: "Developer",
        purpose: "Build",
        responsibilities: [],
      },
    ],
  },
  pipelines: [
    {
      id: "delivery",
      name: "Delivery",
      description: "Design then build",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "design",
          name: "Architecture",
          roleId: "architect",
          objective: "Design",
          checks: [],
          requiresApproval: false,
        },
        {
          id: "build",
          name: "Implementation",
          roleId: "developer",
          objective: "Build",
          checks: [],
          requiresApproval: true,
        },
      ],
    },
  ],
};

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-queries-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));

  const clock = new FixedClock();
  const ids = new SequenceIds();
  const projects = new SqliteProjectRepository(database);
  const tasks = new SqliteTaskRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  const pipelines = new SqlitePipelineRunRepository(database);
  const manifests = new SqliteOfficeManifestRepository(database);
  const governance = new SqliteGovernanceRepository(database);
  const audit = new RecordAuditEvent(
    new SqliteAuditEventRepository(database),
    ids,
    clock,
  );
  const reads = new SqliteOperationalReadRepository(database);
  const queries = new OperationalQueryService({
    reads,
    tasks,
    pipelines,
    clock,
  });

  return {
    database,
    clock,
    ids,
    projects,
    tasks,
    runtime,
    pipelines,
    manifests,
    governance,
    audit,
    reads,
    queries,
    transactions: new SqliteTransactionRunner(database),
  };
}

async function seedProject(
  context: Awaited<ReturnType<typeof fixture>>,
  id: string,
  name: string,
): Promise<void> {
  await context.projects.save(Project.create({ id, name, now }));
  context.database
    .prepare(
      `INSERT INTO project_source(id, project_id, source_type, local_path, remote_url, default_branch, created_at)
       VALUES (?, ?, 'local', ?, ?, ?, ?)`,
    )
    .run(
      `source-${id}`,
      id,
      `/tmp/${id}`,
      "git@example.com:acme/repo.git",
      "main",
      now.toISOString(),
    );
  context.database
    .prepare(
      "INSERT INTO project_repository_identity(repository_id, project_id, created_at) VALUES (?, ?, ?)",
    )
    .run(`repo-${id}`, id, now.toISOString());
}

async function seedAgent(
  context: Awaited<ReturnType<typeof fixture>>,
  projectId: string,
  agentId: string,
  roleKey: string,
): Promise<void> {
  await context.runtime.saveRole(
    Role.create({
      id: `role-${agentId}`,
      projectId,
      key: roleKey,
      name: `${roleKey} role`,
      version: 1,
      capabilities: [],
      tools: [],
      modelPolicy: "default",
      limits: {
        maxIterations: 1,
        maxCostMicros: 1000n,
        timeoutSeconds: 10,
      },
      sourcePath: "roles.yaml",
      now,
    }),
  );
  const agent: Agent = {
    id: agentId,
    projectId,
    name: `${roleKey}-agent`,
    roleId: `role-${agentId}`,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  };
  await context.runtime.saveAgent(agent);
}

describe("operational read repository", () => {
  test("lists projects with repository identity and sources", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "AutoEpoque");
    await seedProject(context, "project-2", "Other");

    const projects = await context.reads.listProjects();
    expect(projects.map((project) => project.name)).toEqual([
      "AutoEpoque",
      "Other",
    ]);
    expect(projects[0]).toMatchObject({
      id: "project-1",
      repositoryId: "repo-project-1",
      localPaths: ["/tmp/project-1"],
      remoteUrl: "git@example.com:acme/repo.git",
      defaultBranch: "main",
    });
    expect(await context.reads.findProject("missing")).toBeNull();
  });

  test("a project with no source reports an empty path list, not a fake one", async () => {
    const context = await fixture();
    await context.projects.save(
      Project.create({ id: "bare", name: "Bare", now }),
    );
    const project = await context.reads.findProject("bare");
    expect(project).toMatchObject({
      repositoryId: null,
      localPaths: [],
      remoteUrl: null,
      defaultBranch: null,
    });
  });

  test("counts tasks and requirements across several projects in one pass", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedProject(context, "project-2", "Two");
    for (const [index, projectId] of [
      "project-1",
      "project-1",
      "project-2",
    ].entries())
      await context.tasks.save(
        Task.create({
          id: `task-${index}`,
          projectId,
          title: `Task ${index}`,
          now,
        }),
      );

    const governance = new ManageGovernance(
      context.projects,
      context.governance,
      context.ids,
      context.clock,
    );
    const milestoneId = await governance.createMilestone({
      projectId: "project-1",
      title: "M8",
    });
    await governance.createRequirement({
      projectId: "project-1",
      key: "REQ-1",
      title: "First",
      description: "First requirement",
      milestoneId,
    });
    await governance.createRequirement({
      projectId: "project-1",
      key: "REQ-2",
      title: "Second",
      description: "Second requirement",
    });

    const taskCounts = await context.reads.countTasksByStatus([
      "project-1",
      "project-2",
    ]);
    expect(taskCounts).toEqual(
      expect.arrayContaining([
        { projectId: "project-1", status: "pending", count: 2 },
        { projectId: "project-2", status: "pending", count: 1 },
      ]),
    );

    const requirementCounts = await context.reads.countRequirementsByStatus([
      "project-1",
    ]);
    expect(requirementCounts).toEqual(
      expect.arrayContaining([
        {
          projectId: "project-1",
          milestoneId,
          status: "proposed",
          count: 1,
        },
        {
          projectId: "project-1",
          milestoneId: null,
          status: "proposed",
          count: 1,
        },
      ]),
    );

    const milestones = await context.reads.listMilestones(["project-1"]);
    expect(milestones).toHaveLength(1);
    expect(milestones[0]?.title).toBe("M8");
  });

  test("empty project lists short-circuit rather than scanning", async () => {
    const context = await fixture();
    expect(await context.reads.countTasksByStatus([])).toEqual([]);
    expect(await context.reads.countRequirementsByStatus([])).toEqual([]);
    expect(await context.reads.listMilestones([])).toEqual([]);
    expect(await context.reads.listAgents([])).toEqual([]);
    expect(await context.reads.countActivePipelineRuns([])).toEqual([]);
    expect(await context.reads.lastActivityAt([])).toEqual([]);
    expect(await context.reads.listActivePipelineStages([])).toEqual([]);
    expect(await context.reads.listAttentionTasks([], 10)).toEqual([]);
    expect(
      await context.reads.listAgentRuns({ projectIds: [], limit: 10 }),
    ).toEqual([]);
    expect(
      await context.reads.listReviews({ projectIds: [], limit: 10 }),
    ).toEqual([]);
  });

  test("joins agents to their role and runs to their task and agent", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedAgent(context, "project-1", "agent-1", "developer");
    await context.tasks.save(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Ship it",
        now,
      }),
    );
    await context.runtime.saveRun(
      AgentRun.create({
        id: "run-1",
        projectId: "project-1",
        taskId: "task-1",
        agentId: "agent-1",
        actionIntent: {
          resourceId: "resource-1",
          operation: "write",
          arguments: { path: "/tmp/x", contents: "secret contents" },
        },
        now,
      }),
    );

    const agents = await context.reads.listAgents(["project-1"]);
    expect(agents[0]).toMatchObject({
      id: "agent-1",
      roleKey: "developer",
      roleName: "developer role",
      enabled: true,
    });

    const runs = await context.reads.listAgentRuns({
      projectIds: ["project-1"],
      limit: 10,
    });
    expect(runs[0]).toMatchObject({
      id: "run-1",
      taskTitle: "Ship it",
      agentName: "developer-agent",
      agentRoleKey: "developer",
      status: "queued",
    });
    // Argument names travel; argument values never leave the record layer.
    expect(runs[0]?.actionIntent).toEqual({
      resourceId: "resource-1",
      operation: "write",
      argumentKeys: ["contents", "path"],
    });
  });

  test("filters and bounds run queries", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedAgent(context, "project-1", "agent-1", "developer");
    for (let index = 0; index < 5; index += 1) {
      await context.tasks.save(
        Task.create({
          id: `task-${index}`,
          projectId: "project-1",
          title: `Task ${index}`,
          now,
        }),
      );
      await context.runtime.saveRun(
        AgentRun.create({
          id: `run-${index}`,
          projectId: "project-1",
          taskId: `task-${index}`,
          agentId: "agent-1",
          now,
        }),
      );
    }

    expect(
      await context.reads.listAgentRuns({
        projectIds: ["project-1"],
        limit: 2,
      }),
    ).toHaveLength(2);
    expect(
      await context.reads.listAgentRuns({
        projectIds: ["project-1"],
        statuses: ["running"],
        limit: 10,
      }),
    ).toEqual([]);
    expect(
      await context.reads.listAgentRuns({
        taskIds: ["task-3"],
        limit: 10,
      }),
    ).toHaveLength(1);
    expect(await context.reads.findAgentRun("nope")).toBeNull();
  });

  test("reads the active stage of every active pipeline in one query", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedAgent(context, "project-1", "agent-1", "architect");
    await context.tasks.save(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Ship it",
        now,
      }),
    );
    await context.manifests.save({
      id: "manifest-1",
      projectId: "project-1",
      revision: 1,
      manifest,
      appliedAt: now,
    });
    const run = PipelineRun.create({
      id: "pipeline-1",
      projectId: "project-1",
      taskId: "task-1",
      manifestRevisionId: "manifest-1",
      manifestRevision: 1,
      definition: manifest.pipelines[0]!,
      startedBy: "operator",
      stageRunIds: ["stage-1", "stage-2"],
      now,
    });
    await context.pipelines.insert(run);

    const stages = await context.reads.listActivePipelineStages(["project-1"]);
    expect(stages).toHaveLength(1);
    expect(stages[0]).toMatchObject({
      pipelineRunId: "pipeline-1",
      pipelineId: "delivery",
      pipelineName: "Delivery",
      stageId: "design",
      stageName: "Architecture",
      stageStatus: "active",
      assignedAgentId: null,
    });
    expect(await context.reads.countActivePipelineRuns(["project-1"])).toEqual([
      { projectId: "project-1", count: 1 },
    ]);
  });

  test("activity is newest first, bounded, and keyset paged", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    for (let index = 0; index < 4; index += 1)
      context.database
        .prepare(
          `INSERT INTO audit_event(id, project_id, event_type, actor_type, actor_id, payload_json, occurred_at)
           VALUES (?, ?, ?, 'daemon', NULL, ?, ?)`,
        )
        .run(
          `event-${index}`,
          "project-1",
          `command.completed`,
          JSON.stringify({ command: `task:list`, exitCode: 0 }),
          new Date(now.getTime() + index * 1000).toISOString(),
        );

    const recent = await context.reads.listActivity({ limit: 2 });
    expect(recent.map((entry) => entry.id)).toEqual(["event-3", "event-2"]);

    const older = await context.reads.listActivity({
      limit: 10,
      before: new Date(now.getTime() + 2000),
    });
    expect(older.map((entry) => entry.id)).toEqual(["event-1", "event-0"]);

    expect(await context.reads.lastActivityAt(["project-1"])).toEqual([
      { projectId: "project-1", occurredAt: new Date(now.getTime() + 3000) },
    ]);
  });
});

describe("operational query service", () => {
  test("an empty runtime reports an empty, honest overview", async () => {
    const context = await fixture();
    const overview = await context.queries.getDashboardOverview();
    expect(overview.projects).toEqual([]);
    expect(overview.totals).toEqual({
      projects: 0,
      openTasks: 0,
      activeAgentRuns: 0,
      activePipelineRuns: 0,
      pendingReviews: 0,
      agentsWorking: 0,
      attentionItems: 0,
    });
    expect(overview.recentActivity).toEqual([]);
  });

  test("summarizes several projects and surfaces cross-project attention", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedProject(context, "project-2", "Two");
    await seedAgent(context, "project-1", "agent-1", "developer");

    await context.tasks.save(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Active work",
        now,
      }),
    );
    const blocked = Task.restore({
      id: "task-blocked",
      projectId: "project-2",
      title: "Stuck",
      status: "blocked",
      priority: 0,
      createdAt: now,
      updatedAt: now,
    });
    await context.tasks.save(blocked);

    const run = AgentRun.create({
      id: "run-1",
      projectId: "project-1",
      taskId: "task-1",
      agentId: "agent-1",
      now,
    });
    run.transition("preparing", now);
    run.transition("running", now);
    await context.runtime.saveRun(run);

    const overview = await context.queries.getDashboardOverview();
    expect(overview.projects.map((project) => project.name)).toEqual([
      "One",
      "Two",
    ]);
    expect(overview.totals.activeAgentRuns).toBe(1);
    expect(overview.totals.agentsWorking).toBe(1);
    expect(overview.totals.attentionItems).toBe(1);
    expect(overview.attentionReasons[0]).toMatchObject({
      kind: "task_blocked",
      projectId: "project-2",
      subjectId: "task-blocked",
    });
    expect(overview.activeRuns[0]?.runId).toBe("run-1");
  });

  test("project detail reports the divergence between stored and operational status", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedAgent(context, "project-1", "agent-1", "developer");
    await context.tasks.save(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Ship it",
        now,
      }),
    );
    const run = AgentRun.create({
      id: "run-1",
      projectId: "project-1",
      taskId: "task-1",
      agentId: "agent-1",
      now,
    });
    run.transition("preparing", now);
    run.transition("running", now);
    await context.runtime.saveRun(run);

    const detail = await context.queries.getProjectDetail("project-1");
    const task = detail.tasks[0]!;
    // schedule-agent-run deliberately does not transition the task, so the
    // stored status stays `pending` while the run is already executing.
    expect(task.recordedStatus).toBe("pending");
    expect(task.operationalStatus).toBe("in_progress");
    expect(task.divergesFromRecordedStatus).toBe(true);
    expect(detail.agents[0]?.state).toBe("working");
    expect(detail.summary.activeAgentRuns).toBe(1);
  });

  test("a pending review shows up as project attention and blocks the task", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await context.tasks.save(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Ship it",
        now,
      }),
    );
    const governance = new ManageGovernance(
      context.projects,
      context.governance,
      context.ids,
      context.clock,
    );
    await governance.createReview({
      projectId: "project-1",
      subjectType: "task",
      subjectId: "task-1",
      reviewer: { type: "user", id: "alice", displayName: "Alice" },
    });

    const detail = await context.queries.getProjectDetail("project-1");
    expect(detail.summary.pendingReviews).toBe(1);
    expect(detail.tasks[0]?.operationalStatus).toBe("awaiting_review");
    expect(detail.summary.attentionReasons.map((r) => r.kind)).toContain(
      "review_pending",
    );
    // The same pending review must not be counted twice.
    expect(
      detail.summary.attentionReasons.filter(
        (reason) => reason.kind === "review_pending",
      ),
    ).toHaveLength(1);

    const pending = await context.queries.listReviews({ pendingOnly: true });
    expect(pending).toHaveLength(1);
    expect(await context.queries.listApprovals({})).toEqual([]);
  });

  test("an approved review moves from reviews to approvals", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await context.tasks.save(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Ship it",
        now,
      }),
    );
    const governance = new ManageGovernance(
      context.projects,
      context.governance,
      context.ids,
      context.clock,
    );
    const reviewId = await governance.createReview({
      projectId: "project-1",
      subjectType: "task",
      subjectId: "task-1",
      reviewer: { type: "user", id: "alice" },
    });
    await governance.approve({
      projectId: "project-1",
      reviewId,
      decision: "approved",
      actor: { type: "user", id: "bob", displayName: "Bob" },
      rationale: "Looks right",
    });

    expect(
      await context.queries.listReviews({ pendingOnly: true }),
    ).toHaveLength(0);
    const approvals = await context.queries.listApprovals({});
    expect(approvals[0]).toMatchObject({
      status: "approved",
      decision: { decision: "approved", rationale: "Looks right" },
    });
  });

  test("pipeline state exposes the persisted stage sequence", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await context.tasks.save(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Ship it",
        now,
      }),
    );
    await context.manifests.save({
      id: "manifest-1",
      projectId: "project-1",
      revision: 1,
      manifest,
      appliedAt: now,
    });
    await context.pipelines.insert(
      PipelineRun.create({
        id: "pipeline-1",
        projectId: "project-1",
        taskId: "task-1",
        manifestRevisionId: "manifest-1",
        manifestRevision: 1,
        definition: manifest.pipelines[0]!,
        startedBy: "operator",
        stageRunIds: ["stage-1", "stage-2"],
        now,
      }),
    );

    const pipelines = await context.queries.listPipelineRuns("project-1", {
      activeOnly: true,
    });
    expect(pipelines).toHaveLength(1);
    expect(pipelines[0]?.stages.map((stage) => stage.name)).toEqual([
      "Architecture",
      "Implementation",
    ]);
    expect(pipelines[0]?.currentStage?.stageId).toBe("design");
    expect(pipelines[0]?.task?.title).toBe("Ship it");
    // An active stage with no assigned agent is a real blocker.
    expect(pipelines[0]?.attentionReasons[0]?.kind).toBe(
      "pipeline_stage_unassigned",
    );
  });

  test("run detail exposes events and controlled actions without raw payloads", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedAgent(context, "project-1", "agent-1", "developer");
    await context.tasks.save(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Ship it",
        now,
      }),
    );
    const run = AgentRun.create({
      id: "run-1",
      projectId: "project-1",
      taskId: "task-1",
      agentId: "agent-1",
      now,
    });
    // Each save records one run event, exactly as the runtime does.
    await context.runtime.saveRun(run);
    run.transition("preparing", now);
    await context.runtime.saveRun(run);
    run.transition("running", now);
    await context.runtime.saveRun(run);
    run.transition("failed", now, {
      error: { message: "worktree missing", code: "EXECUTION_FAILED" },
      result: {
        actions: [{ requestId: "action-1", status: "approval_pending" }],
        internalNote: "must not be published",
      },
    });
    await context.runtime.saveRun(run);

    const detail = await context.queries.getRunDetail("run-1");
    expect(detail.run.status).toBe("failed");
    expect(detail.run.failure).toEqual({
      code: "EXECUTION_FAILED",
      message: "worktree missing",
    });
    expect(detail.actions).toEqual([
      { requestId: "action-1", status: "approval_pending" },
    ]);
    expect(JSON.stringify(detail)).not.toContain("must not be published");
    expect(detail.events.map((event) => event.status)).toEqual([
      "queued",
      "preparing",
      "running",
      "failed",
    ]);
    expect(detail.attentionReasons[0]?.kind).toBe("agent_run_failed");
  });

  test("unknown projects and runs raise a typed not-found error", async () => {
    const context = await fixture();
    await expect(
      context.queries.getProjectDetail("missing"),
    ).rejects.toBeInstanceOf(OperationalResourceNotFoundError);
    await expect(
      context.queries.getRunDetail("missing"),
    ).rejects.toBeInstanceOf(OperationalResourceNotFoundError);
    await expect(context.queries.listTasks("missing")).rejects.toBeInstanceOf(
      OperationalResourceNotFoundError,
    );
  });

  test("activity is sanitized before it reaches a query result", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    context.database
      .prepare(
        `INSERT INTO audit_event(id, project_id, event_type, actor_type, actor_id, payload_json, occurred_at)
         VALUES (?, ?, ?, 'daemon', NULL, ?, ?)`,
      )
      .run(
        "event-1",
        "project-1",
        "command.completed",
        JSON.stringify({
          command: "project:create",
          apiKey: "sk-live-should-not-appear",
          nested: { hidden: true },
        }),
        now.toISOString(),
      );

    const activity = await context.queries.listActivity({
      projectId: "project-1",
    });
    expect(activity[0]?.detail).toEqual({ command: "project:create" });
    expect(activity[0]?.detailTruncated).toBe(true);
    expect(JSON.stringify(activity)).not.toContain("sk-live-should-not-appear");
  });

  test("task listing respects its limit", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    for (let index = 0; index < 5; index += 1)
      await context.tasks.save(
        Task.create({
          id: `task-${index}`,
          projectId: "project-1",
          title: `Task ${index}`,
          now,
        }),
      );
    expect(await context.queries.listTasks("project-1", 2)).toHaveLength(2);
  });
});
