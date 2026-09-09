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
  AgentRunState,
  AttentionReason,
  PipelineRunState,
  ProjectSummary,
  ReviewState,
  TaskOperationalState,
  TaskPageQuery,
  GlobalMemoryLesson,
  GlobalMemoryPattern,
  GlobalMemoryRole,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  agentStateLabel,
  agentStateTone,
  concurrencyNote,
  attentionLabel,
  formatTimestamp,
  formatDuration,
  routeHref,
  runStatusTone,
  shortId,
  stageChips,
  taskStatusLabel,
  taskDivergenceLabel,
  taskStatusTone,
  type OverviewView,
  type SampleView,
  type ProjectView,
  type RunView,
  type TaskView,
  type MemoryView,
  type ToneName,
} from "./view-model.ts";

import { escapeHtml } from "./html.ts";
import {
  renderAgentWorkload,
  renderProjectProgress,
  renderTaskDistribution,
} from "./charts.ts";
export { escapeHtml } from "./html.ts";
import { renderTaskFilters, renderTaskPagination } from "./task-filters.ts";

function tone(value: ToneName): string {
  return ` data-tone="${value}"`;
}

function badge(text: string, value: ToneName): string {
  return `<span class="badge"${tone(value)}>${escapeHtml(text)}</span>`;
}

function executionBadge(execution: AgentRunState["execution"]): string {
  if (execution == null) return badge("Executor not recorded", "muted");
  if (execution.kind === "simulation") return badge("Simulation", "attention");
  if (execution.kind === "controlled_action")
    return badge("Controlled action", "neutral");
  return badge(`Worker · ${execution.adapterId}`, "active");
}

function taskLink(
  projectId: string,
  taskId: string,
  title: string,
  taskQuery?: TaskPageQuery,
): string {
  return `<a href="${routeHref({ kind: "task", projectId, taskId, ...(taskQuery === undefined ? {} : { taskQuery }) })}">${escapeHtml(title)}</a>`;
}

function empty(headline: string, detail: string): string {
  return `<div class="empty"><p class="empty-headline">${escapeHtml(headline)}</p><p class="empty-detail">${escapeHtml(detail)}</p></div>`;
}

function section(title: string, body: string, note?: string | null): string {
  const heading =
    note === undefined || note === null
      ? escapeHtml(title)
      : `${escapeHtml(title)} <span class="section-note">${escapeHtml(note)}</span>`;
  return `<section class="panel"><h2>${heading}</h2>${body}</section>`;
}

