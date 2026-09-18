import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { ManagePipelineRuns } from "@ai-office/application/pipeline/manage-pipeline-runs.ts";
import { OrchestratePipelineStage } from "@ai-office/application/pipeline/orchestrate-pipeline-stage.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import { RecordAuditEvent } from "@ai-office/application/commands/record-audit-event.ts";
import { localOperatorPrincipal } from "@ai-office/application/ports/execution-principal.port.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAuditEventRepository } from "@ai-office/storage-sqlite/repositories/sqlite-audit-event.repository.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteJobOutboxRepository } from "@ai-office/storage-sqlite/repositories/sqlite-job-outbox.repository.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";

const now = new Date("2026-09-18T00:00:00.000Z");
const roots: string[] = [];

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

const manifest: OfficeManifest = {
  schemaVersion: 1,
  provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
  project: {
    mission: "Verify durable stage identity",
    goals: ["Advance safely"],
    constraints: [],
    preferences: [],
    permissionPreferences: [],
  },
  office: {
    name: "Durable queue test office",
    roles: [
      {
        id: "builder",
        title: "Builder",
        purpose: "Build",
        responsibilities: ["Build"],
      },
    ],
  },
  pipelines: [
    {
      id: "repeated-role",
      name: "Repeated role",
      description: "Two consecutive stages use the same eligible agent",
      defaultFor: ["feature"],
      enforcement: "enforced",
      stages: [
        {
          id: "stage-a",
          name: "Stage A",
          roleId: "builder",
          objective: "First",
          checks: ["First complete"],
          requiresApproval: false,
          capabilities: [],
        },
        {
          id: "stage-b",
          name: "Stage B",
          roleId: "builder",
          objective: "Second",
          checks: ["Second complete"],
          requiresApproval: false,
          capabilities: [],
        },
      ],
    },
  ],
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-durable-authority-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  const projects = new SqliteProjectRepository(database);
  const tasks = new SqliteTaskRepository(database);
  const agents = new SqliteAgentRuntimeRepository(database);
  const pipelines = new SqlitePipelineRunRepository(database);
  const manifests = new SqliteOfficeManifestRepository(database);
  const outbox = new SqliteJobOutboxRepository(database);
  const transactions = new SqliteTransactionRunner(database);
  const clock = new FixedClock();
  const ids = new SequenceIds();
  await projects.save(Project.create({ id: "project", name: "Project", now }));
  await tasks.save(
    Task.create({ id: "task", projectId: "project", title: "Work", now }),
  );
  await agents.saveRole(
    Role.create({
      id: "role-builder",
      projectId: "project",
      key: "builder",
      name: "Builder",
      version: 1,
      capabilities: [],
      tools: [],
      modelPolicy: "default",
      limits: { maxIterations: 1, maxCostMicros: 1n, timeoutSeconds: 30 },
      sourcePath: "builder.yaml",
      now,
    }),
  );
  await agents.saveAgent({
    id: "agent-one",
    projectId: "project",
    roleId: "role-builder",
    name: "Builder",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await manifests.save({
    id: "manifest-1",
    projectId: "project",
    revision: 1,
    manifest,
    appliedAt: now,
  });
  const audit = new RecordAuditEvent(
    new SqliteAuditEventRepository(database),
    ids,
    clock,
  );
  const manager = new ManagePipelineRuns(
    manifests,
    pipelines,
    tasks,
    agents,
    audit,
    ids,
    clock,
    transactions,
    outbox,
  );
  const schedule = new ScheduleAgentRun(
    projects,
    tasks,
    agents,
    ids,
    clock,
    transactions,
    pipelines,
    undefined,
    outbox,
  );
  const orchestrator = new OrchestratePipelineStage(
    pipelines,
    agents,
    tasks,
    manager,
    schedule,
  );
  return { database, agents, pipelines, outbox, manager, orchestrator, clock };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function markPendingDispatched(
  outbox: SqliteJobOutboxRepository,
  stageRunId?: string,
): Promise<void> {
  for (const record of await outbox.pending(now, 100)) {
    if (stageRunId === undefined || record.pipelineStageRunId === stageRunId)
      await outbox.markDispatched(record.id, now);
  }
}

describe("durable queue stage authority", () => {
  test("replays only the exact missing stage delivery and binds recovery to a repeated-role stage", async () => {
    const f = await fixture();
    const started = await f.manager.start({
      projectId: "project",
      taskId: "task",
      pipelineId: "repeated-role",
      principal: localOperatorPrincipal,
    });
    const pipelineId = started.snapshot().id;
    const stageA = started.currentStage()!;
    await markPendingDispatched(f.outbox, stageA.id);

    const runAId = await f.orchestrator.execute({
      projectId: "project",
      pipelineRunId: pipelineId,
      pipelineStageRunId: stageA.id,
    });
    expect(runAId).not.toBeNull();
    const runA = await f.agents.findRun(runAId!);
    expect(runA?.snapshot()).toMatchObject({
      pipelineRunId: pipelineId,
      pipelineStageRunId: stageA.id,
      agentId: "agent-one",
    });
    await markPendingDispatched(f.outbox, stageA.id);

    runA!.transition("preparing", now);
    runA!.transition("running", now);
    runA!.transition("completed", now);
    await f.agents.saveRun(runA!);
    await f.agents.releaseTaskLock(runAId!);
    await f.manager.completeStageFromAgentRun({
      projectId: "project",
      agentRunId: runAId!,
      expectedPipelineRunId: pipelineId,
    });

    const afterA = (await f.pipelines.findById(pipelineId, "project"))!;
    const stageB = afterA.currentStage()!;
    expect(stageB.id).not.toBe(stageA.id);
    await markPendingDispatched(f.outbox, stageB.id);

    const replayable = await f.outbox.replayable(50);
    expect(replayable).toHaveLength(1);
    expect(replayable[0]).toMatchObject({
      jobType: "orchestrate_pipeline",
      aggregateId: pipelineId,
      pipelineStageRunId: stageB.id,
    });
    expect(
      replayable.some((value) => value.pipelineStageRunId === stageA.id),
    ).toBe(false);

    const recoveredRunId = await f.orchestrator.execute({
      projectId: "project",
      pipelineRunId: pipelineId,
      pipelineStageRunId: stageB.id,
    });
    expect(recoveredRunId).not.toBeNull();
    expect((await f.agents.findRun(recoveredRunId!))?.snapshot()).toMatchObject(
      {
        pipelineRunId: pipelineId,
        pipelineStageRunId: stageB.id,
        agentId: "agent-one",
      },
    );
    expect(
      await f.orchestrator.execute({
        projectId: "project",
        pipelineRunId: pipelineId,
        pipelineStageRunId: stageB.id,
      }),
    ).toBe(recoveredRunId);

    const staleCompletion = f.manager.completeStageFromAgentRun({
      projectId: "project",
      agentRunId: runAId!,
      expectedPipelineRunId: pipelineId,
    });
    await expect(staleCompletion).rejects.toThrow("not authorized");

    await markPendingDispatched(f.outbox, stageB.id);
    const duringExecution = await f.agents.findRun(recoveredRunId!);
    duringExecution!.transition("preparing", now);
    duringExecution!.transition("running", now);
    await f.agents.saveRun(duringExecution!);
    expect(await f.outbox.replayable(50)).toEqual([]);
    expect(await f.outbox.replayable(50)).toEqual([]);
  });
});
