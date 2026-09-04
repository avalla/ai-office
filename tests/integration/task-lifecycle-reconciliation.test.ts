/**
 * Task lifecycle, requirement linkage, and reconciliation against a real
 * migrated database.
 *
 * The point of these tests is that `task.status` is authoritative operational
 * state: it can be moved only by named transitions, only through the domain,
 * always with an audit record, and never across a project boundary.
 */

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
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteTaskRequirementRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-requirement.repository.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { InvalidTaskTransitionError } from "@ai-office/domain/errors.ts";
import { ManageTaskLifecycle } from "@ai-office/application/commands/manage-task-lifecycle.ts";
import {
  ManageTaskRequirements,
  RequirementNotFoundError,
} from "@ai-office/application/commands/manage-task-requirements.ts";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import { ListTaskBoard } from "@ai-office/application/queries/list-task-board.ts";
import {
  ReconcileTasks,
  TaskReconciliationApprovalError,
} from "@ai-office/application/commands/reconcile-tasks.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { TaskNotFoundError } from "@ai-office/application/commands/schedule-agent-run.ts";
import { ProjectNotFoundError } from "@ai-office/application/errors.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";

const roots: string[] = [];
const now = new Date("2026-09-04T10:00:00.000Z");

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
    ],
  },
  pipelines: [
    {
      id: "delivery",
      name: "Delivery",
      description: "Design",
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
      ],
    },
  ],
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-task-lifecycle-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));

  const clock = new FixedClock();
  const ids = new SequenceIds();
  const projects = new SqliteProjectRepository(database);
  const tasks = new SqliteTaskRepository(database);
  const governance = new SqliteGovernanceRepository(database);
  const links = new SqliteTaskRequirementRepository(database);
  const pipelines = new SqlitePipelineRunRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  const manifests = new SqliteOfficeManifestRepository(database);
  const transactions = new SqliteTransactionRunner(database);
  const audit = new RecordAuditEvent(
    new SqliteAuditEventRepository(database),
    ids,
    clock,
  );
  const lifecycle = new ManageTaskLifecycle(
    projects,
    tasks,
    audit,
    clock,
    transactions,
  );
  return {
    root,
    database,
    clock,
    ids,
    projects,
    tasks,
    governance,
    links,
    pipelines,
    runtime,
    manifests,
    transactions,
    audit,
    lifecycle,
    requirements: new ManageTaskRequirements(
      projects,
      tasks,
      governance,
      links,
      audit,
      clock,
      transactions,
    ),
    governanceService: new ManageGovernance(projects, governance, ids, clock),
    reconcile: new ReconcileTasks(
      projects,
      tasks,
      pipelines,
      runtime,
      links,
      lifecycle,
      clock,
    ),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function seedProject(
  context: Fixture,
  id: string,
  name = "Project",
): Promise<void> {
  await context.projects.save(Project.create({ id, name, now }));
}

async function seedTask(
  context: Fixture,
  projectId: string,
  id: string,
  title = "Work",
): Promise<void> {
  await context.tasks.save(
    Task.create({ id, projectId, title, now }),
  );
}

async function seedRequirement(
  context: Fixture,
  projectId: string,
  key: string,
): Promise<string> {
  return context.governanceService.createRequirement({
    projectId,
    key,
    title: `Requirement ${key}`,
    description: "Must hold",
  });
}

function auditEvents(
  context: Fixture,
  eventType: string,
): { aggregate_id: string; payload_json: string }[] {
  return context.database
    .query<{ aggregate_id: string; payload_json: string }, [string]>(
      "SELECT aggregate_id, payload_json FROM audit_event WHERE event_type = ? ORDER BY id",
    )
    .all(eventType);
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("task lifecycle commands", () => {
  test("starts, submits, and completes a task with an audit trail", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const command = {
      projectId: "project-1",
      taskId: "task-1",
      actorId: "local-operator",
    };

    expect(await context.lifecycle.start(command)).toBe("running");
    expect(await context.lifecycle.submitForReview(command)).toBe(
      "waiting_review",
    );
    expect(await context.lifecycle.complete(command)).toBe("completed");

    const stored = await context.tasks.findById("task-1");
    expect(stored?.snapshot().status).toBe("completed");
    // `updated_at` moves with the status; the clock is fixed, so the value is
    // the transition instant rather than whatever was written at creation.
    expect(stored?.snapshot().updatedAt).toEqual(now);

    const events = auditEvents(context, "task.status_changed");
    expect(events).toHaveLength(3);
    expect(events.map((row) => JSON.parse(row.payload_json))).toEqual([
      { operation: "start", from: "pending", to: "running" },
      {
        operation: "submit-review",
        from: "running",
        to: "waiting_review",
      },
      { operation: "complete", from: "waiting_review", to: "completed" },
    ]);
  });

  test("records the reason for a block on the audit event", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const command = {
      projectId: "project-1",
      taskId: "task-1",
      actorId: "local-operator",
    };
    await context.lifecycle.block({ ...command, reason: "waiting on vendor" });

    const [event] = auditEvents(context, "task.status_changed");
    expect(JSON.parse(event!.payload_json)).toEqual({
      operation: "block",
      from: "pending",
      to: "blocked",
      reason: "waiting on vendor",
    });
    expect(await context.lifecycle.unblock(command)).toBe("pending");
  });

  test("refuses an impossible transition and writes nothing", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const command = {
      projectId: "project-1",
      taskId: "task-1",
      actorId: "local-operator",
    };

    await expect(context.lifecycle.complete(command)).rejects.toBeInstanceOf(
      InvalidTaskTransitionError,
    );
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "pending",
    );
    // A refused transition is not an event: nothing happened.
    expect(auditEvents(context, "task.status_changed")).toHaveLength(0);
  });

  test("refuses to repeat a transition that already happened", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const command = {
      projectId: "project-1",
      taskId: "task-1",
      actorId: "local-operator",
    };
    await context.lifecycle.start(command);
    await context.lifecycle.complete(command);

    // Deliberately not idempotent: a repeated lifecycle event is an operator
    // mistake or a stale plan, and silently accepting it would hide both.
    await expect(context.lifecycle.complete(command)).rejects.toBeInstanceOf(
      InvalidTaskTransitionError,
    );
  });

  test("keeps projects isolated", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedProject(context, "project-2", "Other");
    await seedTask(context, "project-1", "task-1");

    // A task of another project reads as absent, never as forbidden.
    await expect(
      context.lifecycle.start({
        projectId: "project-2",
        taskId: "task-1",
        actorId: "local-operator",
      }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(
      context.lifecycle.start({
        projectId: "missing",
        taskId: "task-1",
        actorId: "local-operator",
      }),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
  });

  test("rolls the status back when the audit write fails", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const failing = new ManageTaskLifecycle(
      context.projects,
      context.tasks,
      {
        execute: async () => {
          throw new Error("audit unavailable");
        },
      } as unknown as RecordAuditEvent,
      context.clock,
      context.transactions,
    );

    await expect(
      failing.start({
        projectId: "project-1",
        taskId: "task-1",
        actorId: "local-operator",
      }),
    ).rejects.toThrow("audit unavailable");
    // The status write and its audit record establish the same change, so they
    // commit together or not at all.
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "pending",
    );
  });
});

