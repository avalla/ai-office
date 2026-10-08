import { describe, expect, test } from "vitest";
import type {
  TaskGraphEdge,
  TaskGraphNode,
  TaskOperationalState,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  projectLongestDependencyChain,
  projectTaskGraphNodes,
} from "@ai-office/application/read-models/task-graph-projection.ts";
import {
  isTerminalTaskStatus,
  type TaskStatus,
} from "@ai-office/domain/task/task.ts";

const node = (
  taskId: string,
  recordedStatus: TaskStatus = "pending",
): TaskGraphNode => ({
  taskId,
  title: taskId,
  priority: 0,
  recordedStatus,
  operationalStatus: "not_started",
  assignedAgent: null,
  milestoneIds: [],
  milestoneGap: "no_requirement",
  unmetPrerequisiteIds: [],
  ready: false,
  waiting: false,
  needsAttention: false,
  completionUnblocks: [],
  terminal: isTerminalTaskStatus(recordedStatus),
});
const edge = (dependsOnTaskId: string, taskId: string): TaskGraphEdge => ({
  taskId,
  dependsOnTaskId,
});

describe("projectLongestDependencyChain", () => {
  test("handles a very long chain without recursion or quadratic copies", () => {
    const length = 50_000;
    const ids = Array.from(
      { length },
      (_, i) => `t${String(i).padStart(6, "0")}`,
    );
    const nodes = ids.map((id) => node(id));
    const edges = ids.slice(1).map((id, i) => edge(ids[i]!, id));

    const started = performance.now();
    const path = projectLongestDependencyChain(nodes, edges);

    expect(path).toHaveLength(length);
    expect(path[0]).toBe(ids[0]);
    expect(path.at(-1)).toBe(ids.at(-1));
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("breaks ties on the smallest task id and follows prerequisites forward", () => {
    const nodes = ["a", "b", "c", "d"].map((id) => node(id));
    const edges = [
      edge("a", "b"),
      edge("a", "c"),
      edge("b", "d"),
      edge("c", "d"),
    ];
    expect(projectLongestDependencyChain(nodes, edges)).toEqual([
      "a",
      "b",
      "d",
    ]);
  });

  test("prefers the longest chain over the smallest id", () => {
    const nodes = ["a", "b", "x", "y", "z"].map((id) => node(id));
    // a -> b is short; x -> y -> z is long.
    const edges = [edge("a", "b"), edge("x", "y"), edge("y", "z")];
    expect(projectLongestDependencyChain(nodes, edges)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  test("ignores terminal tasks and a lone unfinished task", () => {
    const nodes = [
      node("a", "failed"),
      node("b"),
      node("c", "completed"),
      node("d", "cancelled"),
    ];
    const edges = [edge("a", "b"), edge("c", "b"), edge("b", "d")];
    expect(projectLongestDependencyChain(nodes, edges)).toEqual([]);
  });

  test("a corrupted cycle neither loops nor throws", () => {
    const nodes = ["a", "b", "c"].map((id) => node(id));
    const edges = [edge("a", "b"), edge("b", "a"), edge("a", "c")];
    // With every node on or behind the cycle, nothing is ever ready to start,
    // so no chain is reported rather than a misleading partial one.
    expect(projectLongestDependencyChain(nodes, edges)).toEqual([]);
  });
});

describe("projectTaskGraphNodes milestone gap", () => {
  const state = (taskId: string, milestoneIds: string[] = []) =>
    ({
      taskId,
      title: taskId,
      priority: 0,
      recordedStatus: "pending",
      operationalStatus: "not_started",
      assignedAgent: null,
      attentionReasons: [],
      terminal: false,
      milestones: milestoneIds.map((milestoneId) => ({
        milestoneId,
        title: milestoneId,
        status: "active",
      })),
    }) as unknown as TaskOperationalState;

  test("separates a missing requirement from a requirement without a milestone", () => {
    const gaps = Object.fromEntries(
      projectTaskGraphNodes(
        [state("a", ["m1"]), state("b"), state("c"), state("d", ["m1"])],
        [],
        new Set(["c", "d"]),
      ).map((node) => [node.taskId, node.milestoneGap]),
    );
    expect(gaps).toEqual({
      a: null,
      b: "no_requirement",
      c: "requirement_without_milestone",
      d: null,
    });
  });
});

describe("projectTaskGraphNodes prerequisite semantics", () => {
  const state = (
    taskId: string,
    recordedStatus: TaskStatus,
  ): TaskOperationalState =>
    ({
      taskId,
      title: taskId,
      priority: 0,
      recordedStatus,
      terminal: isTerminalTaskStatus(recordedStatus),
      operationalStatus: "not_started",
      assignedAgent: null,
      attentionReasons: [],
      milestones: [],
    }) as unknown as TaskOperationalState;
  const project = (prerequisite: TaskStatus) =>
    new Map(
      projectTaskGraphNodes(
        [state("pre", prerequisite), state("dep", "pending")],
        [edge("pre", "dep")],
      ).map((n) => [n.taskId, n]),
    );

  test.each(["pending", "blocked"] as const)(
    "a %s prerequisite is unmet and unblocks the dependent once it reaches review",
    (status) => {
      const nodes = project(status);
      expect(nodes.get("dep")).toMatchObject({
        unmetPrerequisiteIds: ["pre"],
        ready: false,
        waiting: true,
      });
      expect(nodes.get("pre")?.completionUnblocks).toEqual(["dep"]);
    },
  );

  test("a waiting_review prerequisite satisfies the dependent without being completed", () => {
    const nodes = project("waiting_review");
    expect(nodes.get("dep")).toMatchObject({
      unmetPrerequisiteIds: [],
      ready: true,
      waiting: false,
    });
    expect(nodes.get("pre")).toMatchObject({
      recordedStatus: "waiting_review",
      terminal: false,
      completionUnblocks: [],
    });
  });

  test("a completed prerequisite satisfies the dependent and is terminal", () => {
    const nodes = project("completed");
    expect(nodes.get("dep")).toMatchObject({
      unmetPrerequisiteIds: [],
      ready: true,
    });
    expect(nodes.get("pre")).toMatchObject({
      terminal: true,
      completionUnblocks: [],
    });
  });

  test.each(["failed", "cancelled"] as const)(
    "a %s prerequisite keeps the dependent waiting and unblocks nothing",
    (status) => {
      const nodes = project(status);
      expect(nodes.get("dep")).toMatchObject({
        unmetPrerequisiteIds: ["pre"],
        waiting: true,
        ready: false,
      });
      expect(nodes.get("pre")?.completionUnblocks).toEqual([]);
    },
  );

  test("mixed prerequisites: only the pending one is unmet and unblocks", () => {
    const nodes = new Map(
      projectTaskGraphNodes(
        [
          state("rev", "waiting_review"),
          state("pend", "pending"),
          state("dep", "pending"),
        ],
        [edge("rev", "dep"), edge("pend", "dep")],
      ).map((n) => [n.taskId, n]),
    );
    expect(nodes.get("dep")?.unmetPrerequisiteIds).toEqual(["pend"]);
    expect(nodes.get("pend")?.completionUnblocks).toEqual(["dep"]);
    expect(nodes.get("rev")?.completionUnblocks).toEqual([]);
  });

  test("a blocked dependent is neither ready nor waiting on a review prerequisite", () => {
    const nodes = new Map(
      projectTaskGraphNodes(
        [state("pre", "waiting_review"), state("dep", "blocked")],
        [edge("pre", "dep")],
      ).map((n) => [n.taskId, n]),
    );
    expect(nodes.get("dep")).toMatchObject({ ready: false, waiting: false });
  });
});
