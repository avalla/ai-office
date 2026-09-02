import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import type {
  Worktree,
  WorktreeManager,
} from "@ai-office/agent-runtime/worktree.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import { AgentRun } from "@ai-office/domain/agent/agent-run.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
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
class FixedClock implements Clock {
  now() {
    return new Date("2026-08-05T00:00:00Z");
  }
}
class FakeExecutor implements AgentExecutor {
  constructor(private readonly error?: Error) {}
  async execute() {
    if (this.error) throw this.error;
    return { summary: "done", artifacts: [] };
  }
}
class FakeWorktrees implements WorktreeManager {
  prepareCalls = 0;
  releaseCalls = 0;
  constructor(
    private readonly prepareError?: Error,
    private readonly releaseError?: Error,
  ) {}
  async prepare(runId: string): Promise<Worktree> {
    this.prepareCalls++;
    if (this.prepareError) throw this.prepareError;
    return { path: `/tmp/${runId}`, branch: `run-${runId}` };
  }
  async release(): Promise<void> {
    this.releaseCalls++;
    if (this.releaseError) throw this.releaseError;
  }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-runtime-hardening-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, migrationDirectory);
  const now = new FixedClock().now();
  const projects = new SqliteProjectRepository(database);
  const tasks = new SqliteTaskRepository(database);
  const runtime = new SqliteAgentRuntimeRepository(database);
  await projects.save(Project.create({ id: "project", name: "Demo", now }));
  await tasks.save(
    Task.create({ id: "task", projectId: "project", title: "Task", now }),
  );
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
      limits: { maxIterations: 1, maxCostMicros: 0n, timeoutSeconds: 60 },
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
  for (const id of ["run-1", "run-2", "run-3"]) {
    await runtime.saveRun(
      AgentRun.create({
        id,
        projectId: "project",
        taskId: "task",
        agentId: "agent",
        now,
      }),
    );
  }
  return { database, runtime, now };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("task lock ownership and expiry", () => {
  test("rejects cross-project agent and run references at storage level", async () => {
    const { database, runtime, now } = await setup();
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
    await runtime.saveRole(
      Role.create({
        id: "other-role",
        projectId: "other-project",
        key: "other",
        name: "Other",
        version: 1,
        capabilities: [],
        tools: [],
        modelPolicy: "mock",
        limits: {
          maxIterations: 1,
          maxCostMicros: 0n,
          timeoutSeconds: 60,
        },
        sourcePath: "other.yaml",
        now,
      }),
    );
    await expect(
      runtime.saveAgent({
        id: "cross-agent",
        projectId: "project",
        roleId: "other-role",
        name: "Cross",
        enabled: true,
        createdAt: now,
        updatedAt: now,
      }),
    ).rejects.toThrow("agent role must belong to the same project");
    await expect(
      runtime.saveRun(
        AgentRun.create({
          id: "cross-run",
          projectId: "project",
          taskId: "other-task",
          agentId: "agent",
          now,
        }),
      ),
    ).rejects.toThrow("agent run references must belong to the same project");
    database.close();
  });

  test("lists non-terminal runs that need explicit crash recovery", async () => {
    const { database, runtime, now } = await setup();
    const run = await runtime.findRun("run-1");
    run!.transition("preparing", now);
    await runtime.saveRun(run!);
    expect(
      (await runtime.listRecoverableRuns("project")).map(
        (value) => value.snapshot().id,
      ),
    ).toEqual(["run-1"]);
    database.close();
  });

  test("rejects an active lock and allows an expired lock atomically", async () => {
    const { database, runtime, now } = await setup();
    expect(
      await runtime.acquireTaskLock(
        "task",
        "run-1",
        now,
        new Date(now.getTime() + 1000),
      ),
    ).toBe(true);
    expect(
      await runtime.acquireTaskLock(
        "task",
        "run-2",
        new Date(now.getTime() + 500),
        new Date(now.getTime() + 2000),
      ),
    ).toBe(false);
    expect(
      await runtime.acquireTaskLock(
        "task",
        "run-2",
        new Date(now.getTime() + 1000),
        new Date(now.getTime() + 2000),
      ),
    ).toBe(true);
    database.close();
  });
  test("has one winner for concurrent simulated attempts", async () => {
    const { database, runtime, now } = await setup();
    const results = await Promise.all([
      runtime.acquireTaskLock(
        "task",
        "run-1",
        now,
        new Date(now.getTime() + 1000),
      ),
      runtime.acquireTaskLock(
        "task",
        "run-2",
        now,
        new Date(now.getTime() + 1000),
      ),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) count FROM task_lock")
        .get()?.count,
    ).toBe(1);
    database.close();
  });
  test("only the owning run releases or renews a lock", async () => {
    const { database, runtime, now } = await setup();
    await runtime.acquireTaskLock(
      "task",
      "run-1",
      now,
      new Date(now.getTime() + 1000),
    );
    expect(
      await runtime.renewTaskLock("run-2", now, new Date(now.getTime() + 2000)),
    ).toBe(false);
    expect(
      await runtime.renewTaskLock("run-1", now, new Date(now.getTime() + 2000)),
    ).toBe(true);
    expect(await runtime.releaseTaskLock("run-2")).toBe(false);
    expect(await runtime.releaseTaskLock("run-1")).toBe(true);
    database.close();
  });
  test.each(["completed", "failed", "cancelled"] as const)(
    "does not renew a surviving lock after its run becomes %s",
    async (status) => {
      const { database, runtime, now } = await setup();
      const originalExpiry = new Date(now.getTime() + 1000);
      expect(
        await runtime.acquireTaskLock("task", "run-1", now, originalExpiry),
      ).toBe(true);
      const run = await runtime.findRun("run-1");
      if (status === "completed") {
        run!.transition("preparing", now);
        run!.transition("running", now);
        run!.transition("completed", now);
      } else if (status === "failed") {
        run!.transition("preparing", now);
        run!.transition("failed", now);
      } else run!.transition("cancelled", now);
      await runtime.saveRun(run!);

      expect(
        await runtime.renewTaskLock(
          "run-1",
          now,
          new Date(now.getTime() + 2000),
        ),
      ).toBe(false);
      expect(
        database
          .query<{ expires_at: string }, []>(
            "SELECT expires_at FROM task_lock WHERE run_id='run-1'",
          )
          .get()?.expires_at,
      ).toBe(originalExpiry.toISOString());
      database.close();
    },
  );
});

