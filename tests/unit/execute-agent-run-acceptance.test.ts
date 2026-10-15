import { describe, expect, test } from "vitest";
import type {
  AgentExecutor,
  PreparedAgentExecution,
} from "@ai-office/agent-runtime/executor.ts";
import type { WorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import {
  AgentRunPersistenceConflictError,
  type AgentRuntimeRepository,
} from "@ai-office/application/ports/agent-runtime-repository.port.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import {
  AgentRun,
  type AgentRunStatus,
} from "@ai-office/domain/agent/agent-run.ts";

const start = new Date("2026-10-15T00:00:00.000Z");

class TickingClock implements Clock {
  private tick = 0;
  now(): Date {
    return new Date(start.getTime() + ++this.tick);
  }
}

interface StoredRow {
  status: AgentRunStatus;
  updatedAt: Date;
}

// Minimal token-enforcing store: it mirrors the repositories' contract that an
// update must come from an object whose token matches the stored row.
class TokenStore {
  row: StoredRow | undefined;

  readonly repository = {
    saveRun: async (run: AgentRun): Promise<void> => {
      const value = run.snapshot();
      const token = value.persistenceToken;
      if (
        this.row !== undefined &&
        (token === undefined ||
          token.status !== this.row.status ||
          token.updatedAt.getTime() !== this.row.updatedAt.getTime())
      )
        throw new AgentRunPersistenceConflictError(value.id);
      this.row = { status: value.status, updatedAt: value.updatedAt };
      run.markPersisted();
    },
    releaseTaskLock: async (): Promise<boolean> => true,
  } as unknown as AgentRuntimeRepository;

  // Stands in for the acceptance fence persisting the reviewing transition.
  persistReviewing(acceptedAt: Date): void {
    this.row = { status: "reviewing", updatedAt: acceptedAt };
  }
}

function setup(
  accept: (store: TokenStore, at: Date) => Promise<boolean>,
): { store: TokenStore; execute: () => ReturnType<ExecuteAgentRun["execute"]> } {
  const store = new TokenStore();
  const prepared: PreparedAgentExecution = {
    provenance: {
      kind: "worker",
      adapterId: "test",
      adapterVersion: "1",
      inputHash: "a".repeat(64),
    },
    usesWorktree: false,
    execute: async () => ({ summary: "done", artifacts: [] }),
    accept: async (_run, _result, at) => accept(store, at),
  };
  const executor: AgentExecutor = {
    prepare: async () => prepared,
    execute: async () => ({ summary: "unused", artifacts: [] }),
  };
  const worktrees = {} as unknown as WorktreeManager;
  const run = AgentRun.create({
    id: "run-acceptance",
    projectId: "project",
    taskId: "task",
    agentId: "agent",
    now: start,
  });
  return {
    store,
    execute: async () => {
      await store.repository.saveRun(run);
      return new ExecuteAgentRun(
        store.repository,
        executor,
        worktrees,
        new TickingClock(),
      ).execute(run);
    },
  };
}

describe("ExecuteAgentRun acceptance and the persistence token", () => {
  test("follows an acceptance that persisted the reviewing transition", async () => {
    const { store, execute } = setup(async (s, at) => {
      s.persistReviewing(at);
      return true;
    });
    await expect(execute()).resolves.toMatchObject({ status: "completed" });
    expect(store.row?.status).toBe("completed");
  });

  test("does not follow an acceptance that left the stored run untouched", async () => {
    const { store, execute } = setup(async () => false);
    await expect(execute()).resolves.toMatchObject({ status: "completed" });
    expect(store.row?.status).toBe("completed");
  });

  test("refuses the completion save when acceptance persisted but reported false", async () => {
    const { execute } = setup(async (s, at) => {
      s.persistReviewing(at);
      return false;
    });
    await expect(execute()).resolves.toMatchObject({
      status: "interrupted",
      error: { code: "RUN_STATE_PERSISTENCE_FAILED" },
    });
  });
});
