import { graphlib, layout } from "@dagrejs/dagre";
import type {
  TaskGraph,
  TaskGraphEdge,
  TaskGraphMilestone,
  TaskGraphNode,
  TaskOperationalStatus,
} from "@ai-office/application/read-models/operational-read-models.ts";

export const nodeSize = { width: 264, height: 80 } as const;
export const milestoneNodeSize = { width: 264, height: 64 } as const;

export type GraphDirection = "LR" | "TB";

export interface GraphFilters {
  search: string;
  status: TaskOperationalStatus | "";
  /** "" = all, "none" = tasks without a milestone, otherwise a milestone id. */
  milestone: string;
  readyOnly: boolean;
  hideCompleted: boolean;
  showMilestones: boolean;
}

export const defaultGraphFilters: GraphFilters = {
  search: "",
  status: "",
  milestone: "",
  readyOnly: false,
  hideCompleted: true,
  showMilestones: true,
};

export interface VisibleGraph {
  tasks: readonly TaskGraphNode[];
  milestones: readonly TaskGraphMilestone[];
  edges: readonly TaskGraphEdge[];
  /** Task → milestone membership edges between visible nodes. */
  membership: readonly { taskId: string; milestoneId: string }[];
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
    if (filters.hideCompleted && filters.status === "") {
      if (
        task.operationalStatus === "completed" ||
        task.operationalStatus === "cancelled"
      )
        return false;
    }
    if (filters.status !== "" && task.operationalStatus !== filters.status)
      return false;
    if (filters.readyOnly && !task.ready) return false;
    if (filters.milestone === "none" && task.milestoneIds.length > 0)
      return false;
    if (
      filters.milestone !== "" &&
      filters.milestone !== "none" &&
      !task.milestoneIds.includes(filters.milestone)
    )
      return false;
    if (
      search !== "" &&
      !task.taskId.toLowerCase().includes(search) &&
      !task.title.toLowerCase().includes(search)
    )
      return false;
    return true;
  });
  const ids = new Set(tasks.map((task) => task.taskId));
  const membership = filters.showMilestones
    ? tasks.flatMap((task) =>
        task.milestoneIds.map((milestoneId) => ({
          taskId: task.taskId,
          milestoneId,
        })),
      )
    : [];
  const usedMilestones = new Set(membership.map((link) => link.milestoneId));
  return {
    tasks,
    milestones: graph.milestones.filter((m) =>
      usedMilestones.has(m.milestoneId),
    ),
    edges: graph.edges.filter(
      (edge) => ids.has(edge.taskId) && ids.has(edge.dependsOnTaskId),
    ),
    membership,
    hiddenTaskCount: graph.tasks.length - tasks.length,
  };
}

export interface Lineage {
  /** Transitive prerequisites of the task. */
  upstream: ReadonlySet<string>;
  /** Transitive dependents of the task. */
  downstream: ReadonlySet<string>;
}

/** Walks the whole graph, so a filter can never shorten a lineage. */
export function lineage(
  edges: readonly TaskGraphEdge[],
  taskId: string,
): Lineage {
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
  const walk = (adjacent: ReadonlyMap<string, readonly string[]>) => {
    const seen = new Set<string>();
    const queue = [...(adjacent.get(taskId) ?? [])];
    while (queue.length > 0) {
      const next = queue.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(...(adjacent.get(next) ?? []));
    }
    return seen;
  };
  return { upstream: walk(prerequisites), downstream: walk(dependents) };
}

export interface Positioned {
  x: number;
  y: number;
}

/** Layered layout: prerequisites left of (or above) their dependents. */
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
  for (const milestone of visible.milestones)
    g.setNode(milestoneKey(milestone.milestoneId), { ...milestoneNodeSize });
  for (const edge of visible.edges)
    g.setEdge(taskKey(edge.dependsOnTaskId), taskKey(edge.taskId));
  for (const link of visible.membership)
    g.setEdge(taskKey(link.taskId), milestoneKey(link.milestoneId), {
      weight: 0,
    });
  layout(g);
  const positions = new Map<string, Positioned>();
  for (const id of g.nodes()) {
    const node = g.node(id);
    const size = id.startsWith("m:") ? milestoneNodeSize : nodeSize;
    // dagre reports centres; React Flow positions the top-left corner.
    positions.set(id, {
      x: node.x - size.width / 2,
      y: node.y - size.height / 2,
    });
  }
  return positions;
}

export const taskKey = (taskId: string) => `t:${taskId}`;
export const milestoneKey = (milestoneId: string) => `m:${milestoneId}`;
