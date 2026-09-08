import { afterEach, expect, test, vi } from "vitest";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { PipelineRun } from "@ai-office/domain/pipeline/pipeline-run.ts";
import type { OfficeManifest } from "@ai-office/domain/office/office-manifest.ts";
import { SqliteOfficeManifestRepository } from "@ai-office/storage-sqlite/repositories/sqlite-office-manifest.repository.ts";
import { WorkerAgentExecutor } from "@ai-office/application/commands/worker-agent-executor.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import { InMemoryWorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import { AdmitAgentRun } from "@ai-office/application/commands/admit-agent-run.ts";
import type {
  WorkerRuntime,
  WorkerOutput,
} from "@ai-office/application/ports/worker-runtime.port.ts";
import { taskRunLeaseRenewalMs } from "@ai-office/application/runtime/run-policy.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";

const cleanup: (() => void)[] = [];
const now = new Date("2026-09-07T00:00:00.000Z");
const clock = { now: () => now };
const output: WorkerOutput = {
  schemaVersion: 1,
  summary: "Analysis",
  content: "Generated content",
  sessionId: null,
  model: null,
  usage: null,
  estimatedCostUsd: null,
};
afterEach(() => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0)) close();
});

async function fixture(legacy = false) {
  const root = mkdtempSync(join(tmpdir(), "ao-worker-test-"));
  const db = openDatabase(join(root, "project.sqlite"));
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  const migrations = resolve("migrations/project");
  if (legacy) {
    const partial = join(root, "migrations");
    mkdirSync(partial);
    for (const file of readdirSync(migrations))
      if (file < "0027")
        copyFileSync(join(migrations, file), join(partial, file));
    migrate(db, partial);
  } else migrate(db, migrations);
  const projects = new SqliteProjectRepository(db),
    tasks = new SqliteTaskRepository(db),
    runs = new SqliteAgentRuntimeRepository(db),
    pipelines = new SqlitePipelineRunRepository(db);
  await projects.save(Project.create({ id: "p", name: "Worker test", now }));
  await tasks.save(
    Task.create({
      id: "t",
      projectId: "p",
      title: "Explain tradeoffs",
      description: "Use explicit facts",
      now,
    }),
  );
  await runs.saveRole(
    Role.create({
      id: "role",
      projectId: "p",
      key: "architect",
      name: "Architect",
      version: 1,
      capabilities: [],
      tools: [],
      modelPolicy: "balanced",
      sourcePath: "not-a-worker-input",
      limits: { maxCostMicros: 125000n, maxIterations: 3, timeoutSeconds: 20 },
      now,
    }),
  );
  await runs.saveAgent({
    id: "a",
    projectId: "p",
    roleId: "role",
    name: "Architect",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  const schedule = new ScheduleAgentRun(
    projects,
    tasks,
    runs,
    { generate: () => "r" },
    clock,
    new SqliteTransactionRunner(db),
    pipelines,
  );
  const admitted = async () => {
    await schedule.execute({ projectId: "p", taskId: "t", agentId: "a" });
    return (await new AdmitAgentRun(runs, tasks, pipelines, clock).execute(
      (await runs.findRun("r"))!,
    ))!;
  };
  return { db, runs, tasks, pipelines, admitted };
}

async function addActivePipeline(f: Awaited<ReturnType<typeof fixture>>) {
  const manifest: OfficeManifest = {
    schemaVersion: 1,
    provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
    project: {
      mission: "Analyze",
      goals: [],
      constraints: [],
      preferences: [],
      permissionPreferences: [],
    },
    office: {
      name: "Test",
      roles: [{ id: "architect", title: "Architect", purpose: "Design", responsibilities: [] }],
    },
    pipelines: [{
      id: "analysis",
      name: "Analysis",
      description: "One stage",
      defaultFor: [],
      enforcement: "enforced",
      stages: [{
        id: "design",
        name: "Design",
        roleId: "architect",
        objective: "Assess",
        checks: [],
        requiresApproval: false,
      }],
    }],
  };
  await new SqliteOfficeManifestRepository(f.db).save({
    id: "manifest",
    projectId: "p",
    revision: 1,
    manifest,
    appliedAt: now,
  });
  const pipeline = PipelineRun.create({
    id: "pipeline",
    projectId: "p",
    taskId: "t",
    manifestRevisionId: "manifest",
    manifestRevision: 1,
    definition: manifest.pipelines[0]!,
    startedBy: "operator",
    stageRunIds: ["stage"],
    now,
  });
  pipeline.assign("a", "architect", now);
  await f.pipelines.insert(pipeline);
}

test("worker dispatch persists its context digest before calling the process and observes role limits", async () => {
  const f = await fixture();
  const worker: WorkerRuntime = {
    id: "test-worker",
    inspect: async () => ({ version: "1" }),
    execute: async (context, limits) => {
      expect((await f.runs.findRun("r"))?.snapshot()).toMatchObject({
        status: "running",
        execution: {
          kind: "worker",
          inputHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      });
      expect(context.task).toMatchObject({
        title: "Explain tradeoffs",
        description: "Use explicit facts",
      });
      expect(JSON.stringify(context)).not.toContain("not-a-worker-input");
      expect(limits).toEqual({
        maxTurns: 3,
        timeoutMs: 20000,
        maxEstimatedCostUsd: "0.125000",
      });
      expect(await f.runs.findTaskLock("t")).not.toBeNull();
      return output;
    },
  };
  const result = await new ExecuteAgentRun(
    f.runs,
    new WorkerAgentExecutor(worker, f.runs, f.tasks, f.pipelines, clock),
    {
      prepare: async () => {
        throw new Error("Must not create a fake worktree");
      },
      release: async () => {},
    },
    clock,
  ).execute(await f.admitted());
  expect(result.status).toBe("completed");
  expect((await f.runs.findRun("r"))?.snapshot().result).toMatchObject({
    workerOutput: output,
  });
  expect(await f.runs.findTaskLock("t")).toBeNull();
});

test("a stage-bound worker receives the pinned objective and leaves pipeline acceptance explicit", async () => {
  const f = await fixture();
  const manifest: OfficeManifest = {
    schemaVersion: 1,
    provenance: { host: "codex", skill: "ai-office", skillVersion: "1" },
    project: {
      mission: "Analyze",
      goals: [],
      constraints: [],
      preferences: [],
      permissionPreferences: [],
    },
    office: {
      name: "Test",
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
        id: "analysis",
        name: "Analysis",
        description: "One gated stage",
        defaultFor: [],
        enforcement: "enforced",
        stages: [
          {
            id: "design",
            name: "Design",
            roleId: "architect",
            objective: "Assess tradeoffs",
            checks: ["Evidence reviewed"],
            requiresApproval: true,
          },
        ],
      },
    ],
  };
  await new SqliteOfficeManifestRepository(f.db).save({
    id: "manifest",
    projectId: "p",
    revision: 1,
    manifest,
    appliedAt: now,
  });
  const pipeline = PipelineRun.create({
    id: "pipeline",
    projectId: "p",
    taskId: "t",
    manifestRevisionId: "manifest",
    manifestRevision: 1,
    definition: manifest.pipelines[0]!,
    startedBy: "operator",
    stageRunIds: ["stage"],
    now,
  });
  pipeline.assign("a", "architect", now);
  await f.pipelines.insert(pipeline);
  const worker: WorkerRuntime = {
    id: "test-worker",
    inspect: async () => ({ version: "1" }),
    execute: async (context) => {
      expect(context.stage).toEqual({
        pipelineRunId: "pipeline",
        manifestRevision: 1,
        stageId: "design",
        objective: "Assess tradeoffs",
        checks: ["Evidence reviewed"],
      });
      return output;
    },
  };
  const prepared = await new WorkerAgentExecutor(
    worker,
    f.runs,
    f.tasks,
    f.pipelines,
    clock,
  ).prepare(await f.admitted());
  await prepared.execute();
  expect(
    (await f.pipelines.findById("pipeline", "p"))?.currentStage(),
  ).toMatchObject({ status: "active", assignedAgentId: "a" });
});

test("authority changes after preparation prevent invocation", async () => {
  const f = await fixture();
  const execute = vi.fn(async () => output);
  const executor = new WorkerAgentExecutor(
    { id: "test-worker", inspect: async () => ({ version: "1" }), execute },
    f.runs,
    f.tasks,
    f.pipelines,
    clock,
  );
  const prepared = await executor.prepare(await f.admitted());
  f.db.exec("UPDATE agent SET enabled=0 WHERE id='a'");
  await expect(prepared.execute()).rejects.toMatchObject({
    code: "WORKER_LEASE_LOST",
  });
  expect(execute).not.toHaveBeenCalled();
});

test.each(["task", "agent", "role", "lock"] as const)(
  "completion fence rejects a %s change made while the worker is resolving",
  async (kind) => {
    const f = await fixture();
    let started!: () => void;
    let resolveOutput!: (value: WorkerOutput) => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const worker: WorkerRuntime = {
      id: "test-worker",
      inspect: async () => ({ version: "1" }),
      execute: async () => {
        started();
        return new Promise<WorkerOutput>((resolve) => {
          resolveOutput = resolve;
        });
      },
    };
    const execution = new ExecuteAgentRun(
      f.runs,
      new WorkerAgentExecutor(worker, f.runs, f.tasks, f.pipelines, clock),
      new InMemoryWorktreeManager(),
      clock,
    ).execute(await f.admitted());
    await startedPromise;
    const changedAt = new Date(now.getTime() + 1000).toISOString();
    if (kind === "task")
      f.db.exec(`UPDATE task SET title='changed', updated_at='${changedAt}' WHERE id='t'`);
    if (kind === "agent")
      f.db.exec(`UPDATE agent SET enabled=0, updated_at='${changedAt}' WHERE id='a'`);
    if (kind === "role")
      f.db.exec(`UPDATE role SET version=2, updated_at='${changedAt}' WHERE id='role'`);
    if (kind === "lock") {
      f.db.exec(
        `INSERT INTO agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at) VALUES ('other','p','t','a','running','${changedAt}','${changedAt}')`,
      );
      f.db.exec("UPDATE task_lock SET run_id='other' WHERE task_id='t'");
    }
    resolveOutput(output);
    const result = await execution;
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "WORKER_LEASE_LOST" },
    });
    expect((await f.runs.findRun("r"))?.snapshot().status).toBe("failed");
    expect((await f.runs.findRun("r"))?.snapshot().result).toBeUndefined();
    expect(
      (await f.runs.listRunEvents("r")).some((event) => event.status === "reviewing"),
    ).toBe(false);
  },
);

