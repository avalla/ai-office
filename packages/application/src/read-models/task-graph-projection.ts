/**
 * Pure projection of the task dependency graph.
 *
 * Readiness and the longest dependency chain are computed here once so that every
 * presentation surface agrees; a browser only lays the result out.
 */

import { isTaskRunnable } from "@ai-office/domain/agent/run-eligibility.ts";
import { blockingPrerequisites } from "@ai-office/domain/task/task-dependency.ts";
import { isTerminalTaskStatus } from "@ai-office/domain/task/task.ts";
import type {
  TaskGraphEdge,
  TaskGraphNode,
  TaskGraphSummary,
  TaskMilestoneGap,
  TaskOperationalState,
} from "./operational-read-models.ts";

/**
 * Milestones are derived from task→requirement→milestone links, so a task
 * outside every milestone has either no requirement or only requirements
 * recorded without one.
 */
function milestoneGap(
  task: TaskOperationalState,
  requirementLinkedTaskIds: ReadonlySet<string>,
): TaskMilestoneGap | null {
  if ((task.milestones ?? []).length > 0) return null;
  // A task outside every milestone that still has a requirement: that
  // requirement carries no (surviving) milestone.
  return requirementLinkedTaskIds.has(task.taskId)
    ? "requirement_without_milestone"
    : "no_requirement";
}

export function projectTaskGraphNodes(
  tasks: readonly TaskOperationalState[],
  edges: readonly TaskGraphEdge[],
  /** Tasks linked to at least one requirement, whatever its milestone. */
  requirementLinkedTaskIds: ReadonlySet<string>,
): TaskGraphNode[] {
  const statuses = new Map(
    tasks.map((task) => [task.taskId, task.recordedStatus]),
  );
  const prerequisites = new Map<string, string[]>();
  for (const edge of edges) {
    const values = prerequisites.get(edge.taskId) ?? [];
    values.push(edge.dependsOnTaskId);
    prerequisites.set(edge.taskId, values);
  }
  const unmetById = new Map<string, string[]>();
  for (const task of tasks)
    unmetById.set(
      task.taskId,
      // The domain rule itself; the snapshot guarantees every prerequisite exists.
      blockingPrerequisites(
        task.taskId,
        prerequisites.get(task.taskId) ?? [],
        statuses,
      )
        .map((blocker) => blocker.taskId)
        .sort(),
    );
  // A dependent is unblocked when X reaches review or completion as its only
  // unmet prerequisite and its own status would then allow work. A terminal
  // prerequisite can never move into review or completion, so it unblocks nothing.
  const unblocks = new Map<string, string[]>();
  for (const task of tasks) {
    const unmet = unmetById.get(task.taskId) ?? [];
    const only = unmet.length === 1 ? unmet[0] : undefined;
    if (
      only === undefined ||
      !isTaskRunnable(task.recordedStatus) ||
      isTerminalTaskStatus(statuses.get(only) ?? "completed")
    )
      continue;
    const list = unblocks.get(only);
    if (list === undefined) unblocks.set(only, [task.taskId]);
    else list.push(task.taskId);
  }
  return tasks
    .map((task) => {
      const unmet = unmetById.get(task.taskId) ?? [];
      return {
        taskId: task.taskId,
        title: task.title,
        priority: task.priority,
        recordedStatus: task.recordedStatus,
        operationalStatus: task.operationalStatus,
        assignedAgent: task.assignedAgent,
        milestoneIds: (task.milestones ?? []).map((m) => m.milestoneId).sort(),
        milestoneGap: milestoneGap(task, requirementLinkedTaskIds),
        unmetPrerequisiteIds: unmet,
        // The admission rule of ManageTaskDependencies.readiness, not a copy.
        ready: isTaskRunnable(task.recordedStatus) && unmet.length === 0,
        terminal: task.terminal,
        waiting: !task.terminal && unmet.length > 0,
        needsAttention: task.attentionReasons.length > 0,
        completionUnblocks: (unblocks.get(task.taskId) ?? []).sort(),
      };
    })
    .sort((a, b) => a.taskId.localeCompare(b.taskId));
}

/**
 * Longest chain of unfinished (non-terminal) tasks following prerequisite
 * edges. Iterative, linear in nodes plus edges, with no recursion and no
 * per-node path copies, so a very long chain cannot exhaust the stack.
 * Edges are acyclic by construction; any node a cycle would leave unvisited is
 * simply left out. Ties pick the smallest task id, so the result is stable.
 */
export function projectLongestDependencyChain(
  nodes: readonly TaskGraphNode[],
  edges: readonly TaskGraphEdge[],
): string[] {
  const unfinished = new Set(
    nodes.filter((node) => !node.terminal).map((node) => node.taskId),
  );
  const dependents = new Map<string, string[]>();
  const waitingOn = new Map<string, number>();
  for (const id of unfinished) waitingOn.set(id, 0);
  for (const edge of edges) {
    if (!unfinished.has(edge.taskId) || !unfinished.has(edge.dependsOnTaskId))
      continue;
    const values = dependents.get(edge.dependsOnTaskId);
    if (values === undefined)
      dependents.set(edge.dependsOnTaskId, [edge.taskId]);
    else values.push(edge.taskId);
    waitingOn.set(edge.taskId, (waitingOn.get(edge.taskId) ?? 0) + 1);
  }
  // Kahn's algorithm: prerequisites before dependents.
  const order: string[] = [];
  const queue = [...unfinished].filter((id) => waitingOn.get(id) === 0);
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head]!;
    order.push(id);
    for (const next of dependents.get(id) ?? []) {
      const remaining = (waitingOn.get(next) ?? 0) - 1;
      waitingOn.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  // Longest chain starting at each node, and the dependent that continues it.
  const length = new Map<string, number>();
  const successor = new Map<string, string>();
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index]!;
    let best = 0;
    let bestNext: string | undefined;
    for (const next of dependents.get(id) ?? []) {
      const candidate = length.get(next) ?? 0;
      if (
        candidate > best ||
        (candidate === best && bestNext !== undefined && next < bestNext)
      ) {
        best = candidate;
        bestNext = next;
      }
    }
    length.set(id, best + 1);
    if (bestNext !== undefined) successor.set(id, bestNext);
  }
  let start: string | undefined;
  for (const id of order) {
    const current = length.get(id) ?? 0;
    const known = start === undefined ? 0 : (length.get(start) ?? 0);
    if (
      current > known ||
      (current === known && start !== undefined && id < start)
    )
      start = id;
  }
  const path: string[] = [];
  for (let id = start; id !== undefined; id = successor.get(id)) path.push(id);
  // A lone task is not a chain.
  return path.length < 2 ? [] : path;
}

export function projectTaskGraphSummary(
  nodes: readonly TaskGraphNode[],
): TaskGraphSummary {
  const count = (matches: (node: TaskGraphNode) => boolean) =>
    nodes.filter(matches).length;
  return {
    total: nodes.length,
    ready: count((node) => node.ready),
    waiting: count((node) => node.waiting),
    blocked: count((node) => node.operationalStatus === "blocked"),
    inProgress: count((node) => node.operationalStatus === "in_progress"),
    needsAttention: count((node) => node.needsAttention),
  };
}
