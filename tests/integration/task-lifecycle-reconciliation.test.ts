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
import {
  DomainValidationError,
  InvalidTaskTransitionError,
} from "@ai-office/domain/errors.ts";
import { ManageTaskLifecycle } from "@ai-office/application/commands/manage-task-lifecycle.ts";
import {
  ManageTaskRequirements,
  RequirementNotFoundError,
} from "@ai-office/application/commands/manage-task-requirements.ts";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import { ListTaskBoard } from "@ai-office/application/queries/list-task-board.ts";
import {
  ReconcileTasks,
  TaskReconciliationApprovalError,
} from "@ai-office/application/commands/reconcile-tasks.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import {
  RecordTaskCompletion,
  TaskCompletionApprovalError,
} from "@ai-office/application/commands/record-task-completion.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import type { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
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

/**
 * Audit persistence that can be made to fail on demand.
 *
 * Failure is injected through the real replaceable port rather than by
 * reproducing the service's write sequence in the test: a refactor that moved a
 * write out of its transaction has to break these tests, which is the whole
 * point of having them.
 */
class FailableAuditEvents implements AuditEventRepository {
  private remaining = Number.POSITIVE_INFINITY;

  constructor(private readonly inner: AuditEventRepository) {}

  /** The next `count` appends succeed; the one after that throws. */
  failAfter(count: number): void {
    this.remaining = count;
  }

  async append(event: AuditEvent): Promise<void> {
    if (this.remaining <= 0) {
      this.remaining = Number.POSITIVE_INFINITY;
      throw new Error("audit persistence failed");
    }
    this.remaining -= 1;
    await this.inner.append(event);
  }
}

/**
 * Task persistence that can be made to fail on demand.
 *
 * Failing the task write specifically is what separates "the pipeline service
 * keeps both mutations in one transaction" from "it commits the pipeline and
 * then updates the task": under the first, a failing task write takes the
 * pipeline write with it; under the second, the pipeline is already committed.
 */
class FailableTasks implements TaskRepository {
  private failNextSave = false;

  constructor(private readonly inner: SqliteTaskRepository) {}

  failOnNextSave(): void {
    this.failNextSave = true;
  }

  async findById(id: string): Promise<Task | null> {
    return this.inner.findById(id);
  }

  async listByProject(projectId: string): Promise<Task[]> {
    return this.inner.listByProject(projectId);
  }

