import { graphlib, layout } from "@dagrejs/dagre";
import type {
  TaskGraph,
  TaskGraphEdge,
  TaskGraphNode,
  TaskOperationalStatus,
} from "@ai-office/application/read-models/operational-read-models.ts";

export const nodeSize = { width: 264, height: 96 } as const;

export type GraphNodeDetail = "full" | "medium" | "compact";

/** The node footprint stays fixed; only its presentation changes with zoom. */
export function graphNodeDetail(zoom: number): GraphNodeDetail {
  if (zoom >= 0.85) return "full";
  if (zoom >= 0.4) return "medium";
  return "compact";
}

export type GraphDirection = "LR" | "TB";

/**
 * Dagre runs on the main thread. Dense dependencies cost much more than a
 * sparse chain, so both visible tasks and edges count toward this budget.
 */
export const maxLayoutWeight = 300;

export const exceedsLayoutLimit = (
  visibleTasks: number,
  visibleEdges: number,
) => visibleTasks + visibleEdges > maxLayoutWeight;

/**
 * Operational shortcuts. Every value is a flag or status the read model already
 * computed; the browser only selects among them.
 */
export const quickFilters = [
  "ready",
  "waiting",
  "blocked",
  "in_progress",
  "attention",
] as const;
export type QuickFilter = (typeof quickFilters)[number];

export interface GraphFilters {
  /** Applied only when the user asked to filter the graph by the search text. */
  search: string;
  status: TaskOperationalStatus | "";
  /** Empty = all; "none" includes tasks without a milestone. Other values are IDs. */
  milestones: readonly string[];
  quick: QuickFilter | "";
  hideCompleted: boolean;
}

export const defaultGraphFilters: GraphFilters = {
  search: "",
  status: "",
  milestones: [],
  quick: "",
  hideCompleted: true,
};

export const activeStatusOption = "__active__" as const;
export type GraphStatusOption =
  TaskOperationalStatus | "" | typeof activeStatusOption;

/** Keep the compact default explicit in the status control. */
export function graphStatusOption(filters: GraphFilters): GraphStatusOption {
  return filters.status === "" && filters.hideCompleted
    ? activeStatusOption
    : filters.status;
}

export function withGraphStatusOption(
  filters: GraphFilters,
  option: GraphStatusOption,
): GraphFilters {
  if (option === activeStatusOption)
    return { ...filters, status: "", hideCompleted: true };
  if (option === "") return { ...filters, status: "", hideCompleted: false };
  return { ...filters, status: option };
}

/** Selected categories are an OR filter; keep their order deterministic. */
export function toggleMilestoneFilter(
  selected: readonly string[],
  value: string,
): string[] {
  return selected.includes(value)
    ? selected.filter((id) => id !== value)
    : [...selected, value].sort();
}

export function matchesQuickFilter(
  task: TaskGraphNode,
  quick: QuickFilter,
): boolean {
  switch (quick) {
    case "ready":
      return task.ready;
    case "waiting":
      return task.waiting;
    case "blocked":
      return task.operationalStatus === "blocked";
    case "in_progress":
      return task.operationalStatus === "in_progress";
    case "attention":
      return task.needsAttention;
  }
}

export interface VisibleGraph {
  tasks: readonly TaskGraphNode[];
  edges: readonly TaskGraphEdge[];
  hiddenTaskCount: number;
}

export const neighborhoodModes = [
  "direct",
  "one_hop",
  "two_hops",
  "full_lineage",
] as const;
export type NeighborhoodMode = (typeof neighborhoodModes)[number];

export interface GraphNeighborhood {
  taskIds: ReadonlySet<string>;
  /** Direct relations draw only edges incident to the selected task. */
  edgeKeys?: ReadonlySet<string>;
}

/** A tuple encoding keeps arbitrary task IDs from colliding at an edge key. */
export const graphEdgeKey = (prerequisiteId: string, taskId: string): string =>
  JSON.stringify([prerequisiteId, taskId]);

