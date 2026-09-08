import type { TaskPageQuery } from "@ai-office/application/read-models/operational-read-models.ts";
import {
  parseTaskPageQuery,
  queryLimits,
} from "@ai-office/application/protocol/query-protocol.ts";
import { escapeHtml } from "./html.ts";
import { routeHref, taskStatusLabel, type ProjectView } from "./view-model.ts";

export interface TaskFilterValues {
  search: string;
  status: string;
  priority: string;
  agent: string;
}

/** Applying a filter always returns to the first page. */
export function taskFilterQuery(values: TaskFilterValues): TaskPageQuery {
  const parameters = new URLSearchParams({
    search: values.search,
    status: values.status,
    priority: values.priority,
  });
  if (values.agent === "none") parameters.set("unassigned", "true");
  else if (values.agent.startsWith("agent:"))
    parameters.set("agent", values.agent.slice("agent:".length));
  return parseTaskPageQuery(parameters);
}

function select(
  id: string,
  label: string,
  selected: string,
  options: [string, string][],
): string {
  // Retain a selected filter when refreshed data no longer contains its value.
  if (!options.some(([value]) => value === selected))
    options.push([
      selected,
      `${selected.replace(/^agent:/, "")} (no current matches)`,
    ]);
  return `<div class="task-select"><label for="${id}">${label}</label><select id="${id}" name="${id}">${options.map(([value, text]) => `<option value="${escapeHtml(value)}"${value === selected ? " selected" : ""}>${escapeHtml(text)}</option>`).join("")}</select></div>`;
}

export function renderTaskFilters(view: ProjectView): string {
  const page = view.taskPage;
  if (page === undefined) return "";
  const { filters, options } = page;
  const agentOptions: [string, string][] = [["", "All agents"]];
  if (options.hasUnassigned || filters.unassigned)
    agentOptions.push(["none", "No current agent"]);
  agentOptions.push(
    ...options.agents.map(
      (agent) =>
        [
          `agent:${agent.agentId}`,
          `${agent.name}${agent.roleKey === null ? "" : ` · ${agent.roleKey}`}`,
        ] as [string, string],
    ),
  );
  const reset =
    Object.keys(filters).length > 0 || page.offset > 0
      ? `<a href="${routeHref({ kind: "project", projectId: view.summary.projectId })}">Clear filters</a>`
      : "";
  return `<form id="task-filters" class="task-filters"><label class="task-search" for="task-filter-search">Search tasks<input id="task-filter-search" name="search" type="search" maxlength="${queryLimits.taskSearchLength}" placeholder="Title, description or task ID" value="${escapeHtml(filters.search ?? "")}" /></label>${select("task-filter-status", "Status", filters.status ?? "", [["", "All statuses"], ...options.statuses.map((status) => [status, taskStatusLabel(status)] as [string, string])])}${select("task-filter-priority", "Priority", filters.priority === undefined ? "" : String(filters.priority), [["", "All priorities"], ...options.priorities.map((priority) => [String(priority), String(priority)] as [string, string])])}${select("task-filter-agent", "Agent", filters.unassigned ? "none" : filters.agentId === undefined ? "" : `agent:${filters.agentId}`, agentOptions)}<div class="filter-actions"><button type="submit">Apply filters</button>${reset}</div></form><p id="task-filter-error" class="filter-error" role="alert"></p><p class="section-intro">Searches all project tasks. Status is operational; agent means a current stage assignment or any active run. Higher priority appears first.</p>`;
}

export function renderTaskPagination(view: ProjectView): string {
  const page = view.taskPage;
  if (page === undefined) return "";
  const first = view.tasks.items.length === 0 ? 0 : page.offset + 1;
  const last = page.offset + view.tasks.items.length;
  const href = (offset: number) =>
    routeHref({
      kind: "project",
      projectId: view.summary.projectId,
      taskQuery: { ...page.filters, ...(offset === 0 ? {} : { offset }) },
    });
  const previous =
    page.offset === 0
      ? ""
      : `<a href="${href(Math.max(0, page.offset - page.limit))}">Previous</a>`;
  const next =
    last < view.tasks.total
      ? `<a href="${href(page.offset + page.limit)}">Next</a>`
      : "";
  const firstPage =
    page.offset > 0 ? `<a href="${href(0)}">First page</a>` : "";
  return `<nav class="task-pagination" aria-label="Task pages"><span role="status">${view.tasks.items.length === 0 ? `0 shown · ${view.tasks.total} matching` : `${first}–${last} of ${view.tasks.total} matching`} · ${view.summary.tasks.total} project tasks</span><div>${firstPage}${previous}${next}</div></nav>`;
}