  async save(task: Task): Promise<void> {
    if (this.failNextSave) {
      this.failNextSave = false;
      throw new Error("task persistence failed");
    }
    await this.inner.save(task);
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
    // Non-empty because these tests read the manifest back through the
    // repository, which re-validates it.
    goals: ["Ship the slice"],
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
        responsibilities: ["Design the slice"],
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
          checks: ["Design reviewed"],
          requiresApproval: false,
          capabilities: ["fake.read"],
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
  const tasks = new FailableTasks(new SqliteTaskRepository(database));
  const governance = new SqliteGovernanceRepository(database);
  const links = new SqliteTaskRequirementRepository(database);
  const pipelines = new SqlitePipelineRunRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  const manifests = new SqliteOfficeManifestRepository(database);
  const transactions = new SqliteTransactionRunner(database);
  const events = new FailableAuditEvents(
    new SqliteAuditEventRepository(database),
  );
  const audit = new RecordAuditEvent(events, ids, clock);
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
    events,
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
    pipelineRuns: new ManagePipelineRuns(
      manifests,
      pipelines,
      tasks,
      runtime,
      audit,
      ids,
      clock,
      transactions,
    ),
    agentRuns: new ScheduleAgentRun(
      projects,
      tasks,
      runtime,
      ids,
      clock,
      transactions,
      pipelines,
    ),
    completion: new RecordTaskCompletion(
      projects,
      tasks,
      links,
      audit,
      clock,
      transactions,
    ),
    reconcile: new ReconcileTasks(
      projects,
      tasks,
      pipelines,
      runtime,
      links,
      lifecycle,
      clock,
      transactions,
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
      repairOperation: null,
      // Not `task:complete`: the lifecycle refuses it from `pending`, so
      // suggesting it would send an operator to a command that cannot run.
      suggestedCommand: "task:record-completion",
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

/**
 * The motivating defect, corrected honestly.
 *
 * A task left at `pending` while every requirement it delivers is verified can
 * now be put right — but only by an operator saying so, never by the system
 * inferring it, and never by walking the task through a `running` state nobody
 * observed.
 */
describe("historical completion record", () => {
  /** AUC-03 as reported: pending, two linked requirements, both verified. */
  async function stalePendingTask(
    context: Fixture,
    taskId = "AUC-03",
  ): Promise<void> {
    await seedTask(context, "project-1", taskId);
    for (const key of [`${taskId}-R1`, `${taskId}-R2`]) {
      const requirementId = await seedRequirement(context, "project-1", key);
      await context.requirements.link({
        projectId: "project-1",
        taskId,
        requirementId,
        actorId: "local-operator",
      });
      for (const status of ["accepted", "implemented", "verified"] as const)
        await context.governanceService.setStatus({
          projectId: "project-1",
          kind: "requirement",
          id: requirementId,
          status,
        });
    }
  }

  const attestation = {
    projectId: "project-1",
    taskId: "AUC-03",
    actorId: "local-operator",
    reason: "delivered in the M4 release before AI Office tracked this board",
  };

  test("describes the correction without mutating anything", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await stalePendingTask(context);

    const plan = await context.completion.plan(attestation);
    expect(plan).toMatchObject({
      taskId: "AUC-03",
      status: "pending",
      resultingStatus: "completed",
      kind: "historical_correction",
      available: true,
      refusalReason: null,
      rationaleRequired: true,
    });
    expect(plan.evidence).toEqual({
      total: 2,
      verified: 2,
      terminal: 2,
      open: 0,
    });
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/u);

    // A preflight is a read.
    expect((await context.tasks.findById("AUC-03"))?.snapshot().status).toBe(
      "pending",
    );
    expect(auditEvents(context, "task.completion_recorded")).toHaveLength(0);
    expect(auditEvents(context, "task.status_changed")).toHaveLength(0);
  });

  test("completes the stale task without inventing a start", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await stalePendingTask(context);

    const plan = await context.completion.plan(attestation);
    const result = await context.completion.record({
      ...attestation,
      approvedPlanHash: plan.planHash!,
    });
    expect(result).toMatchObject({
      taskId: "AUC-03",
      from: "pending",
      to: "completed",
      correction: true,
    });
    expect((await context.tasks.findById("AUC-03"))?.snapshot().status).toBe(
      "completed",
    );

    // The whole point: no fabricated execution history. There is no
    // `task.status_changed` at all, so in particular no `start`, and the task
    // was never `running`.
    expect(auditEvents(context, "task.status_changed")).toEqual([]);
    const [recorded] = auditEvents(context, "task.completion_recorded");
    expect(JSON.parse(recorded!.payload_json)).toEqual({
      operation: "record-completion",
      from: "pending",
      to: "completed",
      reason: attestation.reason,
      correction: true,
      evidence: { total: 2, verified: 2, terminal: 2, open: 0 },
      planHash: plan.planHash,
    });

    // And the board now agrees with itself.
    const report = await context.reconcile.inspect("project-1");
    expect(report.issues).toEqual([]);
  });

  test("refuses an approval that does not match the current plan", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await stalePendingTask(context);

    await expect(
      context.completion.record({
        ...attestation,
        approvedPlanHash: "not-the-plan",
      }),
    ).rejects.toBeInstanceOf(TaskCompletionApprovalError);
    expect((await context.tasks.findById("AUC-03"))?.snapshot().status).toBe(
      "pending",
    );
    expect(auditEvents(context, "task.completion_recorded")).toHaveLength(0);
  });