describe("task transition introspection", () => {
  test("reports the allowed transitions without mutating anything", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await context.lifecycle.start({
      projectId: "project-1",
      taskId: "task-1",
      actorId: "local-operator",
    });

    const report = await context.lifecycle.transitions({
      projectId: "project-1",
      taskId: "task-1",
    });
    expect(report.status).toBe("running");
    expect(report.terminal).toBe(false);
    expect(report.allowed.map((value) => value.to)).toEqual([
      "waiting_review",
      "completed",
      "blocked",
      "failed",
      "cancelled",
    ]);
    // Each allowed transition names the command that performs it.
    expect(
      report.allowed.find((value) => value.to === "completed")?.command,
    ).toBe("task:complete");
    expect(report.terminalStatuses).toEqual([
      "completed",
      "failed",
      "cancelled",
    ]);

    // Discovery is read-only.
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "running",
    );
    expect(auditEvents(context, "task.status_changed")).toHaveLength(1);
  });

  test("reports a terminal task as having nothing available", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const command = {
      projectId: "project-1",
      taskId: "task-1",
      actorId: "local-operator",
    };
    await context.lifecycle.cancel(command);

    const report = await context.lifecycle.transitions(command);
    expect(report.terminal).toBe(true);
    expect(report.allowed).toEqual([]);
  });
});

