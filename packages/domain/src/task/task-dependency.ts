import { DomainValidationError } from "../errors.ts";
import type { TaskStatus } from "./task.ts";

export interface BlockingPrerequisite {
  taskId: string;
  status: TaskStatus;
}

export class TaskDependencyError extends DomainValidationError {
  constructor(message: string) {
    super(message);
    this.name = "TaskDependencyError";
  }
}

/** A hard prerequisite is satisfied only by completed work. */
export function blockingPrerequisites(
  taskId: string,
  dependsOnTaskIds: readonly string[],
  statuses: ReadonlyMap<string, TaskStatus>,
): BlockingPrerequisite[] {
  return dependsOnTaskIds.flatMap((id) => {
    const status = statuses.get(id);
    if (status === undefined)
      throw new TaskDependencyError(`Prerequisite task ${id} does not exist`);
    return status === "completed" ? [] : [{ taskId: id, status }];
  });
}

/** Reject a new edge when its prerequisite can already reach its dependent. */
export function assertAcyclicDependency(
  taskId: string,
  dependsOnTaskId: string,
  edges: readonly { taskId: string; dependsOnTaskId: string }[],
): void {
  if (taskId === dependsOnTaskId)
    throw new TaskDependencyError("A task cannot depend on itself");
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    const values = outgoing.get(edge.dependsOnTaskId) ?? [];
    values.push(edge.taskId);
    outgoing.set(edge.dependsOnTaskId, values);
  }
  const visited = new Set<string>();
  const queue = [taskId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === dependsOnTaskId)
      throw new TaskDependencyError("Task dependency would create a cycle");
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
}
