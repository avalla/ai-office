/**
 * HTML rendering for the dashboard.
 *
 * Pure string building: every function takes a view model and returns markup.
 * All interpolated values pass through {@link escapeHtml}; nothing here builds
 * markup from unescaped input.
 */

import type {
  ActivityEntry,
  AgentState,
  AttentionReason,
  PipelineRunState,
  ProjectSummary,
  ReviewState,
  TaskOperationalState,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  agentStateLabel,
  agentStateTone,
  concurrencyNote,
  attentionLabel,
  formatTimestamp,
  routeHref,
  runStatusTone,
  shortId,
  stageChips,
  taskStatusLabel,
  taskStatusTone,
  type OverviewView,
  type SampleView,
  type ProjectView,
  type RunView,
  type ToneName,
} from "./view-model.ts";

const escapes: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => escapes[character]!);
}

function tone(value: ToneName): string {
  return ` data-tone="${value}"`;
}

function badge(text: string, value: ToneName): string {
  return `<span class="badge"${tone(value)}>${escapeHtml(text)}</span>`;
}

function empty(headline: string, detail: string): string {
  return `<div class="empty"><p class="empty-headline">${escapeHtml(headline)}</p><p class="empty-detail">${escapeHtml(detail)}</p></div>`;
}

function section(
  title: string,
  body: string,
  note?: string | null,
): string {
  const heading =
    note === undefined || note === null
      ? escapeHtml(title)
      : `${escapeHtml(title)} <span class="section-note">${escapeHtml(note)}</span>`;
  return `<section class="panel"><h2>${heading}</h2>${body}</section>`;
}

/* -------------------------------------------------------------------------- */
/* Shared fragments                                                            */
/* -------------------------------------------------------------------------- */

/** Exact, entity-scoped attention: no total to compare against. */
function attentionReasonList(reasons: readonly AttentionReason[]): string {
  return attentionList({
    items: reasons,
    total: reasons.length,
    note: null,
  });
}

function attentionList(sample: SampleView<AttentionReason>): string {
  if (sample.total === 0)
    return `<p class="calm">Nothing is waiting for a human.</p>`;
  if (sample.items.length === 0)
    return `<p class="calm">${sample.total} items need attention.</p>`;
  const items = sample.items
    .map(
      (reason) =>
        `<li class="attention-item">${badge(attentionLabel(reason.kind), "attention")}<span class="attention-summary">${escapeHtml(reason.summary)}</span><span class="meta">${escapeHtml(reason.subjectType)} ${escapeHtml(shortId(reason.subjectId))} · ${escapeHtml(formatTimestamp(reason.since))}</span></li>`,
    )
    .join("");
  return `<ul class="attention">${items}</ul>`;
}

