import type {
  ActivityEntry,
  AgentRunState,
  AgentState,
  AttentionReason,
  BoundedList,
  PipelineRunState,
  ProjectSummary,
  ReviewState,
  TaskOperationalState,
} from "@ai-office/application/read-models/operational-read-models.ts";
import {
  AlertTriangle,
  Check,
  Circle,
  LoaderCircle,
  Pause,
  X,
} from "lucide-react";
import { Link } from "react-router-dom";
import { Badge, Card, Table, cn } from "./ui/primitives.tsx";
import {
  agentStateLabel,
  agentStateTone,
  attentionLabel,
  runStatusTone,
  taskDivergenceLabel,
  taskStatusLabel,
  taskStatusTone,
  type ToneName,
} from "../ui/view-model.ts";
import {
  elapsed,
  formatDuration,
  formatTimestamp,
  shortId,
} from "../lib/formatting.ts";

const toneStyles: Record<ToneName, string> = {
  neutral: "border-border bg-muted text-foreground",
  active:
    "border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-200",
  attention:
    "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200",
  good: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  muted: "border-border bg-muted text-subtle",
};
export function StatusBadge({
  label,
  tone = "neutral",
  symbol,
}: {
  label: string;
  tone?: ToneName;
  symbol?: string;
}) {
  return (
    <Badge className={toneStyles[tone]}>
      <span aria-hidden="true">
        {symbol ??
          (tone === "good"
            ? "✓"
            : tone === "attention"
              ? "!"
              : tone === "active"
                ? "●"
                : "○")}
      </span>
      {label.replaceAll("_", " ")}
    </Badge>
  );
}
export function AgentStateBadge({ state }: { state: AgentState["state"] }) {
  return (
    <StatusBadge
      label={agentStateLabel(state)}
      tone={agentStateTone(state)}
      {...(state === "assigned" ? { symbol: "◐" } : {})}
    />
  );
}
export function RunStateBadge({ status }: { status: AgentRunState["status"] }) {
  return <StatusBadge label={status} tone={runStatusTone(status)} />;
}
export function PipelineStateBadge({
  status,
}: {
  status: PipelineRunState["status"];
}) {
  return (
    <StatusBadge
      label={status}
      tone={
        status === "completed"
          ? "good"
          : status === "active"
            ? "active"
            : "muted"
      }
    />
  );
}
export function Id({ value }: { value: string }) {
  return (
    <code className="max-w-[12rem] truncate font-mono text-xs" title={value}>
      {shortId(value)}
    </code>
  );
}
export function DataNote<T>({
  list,
  noun,
}: {
  list: BoundedList<T>;
  noun: string;
}) {
  return list.truncated ? (
    <p className="text-sm text-subtle">
      Showing {list.items.length} of {list.total} {noun}. The total is
      authoritative.
    </p>
  ) : null;
}
export function Section({
  title,
  detail,
  children,
  className,
}: {
  title: string;
  detail?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("space-y-4", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {detail && <span className="text-sm text-subtle">{detail}</span>}
      </div>
      {children}
    </section>
  );
}
export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface px-5 py-8 text-sm text-subtle">
      {children}
    </div>
  );
}
export function FactGrid({
  facts,
}: {
  facts: readonly { label: string; value: React.ReactNode }[];
}) {
  return (
    <dl className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {facts.map(({ label, value }) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-subtle">
            {label}
          </dt>
          <dd className="mt-1 min-w-0 break-words text-sm font-medium">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
export function AttentionList({
  items,
}: {
  items: readonly AttentionReason[];
}) {
  return items.length ? (
    <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
      {items.map((item) => (
        <li key={`${item.kind}:${item.subjectId}`} className="flex gap-3 p-4">
          <AlertTriangle
            size={18}
            className="mt-0.5 shrink-0 text-amber-600"
            aria-hidden="true"
          />
          <div className="min-w-0">
            <div className="font-medium">{attentionLabel(item.kind)}</div>
            <p className="text-sm text-subtle">{item.summary}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-subtle">
              <span>{formatTimestamp(item.since)}</span>
              {item.subjectType === "task" ? (
                <Link
                  to={`/projects/${encodeURIComponent(item.projectId)}/tasks/${encodeURIComponent(item.subjectId)}`}
                >
                  Open task
                </Link>
              ) : item.subjectType === "agent_run" ? (
                <Link to={`/runs/${encodeURIComponent(item.subjectId)}`}>
                  Open run
                </Link>
              ) : null}
            </div>
          </div>
        </li>
      ))}
    </ul>
  ) : (
    <Empty>No attention items recorded.</Empty>
  );
}
export function ActivityList({
  entries,
  nextCursor,
}: {
  entries: readonly ActivityEntry[];
  nextCursor?: string | null;
}) {
  return entries.length ? (
    <>
      <ol className="relative space-y-0 border-l border-border pl-5">
        {entries.map((entry) => (
          <li key={entry.eventId} className="relative pb-5">
            <span className="absolute -left-[1.57rem] top-1 h-2 w-2 rounded-full bg-primary" />
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              <strong className="text-sm">{entry.eventType}</strong>
              <time className="text-xs text-subtle">
                {formatTimestamp(entry.occurredAt)}
              </time>
            </div>
            <p className="text-sm text-subtle">
              {entry.actorType}
              {entry.actorId ? ` · ${entry.actorId}` : ""}
            </p>
            {Object.keys(entry.detail).length > 0 && (
              <p className="mt-1 break-words text-xs text-subtle">
                {Object.entries(entry.detail)
                  .map(([key, value]) => `${key}: ${value}`)
                  .join(" · ")}
              </p>
            )}
            {entry.detailTruncated && (
              <p className="text-xs text-subtle">Some detail omitted</p>
            )}
          </li>
        ))}
      </ol>
      {nextCursor && (
        <p className="text-xs text-subtle">
          Recent events shown; older activity is available from the query API.
        </p>
      )}
    </>
  ) : (
    <Empty>No activity recorded in this view.</Empty>
  );
}

export function PipelineTimeline({
  pipeline,
  runs = [],
}: {
  pipeline: PipelineRunState;
  runs?: readonly AgentRunState[];
}) {
  const associatedRuns = runs.filter(
    (run) => run.pipelineRunId === pipeline.pipelineRunId,
  );
  return (
    <ol className="space-y-0 border-l-2 border-border pl-6">
      {pipeline.stages.map((stage) => {
        const current = pipeline.currentStage?.stageRunId === stage.stageRunId;
        const Icon =
          stage.status === "completed"
            ? Check
            : stage.status === "active"
              ? LoaderCircle
              : stage.status === "awaiting_approval"
                ? Pause
                : stage.status === "cancelled"
                  ? X
                  : Circle;
        return (
          <li
            key={stage.stageRunId}
            className={cn("relative pb-6", current && "font-medium")}
          >
            <span
              className={cn(
                "absolute -left-[2.06rem] top-0 rounded-full border bg-surface p-1",
                current
                  ? "border-primary text-primary"
                  : "border-border text-subtle",
              )}
            >
              <Icon size={16} aria-hidden="true" />
            </span>
            <div
              className={cn(
                "rounded-lg p-3",
                current &&
                  "border border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950",
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <strong>{stage.name}</strong>
                {current && (
                  <span className="text-xs font-semibold uppercase text-blue-700 dark:text-blue-300">
                    Current stage
                  </span>
                )}
                <StatusBadge
                  label={stage.status}
                  tone={
                    stage.status === "completed"
                      ? "good"
                      : stage.status === "active"
                        ? "active"
                        : stage.status === "awaiting_approval"
                          ? "attention"
                          : "neutral"
                  }
                />
              </div>
              <p className="mt-1 text-sm text-subtle">{stage.objective}</p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
                <span>
                  Assigned:{" "}
                  <strong>{stage.assignedAgent?.name ?? "No agent"}</strong>
                </span>
                {stage.assignedAt && (
                  <span>Assigned {formatTimestamp(stage.assignedAt)}</span>
                )}
                {stage.completedAt && (
                  <span>Completed {formatTimestamp(stage.completedAt)}</span>
                )}
                {stage.requiresApproval && (
                  <span>
                    Approval:{" "}
                    {stage.approvalDecision ??
                      (stage.status === "awaiting_approval"
                        ? "waiting"
                        : "required")}
                  </span>
                )}
              </div>
              {current && (
                <p className="mt-2 text-sm">
                  Pipeline active runs:{" "}
                  {associatedRuns.length
                    ? associatedRuns.map((run) => (
                        <Link
                          className="mr-2 inline-block"
                          key={run.runId}
                          to={`/runs/${encodeURIComponent(run.runId)}`}
                        >
                          {run.agent?.name ?? "Agent unavailable"} ·{" "}
                          <Id value={run.runId} />
                        </Link>
                      ))
                    : "none in displayed sample"}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function PipelinePanel({
  pipeline,
  runs = [],
  compact = false,
}: {
  pipeline: PipelineRunState;
  runs?: readonly AgentRunState[];
  compact?: boolean;
}) {
  const current = pipeline.currentStage;
  const matchingRuns = runs.filter(
    (run) => run.pipelineRunId === pipeline.pipelineRunId,
  );
  const workingNames = [
    ...new Set(
      matchingRuns.map((run) => run.agent?.name ?? "Agent unavailable"),
    ),
  ];
  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-subtle">
            Pipeline
          </p>
          <h3 className="mt-1 text-lg font-semibold">
            <Link
              to={`/projects/${encodeURIComponent(pipeline.projectId)}/pipeline`}
            >
              {pipeline.pipelineName}
            </Link>
          </h3>
          <p className="text-sm text-subtle">
            {pipeline.task ? (
              <Link
                to={`/projects/${encodeURIComponent(pipeline.projectId)}/tasks/${encodeURIComponent(pipeline.task.taskId)}`}
              >
                {pipeline.task.title}
              </Link>
            ) : (
              "No task linked"
            )}{" "}
            · <Id value={pipeline.pipelineRunId} />
          </p>
        </div>
        <PipelineStateBadge status={pipeline.status} />
      </div>
      <FactGrid
        facts={[
          { label: "Current stage", value: current?.name ?? "—" },
          {
            label: "Assigned",
            value: current?.assignedAgent?.name ?? "No agent",
          },
          {
            label: "Working on pipeline",
            value: workingNames.length
              ? workingNames.join(", ")
              : "No active run in sample",
          },
          {
            label: "Stages",
            value: `${pipeline.stageCounts.completed} / ${pipeline.stageCounts.total} completed`,
          },
          { label: "Started", value: formatTimestamp(pipeline.createdAt) },
          {
            label: "Elapsed",
            value: elapsed(
              pipeline.createdAt,
              pipeline.completedAt ?? pipeline.cancelledAt,
            ),
          },
        ]}
      />
      {pipeline.attentionReasons.length > 0 && (
        <AttentionList items={pipeline.attentionReasons} />
      )}
      {!compact && <PipelineTimeline pipeline={pipeline} runs={runs} />}
    </Card>
  );
}

export function RunTable({
  runs,
  projectNames,
}: {
  runs: readonly AgentRunState[];
  projectNames?: ReadonlyMap<string, string>;
}) {
  return runs.length ? (
    <Table>
      <thead>
        <tr>
          {[
            "Run",
            "Project / task",
            "Agent",
            "Pipeline",
            "State",
            "Started / elapsed",
          ].map((x) => (
            <th key={x}>{x}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {runs.map((run) => (
          <tr key={run.runId}>
            <td>
              <Link to={`/runs/${encodeURIComponent(run.runId)}`}>
                <Id value={run.runId} />
              </Link>
            </td>
            <td>
              <Link to={`/projects/${encodeURIComponent(run.projectId)}`}>
                {projectNames?.get(run.projectId) ?? "Project"}
              </Link>
              <div className="text-xs text-subtle">
                {run.task ? (
                  <Link
                    to={`/projects/${encodeURIComponent(run.projectId)}/tasks/${encodeURIComponent(run.task.taskId)}`}
                  >
                    {run.task.title}
                  </Link>
                ) : (
                  "No task linked"
                )}
              </div>
            </td>
            <td>{run.agent?.name ?? "Agent unavailable"}</td>
            <td>
              {run.pipelineRunId ? (
                <Link
                  to={`/projects/${encodeURIComponent(run.projectId)}/pipeline`}
                >
                  <Id value={run.pipelineRunId} />
                </Link>
              ) : (
                "—"
              )}
            </td>
            <td>
              <RunStateBadge status={run.status} />
            </td>
            <td>
              {formatTimestamp(run.startedAt)}
              <div className="text-xs text-subtle">
                {run.terminal
                  ? formatDuration(run.durationMs)
                  : elapsed(run.startedAt)}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  ) : (
    <Empty>No runs in this view.</Empty>
  );
}

export function AgentTable({
  agents,
  projectNames,
}: {
  agents: readonly AgentState[];
  projectNames?: ReadonlyMap<string, string>;
}) {
  return agents.length ? (
    <Table>
      <thead>
        <tr>
          {[
            "Agent",
            "Role",
            "State",
            "Project",
            "Current work",
            "Active runs",
            "Assigned stages",
          ].map((x) => (
            <th key={x}>{x}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {agents.map((agent) => (
          <tr key={`${agent.projectId}:${agent.agentId}`}>
            <td className="font-medium">{agent.name}</td>
            <td>{agent.roleName ?? agent.roleKey ?? agent.roleId}</td>
            <td>
              <AgentStateBadge state={agent.state} />
            </td>
            <td>
              <Link to={`/projects/${encodeURIComponent(agent.projectId)}`}>
                {projectNames?.get(agent.projectId) ?? "Project"}
              </Link>
            </td>
            <td>
              {agent.activeRuns.items.map((run) => (
                <div key={run.runId} className="mb-1">
                  <Link to={`/runs/${encodeURIComponent(run.runId)}`}>
                    {run.task?.title ?? <Id value={run.runId} />}
                  </Link>
                </div>
              ))}
              {agent.activeRuns.total === 0 &&
                agent.activeStages.items.map((stage) => (
                  <div key={`${stage.pipelineRunId}:${stage.stageId}`}>
                    {stage.name} · assigned
                  </div>
                ))}
              {agent.activeRuns.total === 0 &&
                agent.activeStages.total === 0 &&
                "—"}
            </td>
            <td>
              {agent.activeRuns.total}
              {agent.activeRuns.total > agent.activeRuns.items.length && (
                <span className="block text-xs text-subtle">
                  {agent.activeRuns.items.length} shown
                </span>
              )}
            </td>
            <td>
              {agent.activeStages.total}
              {agent.activeStages.total > agent.activeStages.items.length && (
                <span className="block text-xs text-subtle">
                  {agent.activeStages.items.length} shown
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  ) : (
    <Empty>No agents recorded.</Empty>
  );
}
export function ProjectCard({
  project,
  pipeline,
}: {
  project: ProjectSummary;
  pipeline?: PipelineRunState;
}) {
  return (
    <Card className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold">
          <Link to={`/projects/${encodeURIComponent(project.projectId)}`}>
            {project.name}
          </Link>
        </h3>
        <p className="line-clamp-2 text-sm text-subtle">
          {project.description ??
            project.repository.localPaths[0] ??
            "No description recorded"}
        </p>
      </div>
      <FactGrid
        facts={[
          {
            label: "Milestone",
            value:
              project.currentMilestone?.title ??
              (project.activeMilestoneCount > 1
                ? `${project.activeMilestoneCount} active`
                : "—"),
          },
          {
            label: "Pipeline",
            value: pipeline ? (
              <Link
                to={`/projects/${encodeURIComponent(project.projectId)}/pipeline`}
              >
                {pipeline.pipelineName} · {pipeline.currentStage?.name ?? "—"}
              </Link>
            ) : (
              `${project.activePipelineRuns} active`
            ),
          },
          { label: "Working agents", value: project.agentsWorking },
          { label: "Active runs", value: project.activeAgentRuns },
          { label: "Attention", value: project.attention.total },
          {
            label: "Tasks",
            value: `${project.tasks.open} open / ${project.tasks.total} total`,
          },
        ]}
      />
    </Card>
  );
}
export function ReviewList({ reviews }: { reviews: readonly ReviewState[] }) {
  return reviews.length ? (
    <ul className="divide-y divide-border rounded-lg border border-border bg-surface">
      {reviews.map((review) => (
        <li key={review.reviewId} className="p-4">
          <div className="flex flex-wrap gap-2">
            <StatusBadge
              label={review.status}
              tone={review.status === "pending" ? "attention" : "good"}
            />
            <span>
              {review.subjectType} · <Id value={review.subjectId} />
            </span>
          </div>
          <p className="mt-1 text-sm text-subtle">
            {review.summary ?? "No summary recorded"} · reviewer{" "}
            {review.reviewer.displayName ?? review.reviewer.id}
          </p>
        </li>
      ))}
    </ul>
  ) : (
    <Empty>No reviews recorded.</Empty>
  );
}
export function TaskRow({
  task,
  query = "",
}: {
  task: TaskOperationalState;
  query?: string;
}) {
  const working = task.activeAgentRuns.items.map(
    (run) => run.agent?.name ?? "Agent unavailable",
  );
  return (
    <tr>
      <td>
        <Link
          className="font-medium"
          to={`/projects/${encodeURIComponent(task.projectId)}/tasks/${encodeURIComponent(task.taskId)}${query}`}
        >
          {task.title}
        </Link>
        <p className="max-w-[24rem] truncate text-xs text-subtle">
          {task.description ?? task.taskId}
        </p>
      </td>
      <td>
        <StatusBadge
          label={taskStatusLabel(task.operationalStatus)}
          tone={taskStatusTone(task.operationalStatus)}
        />
        {task.divergesFromRecordedStatus && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
            Recorded: {task.recordedStatus}
          </p>
        )}
      </td>
      <td>
        {task.activePipelineRun ? (
          <Link to={`/projects/${encodeURIComponent(task.projectId)}/pipeline`}>
            {task.activePipelineRun.pipelineName} ·{" "}
            {task.activePipelineRun.currentStageName ?? "—"}
          </Link>
        ) : (
          "—"
        )}
      </td>
      <td>
        {task.activePipelineRun
          ? (task.assignedAgent?.name ?? "No agent")
          : "—"}
      </td>
      <td>
        {working.length ? working.join(", ") : "No active run"}
        {task.activeAgentRuns.total > working.length && (
          <span className="block text-xs text-subtle">
            {task.activeAgentRuns.total} active runs; {working.length} shown
          </span>
        )}
      </td>
      <td>{task.priority}</td>
      <td>
        {task.milestones?.map((m) => m.title).join(", ") ||
          "No linked milestone"}
      </td>
    </tr>
  );
}
export function TaskTable({
  tasks,
  query,
}: {
  tasks: readonly TaskOperationalState[];
  query?: string;
}) {
  return tasks.length ? (
    <Table>
      <thead>
        <tr>
          {[
            "Task",
            "Operational",
            "Pipeline / stage",
            "Assigned",
            "Working",
            "Priority",
            "Milestone",
          ].map((x) => (
            <th key={x}>{x}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {tasks.map((task) => (
          <TaskRow
            key={task.taskId}
            task={task}
            {...(query === undefined ? {} : { query })}
          />
        ))}
      </tbody>
    </Table>
  ) : (
    <Empty>No tasks in this view.</Empty>
  );
}
export function Divergence({ task }: { task: TaskOperationalState }) {
  return task.divergesFromRecordedStatus ? (
    <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950">
      <strong>Recorded and operational state differ.</strong>
      <ul className="mt-2 list-disc pl-5">
        {task.divergenceReasons.map((reason) => (
          <li key={reason}>{taskDivergenceLabel(reason)}</li>
        ))}
      </ul>
    </div>
  ) : null;
}
