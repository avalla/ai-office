import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { MeteredLlmGateway } from "@ai-office/llm-gateway/metered-gateway.ts";
import { MockLlmProvider } from "@ai-office/llm-gateway/mock-provider.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteCostRepository } from "@ai-office/storage-sqlite/repositories/sqlite-cost.repository.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";

const directories: string[] = [];
const migrations = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);
class Fixed implements Clock {
  now(): Date {
    return new Date("2026-08-05T00:00:00Z");
  }
}
class Ids implements IdGenerator {
  private value = 0;
  generate(): string {
    return `id-${++this.value}`;
  }
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("M3-M5 SQLite storage", () => {
  test("atomically consumes reservations and aggregates persisted cost dimensions", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-cost-storage-"));
    directories.push(root);
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, migrations);
    const now = new Fixed().now();
    await new SqliteProjectRepository(database).save(
      Project.create({ id: "project", name: "Demo", now }),
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
        outputPerMillionMicros: 2_000_000n,
        reasoningPerMillionMicros: 0n,
        effectiveFrom: new Date(0),
      },
      now,
    );
    await costs.saveBudget(
      {
        id: "budget",
        projectId: "project",
        scopeType: "project",
        scopeId: "project",
        currency: "USD",
        limitMicros: 1_000n,
      },
      now,
    );
    const provider = new MockLlmProvider({
      text: "ok",
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 5,
        reasoningTokens: 0,
      },
    });
    await new MeteredLlmGateway(
      provider,
      costs,
      new Ids(),
      new Fixed(),
    ).complete(
      { model: "model", messages: [] },
      {
        projectId: "project",
        purpose: "integration",
        estimatedUsage: {
          inputTokens: 10,
          cachedInputTokens: 0,
          outputTokens: 5,
          reasoningTokens: 0,
        },
        budgetScopeId: "project",
      },
    );

    expect(await costs.aggregate("project", "project")).toEqual([
      { dimension: "project", actualMicros: 20n, currency: "USD" },
    ]);
    expect(
      database
        .query<{ status: string }, []>("SELECT status FROM budget_reservation")
        .get()?.status,
    ).toBe("consumed");

    const governance = new SqliteGovernanceRepository(database);
    await expect(
      governance.saveApproval({
        id: "approval",
        projectId: "project",
        reviewId: "missing",
        decision: "approved",
        actor: "owner",
        createdAt: now,
      }),
    ).rejects.toThrow("FOREIGN KEY constraint failed");
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) count FROM approval")
        .get()?.count,
    ).toBe(0);
    database.close();
  });
});
