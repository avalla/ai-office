import { graphlib, layout } from "@dagrejs/dagre";
import type {
  TaskGraph,
  TaskGraphEdge,
  TaskGraphNode,
  TaskOperationalStatus,
} from "@ai-office/application/read-models/operational-read-models.ts";

export const nodeSize = { width: 264, height: 96 } as const;

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
  /** "" = all, "none" = tasks without a milestone, otherwise a milestone id. */
  milestone: string;
  quick: QuickFilter | "";
  hideCompleted: boolean;
}

export const defaultGraphFilters: GraphFilters = {
  search: "",
  status: "",
  milestone: "",
  quick: "",
  hideCompleted: true,
};

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

export function filterGraph(
  graph: TaskGraph,
  filters: GraphFilters,
  scope: {
    /** Tasks kept whatever the filters say, e.g. the current selection. */
    keep?: ReadonlySet<string>;
    /** When set, exactly these tasks are shown and the filters are ignored. */
    only?: ReadonlySet<string>;
  } = {},
): VisibleGraph {
  const { keep = new Set<string>(), only } = scope;
  const search = filters.search.trim().toLowerCase();
  const tasks = graph.tasks.filter((task) => {
    if (only !== undefined) return only.has(task.taskId);
    if (keep.has(task.taskId)) return true;
    if (
      filters.hideCompleted &&
      filters.status === "" &&
      // An operational shortcut asks about work needing action, and attention
      // can sit on finished tasks: it must not be hidden from itself.
      filters.quick === "" &&
      (task.operationalStatus === "completed" ||
        task.operationalStatus === "cancelled")
    )
      return false;
    if (filters.status !== "" && task.operationalStatus !== filters.status)
      return false;
    if (filters.quick !== "" && !matchesQuickFilter(task, filters.quick))
      return false;
    if (filters.milestone === "none" && task.milestoneIds.length > 0)
      return false;
    if (
      filters.milestone !== "" &&
      filters.milestone !== "none" &&
      !task.milestoneIds.includes(filters.milestone)
    )
      return false;
    if (search !== "" && !matchesSearch(task, search)) return false;
    return true;
  });
  const ids = new Set(tasks.map((task) => task.taskId));
  return {
    tasks,
    edges: graph.edges.filter(
      (edge) => ids.has(edge.taskId) && ids.has(edge.dependsOnTaskId),
    ),
    hiddenTaskCount: graph.tasks.length - tasks.length,
  };
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
  const rank = (task: TaskGraphNode) =>
    task.title.toLowerCase().startsWith(search)
      ? 0
      : task.title.toLowerCase().includes(search)
        ? 1
        : 2;
  const found = graph.tasks
    .filter((task) => matchesSearch(task, search))
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        a.title.localeCompare(b.title) ||
        a.taskId.localeCompare(b.taskId),
    );
  return { matches: found.slice(0, limit), total: found.length };
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

/** Keep the adjacency index and selected lineage across fact-only refreshes. */
export function createLineageMemo() {
  let previousEdges: readonly TaskGraphEdge[] | null = null;
  let index: LineageIndex | null = null;
  let previousTaskId: string | null = null;
  let previousResult: Lineage | null = null;
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
  return (edges: readonly TaskGraphEdge[], taskId: string): Lineage => {
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
    const result = lineageFromIndex(index, taskId);
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
  const finished =
    task.operationalStatus === "completed" ||
    task.operationalStatus === "cancelled" ||
    task.operationalStatus === "failed";
  return finished
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
 * `prerequisite>dependent` keys for every unmet prerequisite, including those
 * of terminal dependents. Built from the per-task read model, never from
 * statuses reconstructed in the browser.
 */
export function unmetEdgeKeys(
  tasks: readonly TaskGraphNode[],
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const task of tasks)
    for (const id of task.unmetPrerequisiteIds)
      keys.add(`${id}>${task.taskId}`);
  return keys;
}