describe("task requirement linkage", () => {
  test("links, lists, and unlinks", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const first = await seedRequirement(context, "project-1", "AUC-03-R1");
    const second = await seedRequirement(context, "project-1", "AUC-03-R2");
    const actorId = "local-operator";

    expect(
      await context.requirements.link({
        projectId: "project-1",
        taskId: "task-1",
        requirementId: first,
        actorId,
      }),
    ).toEqual({ created: true });
    await context.requirements.link({
      projectId: "project-1",
      taskId: "task-1",
      requirementId: second,
      actorId,
    });

    const linked = await context.requirements.listForTask(
      "project-1",
      "task-1",
    );
    expect(linked.map((value) => value.key)).toEqual([
      "AUC-03-R1",
      "AUC-03-R2",
    ]);
    expect(auditEvents(context, "task.requirement_linked")).toHaveLength(2);

    expect(
      await context.requirements.unlink({
        projectId: "project-1",
        taskId: "task-1",
        requirementId: first,
        actorId,
      }),
    ).toEqual({ removed: true });
    expect(
      (await context.requirements.listForTask("project-1", "task-1")).map(
        (value) => value.key,
      ),
    ).toEqual(["AUC-03-R2"]);
  });

  test("treats a repeated link and a missing unlink as no-ops", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const requirementId = await seedRequirement(context, "project-1", "R1");
    const input = {
      projectId: "project-1",
      taskId: "task-1",
      requirementId,
      actorId: "local-operator",
    };

    await context.requirements.link(input);
    // A link is a relation, not an event: asking for one that already holds is
    // not an error, and it emits no second audit record.
    expect(await context.requirements.link(input)).toEqual({ created: false });
    expect(auditEvents(context, "task.requirement_linked")).toHaveLength(1);

    await context.requirements.unlink(input);
    expect(await context.requirements.unlink(input)).toEqual({
      removed: false,
    });
    expect(auditEvents(context, "task.requirement_unlinked")).toHaveLength(1);
  });

  test("supports many-to-many in both directions", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-a");
    await seedTask(context, "project-1", "task-b");
    const shared = await seedRequirement(context, "project-1", "R-shared");
    const extra = await seedRequirement(context, "project-1", "R-extra");
    const actorId = "local-operator";

    // One requirement delivered by two tasks, and one task delivering two
    // requirements — both are ordinary, so neither side can be a foreign key.
    for (const taskId of ["task-a", "task-b"])
      await context.requirements.link({
        projectId: "project-1",
        taskId,
        requirementId: shared,
        actorId,
      });
    await context.requirements.link({
      projectId: "project-1",
      taskId: "task-a",
      requirementId: extra,
      actorId,
    });

    const grouped = await context.links.listForTasks("project-1", [
      "task-a",
      "task-b",
    ]);
    expect(grouped.get("task-a")?.map((value) => value.key)).toEqual([
      "R-extra",
      "R-shared",
    ]);
    expect(grouped.get("task-b")?.map((value) => value.key)).toEqual([
      "R-shared",
    ]);
  });

  test("refuses to link across a project boundary", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedProject(context, "project-2", "Other");
    await seedTask(context, "project-1", "task-1");
    const foreign = await seedRequirement(context, "project-2", "R1");

    await expect(
      context.requirements.link({
        projectId: "project-1",
        taskId: "task-1",
        requirementId: foreign,
        actorId: "local-operator",
      }),
    ).rejects.toBeInstanceOf(RequirementNotFoundError);

    // The database refuses it too, so a caller that bypasses the service still
    // cannot create a cross-project link.
    expect(() =>
      context.database
        .prepare(
          "INSERT INTO task_requirement(task_id, requirement_id, created_at) VALUES (?, ?, ?)",
        )
        .run("task-1", foreign, now.toISOString()),
    ).toThrow(/same project/u);
  });

  test("removes links when the task or requirement is deleted", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const requirementId = await seedRequirement(context, "project-1", "R1");
    await context.requirements.link({
      projectId: "project-1",
      taskId: "task-1",
      requirementId,
      actorId: "local-operator",
    });

    // Cascading keeps dangling references impossible.
    context.database.prepare("DELETE FROM task WHERE id = ?").run("task-1");
    expect(
      context.database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM task_requirement",
        )
        .get()?.count,
    ).toBe(0);
  });
});

