/**
 * Pure projection of the task dependency graph.
 *
 * Readiness and the critical path are computed here once so that every
 * presentation surface agrees; a browser only lays the result out.
 */

import type {
  TaskGraphEdge,
  TaskGraphNode,
  TaskOperationalState,
} from "./operational-read-models.ts";

const nonReadyStatuses = new Set(["completed", "cancelled", "failed"]);

export function projectTaskGraphNodes(
  tasks: readonly TaskOperationalState[],
  edges: readonly TaskGraphEdge[],
): TaskGraphNode[] {
  const recorded = new Map(tasks.map((task) => [task.taskId, task]));
  const prerequisites = new Map<string, string[]>();
  for (const edge of edges) {
    const values = prerequisites.get(edge.taskId) ?? [];
    values.push(edge.dependsOnTaskId);
    prerequisites.set(edge.taskId, values);
  }
  return tasks
    .map((task) => {
      // Same rule as blockingPrerequisites(): only completed work satisfies.
      const unmet = (prerequisites.get(task.taskId) ?? [])
        .filter((id) => recorded.get(id)?.recordedStatus !== "completed")
        .sort();
      return {
        taskId: task.taskId,
        title: task.title,
        priority: task.priority,
        recordedStatus: task.recordedStatus,
        operationalStatus: task.operationalStatus,
        assignedAgent: task.assignedAgent,
        milestoneIds: (task.milestones ?? []).map((m) => m.milestoneId).sort(),
        unmetPrerequisiteIds: unmet,
        ready: !nonReadyStatuses.has(task.recordedStatus) && unmet.length === 0,
      };
    })
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/**
 * Longest chain of unfinished tasks following prerequisite edges. Edges are
 * acyclic by construction; a defensive visited guard keeps a corrupted store
 * from looping.
 */
export function projectCriticalPath(
  nodes: readonly TaskGraphNode[],
  edges: readonly TaskGraphEdge[],
): string[] {
  const unfinished = new Set(
    nodes
      .filter((node) => node.recordedStatus !== "completed")
      .filter((node) => node.recordedStatus !== "cancelled")
      .map((node) => node.taskId),
  );
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    if (!unfinished.has(edge.taskId) || !unfinished.has(edge.dependsOnTaskId))
      continue;
    const values = dependents.get(edge.dependsOnTaskId) ?? [];
    values.push(edge.taskId);
    dependents.set(edge.dependsOnTaskId, values);
  }
  const best = new Map<string, string[]>();
  const visiting = new Set<string>();
  const longestFrom = (id: string): string[] => {
    const known = best.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return [id];
    visiting.add(id);
    let tail: string[] = [];
    for (const next of (dependents.get(id) ?? []).sort()) {
      const candidate = longestFrom(next);
      if (candidate.length > tail.length) tail = candidate;
    }
    visiting.delete(id);
    const path = [id, ...tail];
    best.set(id, path);
    return path;
  };
  let result: string[] = [];
  for (const id of [...unfinished].sort()) {
    const path = longestFrom(id);
    if (path.length > result.length) result = path;
  }
  // A lone task is not a chain.
  return result.length < 2 ? [] : result;
}