  test("invalidates an approval when the rationale or the evidence changes", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await stalePendingTask(context);
    const plan = await context.completion.plan(attestation);

    // The hash covers the attestation text, so an operator cannot approve one
    // statement and record a different one.
    await expect(
      context.completion.record({
        ...attestation,
        reason: "something else entirely",
        approvedPlanHash: plan.planHash!,
      }),
    ).rejects.toBeInstanceOf(TaskCompletionApprovalError);

    // It also covers the evidence shown, so a plan that has gone stale is
    // refused rather than applied against facts the operator never saw.
    const extra = await seedRequirement(context, "project-1", "AUC-03-R3");
    await context.requirements.link({
      projectId: "project-1",
      taskId: "AUC-03",
      requirementId: extra,
      actorId: "local-operator",
    });
    await expect(
      context.completion.record({
        ...attestation,
        approvedPlanHash: plan.planHash!,
      }),
    ).rejects.toBeInstanceOf(TaskCompletionApprovalError);
    expect((await context.tasks.findById("AUC-03"))?.snapshot().status).toBe(
      "pending",
    );
  });

  test("points at task:complete instead when the lifecycle can do the job", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await context.lifecycle.start({
      projectId: "project-1",
      taskId: "task-1",
      actorId: "local-operator",
    });

    const plan = await context.completion.plan({
      ...attestation,
      taskId: "task-1",
    });
    expect(plan).toMatchObject({
      status: "running",
      kind: "lifecycle_transition",
      available: false,
      suggestedCommand: "task:complete",
      planHash: null,
    });
    await expect(
      context.completion.record({
        ...attestation,
        taskId: "task-1",
        approvedPlanHash: "anything",
      }),
    ).rejects.toBeInstanceOf(TaskCompletionApprovalError);
  });

  test("never reopens a terminal task", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    const command = {
      projectId: "project-1",
      taskId: "task-1",
      actorId: "local-operator",
    };
    await context.lifecycle.cancel({ ...command, reason: "descoped" });

    const plan = await context.completion.plan({
      ...attestation,
      taskId: "task-1",
    });
    expect(plan).toMatchObject({
      status: "cancelled",
      kind: "none",
      available: false,
      suggestedCommand: null,
      planHash: null,
    });
    expect(plan.refusalReason).toContain("terminal");
  });

  test("requires a rationale that says something", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await stalePendingTask(context);
    for (const reason of ["", "   ", "x".repeat(2_001)])
      await expect(
        context.completion.plan({ ...attestation, reason }),
      ).rejects.toBeInstanceOf(DomainValidationError);
    expect(auditEvents(context, "task.completion_recorded")).toHaveLength(0);
  });

  test("stays inside the project it names", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedProject(context, "project-2", "Other");
    await stalePendingTask(context);

    await expect(
      context.completion.plan({ ...attestation, projectId: "project-2" }),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  test("rolls the correction back when the audit record cannot be written", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await stalePendingTask(context);
    const plan = await context.completion.plan(attestation);

    context.events.failAfter(0);
    await expect(
      context.completion.record({
        ...attestation,
        approvedPlanHash: plan.planHash!,
      }),
    ).rejects.toThrow("audit persistence failed");
    expect((await context.tasks.findById("AUC-03"))?.snapshot().status).toBe(
      "pending",
    );
  });

  test("refuses to record the same correction twice", async () => {
    // Terminal states are irreversible, so the second attempt has no plan to
    // approve at all: `completed` is not a status this correction applies from.
    const context = await fixture();
    await seedProject(context, "project-1");
    await stalePendingTask(context);
    const plan = await context.completion.plan(attestation);
    await context.completion.record({
      ...attestation,
      approvedPlanHash: plan.planHash!,
    });
    await expect(
      context.completion.record({
        ...attestation,
        approvedPlanHash: plan.planHash!,
      }),
    ).rejects.toBeInstanceOf(TaskCompletionApprovalError);
    expect(auditEvents(context, "task.completion_recorded")).toHaveLength(1);
    expect(
      (await context.completion.plan(attestation)).kind,
    ).toBe("none");
  });
});