/** Compute scope from the complete dependency index, independent of filters. */
function graphNeighborhoodFromIndex(
  index: LineageIndex,
  taskId: string,
  mode: NeighborhoodMode,
  fullLineage?: Lineage,
): GraphNeighborhood {
  if (mode === "full_lineage") {
    const { upstream, downstream } =
      fullLineage ?? lineageFromIndex(index, taskId);
    return { taskIds: new Set([taskId, ...upstream, ...downstream]) };
  }
  const taskIds = new Set([taskId]);
  const depth = mode === "two_hops" ? 2 : 1;
  const walk = (adjacent: ReadonlyMap<string, readonly string[]>) => {
    let frontier = [taskId];
    for (let hop = 0; hop < depth; hop += 1) {
      const next: string[] = [];
      for (const id of frontier)
        for (const neighbor of adjacent.get(id) ?? []) {
          if (taskIds.has(neighbor)) continue;
          taskIds.add(neighbor);
          next.push(neighbor);
        }
      frontier = next;
    }
  };
  walk(index.prerequisites);
  walk(index.dependents);
  if (mode !== "direct") return { taskIds };
  const edgeKeys = new Set<string>();
  for (const prerequisite of index.prerequisites.get(taskId) ?? [])
    edgeKeys.add(graphEdgeKey(prerequisite, taskId));
  for (const dependent of index.dependents.get(taskId) ?? [])
    edgeKeys.add(graphEdgeKey(taskId, dependent));
  return { taskIds, edgeKeys };
}

export function filterGraph(
  graph: TaskGraph,
  filters: GraphFilters,
  scope: {
    /** Tasks kept whatever the filters say, e.g. the current selection. */
    keep?: ReadonlySet<string>;
    /** When set, exactly these tasks are shown and the filters are ignored. */
    only?: ReadonlySet<string>;
    /** When set, only these dependency edges are drawn within the scope. */
    onlyEdges?: ReadonlySet<string>;
  } = {},
): VisibleGraph {
  const { keep = new Set<string>(), only, onlyEdges } = scope;
  const search = filters.search.trim().toLowerCase();
  const matchingTasks = graph.tasks.filter((task) => {
    if (only !== undefined) return only.has(task.taskId);
    if (keep.has(task.taskId)) return true;
    if (filters.status !== "" && task.operationalStatus !== filters.status)
      return false;
    if (filters.quick !== "" && !matchesQuickFilter(task, filters.quick))
      return false;
    if (
      filters.milestones.length > 0 &&
      !filters.milestones.some((id) =>
        id === "none"
          ? task.milestoneIds.length === 0
          : task.milestoneIds.includes(id),
      )
    )
      return false;
    if (search !== "" && !matchesSearch(task, search)) return false;
    return true;
  });
  // Use projected unmet prerequisites of the open tasks that matched the
  // explicit filters. A cancelled node remains only if it also matched those
  // filters and still blocks a visible task.
  const cancelledBlockers = new Set<string>();
  if (
    only === undefined &&
    filters.hideCompleted &&
    filters.status === "" &&
    filters.quick === ""
  ) {
    for (const task of matchingTasks) {
      if (task.terminal) continue;
      for (const prerequisiteId of task.unmetPrerequisiteIds)
        cancelledBlockers.add(prerequisiteId);
    }
  }
  const tasks = matchingTasks.filter((task) => {
    if (only !== undefined || keep.has(task.taskId)) return true;
    // An operational shortcut or status filter overrides default hiding.
    if (!filters.hideCompleted || filters.status !== "" || filters.quick !== "")
      return true;
    return (
      task.operationalStatus !== "completed" &&
      (task.operationalStatus !== "cancelled" ||
        cancelledBlockers.has(task.taskId))
    );
  });
  const ids = new Set(tasks.map((task) => task.taskId));
  return {
    tasks,
    edges: graph.edges.filter(
      (edge) =>
        ids.has(edge.taskId) &&
        ids.has(edge.dependsOnTaskId) &&
        (onlyEdges === undefined ||
          onlyEdges.has(graphEdgeKey(edge.dependsOnTaskId, edge.taskId))),
    ),
    hiddenTaskCount: graph.tasks.length - tasks.length,
  };
}

