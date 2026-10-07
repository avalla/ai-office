import { describe, expect, test } from "vitest";
import type {
  TaskGraph,
  TaskGraphNode,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  decideFraming,
  searchTasks,
  defaultGraphFilters,
  filterGraph,
  layoutGraph,
  lineage,
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
    waiting: false,
    needsAttention: false,
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
      waiting: true,
      unmetPrerequisiteIds: ["a"],
      milestoneIds: ["m1"],
    }),
    node("c", { ready: false, waiting: true, unmetPrerequisiteIds: ["a"] }),
    node("d", {
      ready: false,
      waiting: true,
      needsAttention: true,
      operationalStatus: "blocked",
      unmetPrerequisiteIds: ["b", "c"],
    }),
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
  summary: {
    total: 6,
    ready: 2,
    waiting: 3,
    blocked: 1,
    inProgress: 0,
    needsAttention: 1,
  },
  longestDependencyChain: ["a", "b", "d"],
};

const ids = (tasks: readonly TaskGraphNode[]) => tasks.map((t) => t.taskId);
const all = { ...defaultGraphFilters, hideCompleted: false };

describe("dashboard task graph", () => {
  test("hides completed work by default but keeps counts exact", () => {
    const visible = filterGraph(graph, defaultGraphFilters);
    expect(ids(visible.tasks)).toEqual(["a", "b", "c", "d", "lone"]);
    expect(visible.hiddenTaskCount).toBe(1);
    // An edge to a hidden prerequisite is not drawn.
    expect(visible.edges).toHaveLength(4);
  });

  test("filters by status, milestone and each operational shortcut", () => {
    expect(
      ids(filterGraph(graph, { ...all, status: "completed" }).tasks),
    ).toEqual(["done"]);
    expect(ids(filterGraph(graph, { ...all, milestone: "m1" }).tasks)).toEqual([
      "a",
      "b",
    ]);
    expect(
      ids(filterGraph(graph, { ...all, milestone: "none" }).tasks),
    ).toEqual(["done", "c", "d", "lone"]);
    expect(ids(filterGraph(graph, { ...all, quick: "ready" }).tasks)).toEqual([
      "a",
      "lone",
    ]);
    expect(ids(filterGraph(graph, { ...all, quick: "waiting" }).tasks)).toEqual(
      ["b", "c", "d"],
    );
    expect(ids(filterGraph(graph, { ...all, quick: "blocked" }).tasks)).toEqual(
      ["d"],
    );
    expect(
      ids(filterGraph(graph, { ...all, quick: "attention" }).tasks),
    ).toEqual(["d"]);
    expect(
      ids(filterGraph(graph, { ...all, search: " TITLE C" }).tasks),
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

  test("milestones never take part in the dependency layout", () => {
    const visible = filterGraph(graph, defaultGraphFilters);
    const positions = layoutGraph(visible, "LR");
    expect([...positions.keys()].sort()).toEqual(
      visible.tasks.map((t) => taskKey(t.taskId)).sort(),
    );
    // The same tasks and edges lay out identically with or without milestone
    // data, because the layout never sees it.
    const stripped = {
      ...graph,
      milestones: [],
      tasks: graph.tasks.map((t) => ({ ...t, milestoneIds: [] })),
    };
    expect(
      layoutGraph(filterGraph(stripped, defaultGraphFilters), "LR"),
    ).toEqual(positions);
    // A task keeps its milestone association.
    expect(graph.tasks.find((t) => t.taskId === "a")?.milestoneIds).toEqual([
      "m1",
    ]);
  });

  test("search locates tasks across the whole project, best match first", () => {
    const found = searchTasks(graph, "title");
    expect(found.total).toBe(6);
    expect(found.matches).toHaveLength(6);
    expect(searchTasks(graph, "title b").matches.map((t) => t.taskId)).toEqual([
      "b",
    ]);
    expect(searchTasks(graph, "   ")).toEqual({ matches: [], total: 0 });
    expect(searchTasks(graph, "title", 2).matches).toHaveLength(2);
    // Completed tasks are searchable even though the graph hides them.
    expect(searchTasks(graph, "done").matches.map((t) => t.taskId)).toEqual([
      "done",
    ]);
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

  test("isolating a lineage shows exactly those tasks, ignoring filters", () => {
    const related = new Set(["done", "a", "b", "d"]);
    const visible = filterGraph(graph, defaultGraphFilters, { only: related });
    expect(ids(visible.tasks)).toEqual(["done", "a", "b", "d"]);
    expect(visible.edges).toHaveLength(3);
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
  });

  test("layout is deterministic", () => {
    const visible = filterGraph(graph, defaultGraphFilters);
    expect(layoutGraph(visible, "LR")).toEqual(layoutGraph(visible, "LR"));
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
