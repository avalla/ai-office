import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SimulatedAgentExecutor } from "@ai-office/agent-runtime/executor.ts";
import { InMemoryWorktreeManager } from "@ai-office/agent-runtime/worktree.ts";
import { ExecuteAgentRun } from "@ai-office/application/commands/execute-agent-run.ts";
import {
  ScheduleAgentRun,
  TaskLockedError,
} from "@ai-office/application/commands/schedule-agent-run.ts";
import type { Clock } from "@ai-office/application/ports/clock.port.ts";
import type { IdGenerator } from "@ai-office/application/ports/id-generator.port.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Role } from "@ai-office/domain/agent/role.ts";
import { Task } from "@ai-office/domain/task/task.ts";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteTransactionRunner } from "@ai-office/storage-sqlite/database/sqlite-transaction-runner.ts";
import { SqliteAgentRuntimeRepository } from "@ai-office/storage-sqlite/repositories/sqlite-agent-runtime.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";

const directories: string[] = [];
const migrations = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "migrations",
  "project",
);
class FixedClock implements Clock {
  now(): Date {
    return new Date("2026-08-05T00:00:00Z");
  }
}
class Ids implements IdGenerator {
  private value = 0;
  generate(): string {
    return `run-${++this.value}`;
  }
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("agent runtime SQLite integration", () => {
  test("locks a task, persists every transition, and releases the lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "ai-office-agent-storage-"));
    directories.push(root);
    const database = openDatabase(join(root, "project.sqlite"));
    migrate(database, migrations);
    const now = new FixedClock().now();
    const projects = new SqliteProjectRepository(database);
    const tasks = new SqliteTaskRepository(database);
    const runtime = new SqliteAgentRuntimeRepository(database);
    await projects.save(Project.create({ id: "project", name: "Demo", now }));
    await tasks.save(
      Task.create({ id: "task", projectId: "project", title: "Run", now }),
    );
    await runtime.saveRole(
      Role.create({
        id: "role",
        projectId: "project",
        key: "developer",
        name: "Developer",
        version: 1,
        capabilities: ["code"],
        tools: ["shell"],
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
      name: "developer",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    });
    const schedule = new ScheduleAgentRun(
      projects,
      tasks,
      runtime,
      new Ids(),
      new FixedClock(),
      new SqliteTransactionRunner(database),
    );
    const runId = await schedule.execute({
      projectId: "project",
      taskId: "task",
      agentId: "agent",
    });
    await expect(
      schedule.execute({
        projectId: "project",
        taskId: "task",
        agentId: "agent",
      }),
    ).rejects.toBeInstanceOf(TaskLockedError);
    expect(await runtime.listRuns("project")).toHaveLength(1);
    const run = await runtime.findRun(runId);
    expect(run).not.toBeNull();
    await new ExecuteAgentRun(
      runtime,
      new SimulatedAgentExecutor(),
      new InMemoryWorktreeManager(),
      new FixedClock(),
    ).execute(run!);
    expect((await runtime.findRun(runId))?.snapshot().status).toBe("completed");
    expect(
      database
        .query<{ count: number }, [string]>(
          "SELECT COUNT(*) count FROM agent_run_event WHERE run_id=?",
        )
        .get(runId)?.count,
    ).toBe(5);
    expect(
      database
        .query<{ count: number }, []>("SELECT COUNT(*) count FROM task_lock")
        .get()?.count,
    ).toBe(0);
    database.close();
  });
});
