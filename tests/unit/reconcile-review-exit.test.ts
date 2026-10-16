/**
 * Review-exit findings of task reconciliation, derived in memory.
 *
 * A dependent admitted while its prerequisite was in review inherits the
 * prerequisite's review outcome: a blocked prerequisite stalls it, a failed
 * or cancelled one strands it permanently. These tests pin the finding shape
 * — transition, severity, suggested command, repair operation — without a
 * database; the SQLite integration suite proves the same through real
 * lifecycle transitions and storage.
 */

import { describe, expect, test } from "vitest";
import type { Agent } from "@ai-office/domain/agent/agent.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { Role } from "@ai-office/domain/agent/role.ts";
import type { AgentExecutionResult } from "@ai-office/agent-runtime/executor.ts";
import type { AuditEvent } from "@ai-office/domain/event/audit-event.ts";
import {
  Project as ProjectAggregate,
  type Project,
  type ProjectId,
} from "@ai-office/domain/project/project.ts";
import {
  Task as TaskAggregate,
  type Task,
  type TaskId,
  type TaskStatus,
} from "@ai-office/domain/task/task.ts";
import type {
  PipelineOverrideRecord,
  PipelineRun,
} from "@ai-office/domain/pipeline/pipeline-run.ts";
import { ManageTaskLifecycle } from "@ai-office/application/commands/manage-task-lifecycle.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import {
  ReconcileTasks,
  TaskReconciliationApprovalError,
} from "@ai-office/application/commands/reconcile-tasks.ts";
import type {
  AgentRunEvent,
  AgentRuntimeRepository,
  RunAdmission,
  WorkerAuthorityFence,
} from "@ai-office/application/ports/agent-runtime-repository.port.ts";
import type { AuditEventRepository } from "@ai-office/application/ports/audit-event-repository.port.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import type { PipelineRunRepository } from "@ai-office/application/ports/pipeline-run-repository.port.ts";
import type { ProjectRepository } from "@ai-office/application/ports/project-repository.port.ts";
import type {
  TaskDependency,
  TaskDependencyRepository,
} from "@ai-office/application/ports/task-dependency-repository.port.ts";
import type { TaskRepository } from "@ai-office/application/ports/task-repository.port.ts";
import type {
  LinkedRequirement,
  TaskRequirementLink,
  TaskRequirementRepository,
} from "@ai-office/application/ports/task-requirement-repository.port.ts";
import type { TransactionRunner } from "@ai-office/application/ports/transaction-runner.port.ts";

const now = new Date("2026-10-15T10:00:00.000Z");

class FixedClock implements Clock {
  now(): Date {
    return new Date(now);
  }
}

class SequenceIds implements IdGenerator {
  private next = 0;
  generate(): string {
    this.next += 1;
    return `id-${this.next}`;
  }
}

class InMemoryProjects implements ProjectRepository {
  readonly values = new Map<ProjectId, Project>();
  async findById(id: ProjectId): Promise<Project | null> {
    return this.values.get(id) ?? null;
  }
  async save(project: Project): Promise<void> {
    this.values.set(project.snapshot().id, project);
  }
}

class InMemoryTasks implements TaskRepository {
  readonly values = new Map<TaskId, Task>();
  async findById(id: TaskId): Promise<Task | null> {
    return this.values.get(id) ?? null;
  }
  async listByProject(projectId: ProjectId): Promise<Task[]> {
    // The same deterministic order both storage adapters guarantee.
    return [...this.values.values()]
      .filter((task) => task.snapshot().projectId === projectId)
      .sort(
        (left, right) =>
          right.snapshot().priority - left.snapshot().priority ||
          left.snapshot().createdAt.getTime() -
            right.snapshot().createdAt.getTime() ||
          left.snapshot().id.localeCompare(right.snapshot().id),
      );
  }
  async save(task: Task): Promise<void> {
    this.values.set(task.snapshot().id, task);
  }
}

function unused(name: string): never {
  throw new Error(`${name} is not used by reconciliation`);
}