describe("ExecuteAgentRun result and cleanup", () => {
  async function execute(
    executor: AgentExecutor,
    worktrees: FakeWorktrees,
    signal?: AbortSignal,
    lockReleaseError?: Error,
  ) {
    const { database, runtime, now } = await setup();
    await runtime.acquireTaskLock(
      "task",
      "run-1",
      now,
      new Date(now.getTime() + 1000),
    );
    if (lockReleaseError !== undefined)
      runtime.releaseTaskLock = async () => {
        throw lockReleaseError;
      };
    const run = await runtime.findRun("run-1");
    const result = await new ExecuteAgentRun(
      runtime,
      executor,
      worktrees,
      new FixedClock(),
    ).execute(run!, signal);
    const locks = database
      .query<{ count: number }, []>("SELECT COUNT(*) count FROM task_lock")
      .get()?.count;
    const events = (await runtime.listRunEvents("run-1")).map(
      (event) => event.status,
    );
    database.close();
    return { result, locks, events };
  }
  test("returns completed and releases resources", async () => {
    const worktrees = new FakeWorktrees();
    const value = await execute(new FakeExecutor(), worktrees);
    expect(value.result).toEqual({ runId: "run-1", status: "completed" });
    expect(value.locks).toBe(0);
    expect(worktrees.releaseCalls).toBe(1);
    expect(value.events).toEqual([
      "queued",
      "preparing",
      "running",
      "reviewing",
      "completed",
    ]);
  });
  test("returns failed for executor errors", async () => {
    const value = await execute(
      new FakeExecutor(new Error("executor failed")),
      new FakeWorktrees(),
    );
    expect(value.result).toMatchObject({
      status: "failed",
      error: { message: "executor failed" },
    });
    expect(value.locks).toBe(0);
    expect(value.events.at(-1)).toBe("failed");
  });
  test("cancels before worktree preparation when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const worktrees = new FakeWorktrees();
    const value = await execute(
      new FakeExecutor(),
      worktrees,
      controller.signal,
    );
    expect(value.result).toMatchObject({
      status: "cancelled",
      error: { code: "ABORTED" },
    });
    expect(worktrees.prepareCalls).toBe(0);
    expect(value.locks).toBe(0);
    expect(value.events).toEqual(["queued", "cancelled"]);
  });
  test("fails when worktree preparation fails and releases the lock", async () => {
    const worktrees = new FakeWorktrees(new Error("prepare failed"));
    const value = await execute(new FakeExecutor(), worktrees);
    expect(value.result).toMatchObject({
      status: "failed",
      error: { message: "prepare failed" },
    });
    expect(worktrees.releaseCalls).toBe(0);
    expect(value.locks).toBe(0);
  });
  test("reports cleanup failure without overwriting successful execution", async () => {
    const value = await execute(
      new FakeExecutor(),
      new FakeWorktrees(undefined, new Error("release failed")),
    );
    expect(value.result).toMatchObject({
      status: "completed",
      cleanupError: { message: "release failed", code: "CLEANUP_FAILED" },
    });
    expect(value.result.error).toBeUndefined();
    expect(value.locks).toBe(0);
  });
  test("preserves primary error when cleanup also fails", async () => {
    const value = await execute(
      new FakeExecutor(new Error("primary")),
      new FakeWorktrees(undefined, new Error("cleanup")),
    );
    expect(value.result).toMatchObject({
      status: "failed",
      error: { message: "primary" },
      cleanupError: { message: "cleanup" },
    });
    expect(value.locks).toBe(0);
  });
  test("reports task lock release failures", async () => {
    const value = await execute(
      new FakeExecutor(),
      new FakeWorktrees(),
      undefined,
      new Error("lock release failed"),
    );
    expect(value.result).toMatchObject({
      status: "completed",
      cleanupError: {
        message: "lock release failed",
        code: "CLEANUP_FAILED",
      },
    });
    expect(value.locks).toBe(1);
  });
});