/** Count direct completed prerequisites omitted from the current graph view. */
export function hiddenCompletedPrerequisiteCounts(
  graph: TaskGraph,
  visible: VisibleGraph,
): ReadonlyMap<string, number> {
  const completed = new Set(
    graph.tasks
      .filter((task) => task.recordedStatus === "completed")
      .map((task) => task.taskId),
  );
  const visibleIds = new Set(visible.tasks.map((task) => task.taskId));
  const counts = new Map<string, number>();
  for (const edge of graph.edges) {
    if (
      !visibleIds.has(edge.taskId) ||
      visibleIds.has(edge.dependsOnTaskId) ||
      !completed.has(edge.dependsOnTaskId)
    )
      continue;
    counts.set(edge.taskId, (counts.get(edge.taskId) ?? 0) + 1);
  }
  return counts;
}

function matchesSearch(task: TaskGraphNode, search: string): boolean {
  return (
    task.taskId.toLowerCase().includes(search) ||
    task.title.toLowerCase().includes(search)
  );
}

/**
 * Tasks matching the search text anywhere in the project, best match first:
 * title prefix, then title substring, then id. Used to locate a task without
 * removing the rest of the graph.
 */
export function searchTasks(
  graph: TaskGraph,
  text: string,
  limit = 8,
): { matches: readonly TaskGraphNode[]; total: number } {
  const search = text.trim().toLowerCase();
  if (search === "") return { matches: [], total: 0 };
  const capacity = Math.max(0, Math.trunc(limit));
  type RankedTask = { task: TaskGraphNode; rank: number };
  const best: RankedTask[] = [];
  const compare = (left: RankedTask, right: RankedTask) =>
    left.rank - right.rank ||
    left.task.title.localeCompare(right.task.title) ||
    left.task.taskId.localeCompare(right.task.taskId);
  let total = 0;
  for (const task of graph.tasks) {
    const title = task.title.toLowerCase();
    const rank = title.startsWith(search)
      ? 0
      : title.includes(search)
        ? 1
        : task.taskId.toLowerCase().includes(search)
          ? 2
          : null;
    if (rank === null) continue;
    total += 1;
    if (capacity === 0) continue;
    const candidate = { task, rank };
    if (
      best.length === capacity &&
      compare(candidate, best[capacity - 1]!) >= 0
    )
      continue;
    let low = 0;
    let high = best.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (compare(candidate, best[middle]!) < 0) high = middle;
      else low = middle + 1;
    }
    best.splice(low, 0, candidate);
    if (best.length > capacity) best.pop();
  }
  return { matches: best.map(({ task }) => task), total };
}

export interface Lineage {
  /** Transitive prerequisites of the task. */
  upstream: ReadonlySet<string>;
  /** Transitive dependents of the task. */
  downstream: ReadonlySet<string>;
}

interface LineageIndex {
  prerequisites: ReadonlyMap<string, readonly string[]>;
  dependents: ReadonlyMap<string, readonly string[]>;
}

export interface TaskRelationships {
  prerequisites: readonly string[];
  dependents: readonly string[];
  lineage: Lineage;
  neighborhood: (mode: NeighborhoodMode) => GraphNeighborhood;
}

function buildLineageIndex(edges: readonly TaskGraphEdge[]): LineageIndex {
  const prerequisites = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, value: string) => {
    const values = map.get(key);
    if (values === undefined) map.set(key, [value]);
    else values.push(value);
  };
  for (const edge of edges) {
    add(prerequisites, edge.taskId, edge.dependsOnTaskId);
    add(dependents, edge.dependsOnTaskId, edge.taskId);
  }
  return { prerequisites, dependents };
}