class InMemoryPipelines implements PipelineRunRepository {
  readonly values: PipelineRun[] = [];
  async insert(): Promise<void> {
    unused("insert");
  }
  async findById(): Promise<PipelineRun | null> {
    return unused("findById");
  }
  async findActiveByTask(): Promise<PipelineRun | null> {
    return unused("findActiveByTask");
  }
  async listByProject(): Promise<PipelineRun[]> {
    return this.values;
  }
  async listActiveByProject(): Promise<PipelineRun[]> {
    return unused("listActiveByProject");
  }
  async save(): Promise<boolean> {
    return unused("save");
  }
  async appendOverride(): Promise<void> {
    unused("appendOverride");
  }
  async listOverrides(): Promise<PipelineOverrideRecord[]> {
    return unused("listOverrides");
  }
}

class InMemoryRuntime implements AgentRuntimeRepository {
  readonly runs: AgentRun[] = [];
  async admitQueuedRun(_input: RunAdmission): Promise<AgentRun | null> {
    return unused("admitQueuedRun");
  }
  async executionOwner(): Promise<string | null> {
    return unused("executionOwner");
  }
  async findTaskLock(): Promise<{ runId: string; expiresAt: Date } | null> {
    return unused("findTaskLock");
  }
  async saveRole(_role: Role): Promise<void> {
    unused("saveRole");
  }
  async findRole(): Promise<Role | null> {
    return unused("findRole");
  }
  async listRoles(): Promise<Role[]> {
    return unused("listRoles");
  }
  async saveAgent(_agent: Agent): Promise<void> {
    unused("saveAgent");
  }
  async listAgents(): Promise<Agent[]> {
    return unused("listAgents");
  }
  async findAgent(): Promise<Agent | null> {
    return unused("findAgent");
  }
  async saveRun(run: AgentRun): Promise<void> {
    this.runs.push(run);
  }
  async acceptWorkerResult(_input: {
    fence: WorkerAuthorityFence;
    run: AgentRun;
    result: AgentExecutionResult;
    acceptedAt: Date;
  }): Promise<boolean> {
    return unused("acceptWorkerResult");
  }
  async findRun(): Promise<AgentRun | null> {
    return unused("findRun");
  }
  async listRuns(projectId: string): Promise<AgentRun[]> {
    return this.runs.filter(
      (run) => run.snapshot().projectId === projectId,
    );
  }
  async listQueuedRuns(): Promise<AgentRun[]> {
    return unused("listQueuedRuns");
  }
  async listRecoverableRuns(): Promise<AgentRun[]> {
    return unused("listRecoverableRuns");
  }
  async listRunEvents(): Promise<AgentRunEvent[]> {
    return unused("listRunEvents");
  }
  async acquireTaskLock(): Promise<boolean> {
    return unused("acquireTaskLock");
  }
  async renewTaskLock(): Promise<boolean> {
    return unused("renewTaskLock");
  }
  async releaseTaskLock(): Promise<boolean> {
    return unused("releaseTaskLock");
  }
}

class InMemoryLinks implements TaskRequirementRepository {
  async link(): Promise<boolean> {
    return unused("link");
  }
  async unlink(): Promise<boolean> {
    return unused("unlink");
  }
  async listForTask(): Promise<LinkedRequirement[]> {
    return unused("listForTask");
  }
  async listForTasks(
    _projectId: string,
    taskIds: readonly string[],
  ): Promise<Map<string, LinkedRequirement[]>> {
    return new Map(taskIds.map((taskId) => [taskId, []]));
  }
  async listByProject(): Promise<TaskRequirementLink[]> {
    return unused("listByProject");
  }
}

class InMemoryDependencies implements TaskDependencyRepository {
  readonly edges: TaskDependency[] = [];
  /** Set to make the read fail, proving repository errors propagate. */
  failure: Error | null = null;
  async listByProject(projectId: string): Promise<TaskDependency[]> {
    if (this.failure !== null) throw this.failure;
    // The same deterministic edge order both storage adapters guarantee.
    return this.edges
      .filter((edge) => edge.projectId === projectId)
      .sort(
        (left, right) =>
          left.taskId.localeCompare(right.taskId) ||
          left.dependsOnTaskId.localeCompare(right.dependsOnTaskId),
      );
  }
  async hasExecutionHistory(): Promise<boolean> {
    return true;
  }
  async link(dependency: TaskDependency): Promise<boolean> {
    this.edges.push(dependency);
    return true;
  }
  async unlink(): Promise<boolean> {
    return unused("unlink");
  }
}