/**
 * An approved reconciliation plan is applied whole or not at all.
 *
 * The operator approved a set of repairs. Committing a prefix of it would leave
 * the project in a state nobody approved, described by a plan hash that still
 * claims otherwise.
 */
describe("reconciliation plan atomicity", () => {
  async function twoRepairableTasks(context: Fixture): Promise<void> {
    await seedProject(context, "project-1");
    await context.manifests.save({
      id: "manifest-1",
      projectId: "project-1",
      revision: 1,
      manifest,
      appliedAt: now,
    });
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
        limits: { maxIterations: 1, maxCostMicros: 1000n, timeoutSeconds: 10 },
        sourcePath: "roles.yaml",
        now,
      }),
    );
    await context.runtime.saveAgent({
      id: "agent-x",
      projectId: "project-1",
      name: "architect-agent",
      roleId: "role-architect",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    for (const taskId of ["task-a", "task-b"]) {
      await seedTask(context, "project-1", taskId);
      const run = PipelineRun.create({
        id: `pipeline-${taskId}`,
        projectId: "project-1",
        taskId,
        manifestRevisionId: "manifest-1",
        manifestRevision: 1,
        definition: manifest.pipelines[0]!,
        startedBy: "operator",
        stageRunIds: [`pipeline-${taskId}-stage`],
        now,
      });
      await context.pipelines.insert(run);
      let version = run.snapshot().version;
      run.assign("agent-x", "architect", now);
      await context.pipelines.save(run, version);
      version = run.snapshot().version;
      run.completeStage("agent-x", now);
      await context.pipelines.save(run, version);
      context.database
        .prepare("UPDATE task SET status = 'running' WHERE id = ?")
        .run(taskId);
    }
  }

  test("applies every approved repair together", async () => {
    const context = await fixture();
    await twoRepairableTasks(context);

    const report = await context.reconcile.inspect("project-1");
    expect(report.issues.filter((issue) => issue.repairable)).toHaveLength(2);
    const result = await context.reconcile.repair({
      projectId: "project-1",
      approvedPlanHash: report.planHash!,
      actorId: "local-operator",
    });
    expect(result.applied.map((value) => value.taskId).sort()).toEqual([
      "task-a",
      "task-b",
    ]);
    for (const taskId of ["task-a", "task-b"])
      expect((await context.tasks.findById(taskId))?.snapshot().status).toBe(
        "completed",
      );
    expect(auditEvents(context, "task.status_changed")).toHaveLength(2);
  });

  test("commits nothing when a later repair fails", async () => {
    const context = await fixture();
    await twoRepairableTasks(context);
    const report = await context.reconcile.inspect("project-1");

    // The first repair's audit record is written; the second one's throws.
    context.events.failAfter(1);
    await expect(
      context.reconcile.repair({
        projectId: "project-1",
        approvedPlanHash: report.planHash!,
        actorId: "local-operator",
      }),
    ).rejects.toThrow("audit persistence failed");

    // Neither task moved, and the audit record of the repair that *did* run is
    // gone with it: an approved plan is one unit of work.
    for (const taskId of ["task-a", "task-b"])
      expect((await context.tasks.findById(taskId))?.snapshot().status).toBe(
        "running",
      );
    expect(auditEvents(context, "task.status_changed")).toEqual([]);

    // The plan is still there to be re-approved, unchanged.
    const again = await context.reconcile.inspect("project-1");
    expect(again.planHash).toBe(report.planHash);
  });
});