function lineageFromIndex(index: LineageIndex, taskId: string): Lineage {
  const walk = (adjacent: ReadonlyMap<string, readonly string[]>) => {
    const seen = new Set<string>();
    const queue: string[] = [];
    const enqueue = (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      queue.push(id);
    };
    for (const id of adjacent.get(taskId) ?? []) enqueue(id);
    while (queue.length > 0) {
      const next = queue.pop()!;
      for (const id of adjacent.get(next) ?? []) enqueue(id);
    }
    return seen;
  };
  return {
    upstream: walk(index.prerequisites),
    downstream: walk(index.dependents),
  };
}

/** Walks the whole graph, so a filter can never shorten a lineage. */
export function lineage(
  edges: readonly TaskGraphEdge[],
  taskId: string,
): Lineage {
  return lineageFromIndex(buildLineageIndex(edges), taskId);
}

/** Keep direct and transitive relationships across fact-only refreshes. */
export function createGraphRelationshipMemo() {
  let previousEdges: readonly TaskGraphEdge[] | null = null;
  let index: LineageIndex | null = null;
  let previousTaskId: string | null = null;
  let previousResult: TaskRelationships | null = null;
  const sameEdges = (
    a: readonly TaskGraphEdge[],
    b: readonly TaskGraphEdge[],
  ) =>
    a === b ||
    (a.length === b.length &&
      a.every(
        (edge, i) =>
          edge.taskId === b[i]?.taskId &&
          edge.dependsOnTaskId === b[i]?.dependsOnTaskId,
      ));
  return (
    edges: readonly TaskGraphEdge[],
    taskId: string,
  ): TaskRelationships => {
    if (
      index === null ||
      previousEdges === null ||
      !sameEdges(previousEdges, edges)
    ) {
      index = buildLineageIndex(edges);
      previousTaskId = null;
      previousResult = null;
    }
    previousEdges = edges;
    if (previousTaskId === taskId && previousResult !== null)
      return previousResult;
    const currentIndex = index;
    const currentLineage = lineageFromIndex(currentIndex, taskId);
    const neighborhoods = new Map<NeighborhoodMode, GraphNeighborhood>();
    const result: TaskRelationships = {
      prerequisites: currentIndex.prerequisites.get(taskId) ?? [],
      dependents: currentIndex.dependents.get(taskId) ?? [],
      lineage: currentLineage,
      neighborhood: (mode) => {
        const cached = neighborhoods.get(mode);
        if (cached !== undefined) return cached;
        const scope = graphNeighborhoodFromIndex(
          currentIndex,
          taskId,
          mode,
          currentLineage,
        );
        neighborhoods.set(mode, scope);
        return scope;
      },
    };
    previousTaskId = taskId;
    previousResult = result;
    return result;
  };
}

export interface Positioned {
  x: number;
  y: number;
}

/**
 * Layered layout of task dependencies only: prerequisites left of (or above)
 * their dependents. Nothing else takes part in the geometry.
 */