class RecordedAuditEvents implements AuditEventRepository {
  readonly events: AuditEvent[] = [];
  async append(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }
}

class InMemoryTransactions implements TransactionRunner {
  async run<T>(work: () => Promise<T>): Promise<T> {
    return work();
  }
}

function task(id: string, status: TaskStatus): Task {
  const created = TaskAggregate.create({
    id,
    projectId: "project-1",
    title: `Task ${id}`,
    now,
  });
  if (status === "pending") return created;
  return TaskAggregate.restore({ ...created.snapshot(), status });
}

async function fixture(
  tasks: readonly Task[],
  edges: readonly { taskId: string; dependsOnTaskId: string }[],
) {
  const projects = new InMemoryProjects();
  await projects.save(
    ProjectAggregate.create({ id: "project-1", name: "Project", now }),
  );
  const taskStore = new InMemoryTasks();
  for (const value of tasks) await taskStore.save(value);
  const dependencies = new InMemoryDependencies();
  for (const edge of edges)
    await dependencies.link({
      projectId: "project-1",
      taskId: edge.taskId,
      dependsOnTaskId: edge.dependsOnTaskId,
      createdAt: now,
    });
  const clock = new FixedClock();
  const events = new RecordedAuditEvents();
  const audit = new RecordAuditEvent(events, new SequenceIds(), clock);
  const transactions = new InMemoryTransactions();
  const pipelines = new InMemoryPipelines();
  const runtime = new InMemoryRuntime();
  const lifecycle = new ManageTaskLifecycle(
    projects,
    taskStore,
    audit,
    clock,
    transactions,
  );
  const reconcile = new ReconcileTasks(
    projects,
    taskStore,
    pipelines,
    runtime,
    new InMemoryLinks(),
    lifecycle,
    clock,
    transactions,
    undefined,
    dependencies,
  );
  return {
    projects,
    taskStore,
    dependencies,
    events,
    pipelines,
    runtime,
    reconcile,
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** Dependent `dependent` started behind prerequisite `upstream` at `exit`. */
async function reviewExitFixture(
  exit: "blocked" | "failed" | "cancelled",
  dependentStatus: "running" | "waiting_review",
): Promise<Fixture> {
  return fixture(
    [task("upstream", exit), task("dependent", dependentStatus)],
    [{ taskId: "dependent", dependsOnTaskId: "upstream" }],
  );
}

describe("review-exit findings", () => {
  test.each([
    ["blocked", "running", "block", "warning"],
    ["blocked", "waiting_review", "block", "warning"],
    ["failed", "running", "cancel", "inconsistent"],
    ["failed", "waiting_review", "cancel", "inconsistent"],
    ["cancelled", "running", "cancel", "inconsistent"],
    ["cancelled", "waiting_review", "cancel", "inconsistent"],
  ] as const)(
    "prerequisite exit to %s with dependent %s suggests %s at %s severity",
    async (exit, dependentStatus, operation, severity) => {
      const context = await reviewExitFixture(exit, dependentStatus);

      const report = await context.reconcile.inspect("project-1");
      const issue = report.issues.find(
        (value) => value.finding === "blocking_prerequisite_incomplete",
      );
      expect(issue).toMatchObject({
        taskId: "dependent",
        status: dependentStatus,
        severity,
        repairable: true,
        repairOperation: operation,
        suggestedCommand: `task:${operation}`,
        refusalReason: null,
        reviewExits: [{ taskId: "upstream", from: "waiting_review", to: exit }],
      });
      expect(issue?.summary).toBe(
        exit === "blocked"
          ? "started under review-ready admission; prerequisite upstream exited waiting_review -> blocked; work is stalled until the prerequisite recovers"
          : `started under review-ready admission; prerequisite upstream exited waiting_review -> ${exit} and can never complete this task`,
      );
      expect(report.planHash).toMatch(/^[0-9a-f]{64}$/u);
    },
  );

  test("a terminal exit dominates a recoverable one", async () => {
    const context = await fixture(
      [
        task("recoverable", "blocked"),
        task("terminal", "failed"),
        task("dependent", "running"),
      ],
      [
        { taskId: "dependent", dependsOnTaskId: "recoverable" },
        { taskId: "dependent", dependsOnTaskId: "terminal" },
      ],
    );

    const report = await context.reconcile.inspect("project-1");
    const issue = report.issues.find(
      (value) => value.finding === "blocking_prerequisite_incomplete",
    );
    expect(issue).toMatchObject({
      severity: "inconsistent",
      repairOperation: "cancel",
      suggestedCommand: "task:cancel",
      reviewExits: [
        { taskId: "recoverable", from: "waiting_review", to: "blocked" },
        { taskId: "terminal", from: "waiting_review", to: "failed" },
      ],
    });
  });

  test("names a live unmet prerequisite beside the exits without a repair change", async () => {
    const context = await fixture(
      [
        task("upstream", "failed"),
        task("slow", "running"),
        task("dependent", "running"),
      ],
      [
        { taskId: "dependent", dependsOnTaskId: "slow" },
        { taskId: "dependent", dependsOnTaskId: "upstream" },
      ],
    );

    const issue = (await context.reconcile.inspect("project-1")).issues.find(
      (value) => value.finding === "blocking_prerequisite_incomplete",
    );
    expect(issue).toMatchObject({
      severity: "inconsistent",
      repairOperation: "cancel",
      reviewExits: [{ taskId: "upstream", from: "waiting_review", to: "failed" }],
    });
    expect(issue?.summary).toContain("still unmet: slow (running)");
  });

  test.each(["pending", "assigned", "blocked"] as const)(
    "keeps the repairless finding for a dependent at %s",
    async (status) => {
      const context = await fixture(
        [task("upstream", "failed"), task("dependent", status)],
        [{ taskId: "dependent", dependsOnTaskId: "upstream" }],
      );

      const issue = (await context.reconcile.inspect("project-1")).issues.find(
        (value) => value.finding === "blocking_prerequisite_incomplete",
      );
      expect(issue).toMatchObject({
        taskId: "dependent",
        severity: "warning",
        repairable: false,
        repairOperation: null,
        suggestedCommand: null,
      });
      expect(issue?.reviewExits).toBeUndefined();
      expect(issue?.summary).toBe(
        "cannot start until prerequisites are completed or in review: upstream (failed)",
      );
    },
  );

  test.each(["completed", "waiting_review"] as const)(
    "reports nothing for a started dependent whose prerequisite is %s",
    async (status) => {
      const context = await fixture(
        [task("upstream", status), task("dependent", "running")],
        [{ taskId: "dependent", dependsOnTaskId: "upstream" }],
      );

      const report = await context.reconcile.inspect("project-1");
      expect(
        report.issues.filter(
          (value) => value.finding === "blocking_prerequisite_incomplete",
        ),
      ).toEqual([]);
      expect(report.planHash).toBeNull();
    },
  );

  test("keeps live unmet prerequisites on the repairless path", async () => {
    const context = await fixture(
      [task("upstream", "running"), task("dependent", "running")],
      [{ taskId: "dependent", dependsOnTaskId: "upstream" }],
    );

    const issue = (await context.reconcile.inspect("project-1")).issues.find(
      (value) => value.finding === "blocking_prerequisite_incomplete",
    );
    expect(issue).toMatchObject({
      severity: "warning",
      repairable: false,
      repairOperation: null,
      suggestedCommand: null,
    });
    expect(issue?.reviewExits).toBeUndefined();
    expect(issue?.summary).toContain(
      "started with prerequisites neither completed nor in review: upstream (running)",
    );
  });

  test("refuses the batch repair while an agent run executes the dependent", async () => {
    const context = await reviewExitFixture("failed", "running");
    await context.runtime.saveRun(
      AgentRun.create({
        id: "run-1",
        projectId: "project-1",
        taskId: "dependent",
        agentId: "agent-1",
        now,
      }),
    );

    const report = await context.reconcile.inspect("project-1");
    const issue = report.issues.find(
      (value) => value.finding === "blocking_prerequisite_incomplete",
    );
    expect(issue).toMatchObject({
      severity: "inconsistent",
      repairable: false,
      repairOperation: null,
      suggestedCommand: "task:cancel",
      reviewExits: [{ taskId: "upstream", from: "waiting_review", to: "failed" }],
    });
    expect(issue?.refusalReason).toContain("active pipeline or agent run");
    expect(report.planHash).toBeNull();
  });

  test("reports a missing prerequisite reference instead of an exit", async () => {
    const context = await fixture(
      [task("dependent", "running")],
      [{ taskId: "dependent", dependsOnTaskId: "ghost" }],
    );

    const issue = (await context.reconcile.inspect("project-1")).issues.find(
      (value) => value.finding === "invalid_task_dependency",
    );
    expect(issue).toMatchObject({
      taskId: "dependent",
      severity: "inconsistent",
      repairable: false,
    });
  });

  test("lets an unknown repository failure propagate", async () => {
    const context = await fixture(
      [task("upstream", "failed"), task("dependent", "running")],
      [{ taskId: "dependent", dependsOnTaskId: "upstream" }],
    );
    context.dependencies.failure = new Error("storage on fire");

    await expect(context.reconcile.inspect("project-1")).rejects.toThrow(
      "storage on fire",
    );
  });

  test("is deterministic and idempotent across repeated inspections", async () => {
    const context = await reviewExitFixture("failed", "waiting_review");

    const first = await context.reconcile.inspect("project-1");
    const second = await context.reconcile.inspect("project-1");
    expect(second).toEqual(first);
    expect(second.planHash).toBe(first.planHash);
    // Inspection is a read: no status write, no audit record.
    expect(context.taskStore.values.get("dependent")?.snapshot().status).toBe(
      "waiting_review",
    );
    expect(context.events.events).toEqual([]);
  });
});

describe("review-exit repairs", () => {
  test("cancels the dependent of a failed prerequisite with the exit as the reason", async () => {
    const context = await reviewExitFixture("failed", "running");
    const report = await context.reconcile.inspect("project-1");

    const result = await context.reconcile.repair({
      projectId: "project-1",
      approvedPlanHash: report.planHash!,
      actorId: "operator",
    });
    expect(result.applied).toEqual([
      {
        taskId: "dependent",
        from: "running",
        to: "cancelled",
        operation: "cancel",
      },
    ]);
    expect(context.taskStore.values.get("dependent")?.snapshot().status).toBe(
      "cancelled",
    );
    expect(
      context.events.events.map((event) => event.snapshot()),
    ).toMatchObject([
      {
        eventType: "task.status_changed",
        payload: {
          operation: "cancel",
          from: "running",
          to: "cancelled",
          reason: "reconciled: prerequisite upstream exited review to failed",
        },
      },
    ]);
    // The repair consumed the finding; the consumed hash approves no replay.
    const after = await context.reconcile.inspect("project-1");
    expect(after.planHash).toBeNull();
    await expect(
      context.reconcile.repair({
        projectId: "project-1",
        approvedPlanHash: report.planHash!,
        actorId: "operator",
      }),
    ).rejects.toBeInstanceOf(TaskReconciliationApprovalError);
  });

  test("passes the mandatory reason when blocking the dependent", async () => {
    const context = await reviewExitFixture("blocked", "waiting_review");
    const report = await context.reconcile.inspect("project-1");

    const result = await context.reconcile.repair({
      projectId: "project-1",
      approvedPlanHash: report.planHash!,
      actorId: "operator",
    });
    expect(result.applied).toEqual([
      {
        taskId: "dependent",
        from: "waiting_review",
        to: "blocked",
        operation: "block",
      },
    ]);
    expect(
      context.events.events.map((event) => event.snapshot()),
    ).toMatchObject([
      {
        eventType: "task.status_changed",
        payload: {
          operation: "block",
          from: "waiting_review",
          to: "blocked",
          reason: "reconciled: prerequisite upstream exited review to blocked",
        },
      },
    ]);
  });

  test("refuses a repair whose approval does not match the current plan", async () => {
    const context = await reviewExitFixture("failed", "running");
    await context.reconcile.inspect("project-1");

    await expect(
      context.reconcile.repair({
        projectId: "project-1",
        approvedPlanHash: "0".repeat(64),
        actorId: "operator",
      }),
    ).rejects.toBeInstanceOf(TaskReconciliationApprovalError);
    expect(context.taskStore.values.get("dependent")?.snapshot().status).toBe(
      "running",
    );
    expect(context.events.events).toEqual([]);
  });
});