/**
 * Pipeline and task terminal state are one commit, proved through the service
 * that owns them.
 *
 * These drive `ManagePipelineRuns` itself rather than reproducing its write
 * sequence by hand. A test that re-enacted the sequence would prove only that
 * `SqliteTransactionRunner` rolls back, and would keep passing if a refactor
 * moved `syncTaskTerminal` outside the service's transaction — which is exactly
 * the regression worth catching.
 *
 * Failure is injected through the real audit port, which every one of these
 * paths writes to after it has already mutated both aggregates.
 */
describe("ManagePipelineRuns keeps pipeline and task in one transaction", () => {
  async function ready(context: Fixture): Promise<void> {
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await context.manifests.save({
      id: "manifest-1",
      projectId: "project-1",
      revision: 1,
      manifest,
      appliedAt: now,
    });
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
        limits: { maxIterations: 1, maxCostMicros: 1000n, timeoutSeconds: 10 },
        sourcePath: "roles.yaml",
        now,
      }),
    );
    await context.runtime.saveAgent({
      id: "agent-x",
      projectId: "project-1",
      name: "architect-agent",
      roleId: "role-architect",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  const start = {
    projectId: "project-1",
    taskId: "task-1",
    pipelineId: "delivery",
    principal: localOperatorPrincipal,
  };

  /** A running agent run holding the pipeline's only stage. */
  async function assignedAgentRun(
    context: Fixture,
    pipelineRunId: string,
  ): Promise<string> {
    await context.pipelineRuns.assign({
      projectId: "project-1",
      pipelineRunId,
      agentId: "agent-x",
      principal: localOperatorPrincipal,
    });
    const agentRunId = await context.agentRuns.execute({
      projectId: "project-1",
      taskId: "task-1",
      agentId: "agent-x",
    });
    const agentRun = (await context.runtime.findRun(agentRunId))!;
    agentRun.transition("preparing", now);
    agentRun.transition("running", now);
    await context.runtime.saveRun(agentRun);
    return agentRunId;
  }

  test("starts the pipeline and the task together", async () => {
    const context = await fixture();
    await ready(context);
    const run = await context.pipelineRuns.start(start);
    expect(run.snapshot().status).toBe("active");
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "running",
    );
  });

  test("starts neither when the start cannot be recorded", async () => {
    const context = await fixture();
    await ready(context);

    context.events.failAfter(0);
    await expect(context.pipelineRuns.start(start)).rejects.toThrow(
      "audit persistence failed",
    );

    // The task never started, and no pipeline exists to explain why it would
    // have. Both writes preceded the failing audit append.
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "pending",
    );
    expect(await context.pipelines.listByProject("project-1")).toEqual([]);
  });

  test("completes the pipeline and the task together", async () => {
    const context = await fixture();
    await ready(context);
    const run = await context.pipelineRuns.start(start);
    const agentRunId = await assignedAgentRun(context, run.snapshot().id);

    const completed = await context.pipelineRuns.completeStageFromAgentRun({
      projectId: "project-1",
      agentRunId,
    });
    expect(completed.snapshot().status).toBe("completed");
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "completed",
    );
  });

  test("completes neither when the stage completion cannot be recorded", async () => {
    const context = await fixture();
    await ready(context);
    const run = await context.pipelineRuns.start(start);
    const pipelineRunId = run.snapshot().id;
    const agentRunId = await assignedAgentRun(context, pipelineRunId);

    // `completeStageFromAgentRun` persists the pipeline, syncs the task, then
    // writes its events. Failing the first event proves both preceding writes
    // are inside the same transaction.
    context.events.failAfter(0);
    await expect(
      context.pipelineRuns.completeStageFromAgentRun({
        projectId: "project-1",
        agentRunId,
      }),
    ).rejects.toThrow("audit persistence failed");

    expect(
      (await context.pipelines.findById(pipelineRunId, "project-1"))?.snapshot()
        .status,
    ).toBe("active");
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "running",
    );
    // And reconciliation sees nothing to repair, because nothing diverged.
    expect(
      (await context.reconcile.inspect("project-1")).issues.filter(
        (issue) => issue.finding === "terminal_pipeline_open_task",
      ),
    ).toEqual([]);
  });

  test("rolls the pipeline back when the task it terminates cannot be saved", async () => {
    const context = await fixture();
    await ready(context);
    const run = await context.pipelineRuns.start(start);
    const pipelineRunId = run.snapshot().id;
    const agentRunId = await assignedAgentRun(context, pipelineRunId);

    // This is the direction a "commit the pipeline, then sync the task" refactor
    // would break: the task write fails, and the pipeline must not survive it.
    context.tasks.failOnNextSave();
    await expect(
      context.pipelineRuns.completeStageFromAgentRun({
        projectId: "project-1",
        agentRunId,
      }),
    ).rejects.toThrow("task persistence failed");

    expect(
      (await context.pipelines.findById(pipelineRunId, "project-1"))?.snapshot()
        .status,
    ).toBe("active");
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "running",
    );
  });

  test("rolls the pipeline back when a cancelled task cannot be saved", async () => {
    const context = await fixture();
    await ready(context);
    const run = await context.pipelineRuns.start(start);
    const pipelineRunId = run.snapshot().id;

    context.tasks.failOnNextSave();
    await expect(
      context.pipelineRuns.cancel({
        projectId: "project-1",
        pipelineRunId,
        principal: localOperatorPrincipal,
      }),
    ).rejects.toThrow("task persistence failed");

    expect(
      (await context.pipelines.findById(pipelineRunId, "project-1"))?.snapshot()
        .status,
    ).toBe("active");
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "running",
    );
  });

  test("cancels neither when the cancellation cannot be recorded", async () => {
    const context = await fixture();
    await ready(context);
    const run = await context.pipelineRuns.start(start);
    const pipelineRunId = run.snapshot().id;

    context.events.failAfter(0);
    await expect(
      context.pipelineRuns.cancel({
        projectId: "project-1",
        pipelineRunId,
        principal: localOperatorPrincipal,
      }),
    ).rejects.toThrow("audit persistence failed");

    expect(
      (await context.pipelines.findById(pipelineRunId, "project-1"))?.snapshot()
        .status,
    ).toBe("active");
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "running",
    );
  });
});

