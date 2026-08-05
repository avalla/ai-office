import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BudgetExceededError,
  MonetaryOverflowError,
  PricingOverlapError,
  ReservationExpiredError,
} from "@ai-office/application/cost-errors.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteCostRepository } from "@ai-office/storage-sqlite/repositories/sqlite-cost.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";

const roots: string[] = [];
const migrationDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);
const now = new Date("2026-08-05T00:00:00.000Z");

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-cost-hardening-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, migrationDirectory);
  await new SqliteProjectRepository(database).save(
    Project.create({ id: "project", name: "Demo", now }),
  );
  await new SqliteTaskRepository(database).save(
    Task.create({ id: "task", projectId: "project", title: "Task", now }),
  );
  const runtime = new SqliteAgentRuntimeRepository(database);
  await runtime.saveRole(
    Role.create({
      id: "role",
      projectId: "project",
      key: "developer",
      name: "Developer",
      version: 1,
      capabilities: [],
      tools: [],
      modelPolicy: "mock",
      limits: {
        maxIterations: 1,
        maxCostMicros: 100n,
        timeoutSeconds: 60,
      },
      sourcePath: "agent.yaml",
      now,
    }),
  );
  await runtime.saveAgent({
    id: "agent",
    projectId: "project",
    roleId: "role",
    name: "Developer",
    enabled: true,
    createdAt: now,
    updatedAt: now,
  });
  await runtime.saveRun(
    AgentRun.create({
      id: "run",
      projectId: "project",
      taskId: "task",
      agentId: "agent",
      now,
    }),
  );
  const costs = new SqliteCostRepository(database);
  await costs.savePricing(
    {
      id: "pricing",
      provider: "mock",
      model: "model",
      currency: "USD",
      inputPerMillionMicros: 1_000_000n,
      cachedInputPerMillionMicros: 0n,
      outputPerMillionMicros: 1_000_000n,
      reasoningPerMillionMicros: 0n,
      effectiveFrom: new Date(0),
    },
    now,
  );
  return { database, costs };
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("atomic budget reservations", () => {
  test("has one winner when two reservations exceed the same remainder", async () => {
    const { database, costs } = await setup();
    await costs.saveBudget(
      {
        id: "budget",
        projectId: "project",
        scopeType: "project",
        scopeId: "project",
        currency: "USD",
        limitMicros: 100n,
      },
      now,
    );
    const request = (id: string, amountMicros: bigint) =>
      costs.authorizeAndReserve({
        id,
        projectId: "project",
        scopeType: "project",
        scopeId: "project",
        currency: "USD",
        amountMicros,
        now,
        expiresAt: new Date(now.getTime() + 60_000),
      });
    const results = await Promise.allSettled([
      request("reservation-1", 60n),
      request("reservation-2", 50n),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: expect.any(BudgetExceededError) });
    expect(
      database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM budget_reservation WHERE status='active'",
        )
        .get()?.count,
    ).toBe(1);
    database.close();
  });

  test("allows an amount exactly equal to the remainder and releases idempotently", async () => {
    const { database, costs } = await setup();
    await costs.saveBudget(
      {
        id: "budget",
        projectId: "project",
        scopeType: "project",
        scopeId: "project",
        currency: "USD",
        limitMicros: 100n,
      },
      now,
    );
    for (const [id, amount] of [
      ["reservation-1", 60n],
      ["reservation-2", 40n],
    ] as const)
      await costs.authorizeAndReserve({
        id,
        projectId: "project",
        scopeType: "project",
        scopeId: "project",
        currency: "USD",
        amountMicros: amount,
        now,
        expiresAt: new Date(now.getTime() + 60_000),
      });
    await expect(costs.releaseReservation("reservation-2", now)).resolves.toBe(
      "released",
    );
    await expect(costs.releaseReservation("reservation-2", now)).resolves.toBe(
      "already_released",
    );
    database.close();
  });

  test("ignores expired reservations until explicit audited cleanup", async () => {
    const { database, costs } = await setup();
    await costs.saveBudget(
      {
        id: "budget",
        projectId: "project",
        scopeType: "project",
        scopeId: "project",
        currency: "USD",
        limitMicros: 10n,
      },
      now,
    );
    await costs.authorizeAndReserve({
      id: "expired",
      projectId: "project",
      scopeType: "project",
      scopeId: "project",
      currency: "USD",
      amountMicros: 10n,
      now,
      expiresAt: new Date(now.getTime() + 1_000),
    });
    const later = new Date(now.getTime() + 1_000);
    expect(
      (await costs.findBudget("project", "project", "project", "USD", later))
        ?.reservedMicros,
    ).toBe(0n);
    await expect(costs.releaseExpiredReservations(later)).resolves.toBe(1);
    await expect(costs.releaseExpiredReservations(later)).resolves.toBe(0);
    database.close();
  });
});

