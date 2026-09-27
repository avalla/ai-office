import { afterEach, describe, expect, test, vi } from "vitest";
import {
  isSurrealConcurrencyConflict,
  SurrealConcurrencyExperiment,
} from "../../packages/storage-surrealdb/src/concurrency-experiment.ts";
import {
  isRetryableConflict,
  QueryError,
  Surreal,
} from "../../packages/storage-surrealdb/src/project-storage/test-support.ts";
import { withSurrealTransaction } from "../../packages/storage-surrealdb/src/project-storage/transaction-context.ts";

const pinnedMessage = "There was a problem with the key-value store: Transaction conflict: Write conflict, retry the transaction. This transaction can be retried";
afterEach(() => vi.restoreAllMocks());

describe("experimental conflict classification", () => {
  test("accepts an SDK-classified structured conflict independently of its message", () => {
    const error = new QueryError({
      kind: "Query", code: -32009, message: "structured conflict",
      details: { kind: "TransactionConflict" },
    });
    expect(isRetryableConflict(error)).toBe(true);
    expect(isSurrealConcurrencyConflict(error)).toBe(true);
  });

  test("recognizes only the exact pinned-server unstructured write-conflict message", () => {
    const error = new Error(pinnedMessage);
    expect(isRetryableConflict(error)).toBe(false);
    expect(isSurrealConcurrencyConflict(error)).toBe(true);
  });

  test.each([
    new Error("connection closed"),
    new Error("Transaction conflict: Write conflict"),
    new Error("There was a problem with the key-value store: Transaction conflict: Read conflict, retry the transaction. This transaction can be retried"),
    new Error(`context: ${pinnedMessage}`),
    new Error(`${pinnedMessage} (not retryable)`),
    new Error("Transaction not found"),
    { message: pinnedMessage },
    null,
  ])("does not classify unrelated errors or lookalikes: %s", (error) => {
    expect(isSurrealConcurrencyConflict(error)).toBe(false);
  });
});

describe("experimental renewal outcomes", () => {
  const input = {
    id: "lease", owner: "worker", fence: 1,
    now: new Date("2026-09-27T12:00:00Z"),
    leaseUntil: new Date("2026-09-27T12:01:00Z"),
  };

  test.each([undefined, null])("an empty ONLY result is predicate_miss (%s)", async (empty) => {
    const db = new Surreal();
    vi.spyOn(db, "query").mockResolvedValue([empty]);
    expect(await new SurrealConcurrencyExperiment(db).renew(input)).toBe("predicate_miss");
  });

  test("an updated row is applied", async () => {
    const db = new Surreal();
    vi.spyOn(db, "query").mockResolvedValue([{ owner: "worker", fence: 1 }]);
    expect(await new SurrealConcurrencyExperiment(db).renew(input)).toBe("applied");
  });

  test("a recognized conflict is distinct from stale authority and is not retried", async () => {
    const db = new Surreal();
    const query = vi.spyOn(db, "query").mockRejectedValue(new Error(pinnedMessage));
    expect(await new SurrealConcurrencyExperiment(db).renew(input)).toBe("conflict");
    expect(query).toHaveBeenCalledTimes(1);
  });

  test("unexpected database errors propagate unchanged", async () => {
    const db = new Surreal();
    const error = new Error("permission denied");
    vi.spyOn(db, "query").mockRejectedValue(error);
    await expect(new SurrealConcurrencyExperiment(db).renew(input)).rejects.toBe(error);
  });
});

test.each(["work", "commit"])("rollback cleanup cannot mask the original %s error", async (stage) => {
  const db = new Surreal();
  const error = new Error("original failure");
  const transaction = {
    commit: vi.fn(async () => { if (stage === "commit") throw error; }),
    cancel: vi.fn().mockRejectedValue(new Error("Transaction not found")),
  };
  vi.spyOn(db, "beginTransaction").mockResolvedValue(
    transaction as unknown as Awaited<ReturnType<Surreal["beginTransaction"]>>,
  );
  await expect(withSurrealTransaction(db, async () => {
    if (stage === "work") throw error;
  })).rejects.toBe(error);
  expect(transaction.cancel).toHaveBeenCalledTimes(1);
});