export function layoutGraph(
  visible: VisibleGraph,
  direction: GraphDirection,
): Map<string, Positioned> {
  const g = new graphlib.Graph();
  g.setGraph({
    rankdir: direction,
    nodesep: direction === "LR" ? 28 : 40,
    ranksep: direction === "LR" ? 90 : 70,
    marginx: 24,
    marginy: 24,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const task of visible.tasks)
    // dagre writes x/y into the label, so each node needs its own object.
    g.setNode(taskKey(task.taskId), { ...nodeSize });
  for (const edge of visible.edges)
    g.setEdge(taskKey(edge.dependsOnTaskId), taskKey(edge.taskId));
  layout(g);
  const positions = new Map<string, Positioned>();
  for (const id of g.nodes()) {
    const node = g.node(id);
    // dagre reports centres; React Flow positions the top-left corner.
    positions.set(id, {
      x: node.x - nodeSize.width / 2,
      y: node.y - nodeSize.height / 2,
    });
  }
  return positions;
}

/** Reuse geometry across selection and live data changes with the same layout. */
export function createLayoutMemo() {
  let previousKey = "";
  let previous: Map<string, Positioned> | null = null;
  return (visible: VisibleGraph, direction: GraphDirection) => {
    // Order is significant to Dagre's tie-breaking, so keep it in the key.
    const key = JSON.stringify([
      direction,
      visible.tasks.map((task) => task.taskId),
      visible.edges.map((edge) => [edge.dependsOnTaskId, edge.taskId]),
    ]);
    if (previous !== null && key === previousKey) return previous;
    previousKey = key;
    previous = layoutGraph(visible, direction);
    return previous;
  };
}

export const chainPageSize = 25;

/** Resolve only one page of IDs; the complete source list stays available. */
export function chainPage(
  chain: readonly string[],
  tasksById: ReadonlyMap<string, TaskGraphNode>,
  requestedPage: number,
) {
  const totalPages = Math.ceil(chain.length / chainPageSize);
  const page = Math.max(0, Math.min(requestedPage, totalPages - 1));
  const tasks = chain
    .slice(page * chainPageSize, (page + 1) * chainPageSize)
    .flatMap((id) => {
      const task = tasksById.get(id);
      return task === undefined ? [] : [task];
    });
  return { tasks, page, totalPages };
}

/** Keep dependent membership checks linear even for a task with many children. */
export function otherDependentIds(
  dependents: readonly string[],
  completionUnblocks: readonly string[],
): string[] {
  const unblocked = new Set(completionUnblocks);
  return dependents.filter((id) => !unblocked.has(id));
}

export const taskKey = (taskId: string) => `t:${taskId}`;

export type FramingDecision = "focus" | "frame" | "keep";

/**
 * What the canvas does after a layout or action change: honour a pending focus
 * jump, re-frame the graph, or leave the viewport alone. Only a data-driven
 * change (nothing the user did) after the user moved the viewport is left alone.
 */
export function decideFraming(input: {
  pendingKey: string | null;
  selectedKey: string | null;
  /** Direction, filters or isolation changed since the last pass. */
  actionChanged: boolean;
  /** A selection was cleared since the last pass. */
  cleared: boolean;
  userMoved: boolean;
}): FramingDecision {
  if (input.pendingKey !== null && input.pendingKey === input.selectedKey)
    return "focus";
  if (input.actionChanged || input.cleared || !input.userMoved) return "frame";
  return "keep";
}

export const statusLabel = (status: TaskOperationalStatus) =>
  status.replaceAll("_", " ");

export const blockers = (count: number) =>
  `${count} blocker${count === 1 ? "" : "s"}`;

/** Wording for a task that is neither ready nor waiting (read-model flags). */
export function idleState(task: TaskGraphNode): string {
  return task.terminal
    ? statusLabel(task.operationalStatus).replace(/^./, (c) => c.toUpperCase())
    : "Not startable";
}

/** One line saying what a task is doing, from the read model's flags only. */
export function nodeStateLabel(task: TaskGraphNode): string {
  if (task.ready) return "Ready to start";
  if (task.waiting)
    return `Waiting on ${blockers(task.unmetPrerequisiteIds.length)}`;
  return idleState(task);
}

/**
 * Collision-free keys for every unmet prerequisite, including those
 * of terminal dependents. Built from the per-task read model, never from
 * statuses reconstructed in the browser.
 */
export function unmetEdgeKeys(
  tasks: readonly TaskGraphNode[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const task of tasks)
    for (const id of task.unmetPrerequisiteIds)
      keys.add(graphEdgeKey(id, task.taskId));
  return keys;
}
