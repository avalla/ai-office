import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "@ai-office/storage-sqlite/database/migrate.ts";
import { openDatabase } from "@ai-office/storage-sqlite/database/open-database.ts";
import { SqliteOperationalReadRepository } from "@ai-office/storage-sqlite/repositories/sqlite-operational-read.repository.ts";
import { SqliteProjectRepository } from "@ai-office/storage-sqlite/repositories/sqlite-project.repository.ts";
import { SqliteTaskDependencyRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-dependency.repository.ts";
import { SqliteTaskRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task.repository.ts";
import { SqliteGovernanceRepository } from "@ai-office/storage-sqlite/repositories/sqlite-governance.repository.ts";
import { SqliteTaskRequirementRepository } from "@ai-office/storage-sqlite/repositories/sqlite-task-requirement.repository.ts";
import { ManageGovernance } from "@ai-office/application/commands/manage-governance.ts";
import {
  OperationalQueryService,
  OperationalResourceNotFoundError,
} from "@ai-office/application/queries/operational-query-service.ts";
import { queryLimits } from "@ai-office/application/protocol/query-protocol.ts";
import { Project } from "@ai-office/domain/project/project.ts";
import { Task } from "@ai-office/domain/task/task.ts";

const now = new Date("2026-09-03T10:00:00.000Z");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ai-office-task-graph-"));
  roots.push(root);
  const database = openDatabase(join(root, "project.sqlite"));
  migrate(database, join(process.cwd(), "migrations", "project"));
  const clock = { now: () => new Date(now) };
  let sequence = 0;
  const ids = { generate: () => `generated-${(sequence += 1)}` };
  const projects = new SqliteProjectRepository(database);
  const tasks = new SqliteTaskRepository(database);
  const dependencies = new SqliteTaskDependencyRepository(database);
  const governance = new SqliteGovernanceRepository(database);
  const taskRequirements = new SqliteTaskRequirementRepository(database);
  const queries = new OperationalQueryService({
    reads: new SqliteOperationalReadRepository(database),
    clock,
  });

  async function project(id: string): Promise<void> {
    await projects.save(Project.create({ id, name: `Project ${id}`, now }));
  }
  async function task(projectId: string, id: string): Promise<void> {
    await tasks.save(Task.create({ id, projectId, title: `Task ${id}`, now }));
  }
  async function depend(
    projectId: string,
    taskId: string,
    dependsOnTaskId: string,
  ): Promise<void> {
    await dependencies.link({
      projectId,
      taskId,
      dependsOnTaskId,
      createdAt: now,
    });
  }
  function complete(id: string): void {
    database
      .prepare("UPDATE task SET status = 'completed' WHERE id = ?")
      .run(id);
  }
  return {
    database,
    queries,
    project,
    task,
    depend,
    complete,
    governance: new ManageGovernance(projects, governance, ids, clock),
    taskRequirements,
  };
}

describe("task dependency graph read model", () => {
  test("reports readiness, unmet prerequisites and the critical path", async () => {
    const f = await fixture();
    await f.project("p");
    for (const id of ["done", "a", "b", "c", "d", "lone"])
      await f.task("p", id);
    f.complete("done");
    await f.depend("p", "a", "done");
    await f.depend("p", "b", "a");
    await f.depend("p", "c", "a");
    await f.depend("p", "d", "b");
    await f.depend("p", "d", "c");

    const graph = await f.queries.getTaskGraph("p");
    const byId = new Map(graph.tasks.map((t) => [t.taskId, t]));

    expect(graph.edges).toHaveLength(5);
    expect(byId.get("a")).toMatchObject({
      ready: true,
      unmetPrerequisiteIds: [],
    });
    expect(byId.get("b")).toMatchObject({
      ready: false,
      unmetPrerequisiteIds: ["a"],
    });
    expect(byId.get("d")?.unmetPrerequisiteIds).toEqual(["b", "c"]);
    expect(byId.get("lone")?.ready).toBe(true);
    expect(byId.get("done")?.ready).toBe(false);
    // The completed prerequisite is not part of unfinished work; the diamond
    // resolves its tie by task id.
    expect(graph.criticalPath).toEqual(["a", "b", "d"]);
  });

  test("never drops a task or an edge to a presentation limit", async () => {
    const f = await fixture();
    await f.project("p");
    const length = queryLimits.tasks.default * 2 + 17;
    for (let index = 0; index < length; index += 1) {
      await f.task("p", `t${String(index).padStart(4, "0")}`);
      if (index > 0)
        await f.depend(
          "p",
          `t${String(index).padStart(4, "0")}`,
          `t${String(index - 1).padStart(4, "0")}`,
        );
    }

    const graph = await f.queries.getTaskGraph("p");

    expect(graph.tasks).toHaveLength(length);
    expect(graph.edges).toHaveLength(length - 1);
    expect(graph.criticalPath).toHaveLength(length);
  });

  test("derives milestones from explicit requirement links and isolates projects", async () => {
    const f = await fixture();
    await f.project("p");
    await f.project("other");
    await f.task("p", "a");
    await f.task("p", "b");
    await f.task("other", "x");
    await f.task("other", "y");
    await f.depend("other", "y", "x");
    const milestoneId = await f.governance.createMilestone({
      projectId: "p",
      title: "M1",
    });
    const requirementId = await f.governance.createRequirement({
      projectId: "p",
      key: "REQ-1",
      title: "First",
      description: "First requirement",
      milestoneId,
    });
    await f.taskRequirements.link({
      projectId: "p",
      taskId: "a",
      requirementId,
      now,
    });

    const graph = await f.queries.getTaskGraph("p");

    expect(graph.edges).toEqual([]);
    expect(graph.criticalPath).toEqual([]);
    expect(graph.milestones).toEqual([
      expect.objectContaining({ milestoneId, title: "M1" }),
    ]);
    expect(graph.tasks.find((t) => t.taskId === "a")?.milestoneIds).toEqual([
      milestoneId,
    ]);
    expect(graph.tasks.find((t) => t.taskId === "b")?.milestoneIds).toEqual([]);
  });

  test("an unknown project is not found", async () => {
    const f = await fixture();
    await expect(f.queries.getTaskGraph("missing")).rejects.toBeInstanceOf(
      OperationalResourceNotFoundError,
    );
  });

  test("a prerequisite that is cancelled or failed keeps its dependents blocked", async () => {
    const f = await fixture();
    await f.project("p");
    for (const id of ["gone", "next"]) await f.task("p", id);
    await f.depend("p", "next", "gone");
    f.database
      .prepare("UPDATE task SET status = 'cancelled' WHERE id = 'gone'")
      .run();

    const graph = await f.queries.getTaskGraph("p");

    expect(graph.tasks.find((t) => t.taskId === "next")).toMatchObject({
      ready: false,
      unmetPrerequisiteIds: ["gone"],
    });
  });
});
