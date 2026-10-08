import type { TaskPageQuery } from "@ai-office/application/read-models/operational-read-models.ts";
import { parseTaskPageQuery } from "@ai-office/application/protocol/query-protocol.ts";

export interface TaskFilterValues {
  search: string;
  status: string;
  priority: string;
  agent: string;
  milestone?: string;
  milestones?: readonly string[];
  sort?: string;
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
