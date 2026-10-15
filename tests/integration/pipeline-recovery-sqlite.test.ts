import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteTaskDependencyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-dependency.repository.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import { RecoverSuspendedPipelines } from "@ai-office/application/pipeline/recover-suspended-pipelines.ts";
import { PipelineActorUnauthorizedError } from "@ai-office/application/pipeline-errors.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";

const roots: string[] = [];
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
    return `generated-${this.next}`;
  }
}

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Recover suspended pipelines",
    goals: ["Ship safely"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Recovery office",
    roles: [
      {
        id: "developer",
        title: "Developer",
        purpose: "Build",
        responsibilities: ["Build"],
      },
    ],
  },
  pipelines: [
    {
      id: "delivery",
      name: "Delivery",
      description: "Single stage",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "build",
          name: "Build",
          roleId: "developer",
          objective: "Build",
          checks: [],
          requiresApproval: false,
          capabilities: [],
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
  const root = mkdtempSync(join(tmpdir(), "ai-office-pipeline-recovery-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  const projects = new SqliteProjectRepository(database);
  const tasks = new SqliteTaskRepository(database);
  const manifests = new SqliteOfficeManifestRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  const pipelines = new SqlitePipelineRunRepository(database);
  const dependencies = new SqliteTaskDependencyRepository(database);
  const clock = new FixedClock();
  const ids = new SequenceIds();
  const transactions = new SqliteTransactionRunner(database);
  const audit = new RecordAuditEvent(
    new SqliteAuditEventRepository(database),
    ids,
    clock,
  );
  const pipelineManagement = new ManagePipelineRuns(
    manifests,
    pipelines,
    tasks,
    runtime,
    audit,
    ids,
    clock,
    transactions,
    undefined,
    dependencies,
  );
  const recovery = new RecoverSuspendedPipelines(
    pipelines,
    runtime,
    tasks,
    dependencies,
    pipelineManagement,
  );

  await projects.save(Project.create({ id: "project", name: "Project", now }));
  await manifests.save({
    id: "manifest-1",
    projectId: "project",
    revision: 1,
    manifest,
    appliedAt: now,
  });
  await runtime.saveRole(
    Role.create({
      id: "role-developer",
      projectId: "project",
      key: "developer",
      name: "developer",
      version: 1,
      capabilities: [],
      tools: [],
      modelPolicy: "default",
      limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
      sourcePath: "developer.yaml",
      now,
    }),
  );
  await runtime.saveAgent({
    id: "dev-agent",
    projectId: "project",
    roleId: "role-developer",
    name: "developer",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });

  /**
   * The artifact the review-ready guard leaves behind: the dependent's final
   * stage completion was refused, so the run is completed, the stage and the
   * pipeline are still active, and the task is still running.
   */
  async function seedSuspended() {
    const prerequisite = Task.create({
      id: "prereq",
      projectId: "project",
      title: "Prerequisite",
      now,
    });
    prerequisite.start(now);
    prerequisite.submitForReview(now);
    await tasks.save(prerequisite);
    await tasks.save(
      Task.create({
        id: "dependent",
        projectId: "project",
        title: "Dependent",
        now,
      }),
    );
    await dependencies.link({
      projectId: "project",
      taskId: "dependent",
      dependsOnTaskId: "prereq",
      createdAt: now,
    });
    const run = await pipelineManagement.start({
      projectId: "project",
      taskId: "dependent",
      pipelineId: "delivery",
      principal: localOperatorPrincipal,
    });
    await pipelineManagement.assign({
      projectId: "project",
      pipelineRunId: run.snapshot().id,
      agentId: "dev-agent",
      principal: localOperatorPrincipal,
    });
    const stageId = run.currentStage()!.id;
    const agentRun = AgentRun.create({
      id: "suspended-run",
      projectId: "project",
      taskId: "dependent",
      agentId: "dev-agent",
      pipelineRunId: run.snapshot().id,
      pipelineStageRunId: stageId,
      now,
    });
    await runtime.saveRun(agentRun);
    agentRun.transition("preparing", now);
    await runtime.saveRun(agentRun);
    agentRun.transition("running", now);
    await runtime.saveRun(agentRun);
    agentRun.transition("completed", now);
    await runtime.saveRun(agentRun);
    return { pipelineRunId: run.snapshot().id, stageId };
  }

  async function completePrerequisite() {
    const prerequisite = await tasks.findById("prereq");
    prerequisite!.complete(now);
    await tasks.save(prerequisite!);
  }

  function resumedEvents() {
    return database
      .query<{ payload_json: string }, []>(
        "SELECT payload_json FROM audit_event WHERE event_type = 'pipeline.resumed'",
      )
      .all()
      .map((row) => JSON.parse(row.payload_json) as Record<string, unknown>);
  }

  return {
    database,
    tasks,
    pipelines,
    pipelineManagement,
    recovery,
    seedSuspended,
    completePrerequisite,
    resumedEvents,
  };
}

describe("RecoverSuspendedPipelines (SQLite)", () => {
  test("leaves a suspended pipeline untouched while a prerequisite is still in review", async () => {
    const { recovery, pipelines, tasks, seedSuspended, resumedEvents } =
      await fixture();
    const { pipelineRunId } = await seedSuspended();

    const result = await recovery.execute({ projectId: "project", trigger: "tick" });

    expect(result.recoveries).toEqual([
      expect.objectContaining({
        pipelineRunId,
        outcome: "awaiting_prerequisites",
      }),
    ]);
    expect(
      (await pipelines.findById(pipelineRunId, "project"))!.snapshot().status,
    ).toBe("active");
    expect((await tasks.findById("dependent"))!.snapshot().status).toBe(
      "running",
    );
    expect(resumedEvents()).toEqual([]);
  });

  test("resumes exactly once when the last prerequisite completes, with provenance", async () => {
    const {
      recovery,
      pipelines,
      tasks,
      seedSuspended,
      completePrerequisite,
      resumedEvents,
    } = await fixture();
    const { pipelineRunId } = await seedSuspended();
    await completePrerequisite();

    const first = await recovery.execute({
      projectId: "project",
      trigger: "task_completion",
      triggerTaskId: "prereq",
    });
    expect(first.recoveries).toEqual([
      expect.objectContaining({ pipelineRunId, outcome: "resumed" }),
    ]);
    expect(
      (await pipelines.findById(pipelineRunId, "project"))!.snapshot().status,
    ).toBe("completed");
    expect((await tasks.findById("dependent"))!.snapshot().status).toBe(
      "completed",
    );

    const events = resumedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentRunId: "suspended-run",
      trigger: "task_completion",
      triggerTaskId: "prereq",
      prerequisiteTaskIds: ["prereq"],
    });

    // A repeated trigger finds no candidate: nothing is resumed twice.
    const second = await recovery.execute({
      projectId: "project",
      trigger: "tick",
    });
    expect(second.recoveries).toEqual([]);
    expect(resumedEvents()).toHaveLength(1);
  });

  test("a repeated stage completion is refused, so a stale trigger cannot resume twice", async () => {
    const {
      pipelineManagement,
      seedSuspended,
      completePrerequisite,
      resumedEvents,
    } = await fixture();
    const { pipelineRunId } = await seedSuspended();
    await completePrerequisite();

    const input = {
      projectId: "project",
      agentRunId: "suspended-run",
      expectedPipelineRunId: pipelineRunId,
      resumption: { trigger: "tick" as const },
    };
    await pipelineManagement.completeStageFromAgentRun(input);
    await expect(
      pipelineManagement.completeStageFromAgentRun(input),
    ).rejects.toThrowError(PipelineActorUnauthorizedError);
    expect(resumedEvents()).toHaveLength(1);
  });

  test("a prerequisite that regresses before resume keeps the pipeline suspended", async () => {
    const { recovery, pipelines, tasks, seedSuspended } = await fixture();
    const { pipelineRunId } = await seedSuspended();
    const prerequisite = await tasks.findById("prereq");
    prerequisite!.block(now);
    await tasks.save(prerequisite!);

    const result = await recovery.execute({
      projectId: "project",
      trigger: "tick",
    });

    expect(result.recoveries).toEqual([
      expect.objectContaining({
        pipelineRunId,
        outcome: "awaiting_prerequisites",
      }),
    ]);
    expect(
      (await pipelines.findById(pipelineRunId, "project"))!.snapshot().status,
    ).toBe("active");
  });

  test("a task that turned terminal while suspended is superseded, never completed underneath", async () => {
    const { recovery, pipelines, tasks, seedSuspended, completePrerequisite } =
      await fixture();
    const { pipelineRunId } = await seedSuspended();
    await completePrerequisite();
    const dependent = await tasks.findById("dependent");
    dependent!.cancel(now);
    await tasks.save(dependent!);

    const result = await recovery.execute({
      projectId: "project",
      trigger: "tick",
    });

    expect(result.recoveries).toEqual([
      expect.objectContaining({ pipelineRunId, outcome: "superseded" }),
    ]);
    expect(
      (await pipelines.findById(pipelineRunId, "project"))!.snapshot().status,
    ).toBe("active");
    expect((await tasks.findById("dependent"))!.snapshot().status).toBe(
      "cancelled",
    );
  });
});
