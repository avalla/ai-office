import { describe, expect, test } from "vitest";
import type {
  TaskGraph,
  TaskGraphNode,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  decideFraming,
  defaultGraphFilters,
  filterGraph,
  layoutGraph,
  lineage,
  milestoneKey,
  taskKey,
} from "../../apps/dashboard/src/lib/task-graph.ts";

function node(
  taskId: string,
  overrides: Partial<TaskGraphNode> = {},
): TaskGraphNode {
  return {
    taskId,
    title: `Title ${taskId}`,
    priority: 0,
    recordedStatus: "pending",
    operationalStatus: "not_started",
    assignedAgent: null,
    milestoneIds: [],
    unmetPrerequisiteIds: [],
    ready: true,
    ...overrides,
  };
}

const requirements = { total: 2, open: 1, verified: 1, rejected: 0 };
// done -> a -> b -> d ; a -> c -> d ; lone
const graph: TaskGraph = {
  generatedAt: "2026-10-07T10:00:00.000Z",
  projectId: "p",
  projectName: "P",
  tasks: [
    node("done", {
      recordedStatus: "completed",
      operationalStatus: "completed",
      ready: false,
    }),
    node("a", { milestoneIds: ["m1"] }),
    node("b", {
      ready: false,
      unmetPrerequisiteIds: ["a"],
      milestoneIds: ["m1"],
    }),
    node("c", { ready: false, unmetPrerequisiteIds: ["a"] }),
    node("d", { ready: false, unmetPrerequisiteIds: ["b", "c"] }),
    node("lone"),
  ],
  milestones: [
    {
      milestoneId: "m1",
      title: "M1",
      status: "active",
      requirements: requirements as never,
    },
  ],
  edges: [
    { taskId: "a", dependsOnTaskId: "done" },
    { taskId: "b", dependsOnTaskId: "a" },
    { taskId: "c", dependsOnTaskId: "a" },
    { taskId: "d", dependsOnTaskId: "b" },
    { taskId: "d", dependsOnTaskId: "c" },
  ],
  criticalPath: ["a", "b", "d"],
};

const ids = (tasks: readonly TaskGraphNode[]) => tasks.map((t) => t.taskId);

describe("dashboard task graph", () => {
  test("hides completed work by default but keeps counts exact", () => {
    const visible = filterGraph(graph, defaultGraphFilters);
    expect(ids(visible.tasks)).toEqual(["a", "b", "c", "d", "lone"]);
    expect(visible.hiddenTaskCount).toBe(1);
    // An edge to a hidden prerequisite is not drawn.
    expect(visible.edges).toHaveLength(4);
  });

  test("filters by status, milestone, readiness and search", () => {
    const filters = { ...defaultGraphFilters, hideCompleted: false };
    expect(
      ids(filterGraph(graph, { ...filters, status: "completed" }).tasks),
    ).toEqual(["done"]);
    expect(
      ids(filterGraph(graph, { ...filters, milestone: "m1" }).tasks),
    ).toEqual(["a", "b"]);
    expect(
      ids(filterGraph(graph, { ...filters, milestone: "none" }).tasks),
    ).toEqual(["done", "c", "d", "lone"]);
    expect(
      ids(filterGraph(graph, { ...filters, readyOnly: true }).tasks),
    ).toEqual(["a", "lone"]);
    expect(
      ids(filterGraph(graph, { ...filters, search: " TITLE C" }).tasks),
    ).toEqual(["c"]);
  });

  test("keeps the selection visible whatever the filters say", () => {
    const visible = filterGraph(
      graph,
      { ...defaultGraphFilters, search: "lone" },
      { keep: new Set(["d"]) },
    );
    expect(ids(visible.tasks)).toEqual(["d", "lone"]);
  });

  test("shows milestone nodes and membership only when enabled and used", () => {
    const withMilestones = filterGraph(graph, defaultGraphFilters);
    expect(withMilestones.milestones.map((m) => m.milestoneId)).toEqual(["m1"]);
    expect(withMilestones.membership).toEqual([
      { taskId: "a", milestoneId: "m1" },
      { taskId: "b", milestoneId: "m1" },
    ]);
    const without = filterGraph(graph, {
      ...defaultGraphFilters,
      showMilestones: false,
    });
    expect(without.milestones).toEqual([]);
    expect(without.membership).toEqual([]);
  });

  test("computes the transitive lineage over the whole graph", () => {
    const result = lineage(graph.edges, "b");
    expect([...result.upstream].sort()).toEqual(["a", "done"]);
    expect([...result.downstream]).toEqual(["d"]);
    expect(lineage(graph.edges, "lone")).toEqual({
      upstream: new Set(),
      downstream: new Set(),
    });
  });

  test("lays prerequisites before their dependents in both directions", () => {
    const visible = filterGraph(graph, defaultGraphFilters);
    const horizontal = layoutGraph(visible, "LR");
    expect(horizontal.get(taskKey("a"))!.x).toBeLessThan(
      horizontal.get(taskKey("b"))!.x,
    );
    expect(horizontal.get(taskKey("b"))!.x).toBeLessThan(
      horizontal.get(taskKey("d"))!.x,
    );
    const vertical = layoutGraph(visible, "TB");
    expect(vertical.get(taskKey("a"))!.y).toBeLessThan(
      vertical.get(taskKey("d"))!.y,
    );
    expect(horizontal.has(milestoneKey("m1"))).toBe(true);
  });

  describe("decideFraming", () => {
    const idle = {
      pendingKey: null,
      selectedKey: null,
      actionChanged: false,
      cleared: false,
      userMoved: false,
    };
    test("frames an untouched view whatever changed the layout", () => {
      expect(decideFraming(idle)).toBe("frame");
    });
    test("leaves a user-moved view alone on a data-driven change", () => {
      expect(decideFraming({ ...idle, userMoved: true })).toBe("keep");
    });
    test("a user action or a cleared selection re-frames a moved view", () => {
      expect(
        decideFraming({ ...idle, userMoved: true, actionChanged: true }),
      ).toBe("frame");
      expect(decideFraming({ ...idle, userMoved: true, cleared: true })).toBe(
        "frame",
      );
    });
    test("a pending focus wins only for the current selection", () => {
      const jump = { ...idle, userMoved: true, actionChanged: true };
      expect(
        decideFraming({ ...jump, pendingKey: "t:a", selectedKey: "t:a" }),
      ).toBe("focus");
      expect(
        decideFraming({ ...jump, pendingKey: "t:a", selectedKey: "t:b" }),
      ).toBe("frame");
    });
  });
});
