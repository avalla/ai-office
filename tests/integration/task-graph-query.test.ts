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
import { isTaskRunnable } from "@ai-office/domain/agent/run-eligibility.ts";
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
  const reads = new SqliteOperationalReadRepository(database);
  const queries = new OperationalQueryService({ reads, clock });

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
  function setStatus(id: string, status: string): void {
    database.prepare("UPDATE task SET status = ? WHERE id = ?").run(status, id);
  }
  function complete(id: string): void {
    database
      .prepare("UPDATE task SET status = 'completed' WHERE id = ?")
      .run(id);
  }
  return {
    database,
    reads,
    queries,
    project,
    task,
    depend,
    complete,
    setStatus,
    governance: new ManageGovernance(projects, governance, ids, clock),
    taskRequirements,
  };
}

describe("task dependency graph read model", () => {
  test("reports readiness, unmet prerequisites and the longest dependency chain", async () => {
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
    expect(graph.longestDependencyChain).toEqual(["a", "b", "d"]);
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
    expect(graph.longestDependencyChain).toHaveLength(length);
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
    expect(graph.longestDependencyChain).toEqual([]);
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
  test.each(["cancelled", "failed"])(
    "a %s prerequisite keeps its dependents blocked",
    async (status) => {
      const f = await fixture();
      await f.project("p");
      for (const id of ["gone", "next"]) await f.task("p", id);
      await f.depend("p", "next", "gone");
      f.setStatus("gone", status);

      const graph = await f.queries.getTaskGraph("p");

      expect(graph.tasks.find((t) => t.taskId === "next")).toMatchObject({
        ready: false,
        unmetPrerequisiteIds: ["gone"],
      });
    },
  );

  test("readiness is exactly the admission rule for every task status", async () => {
    const f = await fixture();
    await f.project("p");
    const statuses = [
      "pending",
      "assigned",
      "running",
      "blocked",
      "waiting_review",
      "completed",
      "failed",
      "cancelled",
    ] as const;
    for (const status of statuses) {
      await f.task("p", status);
      f.setStatus(status, status);
    }
    // A runnable task whose prerequisite is not completed is never ready.
    await f.task("p", "needs-pending");
    await f.depend("p", "needs-pending", "pending");

    const graph = await f.queries.getTaskGraph("p");
    const ready = (id: string) =>
      graph.tasks.find((t) => t.taskId === id)?.ready;

    for (const status of statuses)
      expect(ready(status), status).toBe(isTaskRunnable(status));
    expect(ready("blocked")).toBe(false);
    expect(ready("needs-pending")).toBe(false);
  });

  test("failed work is not unfinished and never sits on the longest dependency chain", async () => {
    const f = await fixture();
    await f.project("p");
    for (const id of ["lone-failed", "a", "bad", "z"]) await f.task("p", id);
    f.setStatus("lone-failed", "failed");
    f.setStatus("bad", "failed");
    // a -> bad -> z, with the failed task in the middle of the chain.
    await f.depend("p", "bad", "a");
    await f.depend("p", "z", "bad");

    const graph = await f.queries.getTaskGraph("p");

    // A failed task alone is not a chain, and it is removed from the chain it
    // sits in: a and z are no longer connected through unfinished work.
    expect(graph.longestDependencyChain).toEqual([]);
    // Existing prerequisite rules still hold for the dependent.
    expect(graph.tasks.find((t) => t.taskId === "z")).toMatchObject({
      ready: false,
      unmetPrerequisiteIds: ["bad"],
    });
  });

  test("a concurrent reprioritisation or insert cannot skip or repeat a task", async () => {
    const f = await fixture();
    await f.project("p");
    const length = queryLimits.tasks.default * 3;
    for (let index = 0; index < length; index += 1)
      await f.task("p", `t${String(index).padStart(4, "0")}`);
    await f.depend("p", "t0299", "t0000");
    let mutated = false;
    const original = f.reads.listTaskRunFacts.bind(f.reads);
    // The first batch's projection awaits; shuffle the ordering underneath it,
    // the way a concurrent writer would.
    f.reads.listTaskRunFacts = async (...args) => {
      if (!mutated) {
        mutated = true;
        f.database.prepare("UPDATE task SET priority = 1000 - rowid").run();
        await f.task("p", "inserted-during-read");
      }
      return original(...args);
    };

    const graph = await f.queries.getTaskGraph("p");

    const ids = graph.tasks.map((t) => t.taskId);
    expect(mutated).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(length);
    expect(ids).not.toContain("inserted-during-read");
    expect(graph.edges).toEqual([
      { taskId: "t0299", dependsOnTaskId: "t0000" },
    ]);
  });

  test("the graph never uses OFFSET-paged task reads", async () => {
    const f = await fixture();
    await f.project("p");
    await f.task("p", "a");
    f.reads.listTasks = async () => {
      throw new Error("the exhaustive graph must not page tasks");
    };

    await expect(f.queries.getTaskGraph("p")).resolves.toMatchObject({
      tasks: [expect.objectContaining({ taskId: "a" })],
    });
  });

  test("an empty project yields an empty graph", async () => {
    const f = await fixture();
    await f.project("p");
    await expect(f.queries.getTaskGraph("p")).resolves.toMatchObject({
      tasks: [],
      edges: [],
      milestones: [],
      longestDependencyChain: [],
    });
  });

  test("summarises the project from the same nodes as the graph", async () => {
    const f = await fixture();
    await f.project("p");
    for (const id of ["ready", "waits", "blocked", "failed", "running", "done"])
      await f.task("p", id);
    await f.depend("p", "waits", "ready");
    f.setStatus("blocked", "blocked");
    f.setStatus("failed", "failed");
    f.setStatus("running", "running");
    f.complete("done");

    const graph = await f.queries.getTaskGraph("p");
    const byId = new Map(graph.tasks.map((t) => [t.taskId, t]));

    expect(byId.get("waits")).toMatchObject({ waiting: true, ready: false });
    expect(byId.get("ready")).toMatchObject({ waiting: false, ready: true });
    expect(byId.get("blocked")?.needsAttention).toBe(true);
    expect(byId.get("failed")?.needsAttention).toBe(true);
    expect(byId.get("done")).toMatchObject({
      waiting: false,
      needsAttention: false,
    });
    // pending: ready + waits(waiting); running: ready, in progress; blocked and
    // failed carry attention; done is finished.
    expect(graph.summary).toEqual({
      total: 6,
      ready: 2,
      waiting: 1,
      blocked: 1,
      inProgress: 1,
      needsAttention: 2,
    });
    expect(byId.get("running")?.ready).toBe(true);
  });

  test("a blocked task with an unmet prerequisite is waiting and not ready", async () => {
    const f = await fixture();
    await f.project("p");
    for (const id of ["pre", "stuck"]) await f.task("p", id);
    await f.depend("p", "stuck", "pre");
    f.setStatus("stuck", "blocked");

    const graph = await f.queries.getTaskGraph("p");

    expect(graph.tasks.find((t) => t.taskId === "stuck")).toMatchObject({
      waiting: true,
      ready: false,
      needsAttention: true,
    });
  });

  test("a terminal task with an unmet prerequisite is not waiting", async () => {
    const f = await fixture();
    await f.project("p");
    for (const id of ["pre", "cancelled"]) await f.task("p", id);
    await f.depend("p", "cancelled", "pre");
    f.setStatus("cancelled", "cancelled");

    const graph = await f.queries.getTaskGraph("p");

    expect(graph.tasks.find((t) => t.taskId === "cancelled")).toMatchObject({
      waiting: false,
      unmetPrerequisiteIds: ["pre"],
    });
    expect(graph.summary.waiting).toBe(0);
  });

  test("completion unblocks only dependents it makes ready on its own", async () => {
    const f = await fixture();
    await f.project("p");
    for (const id of ["a", "b", "c", "d", "stuck", "dead", "after-dead"])
      await f.task("p", id);
    await f.depend("p", "b", "a");
    await f.depend("p", "c", "a");
    await f.depend("p", "d", "b");
    await f.depend("p", "d", "c");
    // A dependent whose own status forbids work is not made ready.
    await f.depend("p", "stuck", "a");
    f.setStatus("stuck", "blocked");
    // A prerequisite that is already terminal can never complete.
    await f.depend("p", "after-dead", "dead");
    f.setStatus("dead", "failed");

    const graph = await f.queries.getTaskGraph("p");
    const unblocks = (id: string) =>
      graph.tasks.find((t) => t.taskId === id)?.completionUnblocks;

    // d still waits on c, and stuck is blocked: only b and c become ready.
    expect(unblocks("a")).toEqual(["b", "c"]);
    expect(unblocks("b")).toEqual([]);
    expect(unblocks("c")).toEqual([]);
    expect(unblocks("dead")).toEqual([]);
  });

  test("terminal follows the recorded status, not the operational one", async () => {
    const f = await fixture();
    await f.project("p");
    for (const id of ["open", "failed", "retry", "next"]) await f.task("p", id);
    f.setStatus("failed", "failed");
    await f.depend("p", "next", "retry");
    // A failed latest run changes the operational status, but leaves the
    // recorded task pending and eligible to be completed after a retry.
    f.database
      .prepare(
        `INSERT INTO role(id,project_id,role_key,name,version,capabilities_json,tools_json,
          model_policy,limits_json,source_path,created_at,updated_at)
         VALUES ('role','p','role','Role',1,'[]','[]','default','{}','fixture',?,?)`,
      )
      .run(now.toISOString(), now.toISOString());
    f.database
      .prepare(
        `INSERT INTO agent(id,project_id,role_id,name,enabled,created_at,updated_at)
         VALUES ('agent','p','role','Agent',1,?,?)`,
      )
      .run(now.toISOString(), now.toISOString());
    f.database
      .prepare(
        `INSERT INTO agent_run(id,project_id,task_id,agent_id,status,created_at,updated_at)
         VALUES ('retry-failed-run','p','retry','agent','failed',?,?)`,
      )
      .run(now.toISOString(), now.toISOString());

    const graph = await f.queries.getTaskGraph("p");
    const by = (id: string) => graph.tasks.find((t) => t.taskId === id)!;

    expect(by("open").terminal).toBe(false);
    expect(by("failed").terminal).toBe(true);
    // A pending task stays non-terminal and still unblocks its dependent, which
    // is what the panel must keep offering.
    expect(by("retry")).toMatchObject({
      recordedStatus: "pending",
      operationalStatus: "failed",
      terminal: false,
    });
    expect(by("retry").completionUnblocks).toEqual(["next"]);
  });
});