describe("lifecycle rationale at the application boundary", () => {
  const command = {
    projectId: "project-1",
    taskId: "task-1",
    actorId: "local-operator",
  };

  test("refuses a blank mandatory reason and writes nothing", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");

    for (const reason of ["", "   "]) {
      await expect(
        context.lifecycle.block({ ...command, reason }),
      ).rejects.toBeInstanceOf(DomainValidationError);
      await expect(
        context.lifecycle.fail({ ...command, reason }),
      ).rejects.toBeInstanceOf(DomainValidationError);
    }
    expect((await context.tasks.findById("task-1"))?.snapshot().status).toBe(
      "pending",
    );
    expect(auditEvents(context, "task.status_changed")).toEqual([]);
  });

  test("bounds the reason length", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await expect(
      context.lifecycle.block({ ...command, reason: "x".repeat(2_001) }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    expect(
      await context.lifecycle.block({ ...command, reason: "  spaced  " }),
    ).toBe("blocked");
    const [event] = auditEvents(context, "task.status_changed");
    // Stored trimmed, exactly as the operator meant it.
    expect(JSON.parse(event!.payload_json).reason).toBe("spaced");
  });

  test("refuses an optional reason that is present but empty", async () => {
    const context = await fixture();
    await seedProject(context, "project-1");
    await seedTask(context, "project-1", "task-1");
    await expect(
      context.lifecycle.cancel({ ...command, reason: "  " }),
    ).rejects.toBeInstanceOf(DomainValidationError);
    // Omitting it entirely stays legal: `task:cancel` never demanded one.
    expect(await context.lifecycle.cancel(command)).toBe("cancelled");
  });
});
