import { describe, expect, test, vi } from "vitest";
import type {
  TaskGraph,
  TaskGraphNode,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  unmetEdgeKeys,
  exceedsLayoutLimit,
  maxLayoutWeight,
  createLayoutMemo,
  createGraphRelationshipMemo,
  chainPage,
  chainPageSize,
  otherDependentIds,
  decideFraming,
  nodeStateLabel,
  searchTasks,
  defaultGraphFilters,
  filterGraph,
  layoutGraph,
  lineage,
  relationshipEdgeKind,
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
    completionUnblocks: [],
    terminal: false,
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
  test("classifies direct links and transitive lineage from existing edges", () => {
    const selected = "b";
    const tree = lineage(graph.edges, selected);
    expect(
      relationshipEdgeKind(
        { taskId: "b", dependsOnTaskId: "a" },
        selected,
        tree,
      ),
    ).toBe("direct");
    expect(
      relationshipEdgeKind(
        { taskId: "d", dependsOnTaskId: "b" },
        selected,
        tree,
      ),
    ).toBe("direct");
    expect(
      relationshipEdgeKind(
        { taskId: "a", dependsOnTaskId: "done" },
        selected,
        tree,
      ),
    ).toBe("transitive");
    expect(
      relationshipEdgeKind(
        { taskId: "d", dependsOnTaskId: "c" },
        selected,
        tree,
      ),
    ).toBeNull();
    // This edge reaches a downstream task without passing through b.
    expect(
      relationshipEdgeKind(
        { taskId: "d", dependsOnTaskId: "a" },
        selected,
        tree,
      ),
    ).toBeNull();
  });
  test("hides completed work by default but keeps counts exact", () => {
    const visible = filterGraph(graph, defaultGraphFilters);
    expect(ids(visible.tasks)).toEqual(["a", "b", "c", "d", "lone"]);
    expect(visible.hiddenTaskCount).toBe(1);
    // An edge to a hidden prerequisite is not drawn.
    expect(visible.edges).toHaveLength(4);
  });

  test("keeps cancelled prerequisites visible while they block open work", () => {
    const cancelled = (taskId: string) =>
      node(taskId, {
        recordedStatus: "cancelled",
        operationalStatus: "cancelled",
        terminal: true,
        ready: false,
      });
    const blockedGraph: TaskGraph = {
      ...graph,
      tasks: [
        { ...cancelled("blocking-cancelled"), milestoneIds: ["m1"] },
        { ...cancelled("unrelated-cancelled"), milestoneIds: ["m1"] },
        node("waiting-on-cancelled", {
          ready: false,
          waiting: true,
          milestoneIds: ["m1"],
          unmetPrerequisiteIds: ["blocking-cancelled"],
        }),
        node("finished-dependent", {
          recordedStatus: "failed",
          operationalStatus: "failed",
          terminal: true,
          ready: false,
          milestoneIds: ["m1"],
          unmetPrerequisiteIds: ["unrelated-cancelled"],
        }),
      ],
      edges: [
        {
          taskId: "waiting-on-cancelled",
          dependsOnTaskId: "blocking-cancelled",
        },
        {
          taskId: "finished-dependent",
          dependsOnTaskId: "unrelated-cancelled",
        },
      ],
    };
    const visible = filterGraph(blockedGraph, defaultGraphFilters);
    expect(ids(visible.tasks)).toEqual([
      "blocking-cancelled",
      "waiting-on-cancelled",
      "finished-dependent",
    ]);
    expect(visible.edges).toEqual([
      { taskId: "waiting-on-cancelled", dependsOnTaskId: "blocking-cancelled" },
    ]);
    expect(visible.hiddenTaskCount).toBe(1);
    expect(
      ids(
        filterGraph(blockedGraph, {
          ...defaultGraphFilters,
          milestone: "m1",
        }).tasks,
      ),
    ).toEqual([
      "blocking-cancelled",
      "waiting-on-cancelled",
      "finished-dependent",
    ]);
    expect(
      ids(
        filterGraph(blockedGraph, {
          ...defaultGraphFilters,
          search: "cancelled",
        }).tasks,
      ),
    ).toEqual(["blocking-cancelled", "waiting-on-cancelled"]);
    expect(
      ids(
        filterGraph(blockedGraph, { ...defaultGraphFilters, quick: "waiting" })
          .tasks,
      ),
    ).toEqual(["waiting-on-cancelled"]);
    expect(
      ids(
        filterGraph(blockedGraph, {
          ...defaultGraphFilters,
          search: "waiting-on",
        }).tasks,
      ),
    ).toEqual(["waiting-on-cancelled"]);
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

  test("an operational shortcut is not hidden by 'hide completed'", () => {
    const withFinishedAttention = {
      ...graph,
      tasks: [
        ...graph.tasks,
        node("finished", {
          operationalStatus: "completed",
          recordedStatus: "completed",
          ready: false,
          needsAttention: true,
        }),
      ],
    };
    const visible = filterGraph(withFinishedAttention, {
      ...defaultGraphFilters,
      quick: "attention",
    });
    expect(ids(visible.tasks)).toEqual(["d", "finished"]);
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

  test("counts broad search matches without sorting the full project", () => {
    const tasks = Array.from({ length: 5_000 }, (_, index) =>
      node(`task-${String(index).padStart(4, "0")}`, {
        title: `Task ${String(index).padStart(4, "0")}`,
      }),
    ).reverse();
    const originalSort = Array.prototype.sort;
    const sortSpy = vi
      .spyOn(Array.prototype, "sort")
      .mockImplementation(function (
        this: unknown[],
        compareFn?: (a: unknown, b: unknown) => number,
      ) {
        expect(this.length).toBeLessThanOrEqual(8);
        return Reflect.apply(originalSort, this, [compareFn]) as unknown[];
      });
    try {
      const found = searchTasks({ ...graph, tasks }, "task", 8);
      expect(found.total).toBe(5_000);
      expect(found.matches.map((task) => task.taskId)).toEqual(
        Array.from(
          { length: 8 },
          (_, index) => `task-${String(index).padStart(4, "0")}`,
        ),
      );
    } finally {
      sortSpy.mockRestore();
    }
  });

  test("node wording comes from the read model's flags, not from statuses", () => {
    const by = (id: string) => graph.tasks.find((t) => t.taskId === id)!;
    expect(nodeStateLabel(by("a"))).toBe("Ready to start");
    expect(nodeStateLabel(by("b"))).toBe("Waiting on 1 blocker");
    expect(nodeStateLabel(by("d"))).toBe("Waiting on 2 blockers");
    expect(nodeStateLabel(by("done"))).toBe("Completed");
    // A failed or cancelled task keeps its unmet prerequisite but is not waiting.
    expect(
      nodeStateLabel(
        node("x", {
          operationalStatus: "failed",
          recordedStatus: "failed",
          ready: false,
          waiting: false,
          unmetPrerequisiteIds: ["a"],
        }),
      ),
    ).toBe("Failed");
    expect(
      nodeStateLabel(
        node("y", {
          ready: false,
          waiting: false,
          operationalStatus: "blocked",
        }),
      ),
    ).toBe("Not startable");
  });

  test("unmet edges remain distinct from completed edges for terminal dependents", () => {
    const tasks = [
      ...graph.tasks,
      node("z", {
        operationalStatus: "cancelled",
        recordedStatus: "cancelled",
        ready: false,
        waiting: false,
        unmetPrerequisiteIds: ["a"],
      }),
    ];
    expect([...unmetEdgeKeys(tasks)].sort()).toEqual([
      "a>b",
      "a>c",
      "a>z",
      "b>d",
      "c>d",
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

  test("reuses direct and transitive relationships across fact-only refreshes", () => {
    const memo = createGraphRelationshipMemo();
    const first = memo(graph.edges, "b");
    const refreshedEdges = graph.edges.map((edge) => ({ ...edge }));
    expect(memo(refreshedEdges, "b")).toBe(first);
    expect(memo(refreshedEdges, "d")).toMatchObject({
      prerequisites: ["b", "c"],
      dependents: [],
    });
    expect([...memo(refreshedEdges, "d").lineage.upstream].sort()).toEqual([
      "a",
      "b",
      "c",
      "done",
    ]);
    const rewiredEdges = refreshedEdges.map((edge) =>
      edge.taskId === "d" && edge.dependsOnTaskId === "c"
        ? { taskId: "lone", dependsOnTaskId: "c" }
        : edge,
    );
    expect(memo(rewiredEdges, "c").dependents).toEqual(["lone"]);
    expect([...memo(rewiredEdges, "c").lineage.downstream]).toEqual(["lone"]);
    const changedEdges = [
      ...refreshedEdges,
      { taskId: "lone", dependsOnTaskId: "d" },
    ];
    expect([...memo(changedEdges, "b").lineage.downstream].sort()).toEqual([
      "d",
      "lone",
    ]);
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

  test("the canvas bounds both tasks and dependencies before synchronous layout", () => {
    expect(exceedsLayoutLimit(80, maxLayoutWeight - 80)).toBe(false);
    expect(exceedsLayoutLimit(80, maxLayoutWeight - 79)).toBe(true);
    expect(exceedsLayoutLimit(1_000, 0)).toBe(true);
    expect(exceedsLayoutLimit(75, 2_000)).toBe(true);
    // A deterministic dense DAG, with up to three prerequisites per task.
    const count = 55;
    const tasks = Array.from({ length: count }, (_, i) =>
      node(`t${String(i).padStart(5, "0")}`),
    );
    const dense = {
      ...graph,
      tasks,
      edges: tasks.flatMap((task, i) =>
        i < 3
          ? []
          : [
              ...new Set([i - 1, Math.floor(i * 0.63), Math.floor(i * 0.23)]),
            ].map((prerequisite) => ({
              taskId: task.taskId,
              dependsOnTaskId: tasks[prerequisite]!.taskId,
            })),
      ),
    };
    const visible = filterGraph(dense, all);
    expect(exceedsLayoutLimit(visible.tasks.length, visible.edges.length)).toBe(
      false,
    );
    // CPU time measures Dagre's own synchronous work even while parallel test
    // workers compete for wall time on a loaded CI runner.
    const started = process.cpuUsage();
    const positions = layoutGraph(visible, "LR");
    expect(positions.size).toBe(count);
    const spent = process.cpuUsage(started);
    expect((spent.user + spent.system) / 1_000).toBeLessThan(1_000);
  });

  test("selection-only data changes reuse the same dependency layout", () => {
    const layout = createLayoutMemo();
    const visible = filterGraph(graph, defaultGraphFilters);
    const first = layout(visible, "LR");
    const copied = {
      ...visible,
      tasks: visible.tasks.map((task) => ({ ...task, title: "Refreshed" })),
      edges: visible.edges.map((edge) => ({ ...edge })),
    };
    expect(layout(copied, "LR")).toBe(first);
    expect(layout(copied, "TB")).not.toBe(first);
    expect(layout({ ...copied, edges: copied.edges.slice(1) }, "LR")).not.toBe(
      first,
    );
  });

  test("long dependency chains expose every task through bounded pages", () => {
    const chain = Array.from({ length: 50_000 }, (_, i) => `t${i}`);
    const byId = new Map(chain.map((id) => [id, node(id)]));
    const first = chainPage(chain, byId, 0);
    const last = chainPage(chain, byId, 1_999);
    expect(first.tasks).toHaveLength(chainPageSize);
    expect(last.tasks).toHaveLength(chainPageSize);
    expect(last.tasks.at(-1)?.taskId).toBe("t49999");
    expect(chainPage(chain, byId, 99_999).page).toBe(1_999);
    // A live refresh can shorten a selected task's relationship list while
    // its panel is open on a later page.
    expect(chainPage(chain.slice(0, 3), byId, 1_999)).toMatchObject({
      page: 0,
      totalPages: 1,
      tasks: chain.slice(0, 3).map((id) => byId.get(id)),
    });
  });

  test("a large selected-task panel excludes unblocked dependents in linear time", () => {
    const dependents = Array.from({ length: 20_000 }, (_, i) => `t${i}`);
    const unblocks = dependents.slice(0, 19_000);
    const started = performance.now();
    expect(otherDependentIds(dependents, unblocks)).toEqual(
      dependents.slice(19_000),
    );
    expect(performance.now() - started).toBeLessThan(200);
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