function activityList(entries: readonly ActivityEntry[]): string {
  if (entries.length === 0)
    return `<p class="calm">No recorded activity yet.</p>`;
  const rows = entries
    .map((entry) => {
      const detail = Object.entries(entry.detail)
        .map(
          ([key, value]) =>
            `<span class="kv">${escapeHtml(key)}=${escapeHtml(String(value))}</span>`,
        )
        .join(" ");
      const truncated = entry.detailTruncated
        ? `<span class="kv muted">detail omitted</span>`
        : "";
      return `<tr><td class="mono">${escapeHtml(formatTimestamp(entry.occurredAt))}</td><td class="mono">${escapeHtml(entry.eventType)}</td><td>${escapeHtml(entry.actorType)}</td><td class="detail">${detail}${truncated}</td></tr>`;
    })
    .join("");
  return `<div class="table-scroll"><table><thead><tr><th>When</th><th>Event</th><th>Actor</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function pipelineTrack(pipeline: PipelineRunState): string {
  const chips = stageChips(pipeline)
    .map((chip) => {
      const agent =
        chip.agentName === null
          ? ""
          : `<span class="stage-agent">${escapeHtml(chip.agentName)}</span>`;
      return `<li class="stage"${tone(chip.tone)}><span class="stage-glyph">${escapeHtml(chip.glyph)}</span><span class="stage-name">${escapeHtml(chip.name)}</span>${agent}</li>`;
    })
    .join("");
  return `<ol class="track">${chips}</ol>`;
}

function reviewRows(reviews: readonly ReviewState[]): string {
  if (reviews.length === 0) return `<p class="calm">No reviews recorded.</p>`;
  const rows = reviews
    .map((review) => {
      const decision =
        review.decision === null
          ? "—"
          : `${review.decision.decision} by ${review.decision.actor.displayName ?? review.decision.actor.id}`;
      return `<tr><td>${badge(review.status, review.status === "pending" ? "attention" : review.status === "approved" ? "good" : "muted")}</td><td class="mono">${escapeHtml(review.subjectType)} ${escapeHtml(shortId(review.subjectId))}</td><td>${escapeHtml(review.reviewer.displayName ?? review.reviewer.id)}</td><td>${escapeHtml(decision)}</td><td class="mono">${escapeHtml(formatTimestamp(review.createdAt))}</td></tr>`;
    })
    .join("");
  return `<div class="table-scroll"><table><thead><tr><th>Status</th><th>Subject</th><th>Reviewer</th><th>Decision</th><th>Created</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function agentRows(agents: readonly AgentState[]): string {
  if (agents.length === 0)
    return `<p class="calm">No agents are synchronized for this project.</p>`;
  const rows = agents
    .map((agent) => {
      // One representative item per column, plus the exact count of what the
      // representative leaves out. An agent may hold several concurrent runs
      // and several concurrent stage assignments; the row must not imply that
      // the one it names is the only one.
      const runs = concurrencyNote(agent.activeRuns);
      const stages = concurrencyNote(agent.activeStages);
      const task =
        agent.primaryRun === null || agent.primaryRun.task === null
          ? "—"
          : `<a href="${routeHref({ kind: "project", projectId: agent.projectId })}">${escapeHtml(agent.primaryRun.task.title)}</a>`;
      const stage =
        agent.primaryStage === null
          ? "—"
          : `${escapeHtml(agent.primaryStage.name)}${stages === null ? "" : ` <span class="more">${escapeHtml(stages)}</span>`}`;
      const run =
        agent.primaryRun === null
          ? "—"
          : `<a class="mono" href="${routeHref({ kind: "run", runId: agent.primaryRun.runId })}">${escapeHtml(shortId(agent.primaryRun.runId))}</a>${runs === null ? "" : ` <span class="more">${escapeHtml(runs)}</span>`}`;
      return `<tr><td>${escapeHtml(agent.name)}</td><td>${escapeHtml(agent.roleName ?? agent.roleKey ?? agent.roleId)}</td><td>${badge(agentStateLabel(agent.state), agentStateTone(agent.state))}</td><td>${task}</td><td>${stage}</td><td>${run}</td></tr>`;
    })
    .join("");
  return `<div class="table-scroll"><table><thead><tr><th>Agent</th><th>Role</th><th>State</th><th>Task</th><th>Stage</th><th>Run</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function taskRows(tasks: readonly TaskOperationalState[]): string {
  if (tasks.length === 0) return `<p class="calm">No tasks yet.</p>`;
  const rows = tasks
    .map((task) => {
      const divergence = task.divergesFromRecordedStatus
        ? `<span class="divergence" title="Stored task status: ${escapeHtml(task.recordedStatus)}">stored: ${escapeHtml(task.recordedStatus)}</span>`
        : "";
      const pipeline =
        task.activePipelineRun === null
          ? "—"
          : `${escapeHtml(task.activePipelineRun.pipelineName)} · ${escapeHtml(task.activePipelineRun.currentStageName ?? "—")}`;
      // One representative run plus the exact count of what it leaves out: a
      // task may hold several active runs after a lease takeover.
      const more = concurrencyNote(task.activeAgentRuns);
      const lease =
        task.primaryAgentRun !== null && !task.primaryAgentRun.holdsLease
          ? ` <span class="more" title="This run does not own the task's execution lease">no lease</span>`
          : "";
      const run =
        task.primaryAgentRun === null
          ? "—"
          : `<a class="mono" href="${routeHref({ kind: "run", runId: task.primaryAgentRun.runId })}">${escapeHtml(shortId(task.primaryAgentRun.runId))}</a>${more === null ? "" : ` <span class="more">${escapeHtml(more)}</span>`}${lease}`;
      const agent =
        task.assignedAgent === null ? "—" : escapeHtml(task.assignedAgent.name);
      const blocker =
        task.attentionReasons.length === 0
          ? ""
          : `<span class="blocker">${escapeHtml(task.attentionReasons[0]!.summary)}</span>`;
      return `<tr><td class="mono">${escapeHtml(shortId(task.taskId))}</td><td>${escapeHtml(task.title)}${blocker}</td><td>${badge(taskStatusLabel(task.operationalStatus), taskStatusTone(task.operationalStatus))}${divergence}</td><td class="mono">${task.priority}</td><td>${agent}</td><td>${pipeline}</td><td>${run}</td></tr>`;
    })
    .join("");
  return `<div class="table-scroll"><table><thead><tr><th>ID</th><th>Task</th><th>Status</th><th>Prio</th><th>Agent</th><th>Pipeline</th><th>Run</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function projectCard(project: ProjectSummary): string {
  const milestone =
    project.currentMilestone === null
      ? project.activeMilestoneCount > 1
        ? `${project.activeMilestoneCount} active milestones`
        : "no active milestone"
      : `${project.currentMilestone.title}`;
  const attention = project.attentionRequired
    ? badge(`needs attention: ${project.attention.total}`, "attention")
    : badge("clear", "good");
  const path = project.repository.localPaths[0];
  return `<article class="project-card">
    <h3><a href="${routeHref({ kind: "project", projectId: project.projectId })}">${escapeHtml(project.name)}</a></h3>
    <p class="meta">${escapeHtml(path ?? "no local worktree recorded")}</p>
    <dl class="facts">
      <div><dt>milestone</dt><dd>${escapeHtml(milestone)}</dd></div>
      <div><dt>tasks</dt><dd>${project.tasks.open} open / ${project.tasks.byStatus.completed} completed</dd></div>
      <div><dt>requirements</dt><dd>${project.requirements.open} open / ${project.requirements.verified} verified</dd></div>
      <div><dt>active runs</dt><dd>${project.activeAgentRuns}</dd></div>
      <div><dt>active pipelines</dt><dd>${project.activePipelineRuns}</dd></div>
      <div><dt>pending reviews</dt><dd>${project.pendingReviews}</dd></div>
      <div><dt>last activity</dt><dd class="mono">${escapeHtml(formatTimestamp(project.lastActivityAt))}</dd></div>
    </dl>
    <p>${attention}</p>
  </article>`;
}

/* -------------------------------------------------------------------------- */
/* Pages                                                                       */
/* -------------------------------------------------------------------------- */

export function renderOverview(view: OverviewView): string {
  if (view.empty !== null)
    return `${renderStats(view)}${section("Projects", empty(view.empty.headline, view.empty.detail))}`;

  const projects = view.projects.map(projectCard).join("");
  const runs =
    view.activeRuns.total === 0
      ? `<p class="calm">No agent runs are in flight.</p>`
      : `<div class="table-scroll"><table><thead><tr><th>Run</th><th>Status</th><th>Task</th><th>Agent</th><th>Updated</th></tr></thead><tbody>${view.activeRuns.items
          .map(
            (run) =>
              `<tr><td><a class="mono" href="${routeHref({ kind: "run", runId: run.runId })}">${escapeHtml(shortId(run.runId))}</a></td><td>${badge(run.status, runStatusTone(run.status))}</td><td>${escapeHtml(run.task?.title ?? run.runId)}</td><td>${escapeHtml(run.agent?.name ?? "—")}</td><td class="mono">${escapeHtml(formatTimestamp(run.updatedAt))}</td></tr>`,
          )
          .join("")}</tbody></table></div>`;

  return [
    renderStats(view),
    section(
      "Needs attention",
      attentionList(view.attention),
      view.attention.note,
    ),
    section("Projects", `<div class="project-grid">${projects}</div>`),
    section("Active runs", runs, view.activeRuns.note),
    section("Recent activity", activityList(view.activity)),
  ].join("");
}

function renderStats(view: OverviewView): string {
  const stat = (label: string, value: number, toneName: ToneName) =>
    `<div class="stat"${tone(toneName)}><span class="stat-value">${value}</span><span class="stat-label">${escapeHtml(label)}</span></div>`;
  return `<div class="stats">
    ${stat("projects", view.totals.projects, "neutral")}
    ${stat("open tasks", view.totals.openTasks, "neutral")}
    ${stat("active runs", view.totals.activeAgentRuns, "active")}
    ${stat("active pipelines", view.totals.activePipelineRuns, "active")}
    ${stat("agents working", view.totals.agentsWorking, "active")}
    ${stat("pending reviews", view.totals.pendingReviews, view.totals.pendingReviews > 0 ? "attention" : "good")}
    ${stat("needs attention", view.totals.attentionItems, view.totals.attentionItems > 0 ? "attention" : "good")}
  </div>`;
}

export function renderProject(view: ProjectView): string {
  const summary = view.summary;
  const paths =
    summary.repository.localPaths.length === 0
      ? "no local worktree recorded"
      : summary.repository.localPaths.join(", ");
  const header = `<div class="project-header">
    <h2>${escapeHtml(summary.name)}</h2>
    <p class="meta mono">${escapeHtml(paths)}</p>
    <p class="meta">${escapeHtml(summary.repository.remoteUrl ?? "no remote recorded")} · branch ${escapeHtml(summary.repository.defaultBranch ?? "unknown")}</p>
  </div>`;

  const milestones =
    summary.currentMilestone === null
      ? `<p class="calm">No single active milestone (${summary.activeMilestoneCount} active of ${summary.milestoneCount}).</p>`
      : `<p><strong>${escapeHtml(summary.currentMilestone.title)}</strong> — ${summary.currentMilestone.requirements.open} open / ${summary.currentMilestone.requirements.verified} verified of ${summary.currentMilestone.requirements.total} requirements</p>`;

  const pipelines =
    view.pipelines.total === 0
      ? `<p class="calm">No pipeline runs recorded.</p>`
      : view.pipelines.items
          .map(
            (pipeline) =>
              `<div class="pipeline"><p class="pipeline-title">${escapeHtml(pipeline.pipelineName)} <span class="meta">${escapeHtml(pipeline.task?.title ?? pipeline.pipelineRunId)}</span> ${badge(pipeline.status, pipeline.status === "active" ? "active" : pipeline.status === "completed" ? "good" : "muted")}</p>${pipelineTrack(pipeline)}</div>`,
          )
          .join("");

  const divergence =
    view.divergentTasks.length === 0
      ? ""
      : section(
          "Stored status differs from operational status",
          `<p class="calm">The task record has not been transitioned, but persisted runs, stages, or reviews say otherwise. The operational status is authoritative.</p>${taskRows(view.divergentTasks)}`,
          `${view.divergentTasks.length}`,
        );

  return [
    header,
    section("Milestone", milestones),
    section(
      "Needs attention",
      attentionList(view.attention),
      view.attention.note,
    ),
    section("Pipelines", pipelines, view.pipelines.note),
    section(
      "Tasks",
      taskRows(view.tasks.items),
      view.tasks.note ?? `${view.tasks.total}`,
    ),
    divergence,
    section("Agents", agentRows(view.agents)),
    section("Reviews", reviewRows(view.reviews.items), view.reviews.note),
    section("Recent activity", activityList(view.activity)),
  ].join("");
}

export function renderRun(view: RunView): string {
  const run = view.run;
  const intent =
    run.actionIntent === null
      ? `<p class="calm">No controlled-action intent recorded.</p>`
      : `<p class="mono">${escapeHtml(run.actionIntent.resourceId)} · ${escapeHtml(run.actionIntent.operation)}<br /><span class="meta">arguments: ${escapeHtml(run.actionIntent.argumentKeys.join(", ") || "none")} (values are not exposed)</span></p>`;

  const failure =
    run.failure === null
      ? `<p class="calm">No failure recorded.</p>`
      : `<p>${badge(run.failure.code ?? "error", "attention")} <span class="mono">${escapeHtml(run.failure.message ?? "no message recorded")}</span></p>`;

  const actions =
    view.actions.length === 0
      ? `<p class="calm">No controlled actions were produced.</p>`
      : `<ul class="plain">${view.actions
          .map(
            (action) =>
              `<li class="mono">${escapeHtml(action.requestId)} — ${escapeHtml(action.status)}</li>`,
          )
          .join("")}</ul>`;

  const events =
    view.events.total === 0
      ? `<p class="calm">No run events recorded.</p>`
      : `<div class="table-scroll"><table><thead><tr><th>When</th><th>Status</th><th>Result</th><th>Error</th></tr></thead><tbody>${view.events.items
          .map(
            (event) =>
              `<tr><td class="mono">${escapeHtml(formatTimestamp(event.occurredAt))}</td><td>${escapeHtml(event.status)}</td><td>${event.hasResult ? "yes" : "no"}</td><td>${event.hasError ? "yes" : "no"}</td></tr>`,
          )
          .join("")}</tbody></table></div>`;

  const facts = `<dl class="facts wide">
    <div><dt>run</dt><dd class="mono">${escapeHtml(run.runId)}</dd></div>
    <div><dt>status</dt><dd>${badge(run.status, runStatusTone(run.status))}</dd></div>
    <div><dt>task</dt><dd>${escapeHtml(run.task?.title ?? run.runId)}</dd></div>
    <div><dt>agent</dt><dd>${escapeHtml(run.agent?.name ?? "—")}</dd></div>
    <div><dt>created</dt><dd class="mono">${escapeHtml(formatTimestamp(run.createdAt))}</dd></div>
    <div><dt>started</dt><dd class="mono">${escapeHtml(formatTimestamp(run.startedAt))}</dd></div>
    <div><dt>completed</dt><dd class="mono">${escapeHtml(formatTimestamp(run.completedAt))}</dd></div>
    <div><dt>duration</dt><dd class="mono">${escapeHtml(view.duration)}</dd></div>
    <div><dt>worktree</dt><dd class="mono">${escapeHtml(run.worktreePath ?? "—")}</dd></div>
  </dl>`;

  const pipeline =
    view.pipeline === null
      ? `<p class="calm">This run is not bound to a pipeline stage.</p>`
      : `<p class="pipeline-title">${escapeHtml(view.pipeline.pipelineName)} ${badge(view.pipeline.status, view.pipeline.status === "active" ? "active" : "muted")}</p>${pipelineTrack(view.pipeline)}`;

  return [
    `<div class="project-header"><h2>Run ${escapeHtml(shortId(run.runId))}</h2><p class="meta"><a href="${routeHref({ kind: "project", projectId: run.projectId })}">back to project</a></p></div>`,
    section("Overview", facts),
    section("Needs attention", attentionReasonList(view.attention)),
    section("Pipeline", pipeline),
    section("Action intent", intent),
    section("Failure", failure),
    section("Controlled actions", actions),
    section("Run events", events, view.events.note),
    section("Reviews", reviewRows(view.reviews)),
    section("Run activity", activityList(view.activity)),
  ].join("");
}

export function renderMessage(headline: string, detail: string): string {
  return `<section class="panel">${empty(headline, detail)}</section>`;
}
