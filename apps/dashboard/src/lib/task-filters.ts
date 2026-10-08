import type { TaskPageQuery } from "@ai-office/application/read-models/operational-read-models.ts";
import {
  parseTaskPageQuery,
  queryLimits,
} from "@ai-office/application/protocol/query-protocol.ts";

export interface TaskFilterValues {
  search: string;
  status: string;
  priority: string;
  agent: string;
  milestone?: string;
  milestones?: readonly string[];
  sort?: string;
}

/** The picker enforces the same bound as the query parser. */
export function milestoneChoiceDisabled(
  selected: readonly string[],
  id: string,
): boolean {
  return (
    selected.length >= queryLimits.maxTaskMilestoneFilters &&
    !selected.includes(id)
  );
}
/** Applying a filter returns to page one and uses the daemon's parser. */
export function taskFilterQuery(values: TaskFilterValues): TaskPageQuery {
  const parameters = new URLSearchParams({
    search: values.search,
    status: values.status,
    priority: values.priority,
  });
  if (values.agent === "none") parameters.set("unassigned", "true");
  else if (values.agent.startsWith("agent:"))
    parameters.set("agent", values.agent.slice(6));
  if (values.milestones !== undefined) {
    for (const id of values.milestones) parameters.append("milestone", id);
  } else if (values.milestone) parameters.set("milestone", values.milestone);
  if (values.sort) parameters.set("sort", values.sort);
  return parseTaskPageQuery(parameters);
}