function memoryList(values: readonly string[]): string {
  if (values.length === 0) return `<span class="meta">none recorded</span>`;
  return `<ul class="memory-list">${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function memoryRole(role: GlobalMemoryRole): string {
  return `<article class="memory-entry"><header><div><h3>${escapeHtml(role.name)}</h3><p class="meta mono">${escapeHtml(role.key)} · ${escapeHtml(role.id)} · v${role.version}</p></div>${badge(role.status, role.status === "active" ? "good" : "muted")}</header><p>${escapeHtml(role.description || "No description recorded.")}</p><dl class="facts wide"><div><dt>model policy</dt><dd>${escapeHtml(role.modelPolicy)}</dd></div><div><dt>limits</dt><dd class="mono">${role.limits.maxIterations} iterations · ${role.limits.timeoutSeconds}s · ${escapeHtml(role.limits.maxCostMicros)} μcost</dd></div></dl><div class="memory-columns"><div><h4>Responsibilities</h4>${memoryList(role.responsibilities)}</div><div><h4>Capabilities</h4>${memoryList(role.capabilities)}</div><div><h4>Tools</h4>${memoryList(role.tools)}</div></div><p class="meta mono">updated ${escapeHtml(formatTimestamp(role.updatedAt))}</p></article>`;
}

function memoryPattern(pattern: GlobalMemoryPattern): string {
  return `<article class="memory-entry"><header><div><h3>${escapeHtml(pattern.name)}</h3><p class="meta mono">${escapeHtml(pattern.id)} · v${pattern.version}</p></div>${badge(pattern.status, pattern.status === "active" ? "good" : "muted")}</header><dl class="memory-copy"><div><dt>Problem</dt><dd>${escapeHtml(pattern.problem)}</dd></div><div><dt>Context</dt><dd>${escapeHtml(pattern.context)}</dd></div><div><dt>Solution</dt><dd>${escapeHtml(pattern.solution)}</dd></div></dl><div class="memory-columns"><div><h4>Applicable when</h4>${memoryList(pattern.applicability)}</div><div><h4>Constraints</h4>${memoryList(pattern.constraints)}</div><div><h4>Risks</h4>${memoryList(pattern.risks)}</div></div><p class="meta">${pattern.successCount} successes · ${pattern.failureCount} failures · source project ${escapeHtml(pattern.sourceProjectId ?? "not recorded")}</p></article>`;
}

function memoryLesson(lesson: GlobalMemoryLesson): string {
  return `<article class="memory-entry"><header><div><h3>${escapeHtml(lesson.title)}</h3><p class="meta mono">${escapeHtml(lesson.id)}</p></div>${badge(lesson.status, lesson.status === "active" ? "good" : "muted")}</header><p class="memory-content">${escapeHtml(lesson.content)}</p><p class="meta">confidence ${Math.round(lesson.confidence * 100)}% · source project ${escapeHtml(lesson.sourceProjectId ?? "not recorded")}${lesson.sourceTaskId === null ? "" : ` · task ${escapeHtml(lesson.sourceTaskId)}`}</p></article>`;
}

export function renderMemory(view: MemoryView): string {
  const total = view.memory.roles.length + view.memory.patterns.length + view.memory.lessons.length;
  return [
    `<header class="project-header"><h2>Memory</h2><p class="meta">Global reusable memory, read from the authoritative Runtime store. ${total} saved records.</p></header>`,
    section("How clients use it", `<p class="section-intro">Codex and Claude Code do not open this database directly. Their repository-local AI Office skill tells them to use the Runtime-backed <span class="mono">memory:search</span> command when reusable roles, patterns or lessons are relevant. This page shows the records available through that same authority.</p><p class="meta mono">storage: ${escapeHtml(view.memory.storage)} · snapshot: ${escapeHtml(view.generatedAt)}</p>`),
    section("Roles", view.memory.roles.length === 0 ? empty("No roles saved", "Create one with memory:role:create.") : view.memory.roles.map(memoryRole).join(""), `${view.memory.roles.length}`),
    section("Patterns", view.memory.patterns.length === 0 ? empty("No patterns saved", "Create one with memory:pattern:create.") : view.memory.patterns.map(memoryPattern).join(""), `${view.memory.patterns.length}`),
    section("Lessons", view.memory.lessons.length === 0 ? empty("No lessons saved", "Create one with memory:lesson:create.") : view.memory.lessons.map(memoryLesson).join(""), `${view.memory.lessons.length}`),
  ].join("");
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
  if (sample.total === 0) return `<p class="calm">No items need attention.</p>`;
  if (sample.items.length === 0)
    return `<p class="calm">${sample.total} items need attention.</p>`;
  const items = sample.items
    .map(
      (reason) =>
        `<li class="attention-item">${badge(attentionLabel(reason.kind), "attention")}<span class="attention-summary">${reason.subjectType === "task" ? taskLink(reason.projectId, reason.subjectId, reason.summary) : reason.subjectType === "agent_run" ? `<a href="${routeHref({ kind: "run", runId: reason.subjectId })}">${escapeHtml(reason.summary)}</a>` : escapeHtml(reason.summary)}</span><span class="meta">${escapeHtml(reason.subjectType)} ${escapeHtml(shortId(reason.subjectId))} · ${escapeHtml(formatTimestamp(reason.since))}</span></li>`,
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
          : taskLink(
              agent.projectId,
              agent.primaryRun.task.taskId,
              agent.primaryRun.task.title,
            );
      const stage =
        agent.primaryStage === null
          ? "—"
          : `${escapeHtml(agent.primaryStage.name)}${stages === null ? "" : ` <span class="more">${escapeHtml(stages)}</span>`}`;
      const run =
        agent.primaryRun === null
          ? "—"
          : `<a class="mono" href="${routeHref({ kind: "run", runId: agent.primaryRun.runId })}">${escapeHtml(shortId(agent.primaryRun.runId))}</a>${runs === null ? "" : ` <span class="more">${escapeHtml(runs)}</span>`} ${executionBadge(agent.primaryRun.execution)}`;
      return `<tr><td>${escapeHtml(agent.name)}</td><td>${escapeHtml(agent.roleName ?? agent.roleKey ?? agent.roleId)}</td><td>${badge(agentStateLabel(agent.state), agentStateTone(agent.state))}</td><td>${task}</td><td>${stage}</td><td>${run}</td></tr>`;
    })
    .join("");
  return `<div class="table-scroll"><table><thead><tr><th>Agent</th><th>Role</th><th>State</th><th>Task</th><th>Stage</th><th>Run</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function taskRows(
  tasks: readonly TaskOperationalState[],
  taskQuery?: TaskPageQuery,
): string {
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
      // Owning the lease row is not the same as holding it: an expired lease
      // grants no exclusivity, so the chip reads from `hasValidLease`.
      const lease =
        task.primaryAgentRun === null || task.primaryAgentRun.hasValidLease
          ? ""
          : task.primaryAgentRun.ownsLeaseRecord
            ? ` <span class="more" title="This run owns the task's lease row, but the lease has expired">lease expired</span>`
            : ` <span class="more" title="This run does not hold the task's execution lease">no lease</span>`;
      const run =
        task.primaryAgentRun === null
          ? "—"
          : `<a class="mono" href="${routeHref({ kind: "run", runId: task.primaryAgentRun.runId })}">${escapeHtml(shortId(task.primaryAgentRun.runId))}</a>${more === null ? "" : ` <span class="more">${escapeHtml(more)}</span>`}${lease} ${executionBadge(task.primaryAgentRun.execution)}`;
      const agent =
        task.assignedAgent === null
          ? "No current agent"
          : escapeHtml(task.assignedAgent.name);
      const blocker =
        task.attentionReasons.length === 0
          ? ""
          : `<span class="blocker">${escapeHtml(task.attentionReasons[0]!.summary)}</span>`;
      const requirements =
        task.requirements.availability === "available"
          ? `${task.requirements.value.verified}/${task.requirements.value.total} verified`
          : "Unavailable";
      return `<tr><td class="mono">${escapeHtml(shortId(task.taskId))}</td><td class="task-title">${taskLink(task.projectId, task.taskId, task.title, taskQuery)}${blocker}</td><td>${badge(taskStatusLabel(task.operationalStatus), taskStatusTone(task.operationalStatus))}${divergence}</td><td>${requirements}</td><td class="mono">${task.priority}</td><td>${agent}</td><td>${pipeline}</td><td>${run}</td></tr>`;
    })
    .join("");
  return `<div class="table-scroll"><table><thead><tr><th>ID</th><th>Task</th><th>Status</th><th>Requirements</th><th>Prio</th><th>Current agent</th><th>Pipeline</th><th>Run</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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
              `<tr><td><a class="mono" href="${routeHref({ kind: "run", runId: run.runId })}">${escapeHtml(shortId(run.runId))}</a></td><td>${badge(run.status, runStatusTone(run.status))} ${executionBadge(run.execution)}</td><td>${escapeHtml(run.task?.title ?? run.runId)}</td><td>${escapeHtml(run.agent?.name ?? "—")}</td><td class="mono">${escapeHtml(formatTimestamp(run.updatedAt))}</td></tr>`,
          )
          .join("")}</tbody></table></div>`;

  return [
    renderStats(view),
    section(
      "Reusable memory",
      `<p class="section-intro">Inspect the global roles, patterns and lessons available through the Runtime.</p><p><a class="button-link" href="${routeHref({ kind: "memory" })}">Open memory <span aria-hidden="true">→</span></a></p>`,
    ),
    section(
      "Needs attention",
      attentionList(view.attention),
      view.attention.note,
    ),
    section("Projects", `<div class="project-grid">${projects}</div>`),
    section("Project progress", renderProjectProgress(view.projects)),
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
    ${stat("agents with active runs", view.totals.agentsWorking, "active")}
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

  return [
    header,
    `<nav class="section-nav" aria-label="Project sections"><button type="button" id="jump-tasks">Tasks</button><button type="button" id="jump-agents">Agents</button>${view.pipelines.total === 0 ? "" : `<button type="button" id="jump-pipelines">Pipelines</button>`}</nav>`,
    `<div class="insights">${section("Task distribution", renderTaskDistribution(summary.tasks))}${section("Agent workload", renderAgentWorkload(view.agents))}</div>`,
    summary.milestoneCount === 0 ? "" : section("Milestone", milestones),
    view.attention.total === 0
      ? ""
      : section(
          "Needs attention",
          attentionList(view.attention),
          view.attention.note,
        ),
    `<div id="project-tasks">${section(
      "Tasks",
      `${renderTaskFilters(view)}${view.tasks.items.length === 0 && view.taskPage !== undefined ? `<p class="calm">${view.tasks.total === 0 ? "No tasks match these filters." : "No tasks on this page. Return to the first page."}</p>` : taskRows(view.tasks.items, view.taskPage === undefined ? undefined : { ...view.taskPage.filters, offset: view.taskPage.offset })}${renderTaskPagination(view)}`,
      view.taskPage === undefined
        ? (view.tasks.note ?? `${view.tasks.total}`)
        : `${view.tasks.total} matching`,
    )}</div>`,
    view.pipelines.total === 0
      ? ""
      : `<div id="project-pipelines">${section("Pipelines", pipelines, view.pipelines.note)}</div>`,
    `<div id="project-agents">${section("Agents", agentRows(view.agents))}</div>`,
    view.reviews.total === 0
      ? ""
      : section("Reviews", reviewRows(view.reviews.items), view.reviews.note),
    view.activity.length === 0
      ? ""
      : section("Recent activity", activityList(view.activity)),
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
    <div><dt>executor</dt><dd>${executionBadge(run.execution)}${run.execution == null ? "" : ` <span class="mono">${escapeHtml(run.execution.adapterVersion)}</span>`}</dd></div>
    ${run.execution?.inputHash === undefined ? "" : `<div><dt>input SHA-256</dt><dd class="mono">${escapeHtml(run.execution.inputHash)}</dd></div>`}
    <div><dt>task</dt><dd>${run.task === null ? "Task unavailable" : taskLink(run.projectId, run.task.taskId, run.task.title)}</dd></div>
    <div><dt>agent</dt><dd>${escapeHtml(run.agent?.name ?? "—")}</dd></div>
    <div><dt>created</dt><dd class="mono">${escapeHtml(formatTimestamp(run.createdAt))}</dd></div>
    <div><dt>started</dt><dd class="mono">${escapeHtml(formatTimestamp(run.startedAt))}</dd></div>
    <div><dt>completed</dt><dd class="mono">${escapeHtml(formatTimestamp(run.completedAt))}</dd></div>
    <div><dt>duration</dt><dd class="mono">${escapeHtml(view.duration)}</dd></div>
    ${run.worktreePath === null ? "" : `<div><dt>worktree</dt><dd class="mono">${escapeHtml(run.worktreePath)}</dd></div>`}
  </dl>`;

  const pipeline =
    view.pipeline === null
      ? `<p class="calm">This run is not bound to a pipeline stage.</p>`
      : `<p class="pipeline-title">${escapeHtml(view.pipeline.pipelineName)} ${badge(view.pipeline.status, view.pipeline.status === "active" ? "active" : "muted")}</p>${pipelineTrack(view.pipeline)}`;

  return [
    `<div class="project-header"><h2>Run ${escapeHtml(shortId(run.runId))}</h2><p class="meta"><a href="${routeHref({ kind: "project", projectId: run.projectId })}">back to project</a></p></div>`,
    view.workerOutput == null
      ? ""
      : section(
          "Worker output",
          `<p class="section-intro">Generated content. This result does not establish file changes, test success or human approval.</p><p><strong>${escapeHtml(view.workerOutput.summary)}</strong></p><pre class="task-description">${escapeHtml(view.workerOutput.content)}</pre><dl class="facts wide"><div><dt>model</dt><dd>${escapeHtml(view.workerOutput.model ?? "Not reported")}</dd></div><div><dt>session</dt><dd class="mono">${escapeHtml(view.workerOutput.sessionId ?? "Not reported")}</dd></div><div><dt>reported tokens (uncached input / output)</dt><dd>${view.workerOutput.usage === null ? "Not reported" : `${view.workerOutput.usage.inputTokens} / ${view.workerOutput.usage.outputTokens}`}</dd></div><div><dt>CLI cost estimate (USD)</dt><dd>${view.workerOutput.estimatedCostUsd === null ? "Not reported" : escapeHtml(new Intl.NumberFormat("en", { maximumSignificantDigits: 6 }).format(view.workerOutput.estimatedCostUsd))}</dd></div></dl><p class="calm">External worker usage is separate from gateway billing. Actual billed cost is unknown.</p>`,
        ),
    section("Overview", facts),
    view.attention.length === 0
      ? ""
      : section("Needs attention", attentionReasonList(view.attention)),
    view.pipeline === null ? "" : section("Pipeline", pipeline),
    run.actionIntent === null ? "" : section("Action intent", intent),
    run.failure === null ? "" : section("Failure", failure),
    view.actions.length === 0 ? "" : section("Controlled actions", actions),
    section("Run events", events, view.events.note),
    view.reviews.length === 0
      ? ""
      : section("Reviews", reviewRows(view.reviews)),
    view.activity.length === 0
      ? ""
      : section("Run activity", activityList(view.activity)),
  ].join("");
}

export function renderMessage(headline: string, detail: string): string {
  return `<section class="panel">${empty(headline, detail)}</section>`;
}

export function renderTask(view: TaskView): string {
  const { task, pipeline, projectName } = view.detail;
  const fact = (label: string, value: string) =>
    `<div><dt>${escapeHtml(label)}</dt><dd>${value}</dd></div>`;
  const currentStage = pipeline?.currentStage ?? null;
  const assignment =
    currentStage === null
      ? `<p class="calm">No active pipeline stage. Run agents are listed below; this task has no permanent assignee.</p>`
      : `<dl class="facts wide">${fact("Current stage", escapeHtml(currentStage.name))}${fact("Assigned agent", currentStage.assignedAgent === null ? "Not assigned" : escapeHtml(currentStage.assignedAgent.name))}${fact("Role", escapeHtml(currentStage.assignedAgent?.roleKey ?? currentStage.roleId))}${fact("Stage status", escapeHtml(currentStage.status.replaceAll("_", " ")))}</dl>`;
  const activeRuns = view.activeRuns.items
    .map(
      (run) =>
        `<tr><td><a class="mono" href="${routeHref({ kind: "run", runId: run.runId })}">${escapeHtml(shortId(run.runId))}</a></td><td>${escapeHtml(run.agent?.name ?? "Agent unavailable")}</td><td>${badge(run.status, runStatusTone(run.status))} ${executionBadge(run.execution)}</td><td>${badge(run.hasValidLease ? "Valid lease" : run.ownsLeaseRecord ? "Lease expired" : "No valid lease", run.hasValidLease ? "good" : "attention")}</td></tr>`,
    )
    .join("");
  const active =
    view.activeRuns.total === 0
      ? `<p class="calm">No active runs for this task.</p>`
      : `<div class="table-scroll"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Execution lease</th></tr></thead><tbody>${activeRuns}</tbody></table></div>`;
  const history =
    view.runs.total === 0
      ? `<p class="calm">No runs recorded for this task yet.</p>`
      : `<div class="table-scroll"><table><thead><tr><th>Run</th><th>Agent</th><th>Status</th><th>Started</th><th>Duration</th><th>Updated</th></tr></thead><tbody>${view.runs.items.map((run) => `<tr><td><a class="mono" href="${routeHref({ kind: "run", runId: run.runId })}">${escapeHtml(shortId(run.runId))}</a></td><td>${escapeHtml(run.agent?.name ?? "Agent unavailable")}</td><td>${badge(run.status, runStatusTone(run.status))} ${executionBadge(run.execution)}</td><td class="mono">${escapeHtml(formatTimestamp(run.startedAt))}</td><td>${escapeHtml(formatDuration(run.durationMs))}</td><td class="mono">${escapeHtml(formatTimestamp(run.updatedAt))}</td></tr>`).join("")}</tbody></table></div>`;
  const requirements =
    task.requirements.availability === "available"
      ? task.requirements.value.total === 0
        ? `<p class="calm">No requirements linked to this task.</p>`
        : `<p><strong>${task.requirements.value.verified}/${task.requirements.value.total} verified</strong> · ${task.requirements.value.open} open · ${task.requirements.value.rejected} rejected</p><p class="calm">Requirement verification and task completion are separate decisions.</p>`
      : `<p class="calm">${escapeHtml(task.requirements.explanation)}</p>`;
  const divergence = task.divergesFromRecordedStatus
    ? `<p class="status-explanation">Stored: ${escapeHtml(task.recordedStatus)}. Operational: ${escapeHtml(taskStatusLabel(task.operationalStatus))}.</p><ul class="plain">${task.divergenceReasons.map((reason) => `<li>${escapeHtml(taskDivergenceLabel(reason))}</li>`).join("")}</ul>`
    : `<p class="calm">Recorded and operational status agree.</p>`;
  return [
    `<header class="task-header"><nav class="breadcrumbs" aria-label="Breadcrumb"><a href="#/">Office</a><span aria-hidden="true">/</span><a href="${routeHref({ kind: "project", projectId: task.projectId, ...(view.taskQuery === undefined ? {} : { taskQuery: view.taskQuery }) })}">${escapeHtml(projectName)}</a><span aria-hidden="true">/</span><span>Task</span></nav><h1>${escapeHtml(task.title)}</h1><p class="task-heading-meta">${badge(taskStatusLabel(task.operationalStatus), taskStatusTone(task.operationalStatus))}<span>Priority ${task.priority}</span><span class="mono">${escapeHtml(task.taskId)}</span></p></header>`,
    `<div class="task-detail-layout"><div class="task-column">`,
    section(
      "Description",
      task.description === null || task.description.trim() === ""
        ? `<p class="calm">No description recorded.</p>`
        : `<p class="task-description">${escapeHtml(task.description)}</p>`,
    ),
    section("Assignment", assignment),
    view.activeRuns.total === 0
      ? ""
      : section(
          "Active runs",
          active,
          view.activeRuns.note ?? `${view.activeRuns.total}`,
        ),
    pipeline === null
      ? ""
      : section(
          "Pipeline",
          `<p class="pipeline-title">${escapeHtml(pipeline.pipelineName)}</p>${pipelineTrack(pipeline)}`,
        ),
    section("Run history", history, view.runs.note ?? `${view.runs.total}`),
    section(
      "Task activity",
      `<p class="section-intro">Audit for this task and its pipeline and agent runs. Execution events are available from each run in Run history.</p>${view.detail.activity.items.length === 0 ? `<p class="calm">No audit events recorded for this task or its runs. Task creation alone does not currently produce an audit event.</p>` : activityList(view.detail.activity.items)}`,
      view.detail.activity.nextCursor === null
        ? null
        : "Recent audit events; older events are not shown",
    ),
    `</div><aside class="task-column" aria-label="Task status and requirements">`,
    section(
      "Status and dates",
      `${divergence}<dl class="facts wide">${fact("Created", escapeHtml(formatTimestamp(task.createdAt)))}${fact("Updated", escapeHtml(formatTimestamp(task.updatedAt)))}${fact("Last activity", escapeHtml(formatTimestamp(task.lastActivityAt)))}${fact("Pending reviews", String(task.pendingReviewCount))}</dl>`,
    ),
    section("Requirements", requirements),
    task.attentionReasons.length === 0
      ? ""
      : section("Needs attention", attentionReasonList(task.attentionReasons)),
    `</aside></div>`,
  ].join("");
}