test("completion fence rejects a pipeline version/current-stage change before acceptance", async () => {
  const f = await fixture();
  await addActivePipeline(f);
  let resolveOutput!: (value: WorkerOutput) => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => {
    started = resolve;
  });
  const execution = new ExecuteAgentRun(
    f.runs,
    new WorkerAgentExecutor(
      {
        id: "test-worker",
        inspect: async () => ({ version: "1" }),
        execute: async () => {
          started();
          return new Promise<WorkerOutput>((resolve) => {
            resolveOutput = resolve;
          });
        },
      },
      f.runs,
      f.tasks,
      f.pipelines,
      clock,
    ),
    new InMemoryWorktreeManager(),
    clock,
  ).execute(await f.admitted());
  await startedPromise;
  f.db.exec(
    `UPDATE pipeline_run SET version=version+1, updated_at='${new Date(now.getTime() + 1000).toISOString()}' WHERE id='pipeline'`,
  );
  resolveOutput(output);
  await expect(execution).resolves.toMatchObject({
    status: "failed",
    error: { code: "WORKER_LEASE_LOST" },
  });
  expect((await f.runs.findRun("r"))?.snapshot().result).toBeUndefined();
});

test("zero role budget refuses execution before inspecting a client", async () => {
  const f = await fixture();
  const run = await f.admitted();
  f.db.exec(
    `UPDATE role SET limits_json='{"maxCostMicros":"0","maxIterations":3,"timeoutSeconds":20}'`,
  );
  const inspect = vi.fn(async () => ({ version: "1" }));
  const execute = vi.fn(async () => output);
  await expect(
    new WorkerAgentExecutor(
      { id: "test-worker", inspect, execute },
      f.runs,
      f.tasks,
      f.pipelines,
      clock,
    ).prepare(run),
  ).rejects.toMatchObject({ code: "WORKER_BUDGET_EXHAUSTED" });
  expect(inspect).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
});