describe("task board query", () => {
  test("reports status and requirement progress as separate facts", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "AUC-03", "Deliver");
    await seedTask(context, "project-1", "AUC-04", "Harden");
    const board = new ListTaskBoard(
      context.projects,
      context.tasks,
      context.links,
    );
    const actorId = "local-operator";

    const verified = await seedRequirement(context, "project-1", "AUC-03-R1");
    const open = await seedRequirement(context, "project-1", "AUC-04-R1");
    await context.requirements.link({
      projectId: "project-1",
      taskId: "AUC-03",
      requirementId: verified,
      actorId,
    });
    await context.requirements.link({
      projectId: "project-1",
      taskId: "AUC-04",
      requirementId: open,
      actorId,
    });
    for (const status of ["accepted", "implemented", "verified"] as const)
      await context.governanceService.setStatus({
        projectId: "project-1",
        kind: "requirement",
        id: verified,
        status,
      });

    const rows = await board.execute("project-1");
    const stale = rows.find((row) => row.taskId === "AUC-03")!;
    const healthy = rows.find((row) => row.taskId === "AUC-04")!;

    // The status stays what the task holds; the contradiction is a separate,
    // explicit fact rather than a rewritten status.
    expect(stale.status).toBe("pending");
    expect(stale.progress).toEqual({
      total: 1,
      verified: 1,
      terminal: 1,
      open: 0,
    });
    expect(stale.contradictsRequirements).toBe(true);

    expect(healthy.status).toBe("pending");
    expect(healthy.progress.open).toBe(1);
    // Open requirements under a pending task are ordinary, not a contradiction.
    expect(healthy.contradictsRequirements).toBe(false);
  });

  test("reports no progress for a task with no linked requirements", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const rows = await new ListTaskBoard(
      context.projects,
      context.tasks,
      context.links,
    ).execute("project-1");
    expect(rows[0]?.progress.total).toBe(0);
    expect(rows[0]?.contradictsRequirements).toBe(false);
  });
});

