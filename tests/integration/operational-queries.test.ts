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
import {
  parseActivityCursor,
  queryLimits,
} from "@ai-office/application/protocol/query-protocol.ts";
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
  const queries = new OperationalQueryService({ reads, clock });

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
    expect(await context.reads.listActivePipelineStages([], 10)).toEqual([]);
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

    const stages = await context.reads.listActivePipelineStages(["project-1"], 10);
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
      cursor: { occurredAt: new Date(now.getTime() + 2000), id: "event-2" },
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
    expect(overview.recentActivity).toEqual({ items: [], nextCursor: null });
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
    expect(overview.attention.items[0]).toMatchObject({
      kind: "task_blocked",
      projectId: "project-2",
      subjectId: "task-blocked",
    });
    expect(overview.activeRuns.items[0]?.runId).toBe("run-1");
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
    const task = detail.tasks.items[0]!;
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
    expect(detail.tasks.items[0]?.operationalStatus).toBe("awaiting_review");
    expect(detail.summary.attention.items.map((r) => r.kind)).toContain(
      "review_pending",
    );
    // The same pending review must not be counted twice.
    expect(
      detail.summary.attention.items.filter(
        (reason) => reason.kind === "review_pending",
      ),
    ).toHaveLength(1);

    const pending = await context.queries.listReviews({ pendingOnly: true });
    expect(pending.items).toHaveLength(1);
    expect((await context.queries.listApprovals({})).items).toEqual([]);
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
      (await context.queries.listReviews({ pendingOnly: true })).items,
    ).toHaveLength(0);
    const approvals = await context.queries.listApprovals({});
    expect(approvals.items[0]).toMatchObject({
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
    expect(pipelines.items).toHaveLength(1);
    expect(pipelines.items[0]?.stages.map((stage) => stage.name)).toEqual([
      "Architecture",
      "Implementation",
    ]);
    expect(pipelines.items[0]?.currentStage?.stageId).toBe("design");
    expect(pipelines.items[0]?.task?.title).toBe("Ship it");
    // An active stage with no assigned agent is a real blocker.
    expect(pipelines.items[0]?.attentionReasons[0]?.kind).toBe(
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
    expect(detail.events.items.map((event) => event.status)).toEqual([
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
    expect(activity.items[0]?.detail).toEqual({ command: "project:create" });
    expect(activity.items[0]?.detailTruncated).toBe(true);
    expect(JSON.stringify(activity.items)).not.toContain(
      "sk-live-should-not-appear",
    );
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
    expect((await context.queries.listTasks("project-1", 2)).items).toHaveLength(
      2,
    );
  });
});

/**
 * Scale regressions.
 *
 * Every case here creates more records than the relevant display limit and then
 * asserts the invariant this hardening exists for: a result may be bounded, but
 * bounded evidence must never silently change an authoritative count, status,
 * attention decision, or relationship.
 */
describe("bounded evidence never decides authoritative state", () => {
  async function seedRun(
    context: Awaited<ReturnType<typeof fixture>>,
    input: {
      projectId: string;
      taskId: string;
      agentId: string;
      runId: string;
      status: "queued" | "running" | "failed" | "completed";
      updatedAt: Date;
    },
  ): Promise<void> {
    context.database
      .prepare(
        `INSERT INTO agent_run(
           id, project_id, task_id, agent_id, status,
           created_at, started_at, completed_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.runId,
        input.projectId,
        input.taskId,
        input.agentId,
        input.status,
        now.toISOString(),
        input.status === "queued" ? null : now.toISOString(),
        input.status === "failed" || input.status === "completed"
          ? input.updatedAt.toISOString()
          : null,
        input.updatedAt.toISOString(),
      );
  }

  test("active-run totals stay exact when the sample is truncated", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    const runsWanted = queryLimits.runs.default + 7;
    for (let index = 0; index < runsWanted; index += 1) {
      await seedAgent(context, "project-1", `agent-${index}`, `role${index}`);
      await context.tasks.save(
        Task.create({
          id: `task-${index}`,
          projectId: "project-1",
          title: `Task ${index}`,
          now,
        }),
      );
      await seedRun(context, {
        projectId: "project-1",
        taskId: `task-${index}`,
        agentId: `agent-${index}`,
        runId: `run-${index}`,
        status: "running",
        updatedAt: new Date(now.getTime() + index * 1000),
      });
    }

    const overview = await context.queries.getDashboardOverview();
    const summary = overview.projects[0]!;

    // Totals are exact even though the sample stopped at the limit.
    expect(overview.totals.activeAgentRuns).toBe(runsWanted);
    expect(overview.totals.agentsWorking).toBe(runsWanted);
    expect(summary.activeAgentRuns).toBe(runsWanted);
    expect(summary.agentsWorking).toBe(runsWanted);

    // The sample is smaller, and says so.
    expect(overview.activeRuns.items).toHaveLength(queryLimits.runs.default);
    expect(overview.activeRuns.total).toBe(runsWanted);
    expect(overview.activeRuns.truncated).toBe(true);

    const detail = await context.queries.getProjectDetail("project-1");
    expect(detail.summary.activeAgentRuns).toBe(runsWanted);
    expect(detail.summary.agentsWorking).toBe(runsWanted);
    expect(detail.runs.total).toBe(runsWanted);
    expect(detail.runs.items.length).toBeLessThan(runsWanted);
    expect(detail.runs.truncated).toBe(true);
  });

  test("a task's own run decides its status from outside any display window", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedAgent(context, "project-1", "agent-1", "developer");

    // The task of interest, with an old but in-flight run.
    await context.tasks.save(
      Task.create({
        id: "task-old",
        projectId: "project-1",
        title: "Old but running",
        priority: 100,
        now,
      }),
    );
    await seedRun(context, {
      projectId: "project-1",
      taskId: "task-old",
      agentId: "agent-1",
      runId: "run-old",
      status: "running",
      updatedAt: now,
    });

    // Enough newer, unrelated runs to push it out of any generic window.
    const noise = queryLimits.runs.max + 20;
    for (let index = 0; index < noise; index += 1) {
      await context.tasks.save(
        Task.create({
          id: `noise-task-${index}`,
          projectId: "project-1",
          title: `Noise ${index}`,
          now,
        }),
      );
      await seedRun(context, {
        projectId: "project-1",
        taskId: `noise-task-${index}`,
        agentId: "agent-1",
        runId: `noise-run-${index}`,
        status: "completed",
        updatedAt: new Date(now.getTime() + (index + 1) * 60_000),
      });
    }

    const tasks = await context.queries.listTasks("project-1", 5);
    const task = tasks.items.find((value) => value.taskId === "task-old");
    expect(task).toBeDefined();
    expect(task?.operationalStatus).toBe("in_progress");
    expect(task?.divergesFromRecordedStatus).toBe(true);
    expect(task?.divergenceReasons).toEqual([
      "agent_run_active_without_task_transition",
    ]);
    expect(task?.activeAgentRun?.runId).toBe("run-old");
  });

  test("an agent's own run decides its state from outside any display window", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedAgent(context, "project-1", "agent-quiet", "quiet");
    await seedAgent(context, "project-1", "agent-busy", "busy");
    await context.tasks.save(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Held",
        now,
      }),
    );
    await seedRun(context, {
      projectId: "project-1",
      taskId: "task-1",
      agentId: "agent-quiet",
      runId: "run-quiet",
      status: "running",
      updatedAt: now,
    });

    const noise = queryLimits.runs.max + 20;
    for (let index = 0; index < noise; index += 1)
      await seedRun(context, {
        projectId: "project-1",
        taskId: "task-1",
        agentId: "agent-busy",
        runId: `noise-run-${index}`,
        status: "completed",
        updatedAt: new Date(now.getTime() + (index + 1) * 60_000),
      });

    const agents = await context.queries.listAgents("project-1");
    const quiet = agents.find((agent) => agent.agentId === "agent-quiet");
    expect(quiet?.state).toBe("working");
    expect(quiet?.primaryRun?.runId).toBe("run-quiet");
    expect(quiet?.activeRuns.total).toBe(1);
  });

  test("an assigned stage with no run reports assigned, not working", async () => {
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
    await context.manifests.save({
      id: "manifest-1",
      projectId: "project-1",
      revision: 1,
      manifest,
      appliedAt: now,
    });
    const pipeline = PipelineRun.create({
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
    // A stage can legitimately be assigned before any AgentRun is scheduled.
    pipeline.assign("agent-1", "architect", now);
    await context.pipelines.insert(pipeline);

    const detail = await context.queries.getProjectDetail("project-1");
    const agent = detail.agents.find((value) => value.agentId === "agent-1");

    // The two authoritative statements must not contradict each other: there
    // is no active run, so `agentsWorking` is 0 and the agent is `assigned`.
    expect(detail.summary.agentsWorking).toBe(0);
    expect(agent?.state).toBe("assigned");
    expect(agent?.activeRuns.total).toBe(0);
    expect(agent?.activeStages.total).toBe(1);
    expect(agent?.primaryStage?.stageId).toBe("design");
    expect(
      detail.agents.filter(
        (value) => value.enabled && value.state === "working",
      ),
    ).toHaveLength(0);
  });

  test("several active runs for one agent are all reported and counted once", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedAgent(context, "project-1", "agent-1", "developer");
    for (const [index, taskId] of ["task-a", "task-b"].entries()) {
      await context.tasks.save(
        Task.create({
          id: taskId,
          projectId: "project-1",
          title: `Task ${taskId}`,
          now,
        }),
      );
      // The task lock is per task, not per agent, so one agent legitimately
      // holds two in-flight runs at once.
      await seedRun(context, {
        projectId: "project-1",
        taskId,
        agentId: "agent-1",
        runId: `run-${taskId}`,
        status: "running",
        updatedAt: new Date(now.getTime() + index * 60_000),
      });
    }

    const detail = await context.queries.getProjectDetail("project-1");
    const agent = detail.agents.find((value) => value.agentId === "agent-1");

    // One distinct agent is working, and it reports both of its runs.
    expect(detail.summary.agentsWorking).toBe(1);
    expect(detail.summary.activeAgentRuns).toBe(2);
    expect(agent?.state).toBe("working");
    expect(agent?.activeRuns.total).toBe(2);
    expect(agent?.activeRuns.truncated).toBe(false);
    expect(
      [...(agent?.activeRuns.items ?? [])].map((value) => value.runId).sort(),
    ).toEqual(["run-task-a", "run-task-b"]);
    // Newest-updated first, and named as a representative rather than the one.
    expect(agent?.primaryRun?.runId).toBe("run-task-b");
    expect(agent?.primaryRun?.task?.title).toBe("Task task-b");
  });

  test("several assigned stages for one agent are all reported", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedAgent(context, "project-1", "agent-1", "developer");
    await context.manifests.save({
      id: "manifest-1",
      projectId: "project-1",
      revision: 1,
      manifest,
      appliedAt: now,
    });
    for (const [index, taskId] of ["task-a", "task-b"].entries()) {
      await context.tasks.save(
        Task.create({
          id: taskId,
          projectId: "project-1",
          title: `Task ${taskId}`,
          now,
        }),
      );
      const pipeline = PipelineRun.create({
        id: `pipeline-${taskId}`,
        projectId: "project-1",
        taskId,
        manifestRevisionId: "manifest-1",
        manifestRevision: 1,
        definition: manifest.pipelines[0]!,
        startedBy: "operator",
        stageRunIds: [`stage-a-${taskId}`, `stage-b-${taskId}`],
        now: new Date(now.getTime() + index * 60_000),
      });
      // Pipeline assignment does not reject an agent that another active stage
      // already names, so both assignments are valid persisted facts.
      pipeline.assign("agent-1", "architect", now);
      await context.pipelines.insert(pipeline);
    }

    const detail = await context.queries.getProjectDetail("project-1");
    const agent = detail.agents.find((value) => value.agentId === "agent-1");

    expect(agent?.state).toBe("assigned");
    expect(agent?.activeStages.total).toBe(2);
    expect(agent?.activeStages.truncated).toBe(false);
    expect(
      [...(agent?.activeStages.items ?? [])]
        .map((value) => value.pipelineRunId)
        .sort(),
    ).toEqual(["pipeline-task-a", "pipeline-task-b"]);
    expect(detail.summary.agentsWorking).toBe(0);
    expect(detail.summary.activePipelineRuns).toBe(2);
  });

  test("agentsWorking equals the enabled agents whose state is working", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await seedAgent(context, "project-1", "agent-run", "developer");
    await seedAgent(context, "project-1", "agent-off", "reviewer");
    await context.tasks.save(
      Task.create({
        id: "task-1",
        projectId: "project-1",
        title: "Ship it",
        now,
      }),
    );
    await seedRun(context, {
      projectId: "project-1",
      taskId: "task-1",
      agentId: "agent-run",
      runId: "run-1",
      status: "running",
      updatedAt: now,
    });
    // A disabled agent holding an active run reports `disabled`, so its run
    // must not be counted by the aggregate either.
    await seedRun(context, {
      projectId: "project-1",
      taskId: "task-1",
      agentId: "agent-off",
      runId: "run-2",
      status: "running",
      updatedAt: now,
    });
    context.database
      .prepare("UPDATE agent SET enabled = 0 WHERE id = ?")
      .run("agent-off");

    const detail = await context.queries.getProjectDetail("project-1");
    const working = detail.agents.filter(
      (agent) => agent.enabled && agent.state === "working",
    );

    expect(detail.summary.agentsWorking).toBe(working.length);
    expect(detail.summary.agentsWorking).toBe(1);
    expect(
      detail.agents.find((agent) => agent.agentId === "agent-off")?.state,
    ).toBe("disabled");
    // The run itself is still an exact active run; only the agent count changes.
    expect(detail.summary.activeAgentRuns).toBe(2);

    const overview = await context.queries.getDashboardOverview();
    expect(overview.totals.agentsWorking).toBe(1);
  });

  test("attention survives a blocked task outside the displayed page", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");

    // Low-priority blocked task, so the first page of tasks never contains it.
    const filler = queryLimits.tasks.default + 5;
    for (let index = 0; index < filler; index += 1)
      await context.tasks.save(
        Task.create({
          id: `task-${index}`,
          projectId: "project-1",
          title: `Task ${index}`,
          priority: 50,
          now,
        }),
      );
    context.database
      .prepare(
        `INSERT INTO task(id, project_id, title, description, status, priority,
                          created_at, updated_at)
         VALUES (?, ?, ?, NULL, 'blocked', -100, ?, ?)`,
      )
      .run(
        "task-blocked",
        "project-1",
        "Blocked and invisible",
        now.toISOString(),
        now.toISOString(),
      );

    const detail = await context.queries.getProjectDetail("project-1", {
      taskLimit: 5,
    });
    expect(
      detail.tasks.items.some((task) => task.taskId === "task-blocked"),
    ).toBe(false);
    expect(detail.tasks.truncated).toBe(true);
    expect(detail.tasks.total).toBe(filler + 1);
    expect(detail.summary.attentionRequired).toBe(true);
    expect(detail.summary.attention.total).toBeGreaterThan(0);
    expect(
      detail.summary.attention.items.some(
        (reason) => reason.subjectId === "task-blocked",
      ),
    ).toBe(true);

    const overview = await context.queries.getDashboardOverview();
    expect(overview.projects[0]?.attentionRequired).toBe(true);
    expect(overview.totals.attentionItems).toBeGreaterThan(0);
  });

  test("pending review totals stay exact beyond the attention sample", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    const governance = new ManageGovernance(
      context.projects,
      context.governance,
      context.ids,
      context.clock,
    );
    const reviewsWanted = queryLimits.attention.default + 3;
    for (let index = 0; index < reviewsWanted; index += 1) {
      await context.tasks.save(
        Task.create({
          id: `task-${index}`,
          projectId: "project-1",
          title: `Task ${index}`,
          now,
        }),
      );
      await governance.createReview({
        projectId: "project-1",
        subjectType: "task",
        subjectId: `task-${index}`,
        reviewer: { type: "user", id: "alice" },
      });
    }

    const overview = await context.queries.getDashboardOverview();
    expect(overview.totals.pendingReviews).toBe(reviewsWanted);
    expect(overview.projects[0]?.pendingReviews).toBe(reviewsWanted);
    expect(overview.attention.total).toBeGreaterThanOrEqual(reviewsWanted);
    expect(overview.attention.truncated).toBe(true);

    const detail = await context.queries.getProjectDetail("project-1");
    expect(detail.summary.pendingReviews).toBe(reviewsWanted);
  });

  test("pipeline history returns the most recent runs, not the oldest", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");
    await context.manifests.save({
      id: "manifest-1",
      projectId: "project-1",
      revision: 1,
      manifest,
      appliedAt: now,
    });

    const total = 12;
    const limit = 3;
    for (let index = 0; index < total; index += 1) {
      await context.tasks.save(
        Task.create({
          id: `task-${index}`,
          projectId: "project-1",
          title: `Task ${index}`,
          now,
        }),
      );
      const created = new Date(now.getTime() + index * 60_000);
      const run = PipelineRun.create({
        id: `pipeline-${String(index).padStart(2, "0")}`,
        projectId: "project-1",
        taskId: `task-${index}`,
        manifestRevisionId: "manifest-1",
        manifestRevision: 1,
        definition: manifest.pipelines[0]!,
        startedBy: "operator",
        stageRunIds: [`stage-a-${index}`, `stage-b-${index}`],
        now: created,
      });
      await context.pipelines.insert(run);
    }

    const page = await context.queries.listPipelineRuns("project-1", { limit });
    expect(page.total).toBe(total);
    expect(page.truncated).toBe(true);
    expect(page.items.map((value) => value.pipelineRunId)).toEqual([
      "pipeline-11",
      "pipeline-10",
      "pipeline-09",
    ]);
    // The persisted stage sequence still comes through the read-side query.
    expect(page.items[0]?.stages.map((stage) => stage.name)).toEqual([
      "Architecture",
      "Implementation",
    ]);
    expect(page.items[0]?.task?.title).toBe("Task 11");

    const detail = await context.queries.getProjectDetail("project-1", {
      pipelineLimit: 2,
    });
    expect(detail.pipelines.total).toBe(total);
    expect(detail.pipelines.items.map((value) => value.pipelineRunId)).toEqual([
      "pipeline-11",
      "pipeline-10",
    ]);
  });

  test("run-scoped activity survives beyond the project activity window", async () => {
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
    await seedRun(context, {
      projectId: "project-1",
      taskId: "task-1",
      agentId: "agent-1",
      runId: "run-1",
      status: "running",
      updatedAt: now,
    });

    // The run's own event is the oldest thing in the project.
    context.database
      .prepare(
        `INSERT INTO audit_event(id, project_id, event_type, actor_type,
                                 actor_id, aggregate_type, aggregate_id,
                                 payload_json, occurred_at)
         VALUES (?, ?, 'run.started', 'daemon', NULL, 'agent_run', 'run-1', ?, ?)`,
      )
      .run("event-run", "project-1", JSON.stringify({ step: 1 }), now.toISOString());

    const noise = queryLimits.activity.max + 20;
    for (let index = 0; index < noise; index += 1)
      context.database
        .prepare(
          `INSERT INTO audit_event(id, project_id, event_type, actor_type,
                                   actor_id, aggregate_type, aggregate_id,
                                   payload_json, occurred_at)
           VALUES (?, ?, 'command.completed', 'daemon', NULL, NULL, NULL, ?, ?)`,
        )
        .run(
          `noise-${index}`,
          "project-1",
          JSON.stringify({ command: "task:list" }),
          new Date(now.getTime() + (index + 1) * 1000).toISOString(),
        );

    const detail = await context.queries.getRunDetail("run-1");
    expect(detail.activity.items.map((entry) => entry.eventId)).toEqual([
      "event-run",
    ]);
  });

  test("activity paging never skips events sharing a timestamp", async () => {
    const context = await fixture();
    await seedProject(context, "project-1", "One");

    // Nine events on the same instant, paged three at a time: the boundary
    // falls inside the tie, which is exactly where a timestamp-only cursor
    // loses rows.
    const shared = now.toISOString();
    const expected: string[] = [];
    for (let index = 0; index < 9; index += 1) {
      const id = `same-${String(index).padStart(2, "0")}`;
      expected.push(id);
      context.database
        .prepare(
          `INSERT INTO audit_event(id, project_id, event_type, actor_type,
                                   actor_id, aggregate_type, aggregate_id,
                                   payload_json, occurred_at)
           VALUES (?, ?, 'command.completed', 'daemon', NULL, NULL, NULL, ?, ?)`,
        )
        .run(id, "project-1", JSON.stringify({ index }), shared);
    }
    // Plus one older event, so the last page is not exactly full.
    context.database
      .prepare(
        `INSERT INTO audit_event(id, project_id, event_type, actor_type,
                                 actor_id, aggregate_type, aggregate_id,
                                 payload_json, occurred_at)
         VALUES (?, ?, 'command.completed', 'daemon', NULL, NULL, NULL, ?, ?)`,
      )
      .run(
        "older",
        "project-1",
        JSON.stringify({ index: -1 }),
        new Date(now.getTime() - 1000).toISOString(),
      );
    expected.push("older");

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const parsed = cursor === null ? undefined : parseActivityCursor(cursor);
      const result = await context.queries.listActivity({
        projectId: "project-1",
        limit: 3,
        ...(parsed === undefined ? {} : { cursor: parsed }),
      });
      seen.push(...result.items.map((entry) => entry.eventId));
      cursor = result.nextCursor;
      if (cursor === null) break;
    }

    // Every event exactly once, newest first, ties broken by descending id.
    expect(seen).toHaveLength(expected.length);
    expect(new Set(seen).size).toBe(expected.length);
    expect(seen).toEqual([
      "same-08",
      "same-07",
      "same-06",
      "same-05",
      "same-04",
      "same-03",
      "same-02",
      "same-01",
      "same-00",
      "older",
    ]);
  });
});
