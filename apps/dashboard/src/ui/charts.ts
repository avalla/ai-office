/** Charts render exact read-model aggregates, never counts of sampled rows. */
import type {
  AgentState,
  ProjectSummary,
  TaskCounts,
} from "@ai-office/application/read-models/operational-read-models.ts";
import { escapeHtml } from "./html.ts";
import { agentStateLabel, routeHref, type ToneName } from "./view-model.ts";

function bar(value: number, maximum: number, tone: ToneName): string {
  const width =
    maximum > 0 ? Math.max(0, Math.min(100, (value / maximum) * 100)) : 0;
  // Numeric SVG attributes work under the host's strict CSP, without inline styles.
  return `<svg class="chart-bar" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true" focusable="false" data-tone="${tone}"><rect class="chart-track" width="100" height="8" rx="2"/><rect width="${width}" height="8" rx="2"/></svg>`;
}

const statusSeries: readonly {
  key: keyof TaskCounts["byStatus"];
  label: string;
  tone: ToneName;
}[] = [
  { key: "pending", label: "Pending", tone: "neutral" },
  { key: "assigned", label: "Assigned", tone: "active" },
  { key: "running", label: "Running", tone: "active" },
  { key: "waiting_review", label: "Awaiting review", tone: "attention" },
  { key: "blocked", label: "Blocked", tone: "attention" },
  { key: "completed", label: "Completed", tone: "good" },
  { key: "failed", label: "Failed", tone: "attention" },
  { key: "cancelled", label: "Cancelled", tone: "muted" },
];

export function renderTaskDistribution(counts: TaskCounts): string {
  if (counts.total === 0)
    return `<p class="calm">Create a task to see the status distribution.</p>`;
  const rows = statusSeries
    .filter(({ key }) => counts.byStatus[key] > 0)
    .map(({ key, label, tone }) => {
      const count = counts.byStatus[key];
      return `<li><span>${label}</span><span class="chart-value">${count}</span>${bar(count, counts.total, tone)}</li>`;
    })
    .join("");
  return `<figure class="chart"><figcaption>${counts.total} tasks · recorded status</figcaption><ul class="chart-rows">${rows}</ul><p class="chart-note">All project tasks. Operational status in the table may differ when runs or reviews are active.</p></figure>`;
}

export function renderAgentWorkload(agents: readonly AgentState[]): string {
  if (agents.length === 0)
    return `<p class="calm">Synchronize agents to see their active work.</p>`;
  const working = agents.filter(
    (agent) => agent.activeRuns.total > 0 || agent.activeStages.total > 0,
  );
  if (working.length === 0)
    return `<p class="calm">No active runs or assigned stages. Agent availability is shown in the agent table.</p>`;
  const ordered = [...working].sort(
    (a, b) =>
      b.activeRuns.total - a.activeRuns.total ||
      b.activeStages.total - a.activeStages.total ||
      a.name.localeCompare(b.name),
  );
  const maximum = working.reduce(
    (value, agent) =>
      Math.max(value, agent.activeRuns.total, agent.activeStages.total),
    0,
  );
  const rows = ordered
    .map(
      (agent) =>
        `<li class="workload-agent"><div class="workload-heading"><strong>${escapeHtml(agent.name)}</strong><span class="meta">${escapeHtml(agentStateLabel(agent.state))}</span></div><div class="workload-series"><span>Active runs</span><span class="chart-value">${agent.activeRuns.total}</span>${bar(agent.activeRuns.total, maximum, "active")}</div><div class="workload-series"><span>Assigned stages</span><span class="chart-value">${agent.activeStages.total}</span>${bar(agent.activeStages.total, maximum, "neutral")}</div></li>`,
    )
    .join("");
  const idleNote =
    agents.length === working.length
      ? ""
      : ` ${agents.length - working.length} agents have no active work.`;
  return `<figure class="chart"><figcaption>Active work by agent</figcaption><ul class="workload-list">${rows}</ul><p class="chart-note">Exact run and stage counts, on the same scale. A run may belong to an assigned stage; these counts are not added. Active does not prove a valid execution lease.${idleNote}</p></figure>`;
}

export function renderProjectProgress(
  projects: readonly ProjectSummary[],
): string {
  const rows = projects
    .map(
      (project) =>
        `<li><a href="${routeHref({ kind: "project", projectId: project.projectId })}">${escapeHtml(project.name)}</a><span class="chart-value">${project.tasks.byStatus.completed} / ${project.tasks.total}</span>${bar(project.tasks.byStatus.completed, project.tasks.total, "good")}</li>`,
    )
    .join("");
  return `<figure class="chart"><figcaption>Completed tasks / all tasks</figcaption><ul class="chart-rows">${rows}</ul><p class="chart-note">Recorded completion across every task. Cancelled and failed tasks are included in the total.</p></figure>`;
}