describe("scope accounting and finalization", () => {
  test("rejects cross-project budget and usage ownership", async () => {
    const { database, costs } = await setup();
    await new SqliteProjectRepository(database).save(
      Project.create({ id: "other-project", name: "Other", now }),
    );
    await new SqliteTaskRepository(database).save(
      Task.create({
        id: "other-task",
        projectId: "other-project",
        title: "Other",
        now,
      }),
    );
    await expect(
      costs.saveBudget(
        {
          id: "cross-budget",
          projectId: "project",
          scopeType: "task",
          scopeId: "other-task",
          currency: "USD",
          limitMicros: 10n,
        },
        now,
      ),
    ).rejects.toThrow("invalid or cross-project budget scope");
    await expect(
      costs.recordUsageAndCost({
        usageId: "cross-usage",
        costEventId: "cross-cost",
        context: {
          projectId: "project",
          taskId: "other-task",
          purpose: "cross-project",
        },
        provider: "mock",
        model: "model",
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        pricingVersionId: "pricing",
        estimated: { micros: 1n, currency: "USD" },
        actual: { micros: 1n, currency: "USD" },
        occurredAt: now,
      }),
    ).rejects.toThrow("model usage references must belong to the same project");
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) count FROM model_usage")
        .get()?.count,
    ).toBe(0);
    database.close();
  });

  test("calculates project, task, agent and agent_run spend independently", async () => {
    const { database, costs } = await setup();
    for (const [scopeType, scopeId] of [
      ["project", "project"],
      ["task", "task"],
      ["agent", "agent"],
      ["agent_run", "run"],
    ] as const)
      await costs.saveBudget(
        {
          id: `budget-${scopeType}`,
          projectId: "project",
          scopeType,
          scopeId,
          currency: "USD",
          limitMicros: 1_000n,
        },
        now,
      );

    await costs.recordUsageAndCost({
      usageId: "usage-scoped",
      costEventId: "cost-scoped",
      context: {
        projectId: "project",
        taskId: "task",
        agentId: "agent",
        agentRunId: "run",
        purpose: "scoped",
      },
      provider: "mock",
      model: "model",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      pricingVersionId: "pricing",
      estimated: { micros: 10n, currency: "USD" },
      actual: { micros: 10n, currency: "USD" },
      occurredAt: now,
    });
    await costs.recordUsageAndCost({
      usageId: "usage-project",
      costEventId: "cost-project",
      context: { projectId: "project", purpose: "project-only" },
      provider: "mock",
      model: "model",
      usage: {
        inputTokens: 5,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      pricingVersionId: "pricing",
      estimated: { micros: 5n, currency: "USD" },
      actual: { micros: 5n, currency: "USD" },
      occurredAt: now,
    });

    expect(
      (await costs.findBudget("project", "project", "project", "USD", now))
        ?.spentMicros,
    ).toBe(15n);
    expect(
      (await costs.findBudget("project", "task", "task", "USD", now))
        ?.spentMicros,
    ).toBe(10n);
    expect(
      (await costs.findBudget("project", "agent", "agent", "USD", now))
        ?.spentMicros,
    ).toBe(10n);
    expect(
      (await costs.findBudget("project", "agent_run", "run", "USD", now))
        ?.spentMicros,
    ).toBe(10n);
    database.close();
  });

  test("records overage and consumes once", async () => {
    const { database, costs } = await setup();
    await costs.saveBudget(
      {
        id: "budget",
        projectId: "project",
        scopeType: "project",
        scopeId: "project",
        currency: "USD",
        limitMicros: 100n,
      },
      now,
    );
    await costs.authorizeAndReserve({
      id: "reservation",
      projectId: "project",
      scopeType: "project",
      scopeId: "project",
      currency: "USD",
      amountMicros: 10n,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const input = {
      usageId: "usage",
      costEventId: "cost",
      context: { projectId: "project", purpose: "overage" },
      provider: "mock",
      model: "model",
      providerRequestId: "provider-request",
      usage: {
        inputTokens: 15,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      pricingVersionId: "pricing",
      reservationId: "reservation",
      estimated: { micros: 8n, currency: "USD" as const },
      actual: { micros: 15n, currency: "USD" as const },
      occurredAt: now,
    };
    await expect(costs.recordUsageAndCost(input)).resolves.toBe("recorded");
    await expect(
      costs.recordUsageAndCost({
        ...input,
        usageId: "usage-retry",
        costEventId: "cost-retry",
      }),
    ).resolves.toBe("duplicate");
    expect(
      database
        .query<
          {
            estimated: number;
            reserved: number;
            actual: number;
            overage: number;
          },
          []
        >(
          `SELECT estimated_micros estimated, reserved_micros reserved,
                  actual_micros actual, overage_micros overage
           FROM cost_event`,
        )
        .get(),
    ).toEqual({ estimated: 8, reserved: 10, actual: 15, overage: 5 });
    await expect(costs.releaseReservation("reservation", now)).resolves.toBe(
      "consumed",
    );
    database.close();
  });

  test("rejects finalization after reservation expiry", async () => {
    const { database, costs } = await setup();
    await costs.saveBudget(
      {
        id: "budget",
        projectId: "project",
        scopeType: "project",
        scopeId: "project",
        currency: "USD",
        limitMicros: 100n,
      },
      now,
    );
    await costs.authorizeAndReserve({
      id: "reservation",
      projectId: "project",
      scopeType: "project",
      scopeId: "project",
      currency: "USD",
      amountMicros: 10n,
      now,
      expiresAt: new Date(now.getTime() + 1),
    });
    await expect(
      costs.recordUsageAndCost({
        usageId: "usage",
        costEventId: "cost",
        context: { projectId: "project", purpose: "expired" },
        provider: "mock",
        model: "model",
        usage: {
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        pricingVersionId: "pricing",
        reservationId: "reservation",
        estimated: { micros: 1n, currency: "USD" },
        actual: { micros: 1n, currency: "USD" },
        occurredAt: new Date(now.getTime() + 1),
      }),
    ).rejects.toBeInstanceOf(ReservationExpiredError);
    database.close();
  });
});

describe("pricing intervals and monetary integrity", () => {
  test("allows exact boundaries and rejects overlapping intervals", async () => {
    const { database, costs } = await setup();
    await costs.savePricing(
      {
        id: "bounded",
        provider: "bounded",
        model: "model",
        currency: "USD",
        inputPerMillionMicros: 1n,
        cachedInputPerMillionMicros: 0n,
        outputPerMillionMicros: 0n,
        reasoningPerMillionMicros: 0n,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
        effectiveTo: new Date("2026-02-01T00:00:00Z"),
      },
      now,
    );
    await expect(
      costs.savePricing(
        {
          id: "boundary",
          provider: "bounded",
          model: "model",
          currency: "USD",
          inputPerMillionMicros: 2n,
          cachedInputPerMillionMicros: 0n,
          outputPerMillionMicros: 0n,
          reasoningPerMillionMicros: 0n,
          effectiveFrom: new Date("2026-02-01T00:00:00Z"),
        },
        now,
      ),
    ).resolves.toBeUndefined();
    await expect(
      costs.savePricing(
        {
          id: "overlap",
          provider: "bounded",
          model: "model",
          currency: "USD",
          inputPerMillionMicros: 3n,
          cachedInputPerMillionMicros: 0n,
          outputPerMillionMicros: 0n,
          reasoningPerMillionMicros: 0n,
          effectiveFrom: new Date("2026-01-15T00:00:00Z"),
          effectiveTo: new Date("2026-03-01T00:00:00Z"),
        },
        now,
      ),
    ).rejects.toBeInstanceOf(PricingOverlapError);
    database.close();
  });

  test("closes an open pricing version when a later version is saved", async () => {
    const { database, costs } = await setup();
    await costs.savePricing(
      {
        id: "open-1",
        provider: "versioned",
        model: "model",
        currency: "USD",
        inputPerMillionMicros: 1n,
        cachedInputPerMillionMicros: 0n,
        outputPerMillionMicros: 0n,
        reasoningPerMillionMicros: 0n,
        effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      },
      now,
    );
    await costs.savePricing(
      {
        id: "open-2",
        provider: "versioned",
        model: "model",
        currency: "USD",
        inputPerMillionMicros: 2n,
        cachedInputPerMillionMicros: 0n,
        outputPerMillionMicros: 0n,
        reasoningPerMillionMicros: 0n,
        effectiveFrom: new Date("2026-02-01T00:00:00Z"),
      },
      now,
    );
    expect(
      database
        .query<{ effective_to: string }, [string]>(
          "SELECT effective_to FROM pricing_version WHERE id=?",
        )
        .get("open-1")?.effective_to,
    ).toBe("2026-02-01T00:00:00.000Z");
    database.close();
  });

  test("accepts SQLite's safe integer boundary and rejects overflow", async () => {
    const { database, costs } = await setup();
    await expect(
      costs.saveBudget(
        {
          id: "safe",
          projectId: "project",
          scopeType: "project",
          scopeId: "project",
          currency: "USD",
          limitMicros: BigInt(Number.MAX_SAFE_INTEGER),
        },
        now,
      ),
    ).resolves.toBeUndefined();
    await expect(
      costs.saveBudget(
        {
          id: "overflow",
          projectId: "project",
          scopeType: "project",
          scopeId: "project",
          currency: "EUR",
          limitMicros: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
        },
        now,
      ),
    ).rejects.toBeInstanceOf(MonetaryOverflowError);
    database.close();
  });
});