describe("task reconciliation", () => {
  /** A real agent row: pipeline stage assignment is a foreign key. */
  async function seedAgent(context: Fixture): Promise<void> {
    await context.runtime.saveRole(
      Role.create({
        id: "role-architect",
        projectId: "project-1",
        key: "architect",
        name: "Architect",
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
      id: "agent-x",
      projectId: "project-1",
      name: "architect-agent",
      roleId: "role-architect",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    await context.runtime.saveAgent(agent);
  }

  async function seedManifest(context: Fixture): Promise<void> {
    await context.manifests.save({
      id: "manifest-1",
      projectId: "project-1",
      revision: 1,
      manifest,
      appliedAt: now,
    });
  }

  async function seedPipeline(
    context: Fixture,
    input: { id: string; taskId: string; status: "active" | "completed" },
  ): Promise<void> {
    const run = PipelineRun.create({
      id: input.id,
      projectId: "project-1",
      taskId: input.taskId,
      manifestRevisionId: "manifest-1",
      manifestRevision: 1,
      definition: manifest.pipelines[0]!,
      startedBy: "operator",
      stageRunIds: [`${input.id}-stage`],
      now,
    });
    await context.pipelines.insert(run);
    if (input.status !== "completed") return;
    // One persisted UPDATE per domain transition: `pipeline_run_version_transition`
    // requires the version to advance by exactly one, which is the optimistic
    // concurrency guard the pipeline service relies on.
    let version = run.snapshot().version;
    run.assign("agent-x", "architect", now);
    expect(await context.pipelines.save(run, version)).toBe(true);
    version = run.snapshot().version;
    run.completeStage("agent-x", now);
    expect(run.snapshot().status).toBe("completed");
    expect(await context.pipelines.save(run, version)).toBe(true);
  }

  test("finds nothing wrong with a healthy project", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const requirementId = await seedRequirement(context, "project-1", "R1");
    await context.requirements.link({
      projectId: "project-1",
      taskId: "task-1",
      requirementId,
      actorId: "local-operator",
    });

    const report = await context.reconcile.inspect("project-1");
    expect(report.tasksInspected).toBe(1);
    expect(report.issues).toEqual([]);
    expect(report.planHash).toBeNull();
  });

  test("reports a terminal pipeline whose task never followed", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await seedManifest(context);
    await seedAgent(context);
    await seedPipeline(context, {
      id: "pipeline-1",
      taskId: "task-1",
      status: "completed",
    });
    // Force the divergence the reconciler is meant to catch: pipeline terminal,
    // task left behind.
    context.database
      .prepare("UPDATE task SET status = 'running' WHERE id = 'task-1'")
      .run();

    const report = await context.reconcile.inspect("project-1");
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      finding: "terminal_pipeline_open_task",
      severity: "inconsistent",
      repairable: true,
      suggestedCommand: "task:complete",
    });
    expect(report.planHash).not.toBeNull();
  });

  test("repairs only the approved plan and only through the domain", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await seedManifest(context);
    await seedAgent(context);
    await seedPipeline(context, {
      id: "pipeline-1",
      taskId: "task-1",
      status: "completed",
    });
    context.database
      .prepare("UPDATE task SET status = 'running' WHERE id = 'task-1'")
      .run();

    const report = await context.reconcile.inspect("project-1");
    await expect(
      context.reconcile.repair({
        projectId: "project-1",
        approvedPlanHash: "not-the-plan",
        actorId: "local-operator",
      }),
    ).rejects.toBeInstanceOf(TaskReconciliationApprovalError);

    const result = await context.reconcile.repair({
      projectId: "project-1",
      approvedPlanHash: report.planHash!,
      actorId: "local-operator",
    });
    expect(result.applied).toEqual([
      {
        taskId: "task-1",
        from: "running",
        to: "completed",
        operation: "complete",
      },
    ]);
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "completed",
    );
    // The repair used the lifecycle service, so it left the same audit record a
    // manual `task:complete` would have.
    expect(auditEvents(context, "task.status_changed")).toHaveLength(1);
  });

  test("refuses a repair whose evidence does not determine one outcome", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await seedManifest(context);
    await seedAgent(context);
    await seedPipeline(context, {
      id: "pipeline-1",
      taskId: "task-1",
      status: "completed",
    });
    await seedPipeline(context, {
      id: "pipeline-2",
      taskId: "task-1",
      status: "active",
    });
    context.database
      .prepare("UPDATE task SET status = 'running' WHERE id = 'task-1'")
      .run();

    const report = await context.reconcile.inspect("project-1");
    const issue = report.issues.find(
      (value) => value.finding === "terminal_pipeline_open_task",
    );
    expect(issue?.repairable).toBe(false);
    expect(issue?.refusalReason).toContain("still active");
    expect(report.planHash).toBeNull();
  });

  test("reports an active pipeline under a terminal task", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await seedManifest(context);
    await seedAgent(context);
    await seedPipeline(context, {
      id: "pipeline-1",
      taskId: "task-1",
      status: "active",
    });
    context.database
      .prepare("UPDATE task SET status = 'completed' WHERE id = 'task-1'")
      .run();

    const report = await context.reconcile.inspect("project-1");
    const issue = report.issues.find(
      (value) => value.finding === "active_pipeline_terminal_task",
    );
    expect(issue?.severity).toBe("inconsistent");
    expect(issue?.repairable).toBe(false);
    expect(issue?.refusalReason).toContain("cannot be reopened");
  });

  test("warns about the reported symptom without repairing it", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "AUC-03");
    const actorId = "local-operator";
    for (const key of ["AUC-03-R1", "AUC-03-R2"]) {
      const requirementId = await seedRequirement(context, "project-1", key);
      await context.requirements.link({
        projectId: "project-1",
        taskId: "AUC-03",
        requirementId,
        actorId,
      });
      for (const status of ["accepted", "implemented", "verified"] as const)
        await context.governanceService.setStatus({
          projectId: "project-1",
          kind: "requirement",
          id: requirementId,
          status,
        });
    }

    const report = await context.reconcile.inspect("project-1");
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0]).toMatchObject({
      finding: "stale_pending_task",
      severity: "warning",
      repairable: false,
      suggestedCommand: "task:complete",
    });
    expect(report.issues[0]?.summary).toContain("2/2 linked requirements");
    // Conservative refusal: verified requirements are acceptance state and do
    // not prove that operational work happened.
    expect(report.issues[0]?.refusalReason).toContain(
      "insufficient evidence that operational work completed",
    );
    expect(report.planHash).toBeNull();
  });

  test("warns about a completed task whose requirements are still open", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const requirementId = await seedRequirement(context, "project-1", "R1");
    await context.requirements.link({
      projectId: "project-1",
      taskId: "task-1",
      requirementId,
      actorId: "local-operator",
    });
    const command = {
      projectId: "project-1",
      taskId: "task-1",
      actorId: "local-operator",
    };
    await context.lifecycle.start(command);
    await context.lifecycle.complete(command);

    const report = await context.reconcile.inspect("project-1");
    const issue = report.issues.find(
      (value) => value.finding === "completed_task_open_requirements",
    );
    expect(issue?.severity).toBe("warning");
    expect(issue?.refusalReason).toContain("governance state");
  });

  test("warns about an in-flight task with nothing executing it", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await context.lifecycle.start({
      projectId: "project-1",
      taskId: "task-1",
      actorId: "local-operator",
    });

    const report = await context.reconcile.inspect("project-1");
    expect(report.issues.map((value) => value.finding)).toEqual([
      "in_flight_task_without_execution",
    ]);
    expect(report.issues[0]?.repairable).toBe(false);
  });

  test("keeps pipeline-driven transitions authoritative and atomic", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await seedManifest(context);
    await seedAgent(context);

    // `pipeline:start` drives pending -> running through the same domain method
    // `task:start` uses; there is one path per transition, not two.
    const run = PipelineRun.create({
      id: "pipeline-1",
      projectId: "project-1",
      taskId: "task-1",
      manifestRevisionId: "manifest-1",
      manifestRevision: 1,
      definition: manifest.pipelines[0]!,
      startedBy: "operator",
      stageRunIds: ["pipeline-1-stage"],
      now,
    });
    const task = (await context.tasks.findById("task-1"))!;
    task.start(now);
    await context.transactions.run(async () => {
      await context.tasks.save(task);
      await context.pipelines.insert(run);
    });
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "running",
    );

    // A terminal pipeline and its terminal task commit together: a rollback
    // must not leave one without the other.
    await expect(
      context.transactions.run(async () => {
        let version = run.snapshot().version;
        run.assign("agent-x", "architect", now);
        await context.pipelines.save(run, version);
        version = run.snapshot().version;
        run.completeStage("agent-x", now);
        await context.pipelines.save(run, version);
        const terminal = (await context.tasks.findById("task-1"))!;
        terminal.complete(now);
        await context.tasks.save(terminal);
        throw new Error("interrupted after both writes");
      }),
    ).rejects.toThrow("interrupted after both writes");

    const pipeline = await context.pipelines.findById(
      "pipeline-1",
      "project-1",
    );
    expect(pipeline?.snapshot().status).toBe("active");
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "running",
    );
    // Nothing diverged, so reconciliation has nothing to report either.
    const report = await context.reconcile.inspect("project-1");
    expect(
      report.issues.filter(
        (issue) => issue.finding === "terminal_pipeline_open_task",
      ),
    ).toEqual([]);
  });

  test("refuses to inspect an unknown project", async () => {
    const context = await fixture();
    await expect(context.reconcile.inspect("missing")).rejects.toBeInstanceOf(
      ProjectNotFoundError,
    );
  });
});