test("an expired or lost lease stops a running worker and is not silently renewed", async () => {
  const f = await fixture();
  vi.useFakeTimers();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const worker: WorkerRuntime = {
    id: "test-worker",
    inspect: async () => ({ version: "1" }),
    execute: async (_context, _limits, signal) =>
      new Promise<WorkerOutput>((_resolve, reject) => {
        signal!.addEventListener(
          "abort",
          () => reject(new DOMException("cancelled", "AbortError")),
          { once: true },
        );
        started();
      }),
  };
  const prepared = await new WorkerAgentExecutor(
    worker,
    f.runs,
    f.tasks,
    f.pipelines,
    clock,
  ).prepare(await f.admitted());
  const result = prepared.execute().catch((error: unknown) => error);
  await ready;
  f.db.exec("DELETE FROM task_lock WHERE task_id='t'");
  await vi.advanceTimersByTimeAsync(taskRunLeaseRenewalMs);
  expect(await result).toMatchObject({ code: "WORKER_LEASE_LOST" });
  expect(vi.getTimerCount()).toBe(0);
});

test("upgrading legacy runs preserves unknown provenance and protects new dispatch metadata", async () => {
  const f = await fixture(true);
  f.db
    .prepare(
      "INSERT INTO agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at) VALUES ('legacy','p','t','a','completed',?,?)",
    )
    .run(now.toISOString(), now.toISOString());
  expect(migrate(f.db, resolve("migrations/project")).applied).toEqual([
    "0027_agent_execution_provenance.sql",
  ]);
  expect(
    (await f.runs.findRun("legacy"))?.snapshot().execution,
  ).toBeUndefined();
  expect(migrate(f.db, resolve("migrations/project")).applied).toEqual([]);
  const run = AgentRun.create({
    id: "new",
    projectId: "p",
    taskId: "t",
    agentId: "a",
    now,
  });
  await f.runs.saveRun(run);
  run.transition("preparing", now);
  run.transition("running", now, {
    execution: {
      kind: "worker",
      adapterId: "test-worker",
      adapterVersion: "1",
      inputHash: "a".repeat(64),
    },
  });
  await f.runs.saveRun(run);
  expect(() =>
    run.transition("reviewing", now, {
      execution: {
        kind: "simulation",
        adapterId: "simulated",
        adapterVersion: "1",
      },
    }),
  ).toThrow("immutable");
  expect(() =>
    f.db.exec("UPDATE agent_run SET execution_json=NULL WHERE id='new'"),
  ).toThrow("immutable");
  expect(f.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
