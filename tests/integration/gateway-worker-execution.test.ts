import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { ScheduleAgentRun } from "@ai-office/application/commands/schedule-agent-run.ts";
import { AdmitAgentRun } from "@ai-office/application/commands/admit-agent-run.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import { WorkerAgentExecutor } from "@ai-office/application/commands/worker-agent-executor.ts";
import { projectWorkerOutput } from "@ai-office/application/read-models/worker-output.ts";
import type { ModelRoutingState } from "@ai-office/application/model-routing/model-routing.ts";
import { InMemoryWorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import { loadModelRoutingState } from "@ai-office/llm-gateway/model-routing-configuration.ts";
import {
  EnvironmentGatewayModelProviders,
  GatewayWorkerRuntime,
  gatewayDefaultMaxOutputTokens,
  type GatewayModelProviders,
} from "@ai-office/llm-gateway/gateway-worker-runtime.ts";
import { AnthropicMessagesProvider } from "@ai-office/llm-gateway/anthropic-provider.ts";
import { OpenAiResponsesProvider } from "@ai-office/llm-gateway/openai-provider.ts";
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
const apiKey = "sk-gateway-worker-test-credential";
const migrations = resolve("migrations/project");

afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

/** Placeholder model names: the executor never knows concrete vendor models. */
const routingText = `schema_version: 1
profiles:
  economical: { model: "openai:economy-model", reasoning_effort: low, max_output_tokens: 2000 }
  high_reasoning: { model: "openai:reasoning-model", reasoning_effort: high, max_output_tokens: 4000 }
  uncapped: { model: "openai:economy-model" }
  odd_effort: { model: "openai:economy-model", reasoning_effort: turbo }
  claude_only: { model: "anthropic:client-model", max_output_tokens: 4000 }
agents:
  developer: { profile: high_reasoning }
`;

function routing(text = routingText): ModelRoutingState {
  return loadModelRoutingState(
    { AI_OFFICE_MODEL_ROUTING_FILE: "/host/model-routing.yaml" },
    { readFile: () => text },
  );
}

interface CapturedRequest {
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}

/** The gateway worker's input token bound for a captured Responses request. */
function inputBound(request: CapturedRequest): number {
  const input = request.body.input as { content: string }[];
  return (
    input.reduce(
      (total, message) =>
        total + new TextEncoder().encode(message.content).byteLength + 16,
      0,
    ) + 64
  );
}

/** Expected reservation under the fixture's pricing: max input and output rates. */
function reservationFor(request: CapturedRequest, maxOutputTokens: number) {
  return (
    (BigInt(inputBound(request)) * 1_250_000n +
      BigInt(maxOutputTokens) * 10_000_000n) /
    1_000_000n
  );
}

/**
 * Real registry resolution and the real OpenAI Responses adapter; only the
 * HTTP transport is replaced, so no paid provider is ever called.
 */
function transport(
  answer: (body: Record<string, unknown>) => Record<string, unknown> = (
    body,
  ) => ({
    id: "resp_1",
    model: body.model,
    status: "completed",
    output_text: JSON.stringify({ summary: "Plan", content: "Draft body" }),
    usage: {
      input_tokens: 900,
      input_tokens_details: { cached_tokens: 100 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 120 },
    },
  }),
) {
  const requests: CapturedRequest[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    return Response.json(answer(body));
  };
  return { requests, fetcher };
}

function providers(
  environment: Record<string, string>,
  fetcher: ReturnType<typeof transport>["fetcher"],
): GatewayModelProviders {
  const host = new EnvironmentGatewayModelProviders(environment);
  return {
    descriptors: host.descriptors,
    missingCredentials: (providerId) => host.missingCredentials(providerId),
    resolve: async (modelRef) => {
      const resolved = await host.resolve(modelRef);
      return {
        ...resolved,
        provider:
          resolved.providerId === "anthropic"
            ? new AnthropicMessagesProvider(
                environment.ANTHROPIC_API_KEY!,
                "https://provider.test/v1/messages",
                fetcher,
              )
            : new OpenAiResponsesProvider(
                environment.OPENAI_API_KEY!,
                "https://provider.test/v1/responses",
                fetcher,
              ),
      };
    },
  };
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ao-gateway-worker-"));
  const db = openDatabase(join(root, "project.sqlite"));
  cleanup.push(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  migrate(db, migrations);
  const projects = new SqliteProjectRepository(db);
  const tasks = new SqliteTaskRepository(db);
  const runs = new SqliteAgentRuntimeRepository(db);
  const pipelines = new SqlitePipelineRunRepository(db);
  const costs = new SqliteCostRepository(db);
  let idCount = 0;
  const ids = { generate: () => `id-${++idCount}` };
  await projects.save(Project.create({ id: "p", name: "Gateway", now }));
  const saveRole = (key: string, modelPolicy: string, maxCostMicros: bigint) =>
    runs.saveRole(
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
      }),
    );
  const agents = {
    developer: "economical",
    qa: "economical",
    uncapped: "uncapped",
    odd: "odd_effort",
    claude: "claude_only",
  } as const;
  for (const [name, policy] of Object.entries(agents)) {
    await saveRole(name, policy, 125_000n);
    await runs.saveAgent({
      id: `agent-${name}`,
      projectId: "p",
      roleId: `role-${name}`,
      name,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
  }
  for (const model of ["economy-model", "reasoning-model"])
    await costs.savePricing(
      {
        id: `price-${model}`,
        provider: "openai",
        model,
        currency: "USD",
        // OpenAI-like: $1.25 uncached input, $0.125 cached input, $10 output,
        // reasoning billed as ordinary output.
        inputPerMillionMicros: 1_250_000n,
        cachedInputPerMillionMicros: 125_000n,
        outputPerMillionMicros: 10_000_000n,
        reasoningPerMillionMicros: 10_000_000n,
        effectiveFrom: new Date(0),
      },
      now,
    );
  await costs.savePricing(
    {
      id: "price-client-model",
      provider: "anthropic",
      model: "client-model",
      currency: "USD",
      inputPerMillionMicros: 1_250_000n,
      cachedInputPerMillionMicros: 125_000n,
      outputPerMillionMicros: 10_000_000n,
      reasoningPerMillionMicros: 10_000_000n,
      effectiveFrom: new Date(0),
    },
    now,
  );
  let taskCount = 0;
  const schedule = async (state: ModelRoutingState, agent: string) => {
    taskCount += 1;
    const taskId = `t${taskCount}`;
    await tasks.save(
      Task.create({ id: taskId, projectId: "p", title: `Task ${taskId}`, now }),
    );
    return new ScheduleAgentRun(
      projects,
      tasks,
      runs,
      { generate: () => `r${taskCount}` },
      clock,
      new SqliteTransactionRunner(db),
      pipelines,
      state,
    ).execute({ projectId: "p", taskId, agentId: `agent-${agent}` });
  };
  const execute = async (runId: string, host: GatewayModelProviders) => {
    const admitted = await new AdmitAgentRun(
      runs,
      tasks,
      pipelines,
      clock,
    ).execute((await runs.findRun(runId))!);
    return new ExecuteAgentRun(
      runs,
      new WorkerAgentExecutor(
        new GatewayWorkerRuntime(host, costs, ids, clock),
        runs,
        tasks,
        pipelines,
        clock,
      ),
      new InMemoryWorktreeManager(),
      clock,
    ).execute(admitted!);
  };
  const usageRows = () =>
    db
      .query<{ provider: string; model: string; agent_run_id: string }, []>(
        "SELECT provider, model, agent_run_id FROM model_usage ORDER BY rowid",
      )
      .all();
  const primaryReservationId = (runId: string) =>
    db.query<{ reservation_id: string | null }, [string]>(
      "SELECT reservation_id FROM cost_event c JOIN model_usage u ON u.id = c.usage_id WHERE u.agent_run_id = ?",
    ).get(runId)?.reservation_id ?? null;
  const agentRunReservationId = (runId: string) =>
    db.query<{ id: string }, [string, string]>(
      "SELECT id FROM budget_reservation WHERE agent_run_id = ? AND budget_id IN (SELECT id FROM budget WHERE scope_type='agent_run' AND scope_id=?)",
    ).get(runId, runId)?.id ?? null;
  const costRows = (runId: string) =>
    db
      .query<
        {
          model: string;
          provider_request_id: string | null;
          input_tokens: number;
          output_tokens: number;
          charge_basis: string;
          reserved_micros: number;
          actual_micros: number;
          overage_micros: number;
          reservation_status: string | null;
        },
        [string]
      >(
        `SELECT u.model, u.provider_request_id, u.input_tokens, u.output_tokens,
                c.charge_basis, c.reserved_micros, c.actual_micros, c.overage_micros,
                r.status reservation_status
         FROM cost_event c
         JOIN model_usage u ON u.id = c.usage_id
         LEFT JOIN budget_reservation r ON r.id = c.reservation_id
         WHERE u.agent_run_id = ? ORDER BY c.rowid`,
      )
      .all(runId);
  const reservations = (runId: string) =>
    db
      .query<{ status: string; amount_micros: number }, [string]>(
        "SELECT status, amount_micros FROM budget_reservation WHERE agent_run_id = ? ORDER BY rowid",
      )
      .all(runId);
  return {
    db,
    runs,
    costs,
    schedule,
    execute,
    saveRole,
    usageRows,
    costRows,
    reservations,
    primaryReservationId,
    agentRunReservationId,
  };
}

describe("gateway worker execution of routed runs", () => {
  test("executes a persisted openai selection through the metered gateway", async () => {
    const f = await fixture();
    const runId = await f.schedule(routing(), "qa");
    const http = transport();
    const result = await f.execute(
      runId,
      providers({ OPENAI_API_KEY: apiKey }, http.fetcher),
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      status: "completed",
    });

    // Exactly one request, with the persisted model and parameters applied.
    expect(http.requests).toHaveLength(1);
    expect(http.requests[0]).toMatchObject({
      url: "https://provider.test/v1/responses",
      authorization: `Bearer ${apiKey}`,
      body: {
        model: "economy-model",
        store: false,
        reasoning: { effort: "low" },
        max_output_tokens: 2000,
      },
    });
    const input = http.requests[0]!.body.input as { content: string }[];
    expect(JSON.parse(input[1]!.content)).toMatchObject({
      runId,
      model: { modelRef: "openai:economy-model", profile: "economical" },
    });

    const run = (await f.runs.findRun(runId))!.snapshot();
    expect(run.execution).toMatchObject({
      kind: "worker",
      adapterId: "llm-gateway",
      adapterVersion: "1",
    });
    const output = projectWorkerOutput(run.result);
    expect(output).toMatchObject({
      summary: "Plan",
      content: "Draft body",
      model: "economy-model",
      usage: { inputTokens: 900, outputTokens: 300 },
      // A client estimate is never fabricated for gateway runs.
      estimatedCostUsd: null,
      metering: {
        kind: "gateway",
        providerId: "openai",
        model: "economy-model",
        providerRequestId: "resp_1",
        usage: {
          inputTokens: 900,
          cachedInputTokens: 100,
          outputTokens: 300,
          reasoningTokens: 120,
        },
        appliedParameters: { reasoningEffort: "low", maxOutputTokens: 2000 },
        currency: "USD",
        pricingVersionId: "price-economy-model",
        budgetScope: "agent_run",
        budgetLimitMicros: "125000",
        // Inclusive usage priced by exclusive buckets, each token once:
        // 800 uncached * 1.25 + 100 cached * 0.125 + 180 output * 10
        // + 120 reasoning * 10 = 4012.5 micros.
        actualMicros: "4012",
      },
    });
    // The reservation is the bounded request's worst case: every input token
    // at the dearer input rate and every capped output token at the dearer
    // output rate, never both rates for the same token.
    const metering = output!.metering!;
    expect(metering.reservedMicros).toBe(
      String(reservationFor(http.requests[0]!, 2000)),
    );
    expect(metering.estimatedMicros).toBe(metering.reservedMicros);
    expect(BigInt(metering.actualMicros)).toBeLessThanOrEqual(
      BigInt(metering.reservedMicros),
    );
    expect(run.result).toMatchObject({
      roleLimits: { maxCostMicros: "125000" },
    });
    // Cost accounting lives only in the gateway's own records.
    expect(f.usageRows()).toEqual([
      { provider: "openai", model: "economy-model", agent_run_id: runId },
    ]);
    const budget = await f.costs.findBudget(
      "p",
      "agent_run",
      runId,
      "USD",
      now,
    );
    expect(budget).toMatchObject({ limitMicros: 125_000n, spentMicros: 4012n });
    expect(f.costRows(runId)).toMatchObject([
      { charge_basis: "reported_usage", reservation_status: "consumed" },
    ]);
    expect(budget?.reservedMicros).toBe(0n);
    expect(Buffer.from(f.db.serialize()).includes(apiKey)).toBe(false);
  });
  test("co-reserves configured project, task and agent budgets", async () => {
    const f = await fixture();
    const runId = await f.schedule(routing(), "qa");
    for (const [scopeType, scopeId] of [
      ["project", "p"],
      ["task", "t1"],
      ["agent", "agent-qa"],
    ] as const)
      await f.costs.saveBudget(
        {
          id: `budget-${scopeType}`,
          projectId: "p",
          scopeType,
          scopeId,
          currency: "USD",
          limitMicros: 125_000n,
        },
        now,
      );

    const http = transport();
    await expect(
      f.execute(runId, providers({ OPENAI_API_KEY: apiKey }, http.fetcher)),
    ).resolves.toMatchObject({ status: "completed" });

    expect(f.reservations(runId)).toHaveLength(4);
    expect(
      f.reservations(runId).every((row) => row.status === "consumed"),
    ).toBe(true);
    expect(f.primaryReservationId(runId)).toBe(
      f.agentRunReservationId(runId),
    );
    for (const [scopeType, scopeId] of [
      ["project", "p"],
      ["task", "t1"],
      ["agent", "agent-qa"],
      ["agent_run", runId],
    ] as const) {
      const budget = await f.costs.findBudget(
        "p",
        scopeType,
        scopeId,
        "USD",
        now,
      );
      expect(budget).toMatchObject({
        spentMicros: 4012n,
        reservedMicros: 0n,
      });
    }
  });

  test("releases all four co-reservations after a provider failure", async () => {
    const f = await fixture();
    const runId = await f.schedule(routing(), "qa");
    for (const [scopeType, scopeId] of [
      ["project", "p"],
      ["task", "t1"],
      ["agent", "agent-qa"],
    ] as const)
      await f.costs.saveBudget(
        {
          id: `budget-failure-${scopeType}`,
          projectId: "p",
          scopeType,
          scopeId,
          currency: "USD",
          limitMicros: 125_000n,
        },
        now,
      );

    const result = await f.execute(
      runId,
      providers(
        { OPENAI_API_KEY: apiKey },
        async () => {
          throw new Error("provider unavailable");
        },
      ),
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "WORKER_FAILED" },
    });
    expect(f.reservations(runId)).toHaveLength(4);
    expect(f.reservations(runId).every((row) => row.status === "released")).toBe(
      true,
    );
  });

  test("Anthropic end_turn accepts a valid artifact", async () => {
    const f = await fixture();
    const runId = await f.schedule(routing(), "claude");
    const http = transport((body) => ({
      id: "msg-complete",
      model: body.model,
      stop_reason: "end_turn",
      content: [
        { type: "text", text: JSON.stringify({ summary: "valid", content: "valid" }) },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const result = await f.execute(
      runId,
      providers(
        {
          OPENAI_API_KEY: apiKey,
          ANTHROPIC_API_KEY: "anthropic-test-key",
        },
        http.fetcher,
      ),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "completed" });
    expect(f.costRows(runId)).toMatchObject([
      { charge_basis: "reported_usage", reservation_status: "consumed" },
    ]);
  });

  test("Anthropic non-normal stop reasons reject valid artifacts after metering", async () => {
    for (const stopReason of [
      "max_tokens",
      "model_context_window_exceeded",
      "tool_use",
      "pause_turn",
      "refusal",
    ]) {
      const f = await fixture();
      const runId = await f.schedule(routing(), "claude");
      const http = transport((body) => ({
        id: `msg-${stopReason}`,
        model: body.model,
        stop_reason: stopReason,
        content:
          stopReason === "tool_use"
            ? [{ type: "tool_use", id: "toolu_1", name: "tool" }]
            : [{ type: "text", text: JSON.stringify({ summary: "valid", content: "valid" }) }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }));
      const result = await f.execute(
        runId,
        providers(
          {
            OPENAI_API_KEY: apiKey,
            ANTHROPIC_API_KEY: "anthropic-test-key",
          },
          http.fetcher,
        ),
      );
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "WORKER_OUTPUT_INVALID" },
      });
      expect(f.usageRows()).toEqual([
        { provider: "anthropic", model: "client-model", agent_run_id: runId },
      ]);
      expect(f.costRows(runId)).toMatchObject([
        { charge_basis: "reported_usage", reservation_status: "consumed" },
      ]);
    }
  });

  test("uses the persisted model after routing changes and ignores ambient model settings", async () => {
    const f = await fixture();
    const runId = await f.schedule(routing(), "qa");
    const ambient = process.env.AI_OFFICE_LLM_MODEL;
    process.env.AI_OFFICE_LLM_MODEL = "openai:ambient-model";
    try {
      // Host routing now maps the policy elsewhere; execution does not consult it.
      expect(
        routing(`schema_version: 1
profiles:
  economical: { model: "openai:reasoning-model" }
`).status,
      ).toBe("configured");
      const http = transport();
      const result = await f.execute(
        runId,
        providers(
          {
            OPENAI_API_KEY: apiKey,
            AI_OFFICE_LLM_MODEL: "openai:ambient-model",
          },
          http.fetcher,
        ),
      );
      expect(result.status).toBe("completed");
      expect(http.requests.map((request) => request.body.model)).toEqual([
        "economy-model",
      ]);
    } finally {
      if (ambient === undefined) delete process.env.AI_OFFICE_LLM_MODEL;
      else process.env.AI_OFFICE_LLM_MODEL = ambient;
    }
  });

  test("a different effective model fails closed but its answered request stays charged", async () => {
    const f = await fixture();
    const runId = await f.schedule(routing(), "qa");
    const http = transport((body) => ({
      id: "resp_drift",
      model: `${String(body.model)}-2026-01-01`,
      status: "completed",
      output_text: JSON.stringify({ summary: "Plan", content: "Draft" }),
      usage: { input_tokens: 10, output_tokens: 10 },
    }));
    const result = await f.execute(
      runId,
      providers({ OPENAI_API_KEY: apiKey }, http.fetcher),
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "WORKER_MODEL_MISMATCH" },
    });
    expect(http.requests).toHaveLength(1);
    expect((await f.runs.findRun(runId))!.snapshot().result).toBeUndefined();

    // The substituted model is unpriced, so the reserved worst case is charged
    // rather than released; the usage row keeps what actually answered.
    const reserved = reservationFor(http.requests[0]!, 2000);
    expect(f.costRows(runId)).toEqual([
      {
        model: "economy-model-2026-01-01",
        provider_request_id: "resp_drift",
        input_tokens: 10,
        output_tokens: 10,
        charge_basis: "reserved_envelope",
        reserved_micros: Number(reserved),
        actual_micros: Number(reserved),
        overage_micros: 0,
        reservation_status: "consumed",
      },
    ]);
    const budget = await f.costs.findBudget(
      "p",
      "agent_run",
      runId,
      "USD",
      now,
    );
    // Capacity is not restored as if no request had happened.
    expect(budget).toMatchObject({ spentMicros: reserved, reservedMicros: 0n });
  });

  test("a rejected answer reusing a recorded provider request id is not charged twice", async () => {
    const f = await fixture();
    const first = await f.schedule(routing(), "qa");
    const second = await f.schedule(routing(), "qa");
    const host = (model: (requested: string) => string) =>
      providers(
        { OPENAI_API_KEY: apiKey },
        transport((body) => ({
          id: "resp_same",
          model: model(String(body.model)),
          status: "completed",
          output_text: JSON.stringify({ summary: "Plan", content: "Draft" }),
          usage: { input_tokens: 10, output_tokens: 10 },
        })).fetcher,
      );
    expect(
      (
        await f.execute(
          first,
          host((value) => value),
        )
      ).status,
    ).toBe("completed");
    expect(
      await f.execute(
        second,
        host((value) => `${value}-snapshot`),
      ),
    ).toMatchObject({
      status: "failed",
      error: { code: "WORKER_MODEL_MISMATCH" },
    });
    expect(f.usageRows()).toEqual([
      { provider: "openai", model: "economy-model", agent_run_id: first },
    ]);
    expect(f.reservations(second)).toMatchObject([{ status: "released" }]);
  });

  test("a malformed provider response is rejected and charged at the reserved envelope", async () => {
    const f = await fixture();
    const artifact = JSON.stringify({ summary: "Plan", content: "Draft" });
    for (const answer of [
      // No usage at all: nothing reported can be trusted.
      { id: "resp_no_usage", model: "economy-model", output_text: artifact },
      // Impossible subsets: cached above input, reasoning above output.
      {
        id: "resp_bad_cache",
        model: "economy-model",
        status: "completed",
        output_text: artifact,
        usage: {
          input_tokens: 10,
          input_tokens_details: { cached_tokens: 11 },
          output_tokens: 5,
        },
      },
      {
        id: "resp_bad_reasoning",
        model: "economy-model",
        status: "completed",
        output_text: artifact,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 6 },
        },
      },
    ]) {
      const runId = await f.schedule(routing(), "qa");
      const http = transport(() => answer);
      expect(
        await f.execute(
          runId,
          providers({ OPENAI_API_KEY: apiKey }, http.fetcher),
        ),
      ).toMatchObject({
        status: "failed",
        error: { code: "WORKER_OUTPUT_INVALID" },
      });
      expect((await f.runs.findRun(runId))!.snapshot().result).toBeUndefined();
      const reserved = Number(reservationFor(http.requests[0]!, 2000));
      // Rejected usage is recorded as unknown, never as reported. A well-formed
      // request id is kept for idempotency when the adapter produced a response.
      expect(f.costRows(runId)).toEqual([
        {
          model: "economy-model",
          provider_request_id: "usage" in answer ? answer.id : null,
          input_tokens: 0,
          output_tokens: 0,
          charge_basis: "reserved_envelope",
          reserved_micros: reserved,
          actual_micros: reserved,
          overage_micros: 0,
          reservation_status: "consumed",
        },
      ]);
    }
  });

  test("unsupported execution parameters and providers fail before any request", async () => {
    const f = await fixture();
    for (const [agent, code] of [
      ["odd", "WORKER_MODEL_UNSUPPORTED"],
      ["claude", "WORKER_CREDENTIALS_MISSING"],
    ] as const) {
      const runId = await f.schedule(routing(), agent);
      const http = transport();
      const result = await f.execute(
        runId,
        providers({ OPENAI_API_KEY: apiKey }, http.fetcher),
      );
      expect(result).toMatchObject({ status: "failed", error: { code } });
      expect(http.requests).toEqual([]);
      if (agent === "odd")
        expect(
          (await f.runs.findRun(runId))!.snapshot().execution,
        ).toBeUndefined();
      else
        expect(
          (await f.runs.findRun(runId))!.snapshot().execution,
        ).toMatchObject({ kind: "worker", adapterId: "llm-gateway" });
    }
    expect(f.usageRows()).toEqual([]);
  });

  test("unrouted runs are refused instead of using an ambient default", async () => {
    const f = await fixture();
    const runId = await f.schedule(
      loadModelRoutingState({}, { runtimeHome: "/nonexistent-runtime-home" }),
      "qa",
    );
    const http = transport();
    const result = await f.execute(
      runId,
      providers(
        { OPENAI_API_KEY: apiKey, AI_OFFICE_LLM_MODEL: "openai:economy-model" },
        http.fetcher,
      ),
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "WORKER_MODEL_REQUIRED" },
    });
    expect(http.requests).toEqual([]);
  });

  test("missing credentials fail before any request", async () => {
    const f = await fixture();
    const runId = await f.schedule(routing(), "qa");
    const http = transport();
    const result = await f.execute(runId, providers({}, http.fetcher));
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "WORKER_CREDENTIALS_MISSING" },
    });
    expect(http.requests).toEqual([]);
  });

  test("a stronger model never widens the role budget", async () => {
    const f = await fixture();
    const economical = await f.schedule(routing(), "qa");
    const stronger = await f.schedule(routing(), "developer");
    // An operator-set run budget wider than the role limit is lowered to it.
    await f.costs.saveBudget(
      {
        id: "wide",
        projectId: "p",
        scopeType: "agent_run",
        scopeId: stronger,
        currency: "USD",
        limitMicros: 9_000_000n,
      },
      now,
    );
    const http = transport();
    const host = providers({ OPENAI_API_KEY: apiKey }, http.fetcher);
    expect((await f.execute(economical, host)).status).toBe("completed");
    expect((await f.execute(stronger, host)).status).toBe("completed");
    expect(http.requests.map((request) => request.body.model)).toEqual([
      "economy-model",
      "reasoning-model",
    ]);
    for (const runId of [economical, stronger]) {
      const run = (await f.runs.findRun(runId))!.snapshot();
      expect(projectWorkerOutput(run.result)?.metering?.budgetLimitMicros).toBe(
        "125000",
      );
      expect(
        (await f.costs.findBudget("p", "agent_run", runId, "USD", now))
          ?.limitMicros,
      ).toBe(125_000n);
    }
  });

  test("missing pricing and an exhausted role budget fail before an unmetered request", async () => {
    const f = await fixture();
    // No pricing for the reasoning model's replacement.
    f.db
      .prepare("DELETE FROM pricing_version WHERE model='reasoning-model'")
      .run();
    const unpriced = await f.schedule(routing(), "developer");
    const http = transport();
    const host = providers({ OPENAI_API_KEY: apiKey }, http.fetcher);
    expect(await f.execute(unpriced, host)).toMatchObject({
      status: "failed",
      error: { code: "WORKER_PRICING_UNAVAILABLE" },
    });

    // Without max_output_tokens the executor's bounded default applies, and
    // its worst-case cost exceeds this role budget: nothing is sent.
    const uncapped = await f.schedule(routing(), "uncapped");
    const result = await f.execute(uncapped, host);
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "WORKER_BUDGET_EXHAUSTED" },
    });
    expect(gatewayDefaultMaxOutputTokens * 10).toBeGreaterThan(125_000);
    expect(http.requests).toEqual([]);
    expect(f.usageRows()).toEqual([]);
  });

  test("a truncated or malformed answer is recorded as cost but never accepted", async () => {
    const f = await fixture();
    const runId = await f.schedule(routing(), "qa");
    const http = transport((body) => ({
      id: "resp_incomplete",
      model: body.model,
      status: "incomplete",
      incomplete_details: { reason: "max_output_tokens" },
      output_text: '{"summary": "Pl',
      usage: { input_tokens: 10, output_tokens: 2000 },
    }));
    const result = await f.execute(
      runId,
      providers({ OPENAI_API_KEY: apiKey }, http.fetcher),
    );
    expect(result).toMatchObject({
      status: "failed",
      error: { code: "WORKER_OUTPUT_INVALID" },
    });
    expect(f.usageRows()).toHaveLength(1);
    // Valid usage was reported, so it is priced as reported: 10 * 1.25 + 2000 * 10.
    expect(f.costRows(runId)).toMatchObject([
      {
        charge_basis: "reported_usage",
        actual_micros: 20_012,
        reservation_status: "consumed",
      },
    ]);
    expect((await f.runs.findRun(runId))!.snapshot().result).toBeUndefined();
  });

  test("a budget that fits the true worst case is not refused for double counting", async () => {
    const f = await fixture();
    // high_reasoning caps output at 4000 tokens.
    const runId = await f.schedule(routing(), "developer");
    await f.costs.saveBudget(
      {
        id: "narrow",
        projectId: "p",
        scopeType: "agent_run",
        scopeId: runId,
        currency: "USD",
        limitMicros: 60_000n,
      },
      now,
    );
    const http = transport();
    const result = await f.execute(
      runId,
      providers({ OPENAI_API_KEY: apiKey }, http.fetcher),
    );
    expect(result.status).toBe("completed");
    const request = http.requests[0]!;
    const reserved = reservationFor(request, 4000);
    expect(reserved).toBeLessThan(60_000n);
    // Charging every token at both of its bucket rates would not have fit.
    expect(
      (BigInt(inputBound(request)) * 1_375_000n + 4000n * 20_000_000n) /
        1_000_000n,
    ).toBeGreaterThan(60_000n);
    expect(
      projectWorkerOutput((await f.runs.findRun(runId))!.snapshot().result)
        ?.metering,
    ).toMatchObject({
      model: "reasoning-model",
      budgetLimitMicros: "60000",
      reservedMicros: String(reserved),
      actualMicros: "4012",
    });
  });
});
