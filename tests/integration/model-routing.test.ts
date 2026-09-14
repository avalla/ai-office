import { afterEach, expect, test } from "vitest";
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
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import { AdmitAgentRun } from "@ai-office/application/commands/admit-agent-run.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import { WorkerAgentExecutor } from "@ai-office/application/commands/worker-agent-executor.ts";
import { DescribeModelRouting } from "@ai-office/application/model-routing/describe-model-routing.ts";
import type { ModelRoutingState } from "@ai-office/application/model-routing/model-routing.ts";
import type {
  WorkerContext,
  WorkerLimits,
  WorkerOutput,
  WorkerRuntime,
} from "@ai-office/application/ports/worker-runtime.port.ts";
import type { AgentRunModelSelection } from "@ai-office/domain/agent/agent-run-model.ts";
import { InMemoryWorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import {
  EnvironmentModelProviderCatalog,
  loadModelRoutingState,
} from "@ai-office/llm-gateway/model-routing-configuration.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqlitePipelineRunRepository } from "@ai-office/storage-sqlite/repositories/sqlite-pipeline-run.repository.ts";
import { SqliteCostRepository } from "@ai-office/storage-sqlite/repositories/sqlite-cost.repository.ts";

const cleanup: (() => void)[] = [];
const now = new Date("2026-09-14T00:00:00.000Z");
const clock = { now: () => now };
const secret = "sk-model-routing-integration-secret";
const migrations = resolve("migrations/project");

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

function routing(text: string, environment: Record<string, string> = {}) {
  return loadModelRoutingState(
    { AI_OFFICE_MODEL_ROUTING_FILE: "/host/routing.yaml", ...environment },
    { readFile: () => text },
  );
}

const hostRouting = `schema_version: 1
profiles:
  economical: { model: "anthropic:claude-haiku-4-5", reasoning_effort: low }
  balanced: { model: "anthropic:claude-sonnet-4-6", reasoning_effort: medium }
  high_reasoning: { model: "anthropic:claude-opus-4-1", reasoning_effort: high }
agents:
  developer: { profile: high_reasoning }
`;

async function fixture(options: { cutoff?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "ao-model-routing-"));
  const db = openDatabase(join(root, "project.sqlite"));
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  if (options.cutoff === undefined) migrate(db, migrations);
  else {
    const partial = join(root, "migrations");
    mkdirSync(partial);
    for (const file of readdirSync(migrations))
      if (file < options.cutoff)
        copyFileSync(join(migrations, file), join(partial, file));
    migrate(db, partial);
  }
  const projects = new SqliteProjectRepository(db);
  const tasks = new SqliteTaskRepository(db);
  const runs = new SqliteAgentRuntimeRepository(db);
  const pipelines = new SqlitePipelineRunRepository(db);
  await projects.save(Project.create({ id: "p", name: "Routing", now }));
  const role = (key: string, modelPolicy: string, maxCostMicros = 125000n) =>
    Role.create({
      id: `role-${key}`,
      projectId: "p",
      key,
      name: key,
      version: 1,
      capabilities: [],
      tools: [],
      modelPolicy,
      sourcePath: "agents/x/agent.yaml",
      limits: { maxCostMicros, maxIterations: 3, timeoutSeconds: 20 },
      now,
    });
  await runs.saveRole(role("developer", "economical"));
  await runs.saveRole(role("qa", "economical"));
  for (const name of ["developer", "qa"])
    await runs.saveAgent({
      id: `agent-${name}`,
      projectId: "p",
      roleId: `role-${name}`,
      name,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  let taskCount = 0;
  const task = async () => {
    taskCount += 1;
    const id = `t${taskCount}`;
    await tasks.save(
      Task.create({ id, projectId: "p", title: `Task ${id}`, now }),
    );
    return id;
  };
  let runCount = 0;
  const schedule = (state: ModelRoutingState, taskId: string, agent: string) =>
    new ScheduleAgentRun(
      projects,
      tasks,
      runs,
      { generate: () => `r${++runCount}` },
      clock,
      new SqliteTransactionRunner(db),
      pipelines,
      state,
    ).execute({ projectId: "p", taskId, agentId: `agent-${agent}` });
  const count = (table: string) =>
    db
      .query<{ count: number }, []>(`SELECT COUNT(*) count FROM ${table}`)
      .get()!.count;
  return { db, projects, tasks, runs, pipelines, role, task, schedule, count };
}

function captureWorker(): WorkerRuntime & {
  contexts: WorkerContext[];
  limits: WorkerLimits[];
} {
  const contexts: WorkerContext[] = [];
  const limits: WorkerLimits[] = [];
  return {
    id: "capture-worker",
    contexts,
    limits,
    inspect: async () => ({ version: "1" }),
    supportsModel: () => ({ supported: true }),
    execute: async (context, value): Promise<WorkerOutput> => {
      contexts.push(context);
      limits.push(value);
      return {
        schemaVersion: 1,
        summary: "done",
        content: "content",
        sessionId: null,
        model: context.model?.model ?? null,
        usage: { inputTokens: 5, outputTokens: 7 },
        estimatedCostUsd: 0.01,
      };
    },
  };
}

test("scheduling persists an immutable model snapshot that survives reload and later configuration changes", async () => {
  const f = await fixture();
  const taskId = await f.task();
  const runId = await f.schedule(routing(hostRouting), taskId, "qa");
  const expected: AgentRunModelSelection = {
    policy: "economical",
    profile: "economical",
    modelRef: "anthropic:claude-haiku-4-5",
    providerId: "anthropic",
    model: "claude-haiku-4-5",
    reasoningEffort: "low",
    maxOutputTokens: null,
    source: "role_policy",
  };
  const reloaded = new SqliteAgentRuntimeRepository(f.db);
  expect((await reloaded.findRun(runId))?.snapshot().modelRouting).toEqual({
    status: "resolved",
    selection: expected,
  });
  expect(
    JSON.parse(
      f.db
        .query<{ payload: string }, [string]>(
          "SELECT payload_json payload FROM agent_run_event WHERE run_id=? AND status='queued'",
        )
        .get(runId)!.payload,
    ).modelRouting,
  ).toEqual({ status: "resolved", selection: expected });

  // Role policy, host profiles and overrides all change after admission.
  await f.runs.saveRole(f.role("qa", "high_reasoning"));
  const changedHost = routing(`schema_version: 1
profiles:
  high_reasoning: { model: "anthropic:claude-opus-4-1" }
  economical: { model: "anthropic:claude-sonnet-4-6" }
agents:
  qa: { model: "anthropic:claude-sonnet-4-6" }
`);
  expect(changedHost.status).toBe("configured");
  const run = (await f.runs.findRun(runId))!;
  expect(run.snapshot().modelRouting).toEqual({
    status: "resolved",
    selection: expected,
  });

  run.transition("cancelled", now, { error: { code: "TEST" } });
  await f.runs.saveRun(run);
  expect((await reloaded.findRun(runId))?.snapshot().modelRouting).toEqual({
    status: "resolved",
    selection: expected,
  });
  expect(() =>
    f.db
      .prepare(
        `UPDATE agent_run SET model_routing_json='{"status":"unrouted"}' WHERE id=?`,
      )
      .run(runId),
  ).toThrow("immutable");
  expect(() =>
    f.db
      .prepare("UPDATE agent_run SET model_routing_json=NULL WHERE id=?")
      .run(runId),
  ).toThrow("immutable");
});

test("execution uses the persisted run model, not current role or host configuration", async () => {
  const f = await fixture();
  const runId = await f.schedule(routing(hostRouting), await f.task(), "qa");
  // The role now demands high reasoning; the run keeps its admitted model.
  await f.runs.saveRole(f.role("qa", "high_reasoning"));
  const worker = captureWorker();
  const admitted = await new AdmitAgentRun(
    f.runs,
    f.tasks,
    f.pipelines,
    clock,
  ).execute((await f.runs.findRun(runId))!);
  const result = await new ExecuteAgentRun(
    f.runs,
    new WorkerAgentExecutor(worker, f.runs, f.tasks, f.pipelines, clock),
    new InMemoryWorktreeManager(),
    clock,
  ).execute(admitted!);
  expect(result.status).toBe("completed");
  expect(worker.contexts[0]?.model).toMatchObject({
    policy: "economical",
    profile: "economical",
    modelRef: "anthropic:claude-haiku-4-5",
  });
  expect((await f.runs.findRun(runId))?.snapshot().result).toMatchObject({
    workerOutput: { model: "claude-haiku-4-5" },
    roleLimits: {
      maxCostMicros: "125000",
      maxIterations: 3,
      timeoutSeconds: 20,
    },
  });
});

test("a stronger model override never widens the role budget", async () => {
  const f = await fixture();
  const workerLimits: WorkerLimits[] = [];
  for (const agent of ["developer", "qa"]) {
    const runId = await f.schedule(routing(hostRouting), await f.task(), agent);
    const worker = captureWorker();
    const admitted = await new AdmitAgentRun(
      f.runs,
      f.tasks,
      f.pipelines,
      clock,
    ).execute((await f.runs.findRun(runId))!);
    await new ExecuteAgentRun(
      f.runs,
      new WorkerAgentExecutor(worker, f.runs, f.tasks, f.pipelines, clock),
      new InMemoryWorktreeManager(),
      clock,
    ).execute(admitted!);
    workerLimits.push(worker.limits[0]!);
    if (agent === "developer")
      expect(worker.contexts[0]?.model).toMatchObject({
        profile: "high_reasoning",
        source: "agent_override",
      });
  }
  expect(workerLimits[0]).toEqual(workerLimits[1]);
  expect(workerLimits[0]?.maxEstimatedCostUsd).toBe("0.125000");
});

test("a worker that cannot honor the assigned model fails before dispatch", async () => {
  const f = await fixture();
  const runId = await f.schedule(routing(hostRouting), await f.task(), "qa");
  let executed = false;
  const worker: WorkerRuntime = {
    id: "no-model-support",
    inspect: async () => ({ version: "1" }),
    execute: async () => {
      executed = true;
      throw new Error("not reached");
    },
  };
  const admitted = await new AdmitAgentRun(
    f.runs,
    f.tasks,
    f.pipelines,
    clock,
  ).execute((await f.runs.findRun(runId))!);
  const result = await new ExecuteAgentRun(
    f.runs,
    new WorkerAgentExecutor(worker, f.runs, f.tasks, f.pipelines, clock),
    new InMemoryWorktreeManager(),
    clock,
  ).execute(admitted!);
  expect(result).toMatchObject({
    status: "failed",
    error: { code: "WORKER_MODEL_UNSUPPORTED" },
  });
  expect(executed).toBe(false);
  expect((await f.runs.findRun(runId))?.snapshot().execution).toBeUndefined();
  expect(
    (await f.runs.listRunEvents(runId)).map((event) => event.status),
  ).toEqual(["queued", "preparing", "failed"]);
});

test("model resolution failure leaves no run, event or task lock", async () => {
  const f = await fixture();
  const taskId = await f.task();
  const unresolved = routing(`schema_version: 1
profiles:
  balanced: { model: "anthropic:claude-sonnet-4-6" }
`);
  await expect(f.schedule(unresolved, taskId, "qa")).rejects.toMatchObject({
    code: "MODEL_POLICY_UNRESOLVED",
  });
  const misconfigured = routing(`schema_version: 1
profiles:
  economical: { model: "not a ref" }
`);
  await expect(f.schedule(misconfigured, taskId, "qa")).rejects.toMatchObject({
    code: "MODEL_ROUTING_MISCONFIGURED",
  });
  expect(f.count("agent_run")).toBe(0);
  expect(f.count("agent_run_event")).toBe(0);
  expect(f.count("task_lock")).toBe(0);
  // The same task is still schedulable once routing resolves.
  await f.schedule(routing(hostRouting), taskId, "qa");
  expect(f.count("task_lock")).toBe(1);
});

test("unconfigured hosts record unrouted runs without inventing a model", async () => {
  const f = await fixture();
  const runId = await f.schedule(
    loadModelRoutingState({}),
    await f.task(),
    "qa",
  );
  expect((await f.runs.findRun(runId))?.snapshot().modelRouting).toEqual({
    status: "unrouted",
  });
  const worker = captureWorker();
  const admitted = await new AdmitAgentRun(
    f.runs,
    f.tasks,
    f.pipelines,
    clock,
  ).execute((await f.runs.findRun(runId))!);
  await new ExecuteAgentRun(
    f.runs,
    new WorkerAgentExecutor(worker, f.runs, f.tasks, f.pipelines, clock),
    new InMemoryWorktreeManager(),
    clock,
  ).execute(admitted!);
  expect(worker.contexts[0]).not.toHaveProperty("model");
});

test("upgrading keeps pre-routing runs explicitly unrecorded and executable with legacy semantics", async () => {
  const f = await fixture({ cutoff: "0030" });
  const taskId = await f.task();
  f.db
    .prepare(
      `INSERT INTO agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at)
       VALUES ('legacy','p',?, 'agent-qa','queued',?,?)`,
    )
    .run(taskId, now.toISOString(), now.toISOString());
  f.db
    .prepare(
      "INSERT INTO task_lock(task_id,run_id,acquired_at,expires_at) VALUES (?,?,?,?)",
    )
    .run(taskId, "legacy", now.toISOString(), "2026-09-15T00:00:00.000Z");
  const upgrade = migrate(f.db, migrations);
  expect(upgrade.applied).toEqual([
    "0030_agent_run_model_routing.sql",
    "0031_cost_event_charge_basis.sql",
  ]);
  expect(migrate(f.db, migrations).applied).toEqual([]);
  const repository = new SqliteAgentRuntimeRepository(f.db);
  const legacy = (await repository.findRun("legacy"))!;
  expect(legacy.snapshot().modelRouting).toBeUndefined();
  expect(
    f.db
      .query<{ value: string | null }, []>(
        "SELECT model_routing_json value FROM agent_run WHERE id='legacy'",
      )
      .get()?.value,
  ).toBeNull();

  const worker = captureWorker();
  const admitted = await new AdmitAgentRun(
    repository,
    f.tasks,
    f.pipelines,
    clock,
  ).execute(legacy);
  const result = await new ExecuteAgentRun(
    repository,
    new WorkerAgentExecutor(worker, repository, f.tasks, f.pipelines, clock),
    new InMemoryWorktreeManager(),
    clock,
  ).execute(admitted!);
  expect(result.status).toBe("completed");
  expect(worker.contexts[0]).not.toHaveProperty("model");
  // A lifecycle write never backfills the historical record.
  expect(
    (await repository.findRun("legacy"))?.snapshot().modelRouting,
  ).toBeUndefined();
  expect(() =>
    f.db
      .prepare(
        `UPDATE agent_run SET model_routing_json='{"status":"unrouted"}' WHERE id='legacy'`,
      )
      .run(),
  ).toThrow("immutable");
  expect(() =>
    f.db
      .prepare(
        `INSERT INTO agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at,model_routing_json)
         VALUES ('bad','p',?, 'agent-qa','cancelled',?,?,'{"status":"resolved"}')`,
      )
      .run(taskId, now.toISOString(), now.toISOString()),
  ).toThrow();
});

test("diagnostics resolve every agent read-only and never persist or emit credentials", async () => {
  const f = await fixture();
  const environment = {
    OPENAI_API_KEY: secret,
    AI_OFFICE_LLM_MODEL: "openai:gpt-5.4",
  };
  const state = routing(
    `schema_version: 1
profiles:
  balanced: { model: "anthropic:claude-sonnet-4-6" }
default_profile: balanced
agents:
  developer: { model: "openai:gpt-astra" }
  ghost: { profile: balanced }
`,
    environment,
  );
  const before = f.db.serialize();
  const report = await new DescribeModelRouting(
    state,
    new EnvironmentModelProviderCatalog(environment),
    f.projects,
    f.runs,
    new SqliteCostRepository(f.db),
    clock,
  ).execute({ projectId: "p" });
  expect(Buffer.from(f.db.serialize()).equals(Buffer.from(before))).toBe(true);
  expect(report.valid).toBe(true);
  expect(report.project?.agents).toEqual([
    expect.objectContaining({
      agent: "developer",
      policy: "economical",
      profile: null,
      modelRef: "openai:gpt-astra",
      source: "agent_override",
      maxCostMicros: "125000",
    }),
    expect.objectContaining({
      agent: "qa",
      policy: "economical",
      profile: "balanced",
      source: "default",
    }),
  ]);
  expect(report.findings.map((finding) => finding.code).sort()).toEqual(
    [
      "AGENT_OVERRIDE_UNKNOWN_AGENT",
      "POLICY_UNDEFINED",
      "PRICING_MISSING",
      "PRICING_MISSING",
      "PRICING_MISSING",
    ].sort(),
  );
  // Anthropic models run through a client-login worker, which needs no host
  // credential; OpenAI models are gateway-executable with the host key.
  expect(report.providers).toEqual([
    {
      providerId: "anthropic",
      supported: true,
      gatewayExecution: false,
      missingCredentials: [],
    },
    {
      providerId: "openai",
      supported: true,
      gatewayExecution: true,
      missingCredentials: [],
    },
  ]);

  await f.schedule(state, await f.task(), "developer");
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(Buffer.from(f.db.serialize()).includes(secret)).toBe(false);
});
